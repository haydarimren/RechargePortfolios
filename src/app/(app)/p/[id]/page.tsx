"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  limit,
  query,
  writeBatch,
  setDoc,
  getDoc,
  deleteDoc,
} from "firebase/firestore";
import { requestSync, subscribeSyncState } from "@/lib/brokers/auto-sync";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { getQuotes, StockQuote } from "@/lib/finnhub";
import { HistoricalPoint } from "@/lib/yahoo";
import {
  getCachedHistoricalCloses,
  getCachedHistoricalSeries,
} from "@/lib/historical-cache";
import {
  convertHoldingsToUsd,
  convertPointsToUsd,
  quoteValueUsd,
} from "@/lib/currency";
import { useFxSeries } from "@/lib/use-fx";
import {
  aggregateHoldings,
  buildComparisonSeries,
  buildTradeLog,
  normalizeSeries,
  pickRecentTrades,
  poolPositions,
  SeriesPoint,
} from "@/lib/portfolio";
import { useDisplayName, useDisplayNamesForUids } from "@/lib/users";
import { usePublishPortfolioOwnership } from "@/lib/portfolio-route";
import { BenchmarkChart } from "@/components/BenchmarkChart";
import { SharePanel } from "@/components/SharePanel";
import { UnlockModal } from "@/components/UnlockModal";
import { FriendStack } from "@/components/FriendStack";
import { LogbookTable } from "@/components/LogbookTable";
import { TabBar } from "@/components/TabBar";
import { SyncHistory } from "@/components/SyncHistory";
import { PortfolioHero, type BenchVerdict } from "@/components/PortfolioHero";
import { SparklineButton } from "@/components/Sparkline";
import { InsightsBand } from "@/components/InsightsBand";
import { HoldingsCard } from "@/components/HoldingsCard";
import { LogbookCard } from "@/components/LogbookCard";
import { computeTodayChange } from "@/lib/today-change";
import { useInsightsData } from "@/lib/use-insights-data";
import {
  buildAnalystRatings,
  buildUpcomingDates,
  topMovers,
  type AnalystRating,
} from "@/lib/insights";
import { parseSnaptradeAccountIds } from "@/lib/brokers/snaptrade/sync";
import { BROKERS, SUPPORTED_BROKERS } from "@/lib/brokers/registry";
import { runBrokerSync, type SyncReason } from "@/lib/brokers/run-sync";
import type { BrokerId } from "@/lib/brokers/ids";
import {
  decryptBrokerCredential,
  encryptBrokerCredential,
} from "@/lib/crypto-client";
import { SnapTradeConnectFlow } from "@/components/SnapTradeConnectFlow";
import {
  SnapTradeManageAccounts,
  type ManageAccountsResult,
} from "@/components/SnapTradeManageAccounts";
import { useEncryption } from "@/lib/use-encryption";
import { getCachedPortfolioKey, getUnlocked } from "@/lib/key-store";
import {
  addHolding,
  loadPortfolioKeyWithRetry,
  migratePortfolioToEncrypted,
  reconcileSharedWrappedKeys,
  subscribeHoldings,
} from "@/lib/holdings-repo";
import {
  touchLogbookView,
  touchPortfolioView,
} from "@/lib/views";
import { useShareLinkPublisher } from "@/lib/use-share-link-publisher";
import {
  clearPendingLinkToken,
  getPendingLinkToken,
  readSnapshotByToken,
} from "@/lib/share-links";
import type { SnapshotV1 } from "@/lib/share-links-math";
import { SnapshotPortfolioView } from "@/components/SnapshotPortfolioView";
import { ArrowLeft, ArrowUpRight, ChevronRight, Plus, RefreshCw, Trash2, X } from "lucide-react";

const BENCHMARKS = ["SPY", "QQQ"] as const;

