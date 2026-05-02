// src/components/TwoLinePLCell.tsx
"use client";

export interface TwoLinePLCellProps {
  /** Money value as a number. Sign drives color. */
  amount: number;
  /** Percentage as a number (e.g. 12.4 for "+12.4%"). Sign should match `amount`. */
  pct: number;
  /** Currency formatter ("USD" by default). */
  currency?: string;
  className?: string;
}

const formatMoney = (n: number, currency: string) => {
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(abs);
  return n < 0 ? `−${formatted}` : `+${formatted}`;
};

/**
 * Two-line P/L cell:
 *   +$6,712     ← saturated color
 *   +116.3%     ← same hue at 70% opacity
 */
export function TwoLinePLCell({
  amount,
  pct,
  currency = "USD",
  className = "",
}: TwoLinePLCellProps) {
  const positive = amount >= 0;
  const baseColor = positive ? "text-pos" : "text-neg";
  const sign = positive ? "+" : "";
  return (
    <div className={`inline-flex flex-col items-end leading-tight tabular-nums font-medium ${className}`}>
      <span className={`text-[13px] ${baseColor}`}>{formatMoney(amount, currency)}</span>
      <span className={`text-[11.5px] ${baseColor} opacity-70`}>
        {sign}
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}
