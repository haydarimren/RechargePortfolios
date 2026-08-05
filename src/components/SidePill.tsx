// src/components/SidePill.tsx
"use client";

export function SidePill({ side }: { side: "BUY" | "SELL" }) {
  const isSell = side === "SELL";
  return isSell ? (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-tag bg-neg-soft text-neg">
      SELL
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-tag bg-pos-soft text-pos">
      BUY
    </span>
  );
}
