"use client";

/**
 * Read-only %-view rendered purely from a SnapshotV1 — the share-link
 * tier. Fetches live quotes + benchmark closes itself and computes the
 * percentages client-side (parity with the friend view; see
 * share-links-math.ts). Renders no dollar amounts anywhere by
 * construction: the input data doesn't contain any.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getQuotes, type StockQuote } from "@/lib/finnhub";
import { getCachedHistoricalCloses } from "@/lib/historical-cache";
import type { HistoricalPoint } from "@/lib/yahoo";
import {
  extendSeries,
  headlineFromSnapshot,
  liveRowsFromSnapshot,
  type SnapshotV1,
} from "@/lib/share-links-math";
import { useChartColors } from "@/lib/theme";
import { PerformancePill } from "@/components/PerformancePill";

export function SnapshotPortfolioView({
  snapshot,
  banner,
  footer,
}: {
  snapshot: SnapshotV1;
  /** Optional banner above the content (e.g. "full view pending"). */
  banner?: React.ReactNode;
  /** Optional footer slot (e.g. the Follow button block). */
  footer?: React.ReactNode;
}) {
  const chartColors = useChartColors();
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({});
  // Fetched curve extension, keyed to the snapshot it was computed for —
  // a stale tail (from a previous snapshot) is simply ignored by the
  // memo below instead of being reset synchronously in the effect.
  const [tail, setTail] = useState<{
    forSnapshot: SnapshotV1;
    points: SnapshotV1["series"];
  } | null>(null);
  const extended = useMemo(
    () =>
      tail && tail.forSnapshot === snapshot && tail.points.length > 0
        ? [...snapshot.series.slice(0, -1), ...tail.points]
        : snapshot.series,
    [snapshot, tail],
  );

  // Live quotes, keyed back to display symbols (the app-wide pattern).
  useEffect(() => {
    const symbols = snapshot.positions.map((p) => p.symbol);
    if (symbols.length === 0) return;
    const apiSymbols = snapshot.positions.map((p) => p.yahooSymbol ?? p.symbol);
    let cancelled = false;
    const fetchAll = () => {
      getQuotes(apiSymbols).then((map) => {
        if (cancelled) return;
        const rekeyed: Record<string, StockQuote | null> = {};
        symbols.forEach((s, i) => {
          rekeyed[s] = map[apiSymbols[i]] ?? null;
        });
        setQuotes(rekeyed);
      });
    };
    fetchAll();
    const interval = setInterval(fetchAll, 120_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [snapshot]);

  // Extend the normalized curve from asOf → today with public closes.
  useEffect(() => {
    if (snapshot.series.length === 0) return;
    const lastDate = snapshot.series[snapshot.series.length - 1].date;
    const fromMs = new Date(lastDate).getTime() - 14 * 24 * 60 * 60 * 1000;
    const toMs = Date.now();
    let cancelled = false;
    Promise.all([
      Promise.all(
        snapshot.positions.map((p) =>
          getCachedHistoricalCloses(p.yahooSymbol ?? p.symbol, fromMs, toMs).then(
            (pts) => [p.yahooSymbol ?? p.symbol, pts] as const,
          ),
        ),
      ),
      getCachedHistoricalCloses("SPY", fromMs, toMs),
      getCachedHistoricalCloses("QQQ", fromMs, toMs),
    ]).then(([symbolPts, SPY, QQQ]) => {
      if (cancelled) return;
      const priceMap: Record<string, HistoricalPoint[]> = {};
      for (const [sym, pts] of symbolPts) priceMap[sym] = pts;
      setTail({
        forSnapshot: snapshot,
        points: extendSeries(snapshot, priceMap, { SPY, QQQ }),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  const rows = useMemo(
    () => liveRowsFromSnapshot(snapshot, quotes),
    [snapshot, quotes],
  );
  const headline = useMemo(
    () => headlineFromSnapshot(snapshot, quotes),
    [snapshot, quotes],
  );
  const vsSpy = useMemo(() => {
    const last = extended[extended.length - 1];
    if (!last || typeof last.SPY !== "number") return null;
    return last.portfolio - last.SPY;
  }, [extended]);

  return (
    <div className="space-y-8">
      {banner}
      <section>
        <h1 className="text-[26px] font-semibold tracking-tight text-fg leading-tight">
          {snapshot.name}
        </h1>
        <div className="mt-2 text-[12.5px] text-fg-mid">
          by {snapshot.ownerName}
          <span className="text-line-strong mx-2">·</span>
          <span className="text-fg-fade num">
            as of{" "}
            {new Date(snapshot.asOf).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </span>
        </div>
      </section>

      <div className="flex items-baseline gap-[18px] flex-wrap py-5 border-b border-line">
        <PerformancePill
          pct={headline.gainPct}
          benchmark="vs cost"
          className="text-base px-3.5 py-1.5"
        />
        {vsSpy !== null && <PerformancePill pct={vsSpy} benchmark="vs SPY" />}
        <div className="ml-auto text-[13px] text-fg-mid tabular-nums">
          <span className="text-fg-fade text-xs uppercase tracking-[0.06em] font-medium mr-1">
            Positions
          </span>
          {snapshot.positions.length}
        </div>
      </div>

      {extended.length > 0 && (
        <div className="card p-4 sm:p-5">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart
                data={extended}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="snapport" x1="0" y1="0" x2="0" y2="1">
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
                />
                <YAxis
                  stroke={chartColors.axis}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`}
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
                      ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
                      : String(v)
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12, color: chartColors.axis }} />
                <Area
                  name="Portfolio"
                  type="monotone"
                  dataKey="portfolio"
                  stroke={chartColors.portfolio}
                  strokeWidth={2}
                  fill="url(#snapport)"
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
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="hidden md:grid grid-cols-[1fr_1fr_1fr] gap-4 px-5 py-2 border-b border-line">
          <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">
            Symbol
          </span>
          <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">
            Allocation
          </span>
          <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">
            Gain
          </span>
        </div>
        {rows.map((row) => (
          <div
            key={row.symbol}
            className="grid grid-cols-[1fr_auto_auto] md:grid-cols-[1fr_1fr_1fr] gap-4 px-5 py-4 border-b border-line last:border-b-0"
          >
            <span className="text-fg font-semibold tracking-tight">
              {row.symbol}
            </span>
            <span className="num text-sm text-right text-fg-dim tabular-nums">
              {row.allocationPct !== null
                ? `${row.allocationPct.toFixed(1)}%`
                : "…"}
            </span>
            <span
              className={`num text-sm text-right tabular-nums ${
                row.gainPct === null
                  ? ""
                  : row.gainPct >= 0
                    ? "text-pos"
                    : "text-neg"
              }`}
            >
              {row.gainPct === null
                ? "…"
                : `${row.gainPct >= 0 ? "+" : ""}${row.gainPct.toFixed(2)}%`}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="p-10 text-center text-fg-dim text-sm">
            No positions yet.
          </div>
        )}
      </div>

      {footer}
    </div>
  );
}
