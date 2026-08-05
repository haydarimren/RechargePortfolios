"use client";

import type { TradeLogEntry } from "@/lib/types";
import { SidePill } from "@/components/SidePill";
import { fmtMoney } from "@/lib/format";

/** "2026-08-04" → "Aug 4". UTC parse keeps the date stable across zones. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function LogbookCard({
  trades,
  totalCount,
  isOwner,
  onViewAll,
  onPickSymbol,
}: {
  /** Already sliced newest-first (pickRecentTrades output). */
  trades: TradeLogEntry[];
  totalCount: number;
  isOwner: boolean;
  onViewAll: () => void;
  onPickSymbol: (symbol: string) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="text-[13.5px] font-semibold">Logbook</span>
        <span className="num text-xs text-fg-fade">
          {totalCount} trade{totalCount === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        {totalCount > 0 && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-xs font-medium text-accent hover:underline"
          >
            View all →
          </button>
        )}
      </div>
      {trades.length === 0 ? (
        <div className="p-10 text-center text-sm text-fg-dim">
          No trades yet.
        </div>
      ) : (
        trades.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 text-xs last:border-b-0"
          >
            <span className="num w-[46px] shrink-0 text-fg-fade">
              {shortDate(t.date)}
            </span>
            <SidePill side={t.side} />
            <button
              type="button"
              onClick={() => onPickSymbol(t.symbol)}
              className="flex-1 truncate text-left text-[12.5px] font-semibold tracking-tight text-fg hover:text-accent transition"
            >
              {t.symbol}
            </button>
            {isOwner ? (
              <span className="num text-fg-mid">{fmtMoney(t.value)}</span>
            ) : (
              <span className="num text-fg-mid">
                {(t.symbolWeightAfter * 100).toFixed(1)}%
              </span>
            )}
            {t.realizedPct !== undefined ? (
              <span
                className={`num w-[52px] shrink-0 text-right font-semibold ${
                  t.realizedPct >= 0 ? "text-pos" : "text-neg"
                }`}
              >
                {t.realizedPct >= 0 ? "+" : ""}
                {(t.realizedPct * 100).toFixed(1)}%
              </span>
            ) : (
              <span className="num w-[52px] shrink-0 text-right text-fg-fade">
                —
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}