// Broker constants live in src/lib/brokers/registry.ts as the single
// source of truth — imported above. The connection picker below maps
// over `SUPPORTED_BROKERS` (alphabetical) and uses each adapter's
// `displayName`, `credentialFields`, and `credentialHint` to render
// itself.

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function PortfolioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

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
  // SnapTrade manage-accounts flow: non-null = panel open, holding the
  // decrypted stored credential JSON.
  const [manageCredentialJson, setManageCredentialJson] = useState<string | null>(null);
  const [manageBusy, setManageBusy] = useState(false);

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
  // Snapshot-tier fallback for a follower awaiting their key wrap (set
  // from the key-resolution catch below; cleared once the key lands).
  const [pendingSnapshot, setPendingSnapshot] = useState<SnapshotV1 | null>(
    null,
  );
  useEffect(() => {
    if (portfolioKey) {
      clearPendingLinkToken(id);
      setPendingSnapshot(null);
    }
  }, [portfolioKey, id]);

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

  // On-view auto-sync: refresh this portfolio when opened, throttled.
  useEffect(() => {
    if (!user || !hasCredential) return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    void requestSync(id, { uid: user.uid, unlocked });
  }, [user, hasCredential, id]);

  const [autoSyncing, setAutoSyncing] = useState(false);
  useEffect(() => subscribeSyncState(id, setAutoSyncing), [id]);

  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  useEffect(() => {
    const unsub = onSnapshot(
      query(
        collection(db, "portfolios", id, "syncLogs"),
        orderBy("createdAt", "desc"),
        limit(1),
      ),
      (snap) => setLastSyncAt(snap.docs[0]?.data()?.createdAt ?? null),
      () => setLastSyncAt(null),
    );
    return unsub;
  }, [id]);

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
            if (isPortfolioOwner) {
              setMigrationError(
                "Couldn't unlock your portfolio key — try refreshing.",
              );
            } else {
              // New follower whose key the owner hasn't wrapped yet:
              // fall back to the snapshot tier via the pending token
              // saved at redeem time. No token (or revoked link) →
              // keep the legacy message.
              const tok = getPendingLinkToken(id);
              let snapped = false;
              if (tok) {
                try {
                  const snap = await readSnapshotByToken(id, tok);
                  if (!cancelled) {
                    setPendingSnapshot(snap);
                    snapped = true;
                  }
                } catch {
                  // fall through to the message below
                }
              }
              if (!snapped && !cancelled) {
                setMigrationError(
                  "This portfolio is encrypted but the owner hasn't shared the key with you yet.",
                );
              }
            }
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

  const fxSeries = useFxSeries(holdings);

  /**
   * Holdings with every lot's cost basis restated in USD at the rate on
   * its own purchase date. This is the single conversion point: pooling,
   * the trade log, allocation, and the benchmark chart all read from
   * here, so they can't drift into disagreeing about currency.
   */
  const usdHoldings = useMemo(
    () => convertHoldingsToUsd(holdings, fxSeries),
    [holdings, fxSeries],
  );

  /** A position's market value in USD, or null when it has no quote. */
  const marketValueUsd = useMemo(() => {
    return (symbol: string, shares: number): number | null =>
      quoteValueUsd(quotes[symbol], shares, fxSeries);
  }, [quotes, fxSeries]);

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
    if (usdHoldings.length === 0) {
      setSeries([]);
      return;
    }
    const pooled = poolPositions(usdHoldings);
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
    const chartHoldings = usdHoldings.filter(
      (h) => h.purchaseDate >= firstDate && symbols.includes(h.symbol)
    );
    // Resolve display symbol → Yahoo query symbol for history fetches.
    // buildComparisonSeries still expects priceMap keyed by display symbol.
    const yahooBySymbol = new Map<string, string>();
    for (const h of usdHoldings) {
      if (h.yahooSymbol && !yahooBySymbol.has(h.symbol)) {
        yahooBySymbol.set(h.symbol, h.yahooSymbol);
      }
    }

    Promise.all([
      ...symbols.map((s) =>
        // `getCachedHistoricalSeries` reports the currency Yahoo quoted
        // the closes in, which is what lets us restate them in USD before
        // they're summed. The benchmark is a USD instrument, so a chart
        // that mixed a London and a Milan line into the portfolio curve
        // was comparing against nothing meaningful.
        getCachedHistoricalSeries(yahooBySymbol.get(s) ?? s, fromMs, toMs).then(
          (ser) =>
            [s, convertPointsToUsd(ser.points, ser.currency, fxSeries)] as [
              string,
              HistoricalPoint[],
            ]
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
  }, [usdHoldings, fxSeries]);

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
  // For SnapTrade-locked portfolios, the lock is the SET of account ids
  // tagged on holdings (L). Sorted for stable identity. The credential
  // set C must satisfy C ⊇ L at sync time — that's what keeps the
  // fully-sold sweep safe (no held symbol can belong to an unsynced
  // account). Merged reconciler lots are untagged and don't contribute.
  const lockedSnaptradeAccountIds = useMemo<string[]>(() => {
    if (lockedBroker !== "snaptrade") return [];
    const set = new Set<string>();
    for (const h of holdings) {
      if (
        h.importSource === "snaptrade"
        && typeof h.snaptradeAccountId === "string"
        && h.snaptradeAccountId.length > 0
      ) {
        set.add(h.snaptradeAccountId);
      }
    }
    return Array.from(set).sort();
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
  // Keep the share-link snapshot in lock-step with holdings. No link →
  // cheap no-op (one list read per debounce window).
  useShareLinkPublisher({
    portfolioId: id,
    enabled: isOwner,
    ownerUid: user?.uid ?? null,
    portfolioName: portfolio?.name ?? "",
    holdings,
  });
  // Publish ownership to the AppShell so the right tab (Mine vs Friends)
  // highlights while we're on this route. Pass `null` until the portfolio
  // doc has loaded so we don't wrongly flash the owner state.
  usePublishPortfolioOwnership(
    !user || !portfolio ? null : portfolio.ownerId === user.uid,
  );
  const ownerName = useDisplayName(portfolio?.ownerId ?? null);
  const followerNames = useDisplayNamesForUids(portfolio?.sharedWith ?? []);

  const positions = useMemo(() => {
    const rows = aggregateHoldings(usdHoldings);
    return rows.slice().sort((a, b) => {
      const ma = marketValueUsd(a.symbol, a.shares) ?? -1;
      const mb = marketValueUsd(b.symbol, b.shares) ?? -1;
      return mb - ma;
    });
  }, [usdHoldings, marketValueUsd]);

  const tradeLog = useMemo(() => buildTradeLog(usdHoldings), [usdHoldings]);
  // Bump `lastPortfolioViewAt` once per page load for shared viewers. This
  // is what clears the home-page "N new" badge. Gated so owners never write.
  useEffect(() => {
    if (!user || isOwner || !portfolio) return;
    touchPortfolioView(user.uid, id);
  }, [user, isOwner, portfolio, id]);

  // "overview" = hero + band + two columns; "logbook" = full trade table.
  const [view, setView] = useState<"overview" | "logbook">("overview");
  // Mobile (< lg) shows one column at a time via a 2-item tab bar.
  const [mobileTab, setMobileTab] = useState<"holdings" | "logbook">("holdings");
  // Mobile benchmark chart disclosure (sparkline toggle).
  const [chartOpen, setChartOpen] = useState(false);

  const markLogbookSeen = () => {
    if (user && !isOwner) touchLogbookView(user.uid, id);
  };
  const goSymbol = (symbol: string) => router.push(`/p/${id}/${symbol}`);

  // Total current market value (USD) across positions with resolved
  // quotes — the denominator for per-row allocation %. Positions without
  // a quote can't be valued, so they're excluded and the remaining rows
  // add to 100% of the *priced* portion. That's only honest if the UI
  // says so, hence `unpricedSymbols` below.
  const positionsTotalMarket = useMemo(() => {
    let total = 0;
    for (const p of positions) {
      total += marketValueUsd(p.symbol, p.shares) ?? 0;
    }
    return total;
  }, [positions, marketValueUsd]);

  /**
   * Positions we couldn't get a price for. Previously this failed
   * silently: the row showed "…" and, far worse, the position vanished
   * from the allocation denominator so a two-position portfolio with one
   * dead quote rendered the survivor at a confident 100.0%.
   */
  const unpricedSymbols = useMemo(
    () => positions.filter((p) => !quotes[p.symbol]).map((p) => p.symbol),
    [positions, quotes],
  );

  /**
   * Non-USD currencies actually converted for display. Surfaced so the
   * numbers here being different from the broker's own screen is
   * explained rather than mysterious.
   */
  const convertedCurrencies = useMemo(
    () => Object.keys(fxSeries).sort(),
    [fxSeries],
  );

  const totals = useMemo(() => {
    let cost = 0;
    let market = 0;
    let firstDate: string | null = null;
    for (const p of positions) {
      // `p.cost` is already USD — `positions` pools `usdHoldings`.
      cost += p.cost;
      market += marketValueUsd(p.symbol, p.shares) ?? 0;
      if (!firstDate || p.firstDate < firstDate) firstDate = p.firstDate;
    }
    const gain = market - cost;
    const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
    return { cost, market, gain, gainPct, firstDate };
  }, [positions, marketValueUsd]);

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
  // own first-valid day. Shared with the share-link snapshot builder so
  // the public page inherits identical chart math.
  const normalizedSeries = useMemo(() => normalizeSeries(series), [series]);

  // "What moved today" — from the same quotes/market values the rows show.
  const todayChange = useMemo(
    () =>
      computeTodayChange(
        positions.map((p) => ({
          market: marketValueUsd(p.symbol, p.shares),
          dp: quotes[p.symbol]?.dp ?? null,
        })),
      ),
    [positions, marketValueUsd, quotes],
  );

  // Insights (Yahoo dates/consensus + Finnhub spreads) — shared by the band
  // and the holdings-row pills. One fetch per symbol set (daily server cache).
  const { insights, spreads, datesDegraded, ratingsDegraded } = useInsightsData(positions);
  const todayISO = new Date().toISOString().split("T")[0];

  const upcoming = useMemo(
    () => (insights ? buildUpcomingDates(insights, todayISO).slice(0, 8) : []),
    [insights, todayISO],
  );

  const { ratingsBySymbol, movers } = useMemo(() => {
    const price: Record<string, number | undefined> = {};
    const weight: Record<string, number> = {};
    const moverRows: Array<{ symbol: string; dailyPct: number; returnPct: number }> = [];
    for (const p of positions) {
      const q = quotes[p.symbol];
      price[p.symbol] = q?.c; // native quote price — only compared to same-listing targets
      const market = marketValueUsd(p.symbol, p.shares);
      weight[p.symbol] =
        market !== null && positionsTotalMarket > 0
          ? market / positionsTotalMarket
          : 0;
      if (q && market !== null && p.cost > 0) {
        moverRows.push({
          symbol: p.symbol,
          dailyPct: q.dp,
          returnPct: ((market - p.cost) / p.cost) * 100,
        });
      }
    }
    const bySymbolMap: Record<string, AnalystRating> = {};
    for (const r of buildAnalystRatings(insights ?? {}, price, weight, spreads)) {
      bySymbolMap[r.symbol] = r;
    }
    return { ratingsBySymbol: bySymbolMap, movers: topMovers(moverRows).today };
  }, [positions, quotes, marketValueUsd, positionsTotalMarket, insights, spreads]);

  // Hero verdict chips: portfolio vs each hypothetical benchmark.
  const verdicts = useMemo<BenchVerdict[]>(() => {
    if (!benchGain) return [];
    return BENCHMARKS.flatMap((b) => {
      const v = benchGain.values[b];
      if (typeof v !== "number" || v <= 0) return [];
      return [{ bench: b, diffPct: ((benchGain.portfolio - v) / v) * 100 }];
    });
  }, [benchGain]);

  // Viewer hero "vs SPY" pill from the normalized series' last point.
  const viewerVsSpyPct = useMemo(() => {
    const last = normalizedSeries[normalizedSeries.length - 1];
    if (!last || typeof last.SPY !== "number") return null;
    return last.portfolio - last.SPY;
  }, [normalizedSeries]);

  const recentTrades = useMemo(() => pickRecentTrades(tradeLog, 8), [tradeLog]);

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
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) {
      setSyncError("Unlock your portfolio first.");
      return;
    }
    const outcome = await runBrokerSync({
      portfolioId: id,
      uid: user.uid,
      unlocked,
      brokerIdHint: provider,
      credentialOverride: keyOverride,
    });
    if (!outcome.ran && outcome.reason !== "ok") {
      const msgByReason: Partial<Record<SyncReason, string>> = {
        "no-key": "Unlock your portfolio first.",
        "no-credentials": "No credentials — reconnect.",
        "corrupt-credentials": "Stored credentials are corrupt — reconnect.",
        "broker-mismatch": "Stored credentials are for a different broker.",
        "lock-mismatch": `This portfolio is locked to ${
          lockedBroker ? BROKERS[lockedBroker]?.displayName ?? lockedBroker : provider
        }.`,
        "account-set-mismatch": "This portfolio contains accounts missing from the selected set. Manage accounts to add or remove them.",
      };
      const m = msgByReason[outcome.reason];
      if (m) setSyncError(m);
    } else if (outcome.errors.length > 0) {
      setSyncError(outcome.errors[0]);
    }
    if (outcome.ran) {
      setSyncResults((prev) => ({
        ...prev,
        [provider]: {
          buys: outcome.buys,
          sells: outcome.sells,
          skipped: outcome.skipped,
          partialFillsSkipped: outcome.partialFillsSkipped,
        },
      }));
      setConnectFields({});
      setShowImport(false);
    } else if (keyOverride) {
      setConnectFields({}); // clear the secret off-screen on a failed fresh paste
    }
  };

  const openManageAccounts = async () => {
    if (!user) return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) {
      setSyncError("Unlock your portfolio first.");
      return;
    }
    try {
      const secretSnap = await getDoc(
        doc(db, "portfolios", id, "secrets", "credentials"),
      );
      const data = secretSnap.exists() ? secretSnap.data() : null;
      if (
        !data
        || typeof data.payload !== "string"
        || typeof data.iv !== "string"
      ) {
        setSyncError("No credentials — reconnect.");
        return;
      }
      const decoded = await decryptBrokerCredential(
        { payload: data.payload, iv: data.iv },
        unlocked.masterSecret,
      );
      if (decoded.brokerId !== "snaptrade") {
        setSyncError(
          `Stored credentials are for ${decoded.brokerId}, not snaptrade.`,
        );
        return;
      }
      setManageCredentialJson(decoded.credential);
    } catch {
      setSyncError("Stored credentials are corrupt — reconnect.");
    }
  };

  const handleManageApply = async ({
    newAccountIds,
    removedAccountIds,
  }: ManageAccountsResult) => {
    if (!user) return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked || !manageCredentialJson) return;
    setManageBusy(true);
    try {
      // Order is load-bearing (see the multi-account design doc):
      // credential FIRST — if the flow dies after this write, the next
      // sync is BLOCKED by the C ⊇ L check instead of a stale
      // credential silently re-importing an account the user removed.
      const base = JSON.parse(manageCredentialJson) as Record<string, unknown>;
      delete base.snaptradeAccountId; // retire the legacy singular field
      const newCredential = JSON.stringify({
        ...base,
        snaptradeAccountIds: newAccountIds,
      });
      const env = await encryptBrokerCredential(
        { brokerId: "snaptrade", credential: newCredential },
        unlocked.masterSecret,
      );
      await setDoc(doc(db, "portfolios", id, "secrets", "credentials"), {
        payload: env.payload,
        iv: env.iv,
        updatedAt: Date.now(),
      });
      // Delete removed accounts' lots (provenance-tagged; merged
      // reconcilers are untagged and survive — the chained sync below
      // re-targets or neutralizes them).
      if (removedAccountIds.length > 0) {
        const removedSet = new Set(removedAccountIds);
        const toDelete = holdingsRef.current.filter(
          (h) =>
            h.importSource === "snaptrade"
            && typeof h.snaptradeAccountId === "string"
            && removedSet.has(h.snaptradeAccountId),
        );
        const batch = writeBatch(db);
        for (const h of toDelete) {
          batch.delete(doc(db, "portfolios", id, "holdings", h.id));
        }
        await batch.commit();
      }
      setManageCredentialJson(null);
      // Chained sync: imports added accounts' history and re-targets
      // every merged reconciler against the remaining set.
      await handleSync("snaptrade");
    } finally {
      setManageBusy(false);
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

  // Snapshot-tier fallback: a follower whose wrappedKey hasn't been
  // written yet (owner hasn't been online since they followed) sees the
  // same percent-only view the share link gave them, plus a pending
  // note — instead of an error.
  if (!isOwner && pendingSnapshot && !portfolioKey) {
    return (
      <div className="min-h-screen">
        <main className="max-w-4xl mx-auto px-6 lg:px-10 py-10">
          <SnapshotPortfolioView
            snapshot={pendingSnapshot}
            banner={
              <div className="border border-line bg-bg-3 text-fg-dim text-xs rounded-md p-3">
                Following — you&apos;ll get the full view (trade history,
                live holdings) automatically the next time the owner opens
                the app.
              </div>
            }
          />
        </main>
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
      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-10 space-y-6">
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

        <PortfolioHero
          isOwner={isOwner}
          totals={totals}
          positionsCount={positions.length}
          sinceDate={totals.firstDate}
          today={todayChange}
          verdicts={isOwner ? verdicts : []}
          viewerVsSpyPct={isOwner ? null : viewerVsSpyPct}
          chart={
            holdings.length > 0 ? (
              chartLoading && series.length === 0 ? (
                <div className="flex h-[236px] items-center justify-center text-sm text-fg-dim">
                  Loading history…
                </div>
              ) : series.length === 0 ? (
                <div className="flex h-[236px] items-center justify-center text-sm text-fg-dim">
                  Not enough data.
                </div>
              ) : (
                <BenchmarkChart
                  data={isOwner ? series : normalizedSeries}
                  isOwner={isOwner}
                  height={236}
                />
              )
            ) : null
          }
          spark={
            series.length > 0 ? (
              <SparklineButton
                data={isOwner ? series : normalizedSeries}
                expanded={chartOpen}
                onToggle={() => setChartOpen((v) => !v)}
              />
            ) : null
          }
        />

        {chartOpen && series.length > 0 && (
          <div className="card mb-4 p-3 lg:hidden">
            <BenchmarkChart
              data={isOwner ? series : normalizedSeries}
              isOwner={isOwner}
              height={200}
            />
          </div>
        )}

        <InsightsBand
          movers={movers}
          upcoming={upcoming}
          onPickSymbol={goSymbol}
          className="mb-4"
        />

        {view === "logbook" ? (
          <section className="animate-fade-up">
            <button
              type="button"
              onClick={() => setView("overview")}
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back to overview
            </button>
            <LogbookTable tradeLog={tradeLog} isOwner={isOwner} portfolioId={id} />
            <SyncHistory portfolioId={id} portfolioKey={portfolioKey} isOwner={isOwner} />
          </section>
        ) : (
          <section className="animate-fade-up">
            <TabBar
              className="mb-3 lg:hidden"
              items={[
                { id: "holdings", label: "Holdings", count: positions.length },
                { id: "logbook", label: "Logbook", count: tradeLog.length },
              ]}
              active={mobileTab}
              onSelect={(tid) => {
                setMobileTab(tid as "holdings" | "logbook");
                if (tid === "logbook") markLogbookSeen();
              }}
            />
            <div className="lg:grid lg:grid-cols-[1.45fr_1fr] lg:items-start lg:gap-[18px]">
              <div className={mobileTab === "holdings" ? "" : "hidden lg:block"}>
                <HoldingsCard
                  positions={positions}
                  marketValue={marketValueUsd}
                  totalMarket={positionsTotalMarket}
                  quotes={quotes}
                  ratings={insights === null ? null : ratingsBySymbol}
                  isOwner={isOwner}
                  portfolioId={id}
                  unpricedSymbols={unpricedSymbols}
                  convertedCurrencies={convertedCurrencies}
                  datesDegraded={datesDegraded}
                  ratingsDegraded={ratingsDegraded}
                  onPickSymbol={goSymbol}
                />
              </div>
              <div
                className={`${mobileTab === "logbook" ? "" : "hidden lg:block"} mt-4 lg:mt-0`}
              >
                <LogbookCard
                  trades={recentTrades}
                  totalCount={tradeLog.length}
                  isOwner={isOwner}
                  onViewAll={() => {
                    setView("logbook");
                    markLogbookSeen();
                  }}
                  onPickSymbol={goSymbol}
                />
                <SyncHistory
                  portfolioId={id}
                  portfolioKey={portfolioKey}
                  isOwner={isOwner}
                />
              </div>
            </div>
          </section>
        )}
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
                    const isLoading = syncLoading === lockedBroker || autoSyncing;
                    return (
                      <li key={lockedBroker} className="flex items-center gap-2 bg-bg-3 border border-line rounded-lg px-3 py-2.5">
                        <span className="text-sm font-medium flex-1">
                          {BROKERS[lockedBroker].displayName}
                          {lockedBroker === "snaptrade"
                            && lockedSnaptradeAccountIds.length > 0 && (
                            <span className="text-xs text-fg-fade ml-1.5">
                              · {lockedSnaptradeAccountIds.length} account
                              {lockedSnaptradeAccountIds.length === 1 ? "" : "s"}
                            </span>
                          )}
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
                        {lockedBroker === "snaptrade" && (
                          <button
                            onClick={() => void openManageAccounts()}
                            disabled={!!syncLoading || manageBusy}
                            className="text-xs btn-ghost px-2.5 py-1 disabled:opacity-40"
                            title="Add or remove SnapTrade accounts"
                          >
                            Accounts
                          </button>
                        )}
                        <button
                          onClick={() => handleSync(lockedBroker)}
                          disabled={!!syncLoading || autoSyncing}
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
                {lastSyncAt && (
                  <p className="mt-2 text-fg-fade label">synced {relativeTime(lastSyncAt)}</p>
                )}
              </div>
            )}

            {/* SnapTrade manage-accounts panel — opened from the
                Accounts button on the connected-broker row. */}
            {manageCredentialJson && lockedBroker === "snaptrade" && (
              <div className="mb-5">
                <div className="label mb-3">Manage accounts</div>
                <SnapTradeManageAccounts
                  credentialJson={manageCredentialJson}
                  currentAccountIds={parseSnaptradeAccountIds(manageCredentialJson)}
                  holdingsAccountIds={lockedSnaptradeAccountIds}
                  countLotsFor={(ids) => {
                    const set = new Set(ids);
                    return holdings.filter(
                      (h) =>
                        h.importSource === "snaptrade"
                        && typeof h.snaptradeAccountId === "string"
                        && set.has(h.snaptradeAccountId),
                    ).length;
                  }}
                  busy={manageBusy || !!syncLoading}
                  onApply={handleManageApply}
                  onClose={() => setManageCredentialJson(null)}
                />
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
                        lockedSnaptradeAccountIds={lockedSnaptradeAccountIds}
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
              portfolioName={portfolio.name}
              holdings={holdings}
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
              onKeyRotated={(k) => setPortfolioKey(k)}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1.5">{label}</label>
      {children}
    </div>
  );
}
