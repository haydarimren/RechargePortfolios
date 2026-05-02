// src/components/PerformancePill.tsx
"use client";

import { ArrowDown, ArrowUp } from "lucide-react";

export interface PerformancePillProps {
  /** Decimal pct, e.g. 12.4 for "+12.4%". Sign drives color + arrow. */
  pct: number;
  /** Right-side label, e.g. "vs SPY". */
  benchmark?: string;
  className?: string;
}

/**
 * `↑ 12.4% vs SPY` (green) or `↓ 4.2% vs SPY` (red). Always
 * `align-self: flex-start` so it hugs its text inside column flexboxes.
 */
export function PerformancePill({
  pct,
  benchmark = "vs SPY",
  className = "",
}: PerformancePillProps) {
  const positive = pct >= 0;
  const Arrow = positive ? ArrowUp : ArrowDown;
  const sign = positive ? "+" : ""; // negative carries its own minus
  const tone = positive
    ? "bg-pos-soft text-pos"
    : "bg-neg-soft text-neg";
  return (
    <span
      className={`self-start inline-flex items-center gap-1 px-2.5 py-1 rounded-pill text-xs font-semibold tabular-nums ${tone} ${className}`}
    >
      <Arrow className="w-3 h-3" aria-hidden />
      <span>
        {sign}
        {pct.toFixed(1)}%
      </span>
      {benchmark ? <span className="font-medium">{benchmark}</span> : null}
    </span>
  );
}
