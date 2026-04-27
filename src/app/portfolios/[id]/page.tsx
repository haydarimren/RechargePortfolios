"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
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
import { ThemeToggle, useChartColors } from "@/lib/theme";
import { useDisplayName } from "@/lib/users";
import { SharePanel } from "@/components/SharePanel";
import { UnlockModal } from "@/components/UnlockModal";
import { AllocationTreemap } from "@/components/AllocationTreemap";
import { fetchTrading212OrdersClient } from "@/lib/trading212-client";
import { cleanT212Symbol } from "@/lib/trading212-utils";
import {
  decryptT212Secret,
  encryptT212Secret,
} from "@/lib/crypto-client";
import { useEncryption } from "@/lib/use-encryption";
import { getUnlocked } from "@/lib/key-store";
import {
  addHolding,
  loadPortfolioKey,
  migratePortfolioToEncrypted,
  reconcileSharedWrappedKeys,
  subscribeHoldings,
  updateHoldingFields,
} from "@/lib/holdings-repo";
import { encryptHolding } from "@/lib/crypto-client";
import {
  PortfolioView,
  subscribeToPortfolioViews,
  touchLogbookView,
  touchPortfolioView,
} from "@/lib/views";
import { ArrowLeft, Download, Plus, ChevronRight, X, Trash2, UserPlus } from "lucide-react";
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

