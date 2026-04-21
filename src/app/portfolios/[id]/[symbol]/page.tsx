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
import { getHistoricalCloses, HistoricalPoint } from "@/lib/yahoo";
import { closeOnOrBefore, fmtShares, poolPositions } from "@/lib/portfolio";
import { ThemeToggle, useChartColors } from "@/lib/theme";
import { ArrowLeft, Trash2 } from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceDot,
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

    const unsubHoldings = onSnapshot(
      collection(db, "portfolios", id, "holdings"),
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Holding, "id">) }))
          .filter((h) => h.symbol === symbol);
        rows.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
        setLots(rows);
      },
      () => {
        setLots([]);
      }
    );

    return () => {
      unsubPortfolio();
      unsubHoldings();
    };
  }, [user, id, symbol]);

  useEffect(() => {
    getQuote(symbol).then(setQuote);
  }, [symbol]);

  useEffect(() => {
    if (lots.length === 0) {
      setHistory([]);
      return;
    }
    const first = lots
      .map((l) => l.purchaseDate)
      .reduce((a, b) => (a < b ? a : b));
    getHistoricalCloses(symbol, new Date(first).getTime(), Date.now()).then(
      setHistory
    );
  }, [lots, symbol]);

  const isOwner = !!(user && portfolio && portfolio.ownerId === user.uid);

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

  const lotMarkers = lots.map((l) => {
    const isSell = l.side === "SELL";
    const price = closeOnOrBefore(history, l.purchaseDate);
    if (price !== null) {
      const matched = history.findLast((p) => p.date <= l.purchaseDate)!;
      return { date: matched.date, price: matched.close, isSell };
    }
    if (history.length > 0) {
      return { date: history[0].date, price: history[0].close, isSell };
    }
    return { date: null, price: null, isSell };
  });

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

  return (
    <div className="min-h-screen">
      <header className="px-6 lg:px-10 pt-6 pb-4 border-b border-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <Link
            href={`/portfolios/${id}`}
            className="text-sm text-fg-dim hover:text-accent transition flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> {portfolio.name}
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-10 space-y-10">
        <section className="animate-fade-up flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="label mb-2">Ticker</div>
            <h1 className="text-5xl md:text-6xl font-semibold tracking-tight">
              {symbol}
            </h1>
            <p className="text-sm text-fg-dim mt-2">
              {isOwner
                ? `${lots.length} lot${lots.length === 1 ? "" : "s"} in ${portfolio.name}`
                : `in ${portfolio.name}`}
            </p>
          </div>
          {quote && (
            <div className="text-right">
              <div className="label mb-1">Last quote</div>
              <div className="num text-3xl md:text-4xl font-medium">
                {quote.c === 0 ? "—" : fmtMoney(quote.c)}
              </div>
              {quote.dp != null && (
                <div
                  className={`num text-sm mt-1 ${
                    quote.dp >= 0 ? "text-pos" : "text-neg"
                  }`}
                >
                  {quote.dp >= 0 ? "+" : ""}
                  {quote.dp.toFixed(2)}% today
                </div>
              )}
            </div>
          )}
        </section>

        {isOwner && positionClosed ? (
          <section
            className="animate-fade-up card p-6 text-center"
            style={{ animationDelay: "60ms" }}
          >
            <div className="label mb-2">Position closed</div>
            <p className="text-sm text-fg-dim">
              All shares of {symbol} have been sold. Transaction history below.
            </p>
          </section>
        ) : isOwner ? (
          <section
            className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-up"
            style={{ animationDelay: "60ms" }}
          >
            <StatCard label="Shares" value={fmtShares(totals.shares)} />
            <StatCard label="Avg cost" value={fmtMoney(totals.avg)} />
            <StatCard
              label="Market value"
              value={totals.market !== null ? fmtMoney(totals.market) : "…"}
            />
            <StatCard
              label="Gain"
              value={
                totals.gain === null
                  ? "…"
                  : `${totals.gain >= 0 ? "+" : ""}${fmtMoney(totals.gain)}`
              }
              sub={totals.gainPct !== null ? fmtPct(totals.gainPct) : undefined}
              tone={
                totals.gain === null
                  ? undefined
                  : totals.gain >= 0
                  ? "pos"
                  : "neg"
              }
            />
          </section>
        ) : (
          <section
            className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-up"
            style={{ animationDelay: "60ms" }}
          >
            <StatCard
              label="Gain"
              value={totals.gainPct !== null ? fmtPct(totals.gainPct) : "…"}
              tone={
                totals.gainPct === null
                  ? undefined
                  : totals.gainPct >= 0
                  ? "pos"
                  : "neg"
              }
            />
          </section>
        )}

        <section
          className="animate-fade-up"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                Price since first purchase
              </h2>
              <p className="text-sm text-fg-dim mt-1">
                Yellow dots mark buys; red dots mark sells.
              </p>
            </div>
          </div>
          <div className="card p-4 sm:p-5">
            <div className="h-[340px]">
              {history.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-fg-dim">
                  Loading history…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
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
                      domain={["auto", "auto"]}
                      tickFormatter={(v) => `$${v.toFixed(0)}`}
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

        {isOwner && (
        <section
          className="animate-fade-up"
          style={{ animationDelay: "200ms" }}
        >
          <div className="mb-4">
            <h2 className="text-xl font-semibold tracking-tight">
              Transaction history
            </h2>
          </div>
          <div className="card overflow-hidden">
            <div className="hidden md:grid grid-cols-[0.5fr_1fr_1fr_1fr_1fr_1.3fr_1.5fr_0.3fr] gap-4 px-5 py-3 label border-b border-line">
              <span>Side</span>
              <span>Date</span>
              <span className="text-right">Shares</span>
              <span className="text-right">Price</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Market</span>
              <span className="text-right">Gain</span>
              <span />
            </div>
            {lots.map((l, i) => {
              const isSell = l.side === "SELL";
              const cost = l.shares * l.purchasePrice;
              const market = !isSell && quote ? l.shares * quote.c : null;
              const gain = market !== null ? market - cost : null;
              const gainPct =
                gain !== null && cost > 0 ? (gain / cost) * 100 : null;
              const tone =
                gain === null ? "" : gain >= 0 ? "text-pos" : "text-neg";
              const rowNumTone = isSell ? "text-neg" : "text-fg-dim";
              return (
                <div
                  key={l.id}
                  className={`grid grid-cols-[1fr_auto] md:grid-cols-[0.5fr_1fr_1fr_1fr_1fr_1.3fr_1.5fr_0.3fr] gap-4 px-5 py-4 hover:bg-bg-3 transition ${
                    i !== lots.length - 1 ? "border-b border-line" : ""
                  }`}
                >
                  <span className="hidden md:inline-flex items-center">
                    <SidePill side={isSell ? "SELL" : "BUY"} />
                  </span>
                  <div className="flex flex-col">
                    <span className="num text-sm flex items-center gap-2">
                      <span className="md:hidden">
                        <SidePill side={isSell ? "SELL" : "BUY"} />
                      </span>
                      {new Date(l.purchaseDate).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <span className={`text-xs text-fg-fade md:hidden mt-0.5 ${isSell ? "text-neg" : ""}`}>
                      {fmtShares(l.shares)} @ {fmtMoney(l.purchasePrice)}
                    </span>
                  </div>
                  <span className={`num text-sm text-right hidden md:block truncate ${rowNumTone}`}>
                    {fmtShares(l.shares)}
                  </span>
                  <span className={`num text-sm text-right hidden md:block truncate ${rowNumTone}`}>
                    {fmtMoney(l.purchasePrice)}
                  </span>
                  <span
                    className={`num text-sm text-right hidden md:block truncate ${rowNumTone}`}
                    title={isSell ? "Proceeds" : "Cost"}
                  >
                    {fmtMoney(cost)}
                  </span>
                  <span className="num text-sm text-right hidden md:block truncate">
                    {isSell ? "—" : market !== null ? fmtMoney(market) : "…"}
                  </span>
                  <span className={`num text-sm text-right ${tone} md:hidden truncate`}>
                    {isSell
                      ? "—"
                      : gain === null
                      ? "…"
                      : `${gain >= 0 ? "+" : ""}${fmtPct(gainPct!)}`}
                  </span>
                  <span
                    className={`num text-sm text-right ${tone} hidden md:block truncate`}
                  >
                    {isSell
                      ? "—"
                      : gain === null
                      ? "…"
                      : `${gain >= 0 ? "+" : ""}${fmtMoney(gain)} · ${fmtPct(
                          gainPct!
                        )}`}
                  </span>
                  <span className="text-right">
                    {isOwner && (
                      <button
                        onClick={() => handleDelete(l)}
                        className="text-fg-fade hover:text-neg transition"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        )}
      </main>
    </div>
  );
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

function StatCard({
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
    <div className="card p-5">
      <div className="label mb-3">{label}</div>
      <div className={`num text-2xl md:text-3xl font-medium ${color}`}>
        {value}
      </div>
      {sub && <div className={`num text-sm mt-1 ${color}`}>{sub}</div>}
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
