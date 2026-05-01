// src/components/FriendPortfolioCard.tsx
"use client";

import Link from "next/link";

export interface FriendPortfolioCardSummary {
  id: string;
  name: string;
  pctVsBenchmark: number;   // e.g. 12.4
  positionsCount: number;
  ytdPct: number;           // overall portfolio YTD %, allowed for shared viewers
}

export function FriendPortfolioCard({
  summary,
  href,
}: {
  summary: FriendPortfolioCardSummary;
  href: string;
}) {
  const positive = summary.pctVsBenchmark >= 0;
  const arrow = positive ? "↑" : "↓";
  const sign = positive ? "+" : "";
  return (
    <Link
      href={href}
      className="flex flex-col bg-bg-2 border border-line rounded-[12px] p-[18px] min-h-[140px] hover:border-line-strong transition-colors"
    >
      <div className="text-[13.5px] font-semibold text-fg mb-3.5 tracking-tight">
        {summary.name}
      </div>
      <div className={`text-[28px] font-semibold leading-none tracking-tight tabular-nums ${positive ? "text-pos" : "text-neg"}`}>
        {arrow} {Math.abs(summary.pctVsBenchmark).toFixed(1)}%
      </div>
      <div className="text-[11px] text-fg-fade font-medium mt-1.5">vs SPY · YTD</div>
      <div className="flex-1" />
      <div className="border-t border-line mt-3.5 pt-3 text-[12px] text-fg-mid font-medium tabular-nums flex items-center justify-between">
        <span>{summary.positionsCount} positions</span>
        <span className={summary.ytdPct >= 0 ? "text-pos" : "text-neg"}>
          {sign}{summary.ytdPct.toFixed(1)}% YTD
        </span>
      </div>
    </Link>
  );
}
