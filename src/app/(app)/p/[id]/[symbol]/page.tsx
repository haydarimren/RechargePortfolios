"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  deleteDoc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { getQuote, StockQuote } from "@/lib/finnhub";
import { HistoricalPoint } from "@/lib/yahoo";
import { getCachedHistoricalCloses } from "@/lib/historical-cache";
import { closeOnOrBefore, fmtShares, poolPositions } from "@/lib/portfolio";
import { ThemeToggle, useChartColors } from "@/lib/theme";
import { UnlockModal } from "@/components/UnlockModal";
import { TwoLinePLCell } from "@/components/TwoLinePLCell";
import { useEncryption } from "@/lib/use-encryption";
import { getCachedPortfolioKey, getUnlocked } from "@/lib/key-store";
import {
  loadPortfolioKeyWithRetry,
  subscribeHoldings,
} from "@/lib/holdings-repo";
import { Trash2 } from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceDot,
  ReferenceLine,
} from "recharts";

export default function TickerPage({
  params,
}: {
  params: Promise<{ id: string; symbol: string }>;
}) {
  const { id, symbol: symbolParam } = use(params);
  const symbol = symbolParam.toUpperCase();
  const router = useRouter();
  const chartColors = useChartColors();

  const [user, setUser] = useState<User | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [lots, setLots] = useState<Holding[]>([]);
  const [quote, setQuote] = useState<StockQuote | null>(null);
  const [history, setHistory] = useState<HistoricalPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const encryption = useEncryption();
  // Seed from the module-level cache — if we resolved this portfolio's
  // key on any previous page in the tab, render with real data straight
  // away (no skeleton, no Firestore round-trip). Cache persists across
  // navigation; cleared on sign-out / user-switch.
  const [portfolioKey, setPortfolioKey] = useState<CryptoKey | null>(
    () => getCachedPortfolioKey(id),
  );
  // True once the resolution attempt for this portfolio has settled
  // (success OR final failure). Until then, the page would otherwise
  // render with shares=0/cost=$0/0 lots — which lies during the resolution
  // window because we just haven't decrypted yet. The stat cards consult
  // this flag to swap their values for pulse skeletons during the window.
  // Cache hits are implicitly already attempted (success).
  const [keyAttempted, setKeyAttempted] = useState<boolean>(
    () => getCachedPortfolioKey(id) !== null,
  );

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

  useEffect(() => {
    if (!user) return;

    const unsubPortfolio = onSnapshot(
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
      }
    );

    // Decode through the repo so encrypted-shape docs come back with
    // plaintext symbol/shares/price after the unwrap. Pre-migration docs
    // pass through unchanged.
    const sub = subscribeHoldings(
      id,
      portfolioKey,
      (rows) => {
        const filtered = rows.filter((h) => h.symbol === symbol);
        filtered.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
        setLots(filtered);
      },
      () => setLots([]),
    );

    return () => {
      unsubPortfolio();
      sub.unsubscribe();
    };
  }, [user, id, symbol, portfolioKey]);

  // Resolve K_portfolio for encrypted portfolios. Mirrors the detail page;
  // drilldown is read-only so we never trigger migration here.
  useEffect(() => {
    if (!portfolio || !user) return;
    if (!portfolio.encrypted) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    let cancelled = false;
    // Note: no setKeyAttempted(false) here. The cache makes every call to
    // loadPortfolioKeyWithRetry either return synchronously (hit, which
    // means useState's lazy init already populated portfolioKey + set
    // keyAttempted to true) or kick off a real resolution attempt. In
    // either case the previous attempt's "true" state is correct for
    // the fresh attempt — if we did flip back to false here, a cached
    // hit would briefly flash the skeleton before re-resolving the same
    // CryptoKey we already had.
    loadPortfolioKeyWithRetry(id, user.uid, unlocked.privateKey)
      .then((k) => {
        if (!cancelled) {
          setPortfolioKey(k);
          setKeyAttempted(true);
        }
      })
      .catch(() => {
        // After 3 retries with backoff, key resolution still failed. Most
        // common cause: owner hasn't reconciled the wrappedKey doc yet
        // (their next sign-in fixes it). The stat cards stop showing the
        // pulse skeleton at this point; current behaviour is to render
        // the (zeroed) values which is fine for the rare case until/if
        // we add a "no key yet" message at the page level too.
        if (!cancelled) setKeyAttempted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [portfolio, user, id, encryption.state.kind]);

  // Use the Yahoo-resolved symbol when any lot has one — but only if it
  // plausibly matches the route symbol. A stale pre-merger mapping
  // (e.g. ASTS lot with yahooSymbol "NPA") must not leak into the price
  // fetch, or we 404 and the page looks broken. "Plausibly matches" =
  // starts with the route symbol (allows variants like "ASTS.L").
  const yahooSymbol = useMemo(() => {
    const route = symbol.toUpperCase();
    for (const l of lots) {
      const ys = l.yahooSymbol?.toUpperCase();
      if (ys && ys.startsWith(route)) return l.yahooSymbol!;
    }
    return symbol;
  }, [lots, symbol]);

  useEffect(() => {
    let cancelled = false;
    const fetchQuote = () => {
      getQuote(yahooSymbol).then((q) => {
        if (!cancelled) setQuote(q);
      });
    };
    fetchQuote();
    const interval = setInterval(fetchQuote, 120_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [yahooSymbol]);

  useEffect(() => {
    if (lots.length === 0) {
      setHistory([]);
      return;
    }
    const first = lots
      .map((l) => l.purchaseDate)
      .reduce((a, b) => (a < b ? a : b));
    getCachedHistoricalCloses(yahooSymbol, new Date(first).getTime(), Date.now()).then(
      setHistory
    );
  }, [lots, yahooSymbol]);

  const isOwner = !!(user && portfolio && portfolio.ownerId === user.uid);

  // True for the brief window between page mount/nav-back and the key
  // resolution settling. During this window `lots` is empty for an
  // encrypted portfolio because subscribeHoldings hasn't been able to
  // decrypt anything yet — without the skeleton the page renders with
  // shares=0, avg cost=$0.00, market=…, gain=… ("0 lots in {portfolio}"),
  // which looks like a real position but isn't.
  const keyResolving =
    !!portfolio?.encrypted &&
    !portfolioKey &&
    !keyAttempted &&
    encryption.state.kind === "unlocked";

  const pooled = useMemo(
    () => poolPositions(lots).find((p) => p.symbol === symbol) ?? null,
    [lots, symbol]
  );
  const positionClosed = lots.length > 0 && pooled === null;

  const totals = useMemo(() => {
    const shares = pooled?.shares ?? 0;
    const avg = pooled?.avgPrice ?? 0;
    const cost = shares * avg;
    const market = quote && shares > 0 ? shares * quote.c : null;
    const gain = market !== null ? market - cost : null;
    const gainPct = gain !== null && cost > 0 ? (gain / cost) * 100 : null;
    return { shares, cost, avg, market, gain, gainPct };
  }, [pooled, quote]);

  const handleDelete = async (l: Holding) => {
    if (!isOwner) return;
    if (
      !confirm(
        `Delete lot of ${fmtShares(l.shares)} ${symbol} from ${new Date(
          l.purchaseDate
        ).toLocaleDateString()}?`
      )
    )
      return;
    await deleteDoc(doc(db, "portfolios", id, "holdings", l.id));
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
        <p className="text-lg">Not found.</p>
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Back
        </Link>
      </div>
    );
  }

  // Place the dot at the user's actual transaction price — not the market
  // close on that date. Otherwise a trade executed intraday at a different
  // price than the close (e.g. bought the open high, closed lower) looks
  // misleading: the dot snaps to close while the gain % is computed from
  // the real cost basis, so the two tell different stories.
  const lotMarkers = lots.map((l) => {
    const isSell = l.side === "SELL";
    const hasClose = closeOnOrBefore(history, l.purchaseDate);
    if (hasClose !== null) {
      const matched = history.findLast((p) => p.date <= l.purchaseDate)!;
      return { date: matched.date, price: l.purchasePrice, isSell };
    }
    if (history.length > 0) {
      return { date: history[0].date, price: l.purchasePrice, isSell };
    }
    return { date: null, price: null, isSell };
  });

  // Dynamic Y-axis precision so narrow price ranges don't collapse every tick
  // to the same integer dollar label.
  const priceValues = history.map((p) => p.close);
  for (const m of lotMarkers) {
    if (m.price !== null) priceValues.push(m.price);
  }
  // Include the cost-basis line so it never renders off-chart.
  const avgCost = pooled?.avgPrice ?? null;
  if (avgCost !== null) priceValues.push(avgCost);
  const priceSpan =
    priceValues.length > 0
      ? Math.max(...priceValues) - Math.min(...priceValues)
      : 0;
  const priceDecimals = priceSpan < 1 ? 3 : priceSpan < 10 ? 2 : priceSpan < 100 ? 1 : 0;
  const yTickFormatter = (v: number) => `$${v.toFixed(priceDecimals)}`;

  // Make sure lot dots are always in view. Recharts' auto domain only sees the
  // Area's data, so a buy executed above the highest close (or a sell below
  // the lowest) renders off the chart. Pad by 2% so dots don't sit flush on
  // the edge.
  const yDomain: [number | string, number | string] =
    priceValues.length > 0
      ? (() => {
          const lo = Math.min(...priceValues);
          const hi = Math.max(...priceValues);
          const pad = Math.max((hi - lo) * 0.05, hi * 0.002);
          return [lo - pad, hi + pad];
        })()
      : ["auto", "auto"];

  const spanMs =
    history.length > 1
      ? new Date(history[history.length - 1].date).getTime() -
        new Date(history[0].date).getTime()
      : 0;
  const spanDays = spanMs / 86_400_000;
  const tickFormatter = (d: string) => {
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

  const [showMenu, setShowMenu] = useState(false);
  const needsRecovery = encryption.state.kind === "needs-recovery";

  return (
    <div className="min-h-screen">
      {needsRecovery && encryption.state.kind === "needs-recovery" && (
        <UnlockModal
          uid={encryption.state.uid}
          onRestore={encryption.restore}
        />
      )}
      <header className="px-6 lg:px-10 pt-5 pb-4 border-b border-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <span className="text-[11.5px] text-fg-dim font-medium">
            <ThemeToggle />
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Task 5.1 — Header strip */}
        <section className="animate-fade-up">
          <div className="text-[11.5px] text-fg-fade font-medium mb-3.5 flex items-center gap-1.5">
            <span>Mine</span>
            <span className="text-line-strong">›</span>
            <Link href={`/p/${id}`} className="hover:text-fg">{portfolio.name}</Link>
            <span className="text-line-strong">›</span>
            <span>{symbol}</span>
          </div>
          <div className="flex items-start justify-between gap-5 mb-4">
            <div className="flex-1">
              <div className="flex items-baseline gap-3">
                <span className="text-[30px] font-bold text-fg tracking-tight leading-none tabular-nums">{symbol}</span>
              </div>
              <div className="mt-2 text-[12.5px] text-fg-fade font-medium flex items-center gap-2 flex-wrap">
                {quote && quote.c > 0 && (
                  <span className="text-base text-fg font-semibold tabular-nums">{fmtMoney(quote.c)}</span>
                )}
                {quote && quote.dp != null && (
                  <>
                    <span className={quote.dp >= 0 ? "text-pos font-semibold" : "text-neg font-semibold"}>
                      {quote.dp >= 0 ? "↑" : "↓"} {Math.abs(quote.dp).toFixed(2)}% today
                    </span>
                  </>
                )}
              </div>
            </div>
            {isOwner && (
              <div className="flex gap-2 shrink-0 relative">
                <button className="bg-fg text-bg text-sm font-semibold px-3.5 py-2 rounded-btn">
                  + Add lot
                </button>
                <button
                  onClick={() => setShowMenu((v) => !v)}
                  aria-label="More options"
                  className="w-9 h-9 inline-flex items-center justify-center bg-transparent text-fg-dim border border-line-strong rounded-btn hover:border-accent hover:text-accent transition"
                >
                  ⋯
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-10 z-30 bg-bg-2 border border-line rounded-card shadow-lg py-1 min-w-[160px]">
                    <Link
                      href={`/p/${id}`}
                      className="block w-full text-left px-4 py-2 text-sm text-fg hover:bg-bg-3 transition"
                      onClick={() => setShowMenu(false)}
                    >
                      ← Back to portfolio
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Task 5.2 — Position summary strip (owner only) */}
        {isOwner && positionClosed && !keyResolving ? (
          <div className="py-4 border-b border-line mb-[18px] text-sm text-fg-dim animate-fade-up" style={{ animationDelay: "60ms" }}>
            <span className="text-[11px] uppercase tracking-[0.06em] font-medium text-fg-fade mr-2">Position closed</span>
            All shares of {symbol} have been sold. Transaction history below.
          </div>
        ) : isOwner ? (
          <div
            className="flex items-baseline gap-[22px] flex-wrap py-4 border-b border-line mb-[18px] text-sm animate-fade-up"
            style={{ animationDelay: "60ms" }}
          >
            {keyResolving ? (
              <div className="h-5 w-48 bg-bg-3 rounded animate-pulse" aria-hidden />
            ) : (
              <>
                <Stat label="Your position" value={`${fmtShares(totals.shares)} shares`} big />
                <Stat label="Avg cost" value={fmtMoney(totals.avg)} />
                <Stat label="Mkt value" value={totals.market !== null ? fmtMoney(totals.market) : "—"} />
                <Stat
                  label="Unrealized"
                  value={
                    totals.gain === null
                      ? "—"
                      : `${totals.gain >= 0 ? "+" : "−"}${fmtMoney(Math.abs(totals.gain))} (${totals.gainPct !== null ? totals.gainPct.toFixed(1) : "0"}%)`
                  }
                  tone={totals.gain === null ? undefined : totals.gain >= 0 ? "pos" : "neg"}
                />
              </>
            )}
          </div>
        ) : null}

        {/* Chart: bg-bg-2 card + legend strip with buy/sell color dots */}
        <section
          className="animate-fade-up"
          style={{ animationDelay: "120ms" }}
        >
          <div className="bg-bg-2 border border-line rounded-card p-4 md:p-[16px_18px_14px]">
            {/* Legend row */}
            <div className="flex items-center gap-3.5 text-[11.5px] text-fg-mid mb-2.5">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-[2px] bg-accent" />
                price
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-pos" />
                buys
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-neg" />
                sells
              </span>
            </div>
            <div className="h-[340px]">
              {history.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-fg-dim">
                  Loading history…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={340}>
                  <AreaChart
                    data={history}
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="tick" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor={chartColors.ticker}
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="100%"
                          stopColor={chartColors.ticker}
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
                      tickFormatter={tickFormatter}
                    />
                    <YAxis
                      stroke={chartColors.axis}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      domain={yDomain}
                      tickFormatter={yTickFormatter}
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
                        typeof v === "number" ? fmtMoney(v) : String(v)
                      }
                    />
                    <Area
                      name={symbol}
                      type="monotone"
                      dataKey="close"
                      stroke={chartColors.ticker}
                      strokeWidth={2}
                      fill="url(#tick)"
                    />
                    {avgCost !== null && (
                      <ReferenceLine
                        y={avgCost}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={1}
                        label={{
                          value: `Avg cost ${`$${avgCost.toFixed(priceDecimals)}`}`,
                          position: "insideTopLeft",
                          fill: chartColors.axis,
                          fontSize: 10,
                        }}
                      />
                    )}
                    {lotMarkers.map((m, i) =>
                      m.price !== null && m.date !== null ? (
                        <ReferenceDot
                          key={i}
                          x={m.date}
                          y={m.price}
                          r={5}
                          fill={m.isSell ? chartColors.sellDot : chartColors.dot}
                          stroke={
                            m.isSell
                              ? chartColors.sellDotStroke
                              : chartColors.dotStroke
                          }
                          strokeWidth={2}
                        />
                      ) : null
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </section>

        {/* Lot table: owner sees all $ columns; viewer sees side + date + % gain only */}
        <section
          className="animate-fade-up"
          style={{ animationDelay: "200ms" }}
        >
          <div className="mb-3">
            <h2 className="text-[13px] font-semibold tracking-[0.04em] uppercase text-fg-dim">
              Transaction history
            </h2>
          </div>
          <div className="bg-bg-2 border border-line rounded-card overflow-hidden">
            {/* Table header — owner sees all columns; viewer sees side + date + % gain only */}
            {isOwner ? (
              <div className="hidden md:grid grid-cols-[0.6fr_1.1fr_0.9fr_0.9fr_0.9fr_1.1fr_1.3fr_0.3fr] gap-4 px-5 py-2.5 text-[10.5px] uppercase tracking-[0.07em] font-semibold text-fg-fade border-b border-line">
                <span>Side</span>
                <span>Date</span>
                <span className="text-right">Shares</span>
                <span className="text-right">Price</span>
                <span className="text-right">Total</span>
                <span className="text-right">Market</span>
                <span className="text-right">Realized / Gain</span>
                <span />
              </div>
            ) : (
              <div className="hidden md:grid grid-cols-[0.6fr_1.4fr_1.4fr] gap-4 px-5 py-2.5 text-[10.5px] uppercase tracking-[0.07em] font-semibold text-fg-fade border-b border-line">
                <span>Side</span>
                <span>Date</span>
                <span className="text-right">Gain %</span>
              </div>
            )}
            {lots.map((l, i) => {
              const isSell = l.side === "SELL";
              const cost = l.shares * l.purchasePrice;
              const market = !isSell && quote ? l.shares * quote.c : null;
              const gain = market !== null ? market - cost : null;
              const gainPct =
                gain !== null && cost > 0 ? (gain / cost) * 100 : null;
              // Approximate realized gain for sells using portfolio avg cost
              const sellAvgCost = pooled?.avgPrice ?? l.purchasePrice;
              const realizedGain = isSell ? (l.purchasePrice - sellAvgCost) * l.shares : null;
              const realizedPct =
                realizedGain !== null && sellAvgCost > 0
                  ? (realizedGain / (sellAvgCost * l.shares)) * 100
                  : null;
              const sourceLabel = l.importSource === "trading212" ? "T212" : "manual";
              const displayPct = isSell ? realizedPct : gainPct;
              const displayGain = isSell ? realizedGain : gain;
              return (
                <div
                  key={l.id}
                  className={`grid gap-4 px-5 py-3.5 hover:bg-bg-3 transition ${
                    i !== lots.length - 1 ? "border-b border-line" : ""
                  } ${
                    isOwner
                      ? "grid-cols-[1fr_auto] md:grid-cols-[0.6fr_1.1fr_0.9fr_0.9fr_0.9fr_1.1fr_1.3fr_0.3fr]"
                      : "grid-cols-[1fr_auto] md:grid-cols-[0.6fr_1.4fr_1.4fr]"
                  }`}
                >
                  {/* Side badge — desktop */}
                  <span className="hidden md:inline-flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-tag ${
                        isSell ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"
                      }`}
                    >
                      {isSell ? "SELL" : "BUY"}
                    </span>
                    {isOwner && (
                      <span className="ml-0.5 text-[10.5px] text-fg-fade px-1.5 py-px border border-line rounded-tag font-medium">
                        {sourceLabel}
                      </span>
                    )}
                  </span>
                  {/* Date + mobile summary */}
                  <div className="flex flex-col">
                    <span className="num text-sm flex items-center gap-2">
                      <span className="md:hidden">
                        <span
                          className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-tag ${
                            isSell ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"
                          }`}
                        >
                          {isSell ? "SELL" : "BUY"}
                        </span>
                      </span>
                      {new Date(l.purchaseDate).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    {isOwner && (
                      <span className={`text-xs text-fg-fade md:hidden mt-0.5 ${isSell ? "text-neg" : ""}`}>
                        {fmtShares(l.shares)} @ {fmtMoney(l.purchasePrice)}
                      </span>
                    )}
                  </div>

                  {/* Owner-only columns */}
                  {isOwner && (
                    <>
                      {/* Shares */}
                      <span className="num text-sm text-right hidden md:block truncate text-fg-dim tabular-nums">
                        {fmtShares(l.shares)}
                      </span>
                      {/* Price */}
                      <span className="num text-sm text-right hidden md:block truncate text-fg-dim tabular-nums">
                        {fmtMoney(l.purchasePrice)}
                      </span>
                      {/* Total (cost or proceeds) */}
                      <span
                        className="num text-sm text-right hidden md:block truncate text-fg-dim tabular-nums"
                        title={isSell ? "Proceeds" : "Cost"}
                      >
                        {fmtMoney(cost)}
                      </span>
                      {/* Market value (buys only) */}
                      <span className="num text-sm text-right hidden md:block truncate text-fg-dim tabular-nums">
                        {isSell ? "—" : market !== null ? fmtMoney(market) : "…"}
                      </span>
                      {/* Realized / Gain — two-line cell */}
                      <span className="text-right hidden md:flex justify-end items-center">
                        {displayGain !== null && displayPct !== null ? (
                          <TwoLinePLCell amount={displayGain} pct={displayPct} />
                        ) : (
                          <span className="text-fg-fade text-sm">{isSell ? "—" : "…"}</span>
                        )}
                      </span>
                      {/* Delete */}
                      <span className="text-right hidden md:flex items-center justify-end">
                        <button
                          onClick={() => handleDelete(l)}
                          className="text-fg-fade hover:text-neg transition"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </span>
                    </>
                  )}

                  {/* Viewer: gain % only (desktop), mobile same */}
                  {!isOwner && (
                    <span
                      className={`num text-sm text-right truncate tabular-nums ${
                        displayPct !== null && displayPct >= 0 ? "text-pos" : displayPct !== null ? "text-neg" : "text-fg-fade"
                      }`}
                    >
                      {displayPct !== null
                        ? fmtPct(displayPct)
                        : "…"}
                    </span>
                  )}

                  {/* Mobile: gain pct only (owner) */}
                  {isOwner && (
                    <span className={`num text-sm text-right md:hidden truncate ${displayGain !== null && displayGain >= 0 ? "text-pos" : displayGain !== null ? "text-neg" : ""}`}>
                      {displayPct !== null ? fmtPct(displayPct) : "…"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  big,
  tone,
  className = "",
}: {
  label: string;
  value: string;
  big?: boolean;
  tone?: "pos" | "neg";
  className?: string;
}) {
  const valueClass = big
    ? "text-[18px] font-semibold tabular-nums"
    : "font-medium tabular-nums";
  const toneClass =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg";
  return (
    <div className={`flex items-baseline gap-1.5 ${className}`}>
      <span className="text-fg-fade text-[11px] uppercase tracking-[0.06em] font-medium">
        {label}
      </span>
      <span className={`${valueClass} ${toneClass}`}>{value}</span>
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
