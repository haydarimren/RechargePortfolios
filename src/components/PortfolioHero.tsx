"use client";

import { PerformancePill } from "@/components/PerformancePill";
import { fmtMoney, formatBig } from "@/lib/format";
import type { TodayChange } from "@/lib/today-change";

export interface BenchVerdict {
  bench: string; // "SPY" | "QQQ"
  /** Portfolio ahead (+) / behind (−) the hypothetical, in percent. */
  diffPct: number;
}

function TodayPill({ today, showUsd }: { today: TodayChange; showUsd: boolean }) {
  const flat = Math.abs(today.pct) < 0.005 && Math.abs(today.usd) < 0.005;
  const pos = today.usd >= 0;
  const tone = flat
    ? "text-fg-dim bg-bg-2 border border-line"
    : pos
      ? "text-pos bg-pos-soft"
      : "text-neg bg-neg-soft";
  const sign = pos ? "+" : "−";
  return (
    <span
      className={`num inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-[12.5px] font-semibold ${tone}`}
    >
      today{" "}
      {showUsd && (
        <>
          {sign}${formatBig(Math.abs(today.usd))} ·{" "}
        </>
      )}
      {sign}
      {Math.abs(today.pct).toFixed(2)}%
    </span>
  );
}

function VerdictChip({ v }: { v: BenchVerdict }) {
  const ahead = v.diffPct >= 0;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-bg-2 px-2.5 py-1 text-[12.5px] text-fg-mid">
      vs {v.bench}
      <span
        className={`num font-semibold ${ahead ? "text-pos" : "text-neg"}`}
      >
        {ahead ? "+" : "−"}
        {Math.abs(v.diffPct).toFixed(1)}% {ahead ? "ahead" : "behind"}
      </span>
    </span>
  );
}

export function PortfolioHero({
  isOwner,
  totals,
  positionsCount,
  sinceDate,
  today,
  verdicts,
  viewerVsSpyPct,
  chart,
  spark,
}: {
  isOwner: boolean;
  totals: { market: number; gain: number; gainPct: number };
  positionsCount: number;
  sinceDate: string | null;
  today: TodayChange | null;
  verdicts: BenchVerdict[];
  /** Viewer hero only: portfolio-minus-SPY normalized % (null → hide). */
  viewerVsSpyPct: number | null;
  /** Desktop benchmark chart (rendered ≥ lg). */
  chart: React.ReactNode;
  /** Mobile sparkline button (rendered < lg). */
  spark: React.ReactNode;
}) {
  return (
    <div className="mb-4 border-b border-line pb-5">
      <div className="lg:grid lg:grid-cols-[1fr_1.25fr] lg:items-stretch lg:gap-7">
        <div className="flex flex-col justify-center gap-3">
          {isOwner ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="num text-[34px] font-semibold leading-none tracking-tight text-fg lg:text-[40px]">
                  {totals.market > 0 ? `$${formatBig(totals.market)}` : "—"}
                </span>
                <span className="lg:hidden">{spark}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PerformancePill pct={totals.gainPct} benchmark="vs cost" />
                {today && <TodayPill today={today} showUsd />}
              </div>
              {verdicts.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {verdicts.map((v) => (
                    <VerdictChip key={v.bench} v={v} />
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-5 text-[12.5px] text-fg-mid">
                <span>
                  <span className="label mr-1.5">P/L</span>
                  <span
                    className={`num font-semibold ${totals.gain >= 0 ? "text-pos" : "text-neg"}`}
                  >
                    {totals.market > 0
                      ? `${totals.gain >= 0 ? "+" : "−"}${fmtMoney(Math.abs(totals.gain))}`
                      : "—"}
                  </span>
                </span>
                <span>
                  <span className="label mr-1.5">Positions</span>
                  <span className="num">{positionsCount}</span>
                </span>
                {sinceDate && (
                  <span>
                    <span className="label mr-1.5">Since</span>
                    <span className="num">{sinceDate.slice(0, 7)}</span>
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PerformancePill
                    pct={totals.gainPct}
                    benchmark="vs cost"
                    className="text-base px-3.5 py-1.5"
                  />
                  {viewerVsSpyPct !== null && (
                    <PerformancePill pct={viewerVsSpyPct} benchmark="vs SPY" />
                  )}
                  {today && <TodayPill today={today} showUsd={false} />}
                </div>
                <span className="lg:hidden">{spark}</span>
              </div>
              <div className="flex flex-wrap gap-5 text-[12.5px] text-fg-mid">
                <span>
                  <span className="label mr-1.5">Positions</span>
                  <span className="num">{positionsCount}</span>
                </span>
              </div>
            </>
          )}
        </div>
        <div className="hidden min-w-0 lg:block">{chart}</div>
      </div>
    </div>
  );
}
