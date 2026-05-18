"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  writeBatch,
  setDoc,
  getDoc,
  deleteDoc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { getQuotes, StockQuote } from "@/lib/finnhub";
import { HistoricalPoint } from "@/lib/yahoo";
import { getCachedHistoricalCloses } from "@/lib/historical-cache";
import {
  aggregateHoldings,
  buildComparisonSeries,
  buildTradeLog,
  fmtShares,
  poolPositions,
  SeriesPoint,
} from "@/lib/portfolio";
import { useChartColors } from "@/lib/theme";
import { useDisplayName, useDisplayNamesForUids } from "@/lib/users";
import { usePublishPortfolioOwnership } from "@/lib/portfolio-route";
import { SharePanel } from "@/components/SharePanel";
import { UnlockModal } from "@/components/UnlockModal";
import { AllocationTreemap } from "@/components/AllocationTreemap";
import { FriendStack } from "@/components/FriendStack";
import { PerformancePill } from "@/components/PerformancePill";
import { TwoLinePLCell } from "@/components/TwoLinePLCell";
import { TabBar } from "@/components/TabBar";
import { SyncHistory } from "@/components/SyncHistory";
import { cleanT212Symbol } from "@/lib/brokers/trading212/symbols";
import { BROKERS, SUPPORTED_BROKERS } from "@/lib/brokers/registry";
import type { BrokerId } from "@/lib/brokers/ids";
import type { ImportResult, SnapTradeDiagnostics } from "@/lib/brokers/types";
import {
  decryptBrokerCredential,
  encryptBrokerCredential,
} from "@/lib/crypto-client";
import { SnapTradeConnectFlow } from "@/components/SnapTradeConnectFlow";
import { useEncryption } from "@/lib/use-encryption";
import { getCachedPortfolioKey, getUnlocked } from "@/lib/key-store";
import {
  addHolding,
  loadPortfolioKeyWithRetry,
  migratePortfolioToEncrypted,
  reconcileSharedWrappedKeys,
  subscribeHoldings,
  updateHoldingFields,
} from "@/lib/holdings-repo";
import { encryptHolding, encryptJson } from "@/lib/crypto-client";
import {
  touchLogbookView,
  touchPortfolioView,
} from "@/lib/views";
import { ArrowLeft, ArrowUpRight, ChevronRight, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";

const BENCHMARKS = ["SPY", "QQQ"] as const;

// Broker constants live in src/lib/brokers/registry.ts as the single
// source of truth — imported above. The connection picker below maps
// over `SUPPORTED_BROKERS` (alphabetical) and uses each adapter's
// `displayName`, `credentialFields`, and `credentialHint` to render
// itself.

export default function PortfolioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const chartColors = useChartColors();

  const [user, setUser] = useState<User | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);

  const [showShare, setShowShare] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<{
    symbol: string;
    exchange: string;
    shares: string;
    purchasePrice: string;
    purchaseDate: string;
    side: "BUY" | "SELL";
  }>({
    symbol: "",
    exchange: "",
    shares: "",
    purchasePrice: "",
    purchaseDate: new Date().toISOString().split("T")[0],
    side: "BUY",
  });

  const [showImport, setShowImport] = useState(false);
  const [connectProvider, setConnectProvider] = useState<BrokerId>(SUPPORTED_BROKERS[0]);
  // Generic per-field connect form state: `{ key: "...", secret: "..." }`
  // for both T212 and Alpaca today. Populated from the active adapter's
  // `credentialFields`.
  const [connectFields, setConnectFields] = useState<Record<string, string>>({});
  const [syncResults, setSyncResults] = useState<Record<string, { buys: number; sells: number; skipped: number; partialFillsSkipped: number }>>({});
  const [syncLoading, setSyncLoading] = useState<string | null>(null);
  const [syncError, setSyncError] = useState("");

  const encryption = useEncryption();
  // Unwrapped K_portfolio for the active portfolio. Set once per portfolio
  // load (or after a migration). null means the holdings subscription falls
  // back to the legacy plaintext shape. Seeded from the module-level cache
  // so navigating between portfolios within the same tab doesn't trigger
  // a fresh resolution for keys we already have.
  const [portfolioKey, setPortfolioKey] = useState<CryptoKey | null>(
    () => getCachedPortfolioKey(id),
  );
  const [migrationError, setMigrationError] = useState("");

  // Whether `secrets/credentials` exists for this portfolio. We only need
  // the boolean — the broker identity comes from `lockedBroker` (derived
  // from `holdings.find(h => h.importSource)`). Decrypting the credential
  // doc just to know the broker name would be wasteful; holdings already
  // tell us, and the credential is decrypted on demand inside `handleSync`.
  const [hasCredential, setHasCredential] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.push("/login");
        return;
      }
      setUser(u);
    });
    return () => unsub();
  }, [router]);

  // Portfolio doc listener — stable, never tears down due to portfolioKey
  // changes. Splitting this from the holdings listener avoids a feedback
  // loop where every snapshot would create a new portfolio object,
  // re-fire the encryption-state effect, resolve a fresh K_portfolio,
  // and tear down + recreate this listener on every cycle.
  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "portfolios", id),
      (snap) => {
        if (!snap.exists()) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setPortfolio({
          id: snap.id,
          ...(snap.data() as Omit<Portfolio, "id">),
        });
        setLoading(false);
      },
      () => {
        setNotFound(true);
        setLoading(false);
      },
    );
  }, [user, id]);

  // Holdings listener — depends on portfolioKey. Re-subscribes when the
  // key arrives so encrypted docs start decoding. Pre-migration portfolios
  // pass through to the legacy plaintext shape.
  useEffect(() => {
    if (!user) return;
    const sub = subscribeHoldings(
      id,
      portfolioKey,
      (rows) => setHoldings(rows),
      () => setHoldings([]),
    );
    return () => sub.unsubscribe();
  }, [user, id, portfolioKey]);

  // Watch the credential doc — only the boolean "does it exist?"
  // matters here. Broker identity is supplied by `lockedBroker`
  // (derived from holdings below).
  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "portfolios", id, "secrets", "credentials"),
      (snap) => setHasCredential(snap.exists()),
      () => setHasCredential(false),
    );
  }, [user, id]);

  // Resolve K_portfolio when the portfolio is loaded + user is unlocked.
  // For owners viewing a not-yet-encrypted portfolio, also kick off the
  // one-shot migration that re-encrypts all holdings. For shared viewers,
  // we just attempt to fetch their wrappedKey doc — Phase 3 makes this
  // robust against owners who haven't yet wrapped for them.
  //
  // Critical: deps are *scalar* projections of `portfolio` (encrypted flag,
  // ownerId, sharedWith joined into a string). Using the whole portfolio
  // object would re-fire this effect on every snapshot delivery — even
  // when nothing changed — because `setPortfolio` always allocates a new
  // object. That re-firing was causing a feedback loop with the holdings
  // listener: new key → new listener → new snapshot → new portfolio
  // object → new key → … → 200+ Firestore requests per 10s.
  const portfolioEncrypted = portfolio?.encrypted ?? false;
  const portfolioOwnerId = portfolio?.ownerId;
  // Sort first so the sig is order-independent — Firestore sometimes
  // delivers sharedWith in different orders across snapshots.
  const portfolioSharedSig = portfolio?.sharedWith
    ? [...portfolio.sharedWith].sort().join(",")
    : "";
  useEffect(() => {
    if (!portfolioOwnerId || !user) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    const isPortfolioOwner = portfolioOwnerId === user.uid;
    const sharedWith = portfolioSharedSig
      ? portfolioSharedSig.split(",")
      : [];
    let cancelled = false;
    setMigrationError("");

    (async () => {
      // Path 1: portfolio is already encrypted → just fetch + unwrap our key.
      if (portfolioEncrypted) {
        try {
          const k = await loadPortfolioKeyWithRetry(
            id,
            user.uid,
            unlocked.privateKey,
          );
          if (!cancelled) setPortfolioKey(k);
          // Re-share reconnection: if any sharer enrolled after this
          // portfolio was migrated, they have a publicKey but no
          // wrappedKey doc. Silently fix that on every owner load.
          if (isPortfolioOwner && sharedWith.length > 0) {
            await reconcileSharedWrappedKeys(id, sharedWith, {
              portfolioKey: k,
              ownerPrivateKey: unlocked.privateKey,
              ownerPublicKeyHex: unlocked.publicKeyHex,
            });
          }
        } catch (err) {
          if (!cancelled) {
            setMigrationError(
              isPortfolioOwner
                ? "Couldn't unlock your portfolio key — try refreshing."
                : "This portfolio is encrypted but the owner hasn't shared the key with you yet.",
            );
          }
          console.warn("loadPortfolioKeyWithRetry failed", err);
        }
        return;
      }
      // Path 2: not encrypted, owner is here → migrate.
      if (isPortfolioOwner) {
        try {
          await migratePortfolioToEncrypted(
            id,
            user.uid,
            unlocked.privateKey,
            unlocked.publicKey,
            unlocked.publicKeyHex,
          );
          // After migration, the portfolio doc snapshot will deliver
          // `encrypted: true` shortly; that triggers Path 1 above and
          // populates portfolioKey. Nothing more to do here.
        } catch (err) {
          if (!cancelled) {
            setMigrationError(
              "Couldn't migrate your portfolio to encrypted storage. Refresh to try again.",
            );
          }
          console.warn("migratePortfolioToEncrypted failed", err);
        }
      }
      // Path 3: not encrypted, viewer is a sharer → leave plaintext path
      // active until the owner migrates.
    })();

    return () => {
      cancelled = true;
    };
  }, [
    portfolioEncrypted,
    portfolioOwnerId,
    portfolioSharedSig,
    user,
    id,
    encryption.state.kind,
  ]);

  useEffect(() => {
    const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
    if (symbols.length === 0) return;
    // Resolve each display symbol to its Yahoo query symbol. Quotes state
    // stays keyed by display symbol so render code doesn't need to know
    // about .L/.DE suffixes.
    const yahooBySymbol = new Map<string, string>();
    for (const h of holdings) {
      if (h.yahooSymbol && !yahooBySymbol.has(h.symbol)) {
        yahooBySymbol.set(h.symbol, h.yahooSymbol);
      }
    }
    let cancelled = false;
    const fetchAll = () => {
      const apiSymbols = symbols.map((s) => yahooBySymbol.get(s) ?? s);
      getQuotes(apiSymbols).then((map) => {
        if (cancelled) return;
        const rekeyed: Record<string, StockQuote | null> = {};
        symbols.forEach((s, i) => {
          rekeyed[s] = map[apiSymbols[i]] ?? null;
        });
        setQuotes((prev) => ({ ...prev, ...rekeyed }));
      });
    };
    fetchAll();
    const interval = setInterval(fetchAll, 120_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [holdings]);

  useEffect(() => {
    if (holdings.length === 0) {
      setSeries([]);
      return;
    }
    const pooled = poolPositions(holdings);
    if (pooled.length === 0) {
      // Everything was sold — nothing to chart. Realized history is out of scope.
      setSeries([]);
      return;
    }
    let cancelled = false;
    setChartLoading(true);

    const firstDate = pooled
      .map((p) => p.firstPurchaseDate)
      .reduce((a, b) => (a < b ? a : b));
    // Pad the fetch window back by 14 days so `closeOnOrBefore` never returns
    // null for a lot whose purchase date lands on a weekend/holiday or right
    // at the edge of Yahoo's returned range. Critical for benchmark basis
    // lookups — if SPY has no data at-or-before the lot's date, that lot
    // drops out of the SPY sum, and if it's the only lot on firstDate the
    // SPY line never gets a positive base and stays hidden.
    const fromMs = new Date(firstDate).getTime() - 14 * 24 * 60 * 60 * 1000;
    const toMs = Date.now();
    const symbols = Array.from(new Set(pooled.map((p) => p.symbol)));
    const chartHoldings = holdings.filter(
      (h) => h.purchaseDate >= firstDate && symbols.includes(h.symbol)
    );
    // Resolve display symbol → Yahoo query symbol for history fetches.
    // buildComparisonSeries still expects priceMap keyed by display symbol.
    const yahooBySymbol = new Map<string, string>();
    for (const h of holdings) {
      if (h.yahooSymbol && !yahooBySymbol.has(h.symbol)) {
        yahooBySymbol.set(h.symbol, h.yahooSymbol);
      }
    }

    Promise.all([
      ...symbols.map((s) =>
        getCachedHistoricalCloses(yahooBySymbol.get(s) ?? s, fromMs, toMs).then(
          (pts) => [s, pts] as [string, HistoricalPoint[]]
        )
      ),
      ...BENCHMARKS.map((b) =>
        getCachedHistoricalCloses(b, fromMs, toMs).then(
          (pts) => [`__bench__${b}`, pts] as [string, HistoricalPoint[]]
        )
      ),
    ]).then((results) => {
      if (cancelled) return;
      const priceMap: Record<string, HistoricalPoint[]> = {};
      const benchMap: Record<string, HistoricalPoint[]> = {};
      for (const [key, pts] of results) {
        if (key.startsWith("__bench__")) {
          benchMap[key.slice("__bench__".length)] = pts;
        } else {
          priceMap[key] = pts;
        }
      }
      setSeries(buildComparisonSeries(chartHoldings, priceMap, benchMap));
      setChartLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [holdings]);

  const isOwner = !!(user && portfolio && portfolio.ownerId === user.uid);
  // The portfolio's locked broker, if any. Once any holding has an
  // `importSource`, the portfolio is forever locked to that broker —
  // disconnect deletes the credential but the lock survives. Single
  // source of truth for "which broker does this portfolio belong to";
  // drives both the picker filter and the connected-broker label.
  const lockedBroker = useMemo<BrokerId | null>(() => {
    for (const h of holdings) {
      if (h.importSource && h.importSource in BROKERS) {
        return h.importSource as BrokerId;
      }
    }
    return null;
  }, [holdings]);
  // For SnapTrade-locked portfolios, additionally pin the SnapTrade
  // account id from the first holding that carries one. A user with
  // two SnapTrade-connected portfolios shouldn't be able to mix
  // accounts; the picker filter (and the runtime check inside
  // handleSync) require any future SnapTrade reconnect to use the
  // same account id.
  const lockedSnaptradeAccountId = useMemo<string | null>(() => {
    if (lockedBroker !== "snaptrade") return null;
    for (const h of holdings) {
      if (
        h.importSource === "snaptrade"
        && typeof h.snaptradeAccountId === "string"
        && h.snaptradeAccountId.length > 0
      ) {
        return h.snaptradeAccountId;
      }
    }
    return null;
  }, [lockedBroker, holdings]);
  // Forward-compat safety: if a holding's `importSource` names a
  // broker this build of the app doesn't know about (e.g. portfolio
  // was synced on a newer build with a broker added later, then opened
  // in a stale tab/cache), `lockedBroker` is null but we mustn't let
  // the user reconnect to a different broker. Surfacing this state
  // explicitly lets the modal hide the connect form and tell the
  // user to update.
  const hasUnknownImportSource = useMemo(
    () => holdings.some(
      (h) => !!h.importSource && !(h.importSource in BROKERS),
    ),
    [holdings],
  );
  // Always-current reference to `holdings` — used inside `handleSync`
  // to re-derive the lock at submit time. Without this, `handleSync`'s
  // closure can hold a stale `lockedBroker` from an earlier render
  // (e.g. a concurrent sync in another tab added holdings between
  // render and click). The ref is updated on every render via the
  // effect below; reading `.current` always sees the latest.
  const holdingsRef = useRef(holdings);
  useEffect(() => {
    holdingsRef.current = holdings;
  }, [holdings]);
  // Synchronous in-flight guard for handleSync. The button uses
  // `disabled={!!syncLoading}` based on React state, but state updates
  // don't apply until the next render — so a fast double-click or
  // user impatiently re-clicking can fire multiple `handleSync` calls
  // before the disabled state takes effect, and each one runs through
  // the full pipeline (real-world: user clicked 5x, got 5 duplicate
  // SnapTrade lots). This ref blocks re-entry synchronously.
  const syncInFlightRef = useRef(false);
  // Publish ownership to the AppShell so the right tab (Mine vs Friends)
  // highlights while we're on this route. Pass `null` until the portfolio
  // doc has loaded so we don't wrongly flash the owner state.
  usePublishPortfolioOwnership(
    !user || !portfolio ? null : portfolio.ownerId === user.uid,
  );
  const ownerName = useDisplayName(portfolio?.ownerId ?? null);
  const followerNames = useDisplayNamesForUids(portfolio?.sharedWith ?? []);
  const positions = useMemo(() => {
    const rows = aggregateHoldings(holdings);
    return rows.slice().sort((a, b) => {
      const qa = quotes[a.symbol];
      const qb = quotes[b.symbol];
      const ma = qa ? a.shares * qa.c : -1;
      const mb = qb ? b.shares * qb.c : -1;
      return mb - ma;
    });
  }, [holdings, quotes]);

  const tradeLog = useMemo(() => buildTradeLog(holdings), [holdings]);
  const positionsCount = positions.length;
  const logbookCount = tradeLog.length;
  // Bump `lastPortfolioViewAt` once per page load for shared viewers. This
  // is what clears the home-page "N new" badge. Gated so owners never write.
  useEffect(() => {
    if (!user || isOwner || !portfolio) return;
    touchPortfolioView(user.uid, id);
  }, [user, isOwner, portfolio, id]);

  const [tab, setTabState] = useState<"positions" | "logbook" | "allocation">("positions");
  const setTab = (next: "positions" | "logbook" | "allocation") => {
    setTabState(next);
    if (next === "logbook" && user && !isOwner) {
      touchLogbookView(user.uid, id);
    }
  };

  // Total current market value across positions with resolved quotes. Used to
  // compute per-row allocation % in the owner positions table. Positions
  // without a quote are excluded from the denominator so allocation adds to
  // 100% of the "covered" portion.
  const positionsTotalMarket = useMemo(() => {
    let total = 0;
    for (const p of positions) {
      const q = quotes[p.symbol];
      if (q) total += p.shares * q.c;
    }
    return total;
  }, [positions, quotes]);

  const seriesTickFormatter = useMemo(() => {
    const spanMs =
      series.length > 1
        ? new Date(series[series.length - 1].date).getTime() -
          new Date(series[0].date).getTime()
        : 0;
    const spanDays = spanMs / 86_400_000;
    return (d: string) => {
      const date = new Date(d);
      if (spanDays <= 180) {
        return date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
      }
      if (spanDays <= 365 * 2) {
        return date.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        });
      }
      return date.toLocaleDateString("en-US", { year: "numeric" });
    };
  }, [series]);

  const totals = useMemo(() => {
    let cost = 0;
    let market = 0;
    let firstDate: string | null = null;
    for (const p of positions) {
      cost += p.cost;
      const q = quotes[p.symbol];
      if (q) market += p.shares * q.c;
      if (!firstDate || p.firstDate < firstDate) firstDate = p.firstDate;
    }
    const gain = market - cost;
    const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
    return { cost, market, gain, gainPct, firstDate };
  }, [positions, quotes]);

  const benchGain = useMemo(() => {
    const last = series[series.length - 1];
    if (!last) return null;
    const values: Record<string, number> = {};
    for (const b of BENCHMARKS) {
      const v = last[b];
      if (typeof v === "number") values[b] = v;
    }
    return { portfolio: last.portfolio, values };
  }, [series]);

  // Normalized series for the non-owner view — % return from each series'
  // own first-valid day. Each line (portfolio, SPY, QQQ) finds its own base
  // independently, so a temporary zero on day 0 for one benchmark doesn't
  // hide its line for the entire chart.
  const normalizedSeries = useMemo(() => {
    if (series.length === 0) return [];
    const baseIdx = series.findIndex((p) => p.portfolio > 0);
    if (baseIdx === -1) return [];
    const baseP = series[baseIdx].portfolio;
    const findBase = (key: "SPY" | "QQQ"): number | null => {
      for (let i = baseIdx; i < series.length; i++) {
        const v = series[i][key];
        if (typeof v === "number" && v > 0) return v;
      }
      return null;
    };
    const baseSPY = findBase("SPY");
    const baseQQQ = findBase("QQQ");
    return series.slice(baseIdx).map((p) => {
      const spy = typeof p.SPY === "number" && p.SPY > 0 ? p.SPY : null;
      const qqq = typeof p.QQQ === "number" && p.QQQ > 0 ? p.QQQ : null;
      const point: SeriesPoint = {
        date: p.date,
        portfolio: (p.portfolio / baseP - 1) * 100,
      };
      if (baseSPY && spy !== null) point.SPY = (spy / baseSPY - 1) * 100;
      if (baseQQQ && qqq !== null) point.QQQ = (qqq / baseQQQ - 1) * 100;
      return point;
    });
  }, [series]);

  // Non-owner per-position stats: allocation % + gain %.
  const nonOwnerRows = useMemo(() => {
    const totalMarket = positions.reduce((sum, p) => {
      const q = quotes[p.symbol];
      return q ? sum + p.shares * q.c : sum;
    }, 0);
    const rows = positions.map((p) => {
      const q = quotes[p.symbol];
      const market = q ? p.shares * q.c : null;
      const gainPct =
        q && p.avgPrice > 0 ? ((q.c - p.avgPrice) / p.avgPrice) * 100 : null;
      return { symbol: p.symbol, market, gainPct };
    });
    return rows
      .map((r) => ({
        symbol: r.symbol,
        allocationPct:
          r.market !== null && totalMarket > 0
            ? (r.market / totalMarket) * 100
            : null,
        gainPct: r.gainPct,
      }))
      .sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1));
  }, [positions, quotes]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner) return;
    const shares = parseFloat(form.shares);
    const price = parseFloat(form.purchasePrice);
    if (!form.symbol.trim() || !(shares > 0) || !(price > 0)) return;

    const bareSymbol = form.symbol.trim().toUpperCase();
    // Exchange dropdown value is the Yahoo suffix (e.g. ".L", ".DE"). Empty
    // string = US listing → yahooSymbol equals the bare symbol.
    const yahooSymbol = form.exchange
      ? `${bareSymbol}${form.exchange}`
      : bareSymbol;
    // Encryption-aware add: passes through addHolding which writes the
    // encrypted shape if a portfolioKey is in hand, else falls back to the
    // legacy plaintext shape (pre-migration portfolios).
    await addHolding(id, portfolioKey, {
      symbol: bareSymbol,
      shares,
      purchasePrice: price,
      purchaseDate: form.purchaseDate,
      createdAt: Date.now(),
      side: form.side,
      yahooSymbol,
    });
    setForm({
      symbol: "",
      exchange: "",
      shares: "",
      purchasePrice: "",
      purchaseDate: new Date().toISOString().split("T")[0],
      side: "BUY",
    });
    setShowAdd(false);
  };

  const handleSync = async (provider: BrokerId, keyOverride?: string) => {
    // Synchronous re-entry guard. Must run before any async work so
    // back-to-back clicks (or React-state-lag from `setSyncLoading`)
    // can't double-fire. See `syncInFlightRef` declaration above.
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    // Set syncLoading BEFORE the runHandleSync call so the button's
    // `disabled={!!syncLoading}` applies on the next render — i.e.
    // immediately, not after the credential-decrypt + Firestore-read
    // chain inside runHandleSync. Without this, the button stays
    // visually clickable for up to ~30s during the SnapTrade API
    // call, which makes the click look ignored.
    setSyncLoading(provider);
    setSyncError("");
    try {
      await runHandleSync(provider, keyOverride);
    } finally {
      syncInFlightRef.current = false;
      setSyncLoading(null);
    }
  };

  const runHandleSync = async (provider: BrokerId, keyOverride?: string) => {
    if (!portfolio || !user) return;
    const adapter = BROKERS[provider];
    if (!adapter) {
      setSyncError(`Unsupported broker: ${provider}`);
      return;
    }
    // Lock enforcement (UX rail; server can't see broker identity to
    // enforce). Re-derive from the always-current `holdingsRef` so we
    // catch any holdings added between this handler being created
    // (during render) and being called (on click) — e.g. a concurrent
    // sync in another tab. The render-closure `lockedBroker` is fine
    // for the picker UI; the runtime check needs to be live.
    const liveLocked = (() => {
      for (const h of holdingsRef.current) {
        if (h.importSource && h.importSource in BROKERS) {
          return h.importSource as BrokerId;
        }
      }
      return null;
    })();
    if (liveLocked && liveLocked !== provider) {
      setSyncError(
        `This portfolio is locked to ${BROKERS[liveLocked].displayName}.`,
      );
      return;
    }
    // SnapTrade gets a second-tier lock: the same broker, different
    // account is also a violation. Re-derive from the live ref so we
    // catch any holdings added between this handler being created and
    // being called. The picker UI in SnapTradeConnectFlow already
    // enforces this for the happy path; this is defense-in-depth so
    // any future caller (retry button, scripted invocation, refactor
    // that bypasses the picker) can't slip past the lock.
    const liveLockedSnaptradeAccountId = (() => {
      if (provider !== "snaptrade") return null;
      for (const h of holdingsRef.current) {
        if (
          h.importSource === "snaptrade"
          && typeof h.snaptradeAccountId === "string"
          && h.snaptradeAccountId.length > 0
        ) {
          return h.snaptradeAccountId;
        }
      }
      return null;
    })();
    if (provider === "snaptrade" && keyOverride && liveLockedSnaptradeAccountId) {
      try {
        const incoming = JSON.parse(keyOverride) as {
          snaptradeAccountId?: string;
        };
        if (
          typeof incoming.snaptradeAccountId !== "string"
          || incoming.snaptradeAccountId !== liveLockedSnaptradeAccountId
        ) {
          setSyncError(
            "This portfolio is locked to a different SnapTrade account.",
          );
          return;
        }
      } catch {
        setSyncError("Malformed SnapTrade credential.");
        return;
      }
    }
    // Single generic secrets doc per portfolio. The provider name (e.g.
    // "trading212") is stamped inside the encrypted payload, never on
    // the doc path.
    const secretRef = doc(db, "portfolios", id, "secrets", "credentials");

    // Under the E2E model, broker credentials are encrypted with the user's
    // master secret on the client. The server can't read them at rest. To
    // store/retrieve we need the user to be unlocked.
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) {
      setSyncError("Unlock your portfolio first.");
      return;
    }

    // Resolve a plaintext API key for this sync.
    //   - Fresh paste (`keyOverride`): plaintext in hand, write ciphertext.
    //   - Stored `secrets/credentials` doc: `{ payload, iv }` envelope —
    //     decrypt under master secret. The eager migration on home-page
    //     load already renamed any legacy `secrets/trading212` to this
    //     path, so by the time sync runs we shouldn't see the old name.
    let plaintextKey: string;
    let needsWriteBack = false;
    if (keyOverride) {
      plaintextKey = keyOverride;
      needsWriteBack = true;
    } else {
      const secretSnap = await getDoc(secretRef);
      const data = secretSnap.exists() ? secretSnap.data() : null;
      if (
        data &&
        typeof data.payload === "string" &&
        typeof data.iv === "string"
      ) {
        try {
          // decryptBrokerCredential returns `{brokerId, credential}`.
          // For T212/Alpaca the credential is the bare `key:secret`
          // string. For SnapTrade it's the JSON-encoded 5-field BYO
          // blob. The adapter knows how to parse its own shape.
          const decoded = await decryptBrokerCredential(
            { payload: data.payload, iv: data.iv },
            unlocked.masterSecret,
          );
          // Sanity: doc says it's broker X, picker says Y → refuse.
          if (decoded.brokerId !== provider) {
            setSyncError(
              `Stored credentials are for ${decoded.brokerId}, not ${provider}.`,
            );
            return;
          }
          plaintextKey = decoded.credential;
        } catch {
          setSyncError("Stored credentials are corrupt — reconnect.");
          return;
        }
      } else {
        setSyncError("No credentials — reconnect.");
        return;
      }
    }

    // Note: setSyncLoading/setSyncError already fired in the
    // `handleSync` wrapper before any await. Don't duplicate here.
    const errors: string[] = [];
    let buys = 0;
    let sells = 0;
    let skipped = 0;
    // Captured from the adapter result so the `finally` syncLog write
    // can persist the redacted SnapTrade decision trace (encrypted
    // under the portfolio key). Null for non-SnapTrade brokers.
    let syncDiagnostics: SnapTradeDiagnostics | null = null;
    // For SnapTrade, the keyOverride / decrypted credential is JSON
    // containing `snaptradeAccountId`. Pull it out so each newly
    // imported holding can be tagged with the source account id —
    // that's how `lockedSnaptradeAccountId` enforces account-level
    // lock on subsequent reconnects. Other brokers leave this null.
    //
    // Belt-and-braces re-sync check: if we read a stored credential
    // (no keyOverride) and its accountId doesn't match the live lock
    // derived from holdings, refuse rather than silently rebind. The
    // picker can't reach this state, but if a stored credential ever
    // drifted from the holdings (corruption, partial migration,
    // future bug), we'd rather surface than tag new holdings with the
    // wrong account.
    let snaptradeAccountIdForWrites: string | null = null;
    if (provider === "snaptrade") {
      let parsedAccountId: string | null = null;
      try {
        const parsed = JSON.parse(plaintextKey) as {
          snaptradeAccountId?: string;
        };
        if (typeof parsed.snaptradeAccountId === "string") {
          parsedAccountId = parsed.snaptradeAccountId;
        }
      } catch {
        // Adapter will surface the JSON parse error itself.
      }
      if (
        !keyOverride
        && liveLockedSnaptradeAccountId
        && parsedAccountId
        && parsedAccountId !== liveLockedSnaptradeAccountId
      ) {
        setSyncError(
          "Stored SnapTrade credentials don't match this portfolio's locked account. Disconnect and reconnect.",
        );
        return;
      }
      snaptradeAccountIdForWrites = parsedAccountId;
    }
    try {
      if (needsWriteBack) {
        // Client-side encrypt under master secret. The brokerId stamped
        // INSIDE the encrypted payload tells future readers (us, on
        // re-sync) which broker the credential is for; the doc top
        // level stays generic so the server can't infer broker
        // identity from at-rest data.
        const env = await encryptBrokerCredential(
          { brokerId: provider, credential: plaintextKey },
          unlocked.masterSecret,
        );
        await setDoc(secretRef, {
          payload: env.payload,
          iv: env.iv,
          updatedAt: Date.now(),
        });
      }
      // The `isOrderKnown` predicate stops pagination as soon as a full
      // page of orders is already imported — adapters return orders
      // newest-first, so once we hit a fully-known page everything older
      // is also already imported. Repeat syncs drop from N pages to 1-2.
      //
      // Match BOTH on `brokerOrderId` (preferred — exact identity) AND
      // on shape (symbol + purchaseDate + shares) for legacy holdings
      // that predate broker-id tracking. The shape match uses a per-
      // broker symbol normalizer for `rawTicker` so that broker-specific
      // suffixes (T212's `_EQ`, etc.) are stripped before comparing
      // against the holding's normalized `symbol`.
      const normalizeRawTicker = (raw: string) =>
        provider === "trading212" ? cleanT212Symbol(raw) : raw;
      const isOrderKnown = (args: {
        orderId: string;
        rawTicker: string;
        purchaseDate: string;
        shares: number;
      }) => {
        for (const h of holdings) {
          if (h.brokerOrderId === args.orderId) return true;
        }
        const cleaned = normalizeRawTicker(args.rawTicker);
        for (const h of holdings) {
          if (h.brokerOrderId) continue; // covered by id check above
          if (h.symbol !== cleaned) continue;
          if (h.purchaseDate !== args.purchaseDate) continue;
          if (Math.abs(h.shares - args.shares) > 0.0001) continue;
          return true;
        }
        return false;
      };
      const result: ImportResult = await adapter.fetchOrders({
        credential: plaintextKey,
        isOrderKnown,
      });
      syncDiagnostics = result.diagnostics ?? null;

      // Use the already-decoded `holdings` state from the live
      // subscription. handleSync is recreated on every render, so the
      // closure captures the latest holdings — no stale-snapshot race.
      // Crucial that this is the DECODED shape: for v2 docs, the
      // dedup-by-brokerOrderId check below would always fail against the
      // raw `getDocs` shape (brokerOrderId lives inside the encrypted
      // payload there, not at the doc top level). That bug caused
      // every sync after the first to double-import every order.
      const decodedCurrent = holdings;
      // Decisions are sequential (encrypt-then-write) but we can still
      // batch the Firestore round-trip for the new-doc writes. Backfill
      // updates of encrypted docs need a read-decrypt-merge-encrypt-write
      // cycle each, so they're not batchable — issue them serially.
      const newDocsBuffer: Array<{
        encryptedShape: Record<string, unknown>;
        plaintextShape: Record<string, unknown>;
      }> = [];

      for (const order of result.orders) {
        const existing = decodedCurrent.find(
          (h) =>
            h.importSource === provider &&
            h.brokerOrderId === order.id
        );
        const byShape = existing
          ? undefined
          : decodedCurrent.find(
              (h) =>
                !h.brokerOrderId &&
                h.symbol === order.symbol &&
                h.purchaseDate === order.purchaseDate &&
                Math.abs(h.shares - order.shares) < 0.0001
            );
        const target = existing ?? byShape;
        if (target) {
          // Backfill yahooSymbol/isin/symbol corrections — same logic as
          // before, but routed through updateHoldingFields so encrypted
          // docs go through decrypt-merge-encrypt rather than naively
          // updating top-level fields that don't exist on ciphertext docs.
          //
          // Also backfill brokerOrderId on holdings that were matched by
          // shape rather than by id — without this, the dedup-and-stop
          // optimization stays expensive forever on these holdings
          // (each shape lookup is O(holdings) instead of O(1)). After
          // one sync post-this-fix, future syncs are fully on the
          // cheap id path.
          const patch: Record<string, string | undefined> = {};
          if (order.yahooSymbol && target.yahooSymbol !== order.yahooSymbol) {
            patch.yahooSymbol = order.yahooSymbol;
          }
          if (!target.isin && order.isin) patch.isin = order.isin;
          if (order.symbol && target.symbol !== order.symbol) {
            patch.symbol = order.symbol;
          }
          if (!target.brokerOrderId) patch.brokerOrderId = order.id;
          if (Object.keys(patch).length > 0) {
            await updateHoldingFields(id, target.id, portfolioKey, patch);
          }
          skipped++;
          continue;
        }
        // New holding. Pre-encrypt now so the write batch can be a single
        // round-trip at the end.
        const plaintextShape: Record<string, unknown> = {
          symbol: order.symbol,
          shares: order.shares,
          purchasePrice: order.purchasePrice,
          purchaseDate: order.purchaseDate,
          createdAt: Date.now(),
          importSource: provider,
          brokerOrderId: order.id,
          side: order.side,
        };
        if (order.currency) plaintextShape.currency = order.currency;
        if (order.isin) plaintextShape.isin = order.isin;
        if (order.yahooSymbol) plaintextShape.yahooSymbol = order.yahooSymbol;
        // SnapTrade-locked holdings carry the SnapTrade account id
        // they came from, so future syncs can verify the lock at
        // account granularity (one-account-one-portfolio) — not just
        // at broker granularity. Only stamped for SnapTrade.
        if (snaptradeAccountIdForWrites) {
          plaintextShape.snaptradeAccountId = snaptradeAccountIdForWrites;
        }

        if (portfolioKey) {
          // v2 shape: importSource and brokerOrderId go INSIDE the
          // encrypted payload along with every other field. The
          // Firestore doc top level only carries the envelope plus
          // createdAt and schemaVersion — nothing identifying the
          // broker.
          const ct = await encryptHolding(
            {
              symbol: order.symbol,
              shares: order.shares,
              purchasePrice: order.purchasePrice,
              purchaseDate: order.purchaseDate,
              side: order.side,
              currency: order.currency,
              isin: order.isin,
              yahooSymbol: order.yahooSymbol,
              importSource: provider,
              brokerOrderId: order.id,
              ...(snaptradeAccountIdForWrites
                ? { snaptradeAccountId: snaptradeAccountIdForWrites }
                : {}),
            },
            portfolioKey,
          );
          newDocsBuffer.push({
            plaintextShape,
            encryptedShape: {
              payload: ct.payload,
              iv: ct.iv,
              createdAt: plaintextShape.createdAt,
              schemaVersion: 2,
            },
          });
        } else {
          // Legacy path — plaintext doc.
          newDocsBuffer.push({ plaintextShape, encryptedShape: plaintextShape });
        }
        if (order.side === "SELL") sells++;
        else buys++;
      }
      const batch = writeBatch(db);
      const holdingsCol = collection(db, "portfolios", id, "holdings");
      for (const item of newDocsBuffer) {
        batch.set(doc(holdingsCol), item.encryptedShape);
      }
      await batch.commit();
      setSyncResults((prev) => ({
        ...prev,
        [provider]: {
          buys,
          sells,
          skipped,
          partialFillsSkipped: result.partialFillsSkipped,
        },
      }));
      setConnectFields({});
      setShowImport(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      errors.push(msg);
      setSyncError(msg);
      // Wrong creds are the most common reason a fresh-paste sync
      // fails. Clear the form so a passerby can't read the API
      // secret off the user's screen, and so a retry-with-different-
      // creds workflow doesn't have to manually wipe the inputs first.
      // Only do this when the user just typed credentials in this
      // attempt (`keyOverride`) — a re-sync of an already-connected
      // broker has empty form fields anyway.
      if (keyOverride) {
        setConnectFields({});
        // Atomic rollback: if the portfolio still has zero holdings
        // imported (sync errored before we wrote any), delete the
        // credential doc we just wrote. Without this we'd leave an
        // orphaned credential whose broker identity can't be derived
        // from holdings — a confusing intermediate state.
        //
        // We check the LIVE ref (not the render closure) because new
        // holdings get committed in a single atomic batch downstream;
        // either ALL of this sync's holdings are present (and the lock
        // is established) or NONE are. So a fresh re-derivation here
        // faithfully reflects whether this sync wrote anything before
        // failing. If you ever split the batch, revisit this — the
        // assumption breaks.
        const lockedNow = holdingsRef.current.find(
          (h) => h.importSource && h.importSource in BROKERS,
        );
        if (!lockedNow) {
          try {
            await deleteDoc(secretRef);
          } catch {
            // best-effort cleanup
          }
        }
      }
    } finally {
      // Note: setSyncLoading(null) is now handled in the `handleSync`
      // wrapper's finally — keeps the in-flight ref + the loading
      // state lifecycle in one place.
      try {
        // syncLog body is encrypted under K_portfolio because `errors`
        // strings can carry broker-named messages (e.g. "Trading212
        // API error 429: ..."). Server stores ciphertext only; only
        // the user with portfolio access can decrypt. Schema mirrors
        // holdings: `{ payload, iv, createdAt, schemaVersion: 1 }`.
        // For pre-migration plaintext portfolios (no key) we skip the
        // write entirely rather than leak — these are rare, and an
        // unrecorded sync diagnostic is preferable to an at-rest leak.
        const createdAt = Date.now();
        const payload = {
          timestamp: createdAt,
          imported: buys + sells,
          buys,
          sells,
          skipped,
          errors,
          // Redacted SnapTrade decision trace (no symbols/amounts/ids).
          // Encrypted under K_portfolio along with the rest of the log.
          diagnostics: syncDiagnostics,
        };
        if (portfolioKey) {
          const ct = await encryptJson(payload, portfolioKey);
          await addDoc(collection(db, "portfolios", id, "syncLogs"), {
            payload: ct.payload,
            iv: ct.iv,
            createdAt,
            schemaVersion: 1,
          });
        }
      } catch {
        // best-effort audit log
      }
    }
  };

  const handleDisconnect = async () => {
    // Generic credentials doc; the broker id is stamped inside the
    // encrypted payload, not the path. No portfolio-doc field to update
    // — connection state is implicit in the existence of
    // `secrets/credentials`. The lock survives — `importSource` on
    // existing holdings still constrains future reconnects to the
    // same broker.
    await deleteDoc(doc(db, "portfolios", id, "secrets", "credentials"));
    setSyncResults({});
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-sm text-fg-dim">Loading…</span>
      </div>
    );
  }
  if (notFound || !portfolio) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <p className="text-lg">Portfolio not found.</p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden /> Back
        </Link>
      </div>
    );
  }

  // Daily login auto-unlocks silently. The modal here is only for the
  // browser-cleared / new-device case where we need the user's
  // recovery phrase to rebuild local key state.
  const needsRecovery = encryption.state.kind === "needs-recovery";

  return (
    <div className="min-h-screen">
      {needsRecovery && encryption.state.kind === "needs-recovery" && (
        <UnlockModal
          uid={encryption.state.uid}
          onRestore={encryption.restore}
        />
      )}
      {migrationError && (
        <div className="fixed top-3 right-3 z-40 max-w-sm border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-3 num">
          {migrationError}
        </div>
      )}
      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-10 space-y-10">
        <section className="animate-fade-up">
          {/* Breadcrumb */}
          <div className="text-[11.5px] text-fg-fade font-medium mb-3.5 flex items-center gap-1.5">
            <Link
              href={isOwner ? "/mine" : "/friends"}
              className="hover:text-fg transition-colors"
            >
              {isOwner ? "Mine" : "Shared with me"}
            </Link>
            <ChevronRight className="w-3.5 h-3.5 text-line-strong" aria-hidden />
            <span>{portfolio.name}</span>
          </div>
          {/* Title row */}
          <div className="flex items-start justify-between gap-5 mb-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-[26px] font-semibold tracking-tight text-fg leading-tight">
                {portfolio.name}
              </h1>
              <div className="flex items-center gap-2.5 mt-2 text-[12.5px] text-fg-mid flex-wrap">
                <span className="text-fg-dim">
                  {isOwner
                    ? "by you"
                    : `by ${ownerName || `user ${portfolio.ownerId.slice(0, 4)}…${portfolio.ownerId.slice(-3)}`}`}
                </span>
                <span className="text-line-strong">·</span>
                <FriendStack
                  people={(portfolio.sharedWith ?? []).map((uid) => ({
                    uid,
                    displayName: followerNames[uid],
                  }))}
                  size={22}
                  max={3}
                  label={
                    (portfolio.sharedWith ?? []).length > 0
                      ? `${portfolio.sharedWith.length} friend${portfolio.sharedWith.length !== 1 ? "s" : ""} following`
                      : null
                  }
                  emptyLabel="Not shared yet"
                />
              </div>
            </div>
            {isOwner && (
              <div className="flex gap-2 shrink-0 relative">
                <button
                  onClick={() => setShowShare(true)}
                  className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-3.5 py-2 rounded-btn hover:bg-[#4a7ddc] transition"
                >
                  <ArrowUpRight className="w-4 h-4" aria-hidden /> Share
                </button>
                <button
                  onClick={() => setShowImport(true)}
                  className="inline-flex items-center gap-1.5 bg-transparent text-fg-dim border border-line-strong rounded-btn px-3 py-2 text-sm font-medium hover:border-accent hover:text-accent transition"
                  title="Open import / sync"
                >
                  <RefreshCw className="w-4 h-4" aria-hidden /> Sync
                </button>
                <button
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-1.5 bg-transparent text-fg-dim border border-line-strong rounded-btn px-3 py-2 text-sm font-medium hover:border-accent hover:text-accent transition"
                >
                  <Plus className="w-4 h-4" aria-hidden /> Add holding
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Hero strip */}
        <div
          className="flex items-baseline gap-[18px] flex-wrap py-5 border-b border-line mb-[18px] animate-fade-up"
          style={{ animationDelay: "60ms" }}
        >
          {isOwner ? (
            <>
              <span className="text-[40px] font-semibold leading-none tracking-tight tabular-nums text-fg">
                {totals.market > 0 ? `$${formatBig(totals.market)}` : "—"}
              </span>
              <PerformancePill pct={totals.gainPct} benchmark="vs cost" />
              <div className="ml-auto flex gap-[14px] text-[13px] text-fg-mid tabular-nums flex-wrap">
                <span>
                  <span className="text-fg-fade text-xs uppercase tracking-[0.06em] font-medium mr-1">P/L</span>
                  {totals.market > 0 ? (
                    <span className={totals.gain >= 0 ? "text-pos font-semibold" : "text-neg font-semibold"}>
                      {totals.gain >= 0 ? "+" : "−"}${formatBig(Math.abs(totals.gain))} ({totals.gainPct.toFixed(1)}%)
                    </span>
                  ) : (
                    <span className="text-fg-fade">—</span>
                  )}
                </span>
                <span>
                  <span className="text-fg-fade text-xs uppercase tracking-[0.06em] font-medium mr-1">Positions</span>
                  {positions.length}
                </span>
              </div>
            </>
          ) : (
            <>
              {/* Viewer hero: % gain vs cost as the headline; no $ amounts */}
              <PerformancePill
                pct={totals.gainPct}
                benchmark="vs cost"
                className="text-base px-3.5 py-1.5"
              />
              {/* vs SPY derived from normalizedSeries last point — all % relative, no $ */}
              {normalizedSeries.length > 0 && (() => {
                const last = normalizedSeries[normalizedSeries.length - 1];
                const portPct = last.portfolio;
                const spyPct = typeof last.SPY === "number" ? last.SPY : null;
                if (spyPct !== null) {
                  return (
                    <PerformancePill
                      pct={portPct - spyPct}
                      benchmark="vs SPY"
                    />
                  );
                }
                return null;
              })()}
              <div className="ml-auto flex gap-[14px] text-[13px] text-fg-mid tabular-nums flex-wrap">
                <span>
                  <span className="text-fg-fade text-xs uppercase tracking-[0.06em] font-medium mr-1">Positions</span>
                  {positions.length}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Benchmark */}
        {holdings.length > 0 && (
          <section
            className="animate-fade-up"
            style={{ animationDelay: "120ms" }}
          >
            <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  Portfolio Benchmark
                </h2>
                <p className="text-sm text-fg-dim mt-1">
                  {isOwner
                    ? "If the same amounts had been invested in SPY or QQQ on the same dates."
                    : "% return since first investment, vs hypothetical SPY / QQQ."}
                </p>
              </div>
            </div>

            {benchGain && isOwner && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                <SmallStat
                  label="Portfolio"
                  value={fmtMoney(benchGain.portfolio)}
                />
                {BENCHMARKS.map((b) => {
                  const v = benchGain.values[b] ?? 0;
                  const diff = benchGain.portfolio - v;
                  const diffPct = v > 0 ? (diff / v) * 100 : 0;
                  return (
                    <SmallStat
                      key={b}
                      label={`Hypothetical ${b}`}
                      value={fmtMoney(v)}
                      sub={`vs portfolio ${fmtPct(diffPct)}`}
                      tone={diff >= 0 ? "pos" : "neg"}
                    />
                  );
                })}
              </div>
            )}

            <div className="card p-4 sm:p-5">
              <div className="h-[340px]">
                {chartLoading && series.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-fg-dim">
                    Loading history…
                  </div>
                ) : series.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-fg-dim">
                    Not enough data.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={340}>
                    <AreaChart
                      data={isOwner ? series : normalizedSeries}
                      margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="port" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor={chartColors.portfolio}
                            stopOpacity={0.25}
                          />
                          <stop
                            offset="100%"
                            stopColor={chartColors.portfolio}
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke={chartColors.grid}
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        stroke={chartColors.axis}
                        fontSize={11}
                        tickLine={false}
                        axisLine={{ stroke: chartColors.grid }}
                        minTickGap={50}
                        tickFormatter={seriesTickFormatter}
                      />
                      <YAxis
                        stroke={chartColors.axis}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) =>
                          isOwner
                            ? v >= 1000
                              ? `$${(v / 1000).toFixed(0)}k`
                              : `$${v.toFixed(0)}`
                            : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`
                        }
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: chartColors.tooltipBg,
                          borderColor: chartColors.tooltipBorder,
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        labelStyle={{
                          color: chartColors.tooltipLabel,
                          fontSize: 11,
                        }}
                        itemStyle={{ color: chartColors.tooltipText }}
                        formatter={(v) =>
                          typeof v === "number"
                            ? isOwner
                              ? fmtMoney(v)
                              : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
                            : String(v)
                        }
                      />
                      <Legend
                        wrapperStyle={{
                          fontSize: 12,
                          color: chartColors.axis,
                        }}
                      />
                      <Area
                        name="Portfolio"
                        type="monotone"
                        dataKey="portfolio"
                        stroke={chartColors.portfolio}
                        strokeWidth={2}
                        fill="url(#port)"
                      />
                      <Area
                        name="Hypothetical SPY"
                        type="monotone"
                        dataKey="SPY"
                        stroke={chartColors.benchmark}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        fill="transparent"
                      />
                      <Area
                        name="Hypothetical QQQ"
                        type="monotone"
                        dataKey="QQQ"
                        stroke={chartColors.benchmark2}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        fill="transparent"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Positions / Logbook */}
        <section className="animate-fade-up" style={{ animationDelay: "200ms" }}>
          <TabBar
            items={[
              { id: "positions", label: "Positions", count: positionsCount },
              { id: "logbook", label: "Logbook", count: logbookCount },
              { id: "allocation", label: "Allocation" },
            ]}
            active={tab}
            onSelect={(id) => setTab(id as "positions" | "logbook" | "allocation")}
            className="mb-4"
          />

          {tab === "allocation" ? (
            <div className="bg-bg-2 border border-line rounded-card p-4 md:p-5">
              <AllocationTreemap
                positions={positions}
                quotes={quotes}
                totalMarket={positionsTotalMarket}
                isOwner={isOwner}
                portfolioId={id}
              />
            </div>
          ) : tab === "logbook" ? (
            tradeLog.length === 0 ? (
              <div className="card p-10 text-center text-fg-dim text-sm">
                No trades yet.
              </div>
            ) : isOwner ? (
              <div className="card overflow-hidden">
                <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-2 border-b border-line">
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Date</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Side</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Shares</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Price</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Value</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Realized</span>
                </div>
                {tradeLog.map((t) => {
                  const isSell = t.side === "SELL";
                  return (
                    <div
                      key={t.id}
                      className="grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-3 border-b border-[#20242c] last:border-b-0"
                    >
                      <div className="flex items-center gap-2 md:contents">
                        <span className="num text-xs text-fg-dim tabular-nums md:text-sm">
                          {t.date}
                        </span>
                        <SidePill side={t.side} />
                        <button
                          onClick={() =>
                            router.push(`/p/${id}/${t.symbol}`)
                          }
                          className="text-fg font-semibold text-sm tracking-tight hover:text-accent transition text-left"
                        >
                          {t.symbol}
                        </button>
                      </div>
                      <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
                        {fmtShares(t.shares)}
                      </span>
                      <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
                        {fmtMoney(t.price)}
                      </span>
                      <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
                        {fmtMoney(t.value)}
                        {isSell && (
                          <span className="text-fg-fade ml-1">proceeds</span>
                        )}
                      </span>
                      <div className="flex items-center justify-end">
                        {t.realizedGain === undefined ? (
                          <span className="num text-xs text-fg-fade tabular-nums">—</span>
                        ) : (
                          <TwoLinePLCell
                            amount={t.realizedGain}
                            pct={(t.realizedPct ?? 0) * 100}
                            currency="USD"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-2 border-b border-line">
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Date</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Side</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Weight</span>
                  <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Realized</span>
                </div>
                {tradeLog.map((t) => (
                  <div
                    key={t.id}
                    className="grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-3 items-center border-b border-[#20242c] last:border-b-0"
                  >
                    <div className="flex items-center gap-2 md:contents">
                      <span className="num text-xs text-fg-dim tabular-nums md:text-sm">
                        {t.date}
                      </span>
                      <SidePill side={t.side} />
                      <button
                        onClick={() =>
                          router.push(`/p/${id}/${t.symbol}`)
                        }
                        className="text-fg font-semibold text-sm tracking-tight hover:text-accent transition text-left"
                      >
                        {t.symbol}
                      </button>
                    </div>
                    <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
                      {(t.symbolWeightAfter * 100).toFixed(1)}%
                    </span>
                    <div className="flex items-center justify-end">
                      {t.realizedPct === undefined ? (
                        <span className="num text-xs text-fg-fade tabular-nums">—</span>
                      ) : (
                        <span className={`num text-xs tabular-nums font-semibold ${t.realizedPct >= 0 ? "text-pos" : "text-neg"}`}>
                          {t.realizedPct >= 0 ? "+" : ""}{(t.realizedPct * 100).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : positions.length === 0 ? (
            <div className="card p-10 text-center text-fg-dim text-sm">
              No holdings yet.
            </div>
          ) : (
            <>
              {!isOwner ? (
                <div className="card overflow-hidden">
                  <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-3 py-2 border-b border-line">
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Allocation</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Gain</span>
                    <span />
                  </div>
                  {nonOwnerRows.map((row) => {
                    const tone =
                      row.gainPct === null
                        ? ""
                        : row.gainPct >= 0
                        ? "text-pos"
                        : "text-neg";
                    return (
                      <button
                        key={row.symbol}
                        onClick={() =>
                          router.push(`/p/${id}/${row.symbol}`)
                        }
                        className={`w-full text-left grid grid-cols-[1fr_auto_auto] md:grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-4 hover:bg-[rgba(91,141,239,0.04)] transition group border-b border-[#20242c] last:border-b-0`}
                      >
                        <span className="text-fg font-semibold tracking-tight">
                          {row.symbol}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums">
                          {row.allocationPct !== null
                            ? `${row.allocationPct.toFixed(1)}%`
                            : "…"}
                        </span>
                        <span className={`num text-sm text-right tabular-nums ${tone}`}>
                          {row.gainPct === null ? "…" : fmtPct(row.gainPct)}
                        </span>
                        <span className="flex items-center justify-end text-fg-fade group-hover:text-accent transition">
                          <ChevronRight className="w-3.5 h-3.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="card overflow-hidden">
                  {/* Desktop table */}
                  <div className="hidden md:grid grid-cols-[1fr_0.7fr_0.8fr_0.8fr_0.9fr_1fr_0.9fr_1.3fr_0.5fr] gap-4 px-5 py-2 border-b border-line">
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Shares</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Avg cost</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Current</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Cost</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Market</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Allocation</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Gain</span>
                    <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Lots</span>
                  </div>
                  {positions.map((p) => {
                    const q = quotes[p.symbol];
                    const market = q ? p.shares * q.c : null;
                    const gain = market !== null ? market - p.cost : null;
                    const gainPct =
                      gain !== null && p.cost > 0 ? (gain / p.cost) * 100 : null;
                    const allocationPct =
                      market !== null && positionsTotalMarket > 0
                        ? (market / positionsTotalMarket) * 100
                        : null;
                    return (
                      <button
                        key={p.symbol}
                        onClick={() =>
                          router.push(`/p/${id}/${p.symbol}`)
                        }
                        className="w-full text-left px-5 py-3.5 hover:bg-[rgba(91,141,239,0.04)] transition group md:grid md:grid-cols-[1fr_0.7fr_0.8fr_0.8fr_0.9fr_1fr_0.9fr_1.3fr_0.5fr] md:gap-4 border-b border-[#20242c] last:border-b-0"
                      >
                        {/* Mobile row */}
                        <div className="md:hidden flex items-center justify-between gap-4">
                          <div className="flex flex-col leading-tight min-w-0">
                            <span className="text-fg font-semibold tracking-tight truncate">
                              {p.symbol}
                            </span>
                            <span className="num text-[10px] text-fg-fade mt-0.5">
                              {fmtShares(p.shares)} · {fmtMoney(p.avgPrice)}
                            </span>
                          </div>
                          <div className="flex flex-col items-end leading-tight shrink-0">
                            <span className="num text-fg font-semibold tabular-nums">
                              {market !== null ? fmtMoney(market) : "…"}
                            </span>
                            {gain !== null && gainPct !== null ? (
                              <TwoLinePLCell amount={gain} pct={gainPct} currency="USD" className="mt-0.5" />
                            ) : (
                              <span className="num text-[10px] text-fg-fade tabular-nums">…</span>
                            )}
                          </div>
                        </div>
                        {/* Desktop cells */}
                        <div className="hidden md:flex items-center">
                          <span className="text-fg font-semibold tracking-tight">
                            {p.symbol}
                          </span>
                        </div>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block truncate">
                          {fmtShares(p.shares)}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block">
                          {fmtMoney(p.avgPrice)}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block">
                          {q ? fmtMoney(q.c) : "…"}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block">
                          {fmtMoney(p.cost)}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block">
                          {market !== null ? fmtMoney(market) : "…"}
                        </span>
                        <span className="num text-sm text-right text-fg-dim tabular-nums hidden md:block">
                          {allocationPct !== null ? (
                            <>
                              <span className="inline-block w-[80px] h-1 bg-[#242932] rounded overflow-hidden align-middle mr-1.5">
                                <span
                                  style={{ width: `${allocationPct}%` }}
                                  className="block h-full bg-accent"
                                />
                              </span>
                              {allocationPct.toFixed(1)}%
                            </>
                          ) : "…"}
                        </span>
                        <div className="hidden md:flex items-center justify-end">
                          {gain !== null && gainPct !== null ? (
                            <TwoLinePLCell amount={gain} pct={gainPct} currency="USD" />
                          ) : (
                            <span className="num text-sm text-fg-dim">…</span>
                          )}
                        </div>
                        <span className="hidden md:flex items-center justify-end gap-1 text-fg-fade group-hover:text-accent transition">
                          <span className="num text-xs">{p.lots.length}</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Encrypted sync diagnostics — readable in-app by the owner
              and by shared viewers (Firestore rule relaxed to
              owner-or-sharedWith). Lets a collaborator debug a sync
              without any download or server logs. */}
          <SyncHistory
            portfolioId={id}
            portfolioKey={portfolioKey}
            isOwner={isOwner}
          />
        </section>
      </main>

      {showImport && isOwner && portfolio && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm p-4">
          <div className="card w-full max-w-md p-6 animate-fade-up">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-lg font-semibold">Import / Sync</h3>
              <button
                onClick={() => { setShowImport(false); setSyncError(""); setSyncResults({}); }}
                className="text-fg-fade hover:text-fg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Connected Broker — singular: one portfolio, one broker. */}
            {hasCredential && lockedBroker && (
              <div className="mb-5">
                <div className="label mb-3">Connected Broker</div>
                <ul className="space-y-2">
                  {(() => {
                    const result = syncResults[lockedBroker];
                    const isLoading = syncLoading === lockedBroker;
                    return (
                      <li key={lockedBroker} className="flex items-center gap-2 bg-bg-3 border border-line rounded-lg px-3 py-2.5">
                        <span className="text-sm font-medium flex-1">
                          {BROKERS[lockedBroker].displayName}
                        </span>
                        {result && (
                          <span className="text-xs text-fg-fade">
                            {result.buys === 0
                              && result.sells === 0
                              && result.skipped === 0
                              && result.partialFillsSkipped === 0 ? (
                              // All counters zero → either nothing
                              // changed since last sync (adapter-level
                              // dedup filtered everything before the
                              // page even saw it), or the broker
                              // returned no orders at all. Either way
                              // the literal "0 buys · 0 sells · 0
                              // already existed" line is misleading;
                              // a single "Already up to date" reads
                              // correctly for both cases.
                              <>Already up to date</>
                            ) : (
                              <>
                                {result.buys} buys · {result.sells} sells · {result.skipped} already existed
                                {result.partialFillsSkipped > 0 && (
                                  <> · {result.partialFillsSkipped} partial fills skipped</>
                                )}
                              </>
                            )}
                          </span>
                        )}
                        <button
                          onClick={() => handleSync(lockedBroker)}
                          disabled={!!syncLoading}
                          className="text-xs btn-ghost px-2.5 py-1 disabled:opacity-40"
                        >
                          {isLoading ? "Syncing…" : "Sync"}
                        </button>
                        <button
                          onClick={() => handleDisconnect()}
                          disabled={!!syncLoading}
                          className="text-fg-fade hover:text-neg transition disabled:opacity-40"
                          title="Disconnect"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </li>
                    );
                  })()}
                </ul>
              </div>
            )}

            {/* Orphan-credential safety: should never happen with the
                atomic-rollback in handleSync, but if it does (e.g. tab
                closed mid-first-sync), let the user disconnect and
                start over rather than be stuck.
                Suppressed while a sync is in flight (`syncLoading`)
                or has just failed (`syncError`) — both states are
                transient orphan windows that the rollback resolves
                within ~hundreds of ms; flashing this red panel during
                them confuses the user about what just happened.
                After the user dismisses syncError (by closing the
                modal), this becomes visible for any genuinely orphaned
                state. */}
            {hasCredential && !lockedBroker && !syncLoading && !syncError && (
              <div className="mb-5 border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-3 flex items-center gap-2">
                <span className="flex-1">
                  A credential is connected but no holdings have been
                  imported yet. Disconnect and try again.
                </span>
                <button
                  onClick={() => handleDisconnect()}
                  className="btn-ghost px-2 py-1 text-xs"
                >
                  Disconnect
                </button>
              </div>
            )}

            {/* Forward-compat safety: portfolio has holdings tagged
                with a broker this build doesn't know. Refuse to show
                the connect form rather than risk accidentally mixing
                brokers via a fall-through to the all-brokers picker. */}
            {!hasCredential && hasUnknownImportSource && !lockedBroker && (
              <div className="border border-line bg-bg-3 text-xs text-fg-dim rounded-md p-3">
                This portfolio was synced with a broker this version of
                the app doesn&apos;t recognize. Update the app to
                reconnect.
              </div>
            )}

            {/* Connect a broker — visible whenever no credential is
                stored AND we recognize the broker (or there's no
                broker yet). Picker is filtered to `lockedBroker` if
                the portfolio is locked from prior holdings.
                SnapTrade has its own multi-step flow (disclosure →
                4-field form → account picker) handled by the
                `SnapTradeConnectFlow` component below; the standard
                form path renders for T212/Alpaca. */}
            {!hasCredential && (lockedBroker || !hasUnknownImportSource) && (() => {
              const activeProvider: BrokerId = lockedBroker ?? connectProvider;
              const adapter = BROKERS[activeProvider];
              return (
                <div>
                  <div className="label mb-3">Connect a broker</div>
                  <Field label="Broker">
                    {lockedBroker ? (
                      // When the portfolio is locked, render the broker
                      // name as a static label rather than a single-
                      // option disabled <select> — clearer affordance
                      // ("locked" vs "broken control").
                      <div className="field flex items-center gap-2 text-sm">
                        <span>{BROKERS[lockedBroker].displayName}</span>
                        <span className="text-xs text-fg-fade">(locked)</span>
                      </div>
                    ) : (
                      <select
                        value={activeProvider}
                        onChange={(e) => {
                          const v = e.target.value;
                          // Type guard: only accept values that are
                          // genuinely known broker ids.
                          if (v in BROKERS) setConnectProvider(v as BrokerId);
                        }}
                        className="field"
                      >
                        {SUPPORTED_BROKERS.map((b) => (
                          <option key={b} value={b}>{BROKERS[b].displayName}</option>
                        ))}
                      </select>
                    )}
                  </Field>

                  {/* SnapTrade: multi-step BYO flow */}
                  {activeProvider === "snaptrade" ? (
                    <div className="mt-3">
                      <SnapTradeConnectFlow
                        syncLoading={syncLoading === "snaptrade"}
                        lockedSnaptradeAccountId={lockedSnaptradeAccountId}
                        onCancel={() => {
                          // For locked portfolios, close the modal
                          // (no other broker is selectable anyway).
                          // For unlocked, just close the modal too —
                          // re-opening leaves the dropdown on the
                          // user's last pick (SnapTrade) so they can
                          // continue or change their mind, rather
                          // than yanking the dropdown to a different
                          // broker behind their back.
                          setShowImport(false);
                          setSyncError("");
                        }}
                        onSubmit={async (credential) => {
                          await handleSync("snaptrade", credential);
                        }}
                      />
                    </div>
                  ) : (
                    /* Standard credential form (T212, Alpaca) */
                    (() => {
                      const allFieldsFilled = adapter.credentialFields.every(
                        (f) => (connectFields[f.id] ?? "").trim().length > 0,
                      );
                      return (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!allFieldsFilled) return;
                            const credential =
                              adapter.buildCredential(connectFields);
                            handleSync(activeProvider, credential);
                          }}
                          className="space-y-3 mt-3"
                        >
                          {adapter.credentialFields.map((f) => (
                            <Field key={f.id} label={f.label}>
                              <input
                                value={connectFields[f.id] ?? ""}
                                onChange={(e) =>
                                  setConnectFields((prev) => ({
                                    ...prev,
                                    [f.id]: e.target.value,
                                  }))
                                }
                                placeholder={f.placeholder}
                                className="field font-mono text-xs"
                                required
                              />
                            </Field>
                          ))}
                          <p className="text-xs text-fg-fade">
                            {adapter.credentialHint}
                          </p>
                          <button
                            type="submit"
                            disabled={!!syncLoading || !allFieldsFilled}
                            className="btn-primary w-full disabled:opacity-50"
                          >
                            {syncLoading === activeProvider
                              ? "Connecting…"
                              : "Connect & Sync"}
                          </button>
                        </form>
                      );
                    })()
                  )}
                </div>
              );
            })()}

            {syncError && (
              <div className="mt-4 border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
                {syncError}
              </div>
            )}
          </div>
        </div>
      )}

      {showShare && isOwner && portfolio && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm p-4">
          <div className="card w-full max-w-md p-6 animate-fade-up">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-lg font-semibold">Share &ldquo;{portfolio.name}&rdquo;</h3>
              <button
                onClick={() => setShowShare(false)}
                className="text-fg-fade hover:text-fg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <SharePanel
              portfolioId={id}
              ownerUid={portfolio.ownerId}
              sharedWith={portfolio.sharedWith}
              onClose={() => setShowShare(false)}
              encryption={
                portfolio.encrypted &&
                portfolioKey &&
                user &&
                getUnlocked(user.uid)
                  ? {
                      portfolioKey,
                      ownerPrivateKey: getUnlocked(user.uid)!.privateKey,
                      ownerPublicKey: getUnlocked(user.uid)!.publicKey,
                      ownerPublicKeyHex: getUnlocked(user.uid)!.publicKeyHex,
                    }
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {showAdd && isOwner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm p-4">
          <div className="card w-full max-w-md p-6 animate-fade-up">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-lg font-semibold">Add holding</h3>
              <button
                onClick={() => setShowAdd(false)}
                className="text-fg-fade hover:text-fg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="inline-flex items-center gap-px rounded-full border border-line p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, side: "BUY" })}
                  className={`px-3 py-1 rounded-full transition ${
                    form.side === "BUY"
                      ? "bg-pos/20 text-pos"
                      : "text-fg-fade hover:text-fg"
                  }`}
                  aria-pressed={form.side === "BUY"}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, side: "SELL" })}
                  className={`px-3 py-1 rounded-full transition ${
                    form.side === "SELL"
                      ? "bg-neg/20 text-neg"
                      : "text-fg-fade hover:text-fg"
                  }`}
                  aria-pressed={form.side === "SELL"}
                >
                  Sell
                </button>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label="Ticker">
                  <input
                    autoFocus
                    value={form.symbol}
                    onChange={(e) =>
                      setForm({ ...form, symbol: e.target.value.toUpperCase() })
                    }
                    placeholder="AAPL"
                    className="field uppercase"
                    required
                  />
                </Field>
                <Field label="Exchange">
                  <select
                    value={form.exchange}
                    onChange={(e) => setForm({ ...form, exchange: e.target.value })}
                    className="field"
                  >
                    <option value="">US</option>
                    <option value=".L">London (.L)</option>
                    <option value=".DE">Xetra (.DE)</option>
                    <option value=".PA">Paris (.PA)</option>
                    <option value=".AS">Amsterdam (.AS)</option>
                    <option value=".SW">Swiss (.SW)</option>
                    <option value=".MI">Milan (.MI)</option>
                    <option value=".MC">Madrid (.MC)</option>
                    <option value=".ST">Stockholm (.ST)</option>
                    <option value=".CO">Copenhagen (.CO)</option>
                    <option value=".OL">Oslo (.OL)</option>
                    <option value=".HE">Helsinki (.HE)</option>
                    <option value=".WA">Warsaw (.WA)</option>
                    <option value=".IR">Dublin (.IR)</option>
                    <option value=".TO">Toronto (.TO)</option>
                    <option value=".HK">Hong Kong (.HK)</option>
                    <option value=".T">Tokyo (.T)</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Shares">
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={form.shares}
                    onChange={(e) =>
                      setForm({ ...form, shares: e.target.value })
                    }
                    placeholder="10"
                    className="field"
                    required
                  />
                </Field>
                <Field label="Price / share">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.purchasePrice}
                    onChange={(e) =>
                      setForm({ ...form, purchasePrice: e.target.value })
                    }
                    placeholder="175.50"
                    className="field"
                    required
                  />
                </Field>
              </div>
              <Field label="Purchase date">
                <input
                  type="date"
                  value={form.purchaseDate}
                  onChange={(e) =>
                    setForm({ ...form, purchaseDate: e.target.value })
                  }
                  className="field"
                  required
                />
              </Field>
              <button type="submit" className="btn-primary w-full mt-1">
                Save holding
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SmallStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
}) {
  const color =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className="card p-4">
      <div className="label mb-2">{label}</div>
      <div className={`num text-lg font-medium ${color}`}>{value}</div>
      {sub && <div className={`num text-xs mt-0.5 ${color}`}>{sub}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function formatBig(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function SidePill({ side }: { side: "BUY" | "SELL" }) {
  const isSell = side === "SELL";
  return isSell ? (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-tag bg-neg-soft text-neg">
      SELL
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-tag bg-pos-soft text-pos">
      BUY
    </span>
  );
}
