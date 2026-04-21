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
  deleteField,
  writeBatch,
  arrayUnion,
  arrayRemove,
  setDoc,
  getDoc,
  getDocs,
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
  fmtShares,
  poolPositions,
  SeriesPoint,
} from "@/lib/portfolio";
import { ThemeToggle, useChartColors } from "@/lib/theme";
import { useDisplayName } from "@/lib/users";
import { SharePanel } from "@/components/SharePanel";
import { fetchTrading212Orders } from "@/lib/trading212";
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
  const [portfolio, setPortfolio] = useState<(Portfolio & { connectedBrokers?: string[] }) | null>(null);
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
    shares: string;
    purchasePrice: string;
    purchaseDate: string;
    side: "BUY" | "SELL";
  }>({
    symbol: "",
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
        const rows = snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<Holding, "id">) })
        );
        rows.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
        setHoldings(rows);
      },
      () => {
        setHoldings([]);
      }
    );

    return () => {
      unsubPortfolio();
      unsubHoldings();
    };
  }, [user, id]);

  useEffect(() => {
    const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
    if (symbols.length === 0) return;
    let cancelled = false;
    const fetchAll = () => {
      getQuotes(symbols).then((map) => {
        if (cancelled) return;
        setQuotes((prev) => ({ ...prev, ...map }));
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
    const fromMs = new Date(firstDate).getTime();
    const toMs = Date.now();
    const symbols = Array.from(new Set(pooled.map((p) => p.symbol)));
    const chartHoldings = holdings.filter(
      (h) => h.purchaseDate >= firstDate && symbols.includes(h.symbol)
    );

    Promise.all([
      ...symbols.map((s) =>
        getCachedHistoricalCloses(s, fromMs, toMs).then(
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

  // Normalized series (indexed to 100 at the first non-zero portfolio value).
  // Used for the non-owner view so absolute $ are not revealed.
  const normalizedSeries = useMemo(() => {
    if (series.length === 0) return [];
    const baseIdx = series.findIndex((p) => p.portfolio > 0);
    if (baseIdx === -1) return [];
    const base = series[baseIdx];
    const baseP = base.portfolio;
    const baseSPY = typeof base.SPY === "number" && base.SPY > 0 ? base.SPY : null;
    const baseQQQ = typeof base.QQQ === "number" && base.QQQ > 0 ? base.QQQ : null;
    return series.slice(baseIdx).map((p) => {
      const spy = typeof p.SPY === "number" ? p.SPY : null;
      const qqq = typeof p.QQQ === "number" ? p.QQQ : null;
      const point: SeriesPoint = {
        date: p.date,
        portfolio: (p.portfolio / baseP) * 100,
      };
      if (baseSPY && spy !== null) point.SPY = (spy / baseSPY) * 100;
      if (baseQQQ && qqq !== null) point.QQQ = (qqq / baseQQQ) * 100;
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

    await addDoc(collection(db, "portfolios", id, "holdings"), {
      symbol: form.symbol.trim().toUpperCase(),
      shares,
      purchasePrice: price,
      purchaseDate: form.purchaseDate,
      createdAt: Date.now(),
      side: form.side,
    });
    setForm({
      symbol: "",
      shares: "",
      purchasePrice: "",
      purchaseDate: new Date().toISOString().split("T")[0],
      side: "BUY",
    });
    setShowAdd(false);
  };

  const handleSync = async (provider: string, keyOverride?: string) => {
    if (!portfolio) return;
    const portfolioRef = doc(db, "portfolios", id);
    const secretRef = doc(db, "portfolios", id, "secrets", provider);
    let key = keyOverride;
    if (!key) {
      const secretSnap = await getDoc(secretRef);
      key = secretSnap.exists() ? (secretSnap.data().value as string) : undefined;
    }
    if (!key) {
      setSyncError("No credentials — reconnect.");
      return;
    }
    setSyncLoading(provider);
    setSyncError("");
    const errors: string[] = [];
    let buys = 0;
    let sells = 0;
    let skipped = 0;
    try {
      if (keyOverride) {
        await setDoc(secretRef, { value: keyOverride, updatedAt: Date.now() });
        await updateDoc(portfolioRef, {
          connectedBrokers: arrayUnion(provider),
          [`brokerKeys.${provider}`]: deleteField(),
        });
      }
      let result: Awaited<ReturnType<typeof fetchTrading212Orders>>;
      if (provider === "trading212") {
        result = await fetchTrading212Orders(key);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      // Fresh read to avoid stale closure on holdings
      const currentSnap = await getDocs(collection(db, "portfolios", id, "holdings"));
      const currentHoldings: Holding[] = currentSnap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Holding, "id">) })
      );

      const batch = writeBatch(db);
      const holdingsCol = collection(db, "portfolios", id, "holdings");
      for (const order of result.orders) {
        const byId = currentHoldings.some(
          (h) =>
            h.importSource === "trading212" &&
            h.t212OrderId === order.id
        );
        const byShape =
          !byId &&
          currentHoldings.some(
            (h) =>
              !h.t212OrderId &&
              h.symbol === order.symbol &&
              h.purchaseDate === order.purchaseDate &&
              Math.abs(h.shares - order.shares) < 0.0001
          );
        if (byId || byShape) { skipped++; continue; }
        const holdingData: Record<string, unknown> = {
          symbol: order.symbol,
          shares: order.shares,
          purchasePrice: order.purchasePrice,
          purchaseDate: order.purchaseDate,
          createdAt: Date.now(),
          importSource: provider,
          t212OrderId: order.id,
          side: order.side,
        };
        if (order.currency) holdingData.currency = order.currency;
        batch.set(doc(holdingsCol), holdingData);
        if (order.side === "SELL") sells++;
        else buys++;
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
        await addDoc(collection(db, "portfolios", id, "syncLogs"), {
          provider,
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
    await deleteDoc(doc(db, "portfolios", id, "secrets", provider));
    await updateDoc(doc(db, "portfolios", id), {
      connectedBrokers: arrayRemove(provider),
      [`brokerKeys.${provider}`]: deleteField(),
    });
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

  return (
    <div className="min-h-screen">
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
                    : "% return indexed to 100 at first investment, vs hypothetical SPY / QQQ."}
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
                  <ResponsiveContainer width="100%" height="100%">
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
                            : `${v.toFixed(0)}`
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
                              : `${v.toFixed(1)}`
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

        {/* Positions */}
        <section className="animate-fade-up" style={{ animationDelay: "200ms" }}>
          <div className="mb-4">
            <h2 className="text-xl font-semibold tracking-tight">Positions</h2>
            <p className="text-sm text-fg-dim mt-1">
              Click a row to see lot history and price chart.
            </p>
          </div>

          {positions.length === 0 ? (
            <div className="card p-10 text-center text-fg-dim text-sm">
              No holdings yet.
            </div>
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
              <div className="hidden md:grid grid-cols-[1fr_0.8fr_0.9fr_0.9fr_1fr_1.1fr_1.4fr_0.5fr] gap-4 px-5 py-3 label border-b border-line">
                <span>Symbol</span>
                <span className="text-right">Shares</span>
                <span className="text-right">Avg cost</span>
                <span className="text-right">Current</span>
                <span className="text-right">Cost</span>
                <span className="text-right">Market</span>
                <span className="text-right">Gain</span>
                <span className="text-right">Lots</span>
              </div>
              {positions.map((p, i) => {
                const q = quotes[p.symbol];
                const market = q ? p.shares * q.c : null;
                const gain = market !== null ? market - p.cost : null;
                const gainPct =
                  gain !== null && p.cost > 0 ? (gain / p.cost) * 100 : null;
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
                    className={`w-full text-left grid grid-cols-[1fr_auto] md:grid-cols-[1fr_0.8fr_0.9fr_0.9fr_1fr_1.1fr_1.4fr_0.5fr] gap-4 px-5 py-4 hover:bg-bg-3 transition group ${
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
            {(portfolio.connectedBrokers ?? []).length > 0 && (
              <div className="mb-5">
                <div className="label mb-3">Connected brokers</div>
                <ul className="space-y-2">
                  {(portfolio.connectedBrokers ?? []).map((provider) => {
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
                      (b) => !(portfolio.connectedBrokers ?? []).includes(b)
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
              sharedWith={portfolio.sharedWith}
              onClose={() => setShowShare(false)}
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
