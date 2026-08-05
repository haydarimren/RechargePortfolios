// src/components/LogbookTable.tsx
"use client";

import { useRouter } from "next/navigation";
import type { TradeLogEntry } from "@/lib/types";
import { fmtShares } from "@/lib/portfolio";
import { fmtMoney } from "@/lib/format";
import { SidePill } from "@/components/SidePill";
import { TwoLinePLCell } from "@/components/TwoLinePLCell";

export function LogbookTable({
  tradeLog,
  isOwner,
  portfolioId,
}: {
  tradeLog: TradeLogEntry[];
  isOwner: boolean;
  portfolioId: string;
}) {
  const router = useRouter();
  if (tradeLog.length === 0) {
    return (
      <div className="card p-10 text-center text-fg-dim text-sm">
        No trades yet.
      </div>
    );
  }
  return isOwner ? (
    <div className="card overflow-hidden">
      <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-2 border-b border-line">
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Date</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Side</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Shares</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Price</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Value</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Realized</span>
      </div>
      {tradeLog.map((t) => {
        const isSell = t.side === "SELL";
        return (
          <div
            key={t.id}
            className="grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_0.9fr_0.7fr_0.8fr_1fr_1.2fr] gap-4 px-5 py-3 border-b border-line last:border-b-0"
          >
            <div className="flex items-center gap-2 md:contents">
              <span className="num text-xs text-fg-dim tabular-nums md:text-sm">
                {t.date}
              </span>
              <SidePill side={t.side} />
              <button
                onClick={() =>
                  router.push(`/p/${portfolioId}/${t.symbol}`)
                }
                className="text-fg font-semibold text-sm tracking-tight hover:text-accent transition text-left"
              >
                {t.symbol}
              </button>
            </div>
            <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
              {fmtShares(t.shares)}
            </span>
            <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
              {fmtMoney(t.price)}
            </span>
            <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
              {fmtMoney(t.value)}
              {isSell && (
                <span className="text-fg-fade ml-1">proceeds</span>
              )}
            </span>
            <div className="flex items-center justify-end">
              {t.realizedGain === undefined ? (
                <span className="num text-xs text-fg-fade tabular-nums">—</span>
              ) : (
                <TwoLinePLCell
                  amount={t.realizedGain}
                  pct={(t.realizedPct ?? 0) * 100}
                  currency="USD"
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  ) : (
    <div className="card overflow-hidden">
      <div className="hidden md:grid grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-2 border-b border-line">
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Date</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Side</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade">Symbol</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Weight</span>
        <span className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade text-right">Realized</span>
      </div>
      {tradeLog.map((t) => (
        <div
          key={t.id}
          className="grid grid-cols-[1fr_auto] md:grid-cols-[0.9fr_0.6fr_1fr_0.9fr_0.9fr] gap-4 px-5 py-3 items-center border-b border-line last:border-b-0"
        >
          <div className="flex items-center gap-2 md:contents">
            <span className="num text-xs text-fg-dim tabular-nums md:text-sm">
              {t.date}
            </span>
            <SidePill side={t.side} />
            <button
              onClick={() =>
                router.push(`/p/${portfolioId}/${t.symbol}`)
              }
              className="text-fg font-semibold text-sm tracking-tight hover:text-accent transition text-left"
            >
              {t.symbol}
            </button>
          </div>
          <span className="num text-xs text-right text-fg-dim tabular-nums hidden md:block">
            {(t.symbolWeightAfter * 100).toFixed(1)}%
          </span>
          <div className="flex items-center justify-end">
            {t.realizedPct === undefined ? (
              <span className="num text-xs text-fg-fade tabular-nums">—</span>
            ) : (
              <span className={`num text-xs tabular-nums font-semibold ${t.realizedPct >= 0 ? "text-pos" : "text-neg"}`}>
                {t.realizedPct >= 0 ? "+" : ""}{(t.realizedPct * 100).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