const BROKER_LABELS: Record<string, string> = { trading212: "Trading212" };
const SUPPORTED_BROKERS = ["trading212"] as const;

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
  const [connectProvider, setConnectProvider] = useState<string>(SUPPORTED_BROKERS[0]);
  const [connectKey, setConnectKey] = useState("");
  const [connectSecret, setConnectSecret] = useState("");
  const [syncResults, setSyncResults] = useState<Record<string, { buys: number; sells: number; skipped: number }>>({});
  const [syncLoading, setSyncLoading] = useState<string | null>(null);
  const [syncError, setSyncError] = useState("");

  const encryption = useEncryption();
  // Unwrapped K_portfolio for the active portfolio. Set once per portfolio
  // load (or after a migration). null means the holdings subscription falls
  // back to the legacy plaintext shape.
  const [portfolioKey, setPortfolioKey] = useState<CryptoKey | null>(null);
  const [migrationError, setMigrationError] = useState("");

  // Which brokers are currently connected on this portfolio. Derived from
  // the existence of `secrets/credentials` (= some broker connected); we
  // can't tell *which* broker without decrypting, but with single-broker
  // support today we default to the only one we know about. Replaces the
  // deprecated plaintext `connectedBrokers` array on the portfolio doc.
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

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

  // Watch the credentials doc to populate `connectedProviders`. The doc's
  // existence signals "a broker is connected"; with single-broker support
  // today we map that to the only broker we know about. Multi-broker
  // future moves provider discrimination INTO the encrypted payload,
  // requiring a decrypt here.
  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "portfolios", id, "secrets", "credentials"),
      (snap) => {
        setConnectedProviders(snap.exists() ? ["trading212"] : []);
      },
      () => setConnectedProviders([]),
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
          const k = await loadPortfolioKey(id, user.uid, unlocked.privateKey);
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
          console.warn("loadPortfolioKey failed", err);
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
  const ownerName = useDisplayName(portfolio?.ownerId ?? null);
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
  const [myView, setMyView] = useState<PortfolioView | null>(null);

  // Subscribe to this viewer's own `portfolioViews` record for this
  // portfolio. Only used for the Logbook unread dot — shared viewers only.
  useEffect(() => {
    if (!user || isOwner) return;
    const unsub = subscribeToPortfolioViews(user.uid, (map) => {
      setMyView(map.get(id) ?? null);
    });
    return unsub;
  }, [user, isOwner, id]);

  // Bump `lastPortfolioViewAt` once per page load for shared viewers. This
  // is what clears the home-page "N new" badge. Gated so owners never write.
  useEffect(() => {
    if (!user || isOwner || !portfolio) return;
    touchPortfolioView(user.uid, id);
  }, [user, isOwner, portfolio, id]);

  const hasUnreadTrades = useMemo(() => {
    if (isOwner || !myView) return false;
    for (const h of holdings) {
      if ((h.createdAt ?? 0) > myView.lastLogbookViewAt) return true;
    }
    return false;
  }, [isOwner, myView, holdings]);

  const [tab, setTabState] = useState<"positions" | "logbook">("positions");
  const setTab = (next: "positions" | "logbook") => {
    setTabState(next);
    if (next === "logbook" && user && !isOwner) {
      touchLogbookView(user.uid, id);
    }
  };

  const [posView, setPosView] = useState<"table" | "map">("table");

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
    let totalMarket = 0;
    const rows = positions.map((p) => {
      const q = quotes[p.symbol];
      const market = q ? p.shares * q.c : null;
      if (market !== null) totalMarket += market;
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

  const handleSync = async (provider: string, keyOverride?: string) => {
    if (!portfolio || !user) return;
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
          plaintextKey = await decryptT212Secret(
            { payload: data.payload, iv: data.iv },
            unlocked.masterSecret,
          );
        } catch {
          setSyncError("Stored credentials are corrupt — reconnect.");
          return;
        }
      } else {
        setSyncError("No credentials — reconnect.");
        return;
      }
    }

    setSyncLoading(provider);
    setSyncError("");
    const errors: string[] = [];
    let buys = 0;
    let sells = 0;
    let skipped = 0;
    try {
      if (needsWriteBack) {
        // Client-side encrypt under master secret. Server holds ciphertext
        // it can't decrypt at rest. The provider field is informational
        // only — we know which broker this portfolio talks to once we've
        // decrypted; before that the server sees only "credentials".
        const env = await encryptT212Secret(plaintextKey, unlocked.masterSecret);
        // No `provider` field on the doc itself — that would leak the
        // broker name. With single-broker support today, the UI infers
        // "this is a T212 connection" from the doc's existence. Adding
        // a second broker in the future means moving provider
        // discrimination INTO the encrypted payload (e.g. encrypting a
        // `{ provider, apiKey }` object instead of just the API key).
        await setDoc(secretRef, {
          payload: env.payload,
          iv: env.iv,
          updatedAt: Date.now(),
        });
        // Note: previously this call also wrote `connectedBrokers:
        // arrayUnion(provider)` on the portfolio doc. That field has
        // been deprecated — UI now infers connection state from the
        // existence of `secrets/credentials`. Eager migration cleans up
        // any leftover values.
      }
      let result: Awaited<ReturnType<typeof fetchTrading212OrdersClient>>;
      if (provider === "trading212") {
        // All HTTP calls to the broker go through the dumb relay at
        // /api/broker-proxy. Server sees the auth header for the
        // duration of one request and never persists it.
        //
        // The `isOrderKnown` callback lets the client stop paginating
        // as soon as a full page of orders is already imported — T212
        // returns orders newest-first, so once we hit a fully-known
        // page everything older is also already imported. Repeat
        // syncs of an active account drop from N pages to 1-2,
        // critical for staying under T212's per-minute rate limit on
        // history/orders.
        //
        // We match BOTH on `t212OrderId` (preferred — exact identity)
        // AND on shape (symbol + purchaseDate + shares — the
        // fallback used by the post-fetch dedup loop below). The
        // shape match catches holdings that were imported before
        // we tracked t212OrderId; without it, the optimization
        // would be nearly useless on legacy portfolios.
        const isOrderKnown = (args: {
          orderId: string;
          rawTicker: string;
          purchaseDate: string;
          shares: number;
        }) => {
          for (const h of holdings) {
            if (h.t212OrderId === args.orderId) return true;
          }
          const cleaned = cleanT212Symbol(args.rawTicker);
          for (const h of holdings) {
            if (h.t212OrderId) continue; // covered by id check above
            if (h.symbol !== cleaned) continue;
            if (h.purchaseDate !== args.purchaseDate) continue;
            if (Math.abs(h.shares - args.shares) > 0.0001) continue;
            return true;
          }
          return false;
        };
        result = await fetchTrading212OrdersClient(
          plaintextKey,
          isOrderKnown,
        );
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      // Use the already-decoded `holdings` state from the live
      // subscription. handleSync is recreated on every render, so the
      // closure captures the latest holdings — no stale-snapshot race.
      // Crucial that this is the DECODED shape: for v2 docs, the
      // dedup-by-t212OrderId check below would always fail against the
      // raw `getDocs` shape (t212OrderId lives inside the encrypted
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
            h.importSource === "trading212" &&
            h.t212OrderId === order.id
        );
        const byShape = existing
          ? undefined
          : decodedCurrent.find(
              (h) =>
                !h.t212OrderId &&
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
          // Also backfill t212OrderId on holdings that were matched by
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
          if (!target.t212OrderId) patch.t212OrderId = order.id;
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
          t212OrderId: order.id,
          side: order.side,
        };
        if (order.currency) plaintextShape.currency = order.currency;
        if (order.isin) plaintextShape.isin = order.isin;
        if (order.yahooSymbol) plaintextShape.yahooSymbol = order.yahooSymbol;

        if (portfolioKey) {
          // v2 shape: importSource and t212OrderId go INSIDE the
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
              t212OrderId: order.id,
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
        [provider]: { buys, sells, skipped },
      }));
      setConnectKey("");
      setConnectSecret("");
      setShowImport(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      errors.push(msg);
      setSyncError(msg);
    } finally {
      setSyncLoading(null);
      try {
        // syncLog used to record `provider: "trading212"`; that's gone
        // now — the existence of `secrets/credentials` already implies a
        // broker connection, and we don't need to broadcast which one in
        // the diagnostic log.
        await addDoc(collection(db, "portfolios", id, "syncLogs"), {
          timestamp: Date.now(),
          imported: buys + sells,
          buys,
          sells,
          skipped,
          errors,
        });
      } catch {
        // best-effort audit log
      }
    }
  };

  const handleDisconnect = async (provider: string) => {
    // Generic credentials doc; the provider name is/was stamped in the
    // encrypted payload, not the path. No portfolio-doc field to update
    // — connectedBrokers is deprecated and connection state is now
    // implicit in the existence of `secrets/credentials`.
    await deleteDoc(doc(db, "portfolios", id, "secrets", "credentials"));
    void provider; // signature kept for the existing call sites; unused now
    setSyncResults((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
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
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Back
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
      <header className="px-6 lg:px-10 pt-6 pb-4 border-b border-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <Link
            href="/"
            className="text-sm text-fg-dim hover:text-accent transition flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-10 space-y-10">
        <section className="animate-fade-up flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="label mb-2">
              {isOwner
                ? "Your portfolio"
                : `by ${ownerName || `user ${portfolio.ownerId.slice(0, 4)}…${portfolio.ownerId.slice(-3)}`}`}
            </div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight">
              {portfolio.name}
            </h1>
            {totals.firstDate && (
              <p className="text-sm text-fg-dim mt-2">
                First investment{" "}
                {new Date(totals.firstDate).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </p>
            )}
          </div>
          {isOwner && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowShare(true)}
                className="btn-ghost flex items-center gap-2"
              >
                <UserPlus className="w-4 h-4" /> Share
              </button>
              <button
                onClick={() => setShowImport(true)}
                className="btn-ghost flex items-center gap-2"
              >
                <Download className="w-4 h-4" /> Import
              </button>
              <button
                onClick={() => setShowAdd(true)}
                className="btn-primary flex items-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add holding
              </button>
            </div>
          )}
        </section>

        {/* Top stats */}
        {isOwner ? (
          <section
            className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-up"
            style={{ animationDelay: "60ms" }}
          >
            <StatCard label="Cost basis" value={fmtMoney(totals.cost)} />
            <StatCard
              label="Market value"
              value={totals.market > 0 ? fmtMoney(totals.market) : "—"}
              hint={totals.market === 0 ? "Fetching quotes…" : undefined}
            />
            <StatCard
              label="Total gain"
              value={totals.market > 0 ? fmtMoney(totals.gain) : "—"}
              sub={totals.market > 0 ? fmtPct(totals.gainPct) : undefined}
              tone={totals.gain >= 0 ? "pos" : "neg"}
            />
          </section>
        ) : (
          <section
            className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-up"
            style={{ animationDelay: "60ms" }}
          >
            <StatCard
              label="Overall gain"
              value={totals.market > 0 ? fmtPct(totals.gainPct) : "…"}
              tone={
                totals.market === 0
                  ? undefined
                  : totals.gain >= 0
                  ? "pos"
                  : "neg"
              }
            />
            <StatCard label="Holdings" value={String(positions.length)} />
            {BENCHMARKS.map((b) => {
              if (!benchGain || benchGain.portfolio === 0) {
                return <StatCard key={b} label={`vs ${b}`} value="…" />;
              }
              const v = benchGain.values[b] ?? 0;
              const portPct = totals.cost > 0 ? (totals.gain / totals.cost) * 100 : 0;
              const benchPct =
                totals.cost > 0 ? ((v - totals.cost) / totals.cost) * 100 : 0;
              const diff = portPct - benchPct;
              return (
                <StatCard
                  key={b}
                  label={`vs ${b}`}
                  value={fmtPct(diff)}
                  tone={diff >= 0 ? "pos" : "neg"}
                />
              );
            })}
          </section>
        )}

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
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                {tab === "positions" ? "Positions" : "Logbook"}
              </h2>
              <p className="text-sm text-fg-dim mt-1">
                {tab === "positions"
                  ? `Click a ${posView === "map" ? "tile" : "row"} to see lot history and price chart.`
                  : "Every buy and sell, newest first."}
              </p>
            </div>
            <div className="flex gap-1 bg-bg-3 border border-line rounded-full p-1 shrink-0">
              <button
                onClick={() => setTab("positions")}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                  tab === "positions"
                    ? "bg-bg text-fg shadow-sm"
                    : "text-fg-dim hover:text-fg"
                }`}
                aria-pressed={tab === "positions"}
              >
                Positions
              </button>
              <button
                onClick={() => setTab("logbook")}
                className={`relative px-3 py-1.5 rounded-full text-xs font-medium transition ${
                  tab === "logbook"
                    ? "bg-bg text-fg shadow-sm"
                    : "text-fg-dim hover:text-fg"
                }`}
                aria-pressed={tab === "logbook"}
              >
                Logbook
                {hasUnreadTrades && (
                  <span
                    className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-accent"
                    aria-label="unread trades"
                  />
                )}
              </button>
            </div>
          </div>

          {tab === "logbook" ? (
            tradeLog.length === 0 ? (
              <div className="card p-10 text-center text-fg-dim text-sm">
                No trades yet.
              </div>
            ) : isOwner ? (
              <div className="card overflow-hidden">
                <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-3 label border-b border-line">
                  <span>Date</span>
                  <span>Side</span>
                  <span>Symbol</span>
                  <span className="text-right">Shares</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Value</span>
                  <span className="text-right">Realized</span>
                </div>
                {tradeLog.map((t, i) => {
                  const tone =
                    t.realizedGain === undefined
                      ? ""
                      : t.realizedGain >= 0
                      ? "text-pos"
                      : "text-neg";
                  const isSell = t.side === "SELL";
                  return (
                    <div
                      key={t.id}
                      className={`grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-3 ${
                        i !== tradeLog.length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2 md:contents">
                        <span className="num text-xs text-fg-dim md:text-sm">
                          {t.date}
                        </span>
                        <SidePill side={t.side} />
                        <button
                          onClick={() =>
                            router.push(`/portfolios/${id}/${t.symbol}`)
                          }
                          className="font-semibold text-sm tracking-tight hover:text-accent transition text-left"
                        >
                          {t.symbol}
                        </button>
                      </div>
                      <span className="num text-xs text-right text-fg-dim hidden md:block">
                        {fmtShares(t.shares)}
                      </span>
                      <span className="num text-xs text-right text-fg-dim hidden md:block">
                        {fmtMoney(t.price)}
                      </span>
                      <span className="num text-xs text-right text-fg-dim hidden md:block">
                        {fmtMoney(t.value)}
                        {isSell && (
                          <span className="text-fg-fade ml-1">proceeds</span>
                        )}
                      </span>
                      <span
                        className={`num text-xs text-right md:text-sm ${tone}`}
                      >
                        {t.realizedGain === undefined
                          ? "—"
                          : `${t.realizedGain >= 0 ? "+" : ""}${fmtMoney(
                              t.realizedGain
                            )} · ${fmtPct((t.realizedPct ?? 0) * 100)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-3 label border-b border-line">
                  <span>Date</span>
                  <span>Side</span>
                  <span>Symbol</span>
                  <span className="text-right">Weight</span>
                  <span className="text-right">Realized</span>
                </div>
                {tradeLog.map((t, i) => {
                  const tone =
                    t.realizedPct === undefined
                      ? ""
                      : t.realizedPct >= 0
                      ? "text-pos"
                      : "text-neg";
                  return (
                    <div
                      key={t.id}
                      className={`grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-3 items-center ${
                        i !== tradeLog.length - 1 ? "border-b border-line" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2 md:contents">
                        <span className="num text-xs text-fg-dim md:text-sm">
                          {t.date}
                        </span>
                        <SidePill side={t.side} />
                        <button
                          onClick={() =>
                            router.push(`/portfolios/${id}/${t.symbol}`)
                          }
                          className="font-semibold text-sm tracking-tight hover:text-accent transition text-left"
                        >
                          {t.symbol}
                        </button>
                      </div>
                      <span className="num text-xs text-right text-fg-dim hidden md:block">
                        {(t.symbolWeightAfter * 100).toFixed(1)}%
                      </span>
                      <span
                        className={`num text-xs text-right md:text-sm ${tone}`}
                      >
                        {t.realizedPct === undefined
                          ? "—"
                          : `${t.realizedPct >= 0 ? "+" : ""}${fmtPct(
                              t.realizedPct * 100
                            )}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )
          ) : positions.length === 0 ? (
            <div className="card p-10 text-center text-fg-dim text-sm">
              No holdings yet.
            </div>
          ) : (
            <>
              <div className="mb-3 flex justify-end">
                <div className="flex gap-1 bg-bg-3 border border-line rounded-full p-1">
                  <button
                    onClick={() => setPosView("table")}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                      posView === "table"
                        ? "bg-bg text-fg shadow-sm"
                        : "text-fg-dim hover:text-fg"
                    }`}
                    aria-pressed={posView === "table"}
                  >
                    Table
                  </button>
                  <button
                    onClick={() => setPosView("map")}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                      posView === "map"
                        ? "bg-bg text-fg shadow-sm"
                        : "text-fg-dim hover:text-fg"
                    }`}
                    aria-pressed={posView === "map"}
                  >
                    Map
                  </button>
                </div>
              </div>
              {posView === "map" ? (
                <AllocationTreemap
                  positions={positions}
                  quotes={quotes}
                  totalMarket={positionsTotalMarket}
                  isOwner={isOwner}
                  portfolioId={id}
                />
              ) : !isOwner ? (
            <div className="card overflow-hidden">
              <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-3 label border-b border-line">
                <span>Symbol</span>
                <span className="text-right">Allocation</span>
                <span className="text-right">Gain</span>
                <span />
              </div>
              {nonOwnerRows.map((row, i) => {
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
                      router.push(`/portfolios/${id}/${row.symbol}`)
                    }
                    className={`w-full text-left grid grid-cols-[1fr_auto_auto] md:grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-4 hover:bg-bg-3 transition group ${
                      i !== nonOwnerRows.length - 1 ? "border-b border-line" : ""
                    }`}
                  >
                    <span className="font-semibold text-base tracking-tight">
                      {row.symbol}
                    </span>
                    <span className="num text-sm text-right text-fg-dim">
                      {row.allocationPct !== null
                        ? `${row.allocationPct.toFixed(1)}%`
                        : "…"}
                    </span>
                    <span className={`num text-sm text-right ${tone}`}>
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
              <div className="hidden md:grid grid-cols-[1fr_0.7fr_0.8fr_0.8fr_0.9fr_1fr_0.7fr_1.3fr_0.5fr] gap-4 px-5 py-3 label border-b border-line">
                <span>Symbol</span>
                <span className="text-right">Shares</span>
                <span className="text-right">Avg cost</span>
                <span className="text-right">Current</span>
                <span className="text-right">Cost</span>
                <span className="text-right">Market</span>
                <span className="text-right">Allocation</span>
                <span className="text-right">Gain</span>
                <span className="text-right">Lots</span>
              </div>
              {positions.map((p, i) => {
                const q = quotes[p.symbol];
                const market = q ? p.shares * q.c : null;
                const gain = market !== null ? market - p.cost : null;
                const gainPct =
                  gain !== null && p.cost > 0 ? (gain / p.cost) * 100 : null;
                const allocationPct =
                  market !== null && positionsTotalMarket > 0
                    ? (market / positionsTotalMarket) * 100
                    : null;
                const tone =
                  gain === null
                    ? ""
                    : gain >= 0
                    ? "text-pos"
                    : "text-neg";
                return (
                  <button
                    key={p.symbol}
                    onClick={() =>
                      router.push(`/portfolios/${id}/${p.symbol}`)
                    }
                    className={`w-full text-left grid grid-cols-[1fr_auto] md:grid-cols-[1fr_0.7fr_0.8fr_0.8fr_0.9fr_1fr_0.7fr_1.3fr_0.5fr] gap-4 px-5 py-4 hover:bg-bg-3 transition group ${
                      i !== positions.length - 1 ? "border-b border-line" : ""
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-base tracking-tight">
                        {p.symbol}
                      </span>
                      <span className="text-xs text-fg-fade md:hidden">
                        · {p.lots.length} lot{p.lots.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <span className="num text-sm text-right text-fg-dim hidden md:block truncate">
                      {fmtShares(p.shares)}
                    </span>
                    <span className="num text-sm text-right text-fg-dim hidden md:block">
                      {fmtMoney(p.avgPrice)}
                    </span>
                    <span className="num text-sm text-right text-fg-dim hidden md:block">
                      {q ? fmtMoney(q.c) : "…"}
                    </span>
                    <span className="num text-sm text-right text-fg-dim hidden md:block">
                      {fmtMoney(p.cost)}
                    </span>
                    <span className="num text-sm text-right hidden md:block">
                      {market !== null ? fmtMoney(market) : "…"}
                    </span>
                    <span className="num text-sm text-right text-fg-dim hidden md:block">
                      {allocationPct !== null
                        ? `${allocationPct.toFixed(1)}%`
                        : "…"}
                    </span>
                    <span className={`num text-sm text-right ${tone} md:hidden`}>
                      {gain === null
                        ? "…"
                        : `${gain >= 0 ? "+" : ""}${fmtPct(gainPct!)}`}
                    </span>
                    <span
                      className={`num text-sm text-right hidden md:inline-flex justify-end items-center gap-1 ${tone}`}
                    >
                      {gain === null
                        ? "…"
                        : `${gain >= 0 ? "+" : ""}${fmtMoney(gain)} · ${fmtPct(
                            gainPct!
                          )}`}
                    </span>
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

            {/* Connected brokers */}
            {connectedProviders.length > 0 && (
              <div className="mb-5">
                <div className="label mb-3">Connected brokers</div>
                <ul className="space-y-2">
                  {connectedProviders.map((provider) => {
                    const result = syncResults[provider];
                    const isLoading = syncLoading === provider;
                    return (
                      <li key={provider} className="flex items-center gap-2 bg-bg-3 border border-line rounded-lg px-3 py-2.5">
                        <span className="text-sm font-medium flex-1">
                          {BROKER_LABELS[provider] ?? provider}
                        </span>
                        {result && (
                          <span className="text-xs text-fg-fade">
                            {result.buys} buys · {result.sells} sells · {result.skipped} already existed
                          </span>
                        )}
                        <button
                          onClick={() => handleSync(provider)}
                          disabled={!!syncLoading}
                          className="text-xs btn-ghost px-2.5 py-1 disabled:opacity-40"
                        >
                          {isLoading ? "Syncing…" : "Sync"}
                        </button>
                        <button
                          onClick={() => handleDisconnect(provider)}
                          disabled={!!syncLoading}
                          className="text-fg-fade hover:text-neg transition disabled:opacity-40"
                          title="Disconnect"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Connect new broker */}
            <div>
              <div className="label mb-3">Connect a broker</div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const credentials = `${connectKey.trim()}:${connectSecret.trim()}`;
                  if (connectKey.trim() && connectSecret.trim()) handleSync(connectProvider, credentials);
                }}
                className="space-y-3"
              >
                <Field label="Provider">
                  <select
                    value={connectProvider}
                    onChange={(e) => setConnectProvider(e.target.value)}
                    className="field"
                  >
                    {SUPPORTED_BROKERS.filter(
                      (b) => !connectedProviders.includes(b)
                    ).map((b) => (
                      <option key={b} value={b}>{BROKER_LABELS[b]}</option>
                    ))}
                  </select>
                </Field>
                <Field label="API key">
                  <input
                    value={connectKey}
                    onChange={(e) => setConnectKey(e.target.value)}
                    placeholder="Paste your API key"
                    className="field font-mono text-xs"
                    required
                  />
                </Field>
                <Field label="API secret">
                  <input
                    value={connectSecret}
                    onChange={(e) => setConnectSecret(e.target.value)}
                    placeholder="Paste your API secret"
                    className="field font-mono text-xs"
                    required
                  />
                </Field>
                <p className="text-xs text-fg-fade">
                  Trading212: Settings → API (Beta) → Generate key
                </p>
                <button
                  type="submit"
                  disabled={!!syncLoading || !connectKey.trim() || !connectSecret.trim()}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {syncLoading === connectProvider ? "Connecting…" : "Connect & Sync"}
                </button>
              </form>
            </div>

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

function StatCard({
  label,
  value,
  sub,
  hint,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: "pos" | "neg";
}) {
  const color =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className="card p-5">
      <div className="label mb-3">{label}</div>
      <div className={`num text-2xl md:text-3xl font-medium ${color}`}>
        {value}
      </div>
      {sub && <div className={`num text-sm mt-1 ${color}`}>{sub}</div>}
      {hint && <div className="text-xs text-fg-fade mt-1">{hint}</div>}
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
  return (
    <span
      className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
        isSell
          ? "text-neg border-neg/40 bg-neg/10"
          : "text-pos border-pos/40 bg-pos/10"
      }`}
    >
      {isSell ? "Sell" : "Buy"}
    </span>
  );
}
