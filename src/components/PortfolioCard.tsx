// src/components/PortfolioCard.tsx
"use client";

import Link from "next/link";
import { InitialChip } from "./InitialChip";
import { PerformancePill } from "./PerformancePill";
import { FriendStack } from "./FriendStack";

export interface PortfolioCardSummary {
  id: string;
  name: string;
  ownerUid: string;
  ownerDisplayName?: string;
  totalValue: number;            // absolute USD
  pctVsBenchmark: number;        // e.g. 12.4
  benchmarkLabel?: string;       // "vs SPY" by default
  positionsCount: number;
  pl: { amount: number; pct: number };
  followers: { uid: string; displayName?: string }[];
}

export function PortfolioCard({
  summary,
  href,
}: {
  summary: PortfolioCardSummary;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col bg-bg-2 border border-line rounded-card p-5 pb-4 min-h-[240px] hover:border-line-strong transition-all hover:-translate-y-px"
    >
      <div className="flex items-center gap-3 mb-5">
        <InitialChip uid={summary.ownerUid} displayName={summary.ownerDisplayName} size={30} />
        <div className="text-[14.5px] font-semibold text-fg tracking-tight">{summary.name}</div>
      </div>

      <div className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-fg mb-3">
        ${formatBig(summary.totalValue)}
      </div>
      <PerformancePill pct={summary.pctVsBenchmark} benchmark={summary.benchmarkLabel ?? "vs SPY"} />

      <div className="border-t border-line mt-5 pt-3" />

      <div className="flex gap-7 mb-4">
        <Stat label="Positions" value={String(summary.positionsCount)} />
        <Stat
          label="P/L"
          value={`${summary.pl.amount >= 0 ? "+" : "−"}$${formatBig(Math.abs(summary.pl.amount))}`}
          tone={summary.pl.amount >= 0 ? "pos" : "neg"}
        />
      </div>

      <FriendStack people={summary.followers} label={`${summary.followers.length} friends following`} emptyLabel="Not shared yet" />
    </Link>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`text-[13px] font-medium tabular-nums ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg"}`}>{value}</div>
      <div className="text-[10px] tracking-[0.1em] uppercase font-medium text-fg-fade">{label}</div>
    </div>
  );
}

function formatBig(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}
