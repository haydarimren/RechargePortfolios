/**
 * Aggregate "what moved today" from per-position USD market values and the
 * quote's day-percent (`StockQuote.dp`). Backing out the previous-close
 * basis from `market / (1 + dp/100)` reuses the existing USD conversion —
 * converting the raw `d` (native-currency change) separately would open a
 * second FX path that could disagree with the market values on screen.
 *
 * Positions without a price or a day-percent are excluded, mirroring how
 * `unpricedSymbols` excludes them from totals and allocation.
 */

export interface TodayChangeInput {
  /** USD market value, or null when the position is unpriced. */
  market: number | null;
  /** Quote day change in percent (StockQuote.dp), or null when absent. */
  dp: number | null;
}

export interface TodayChange {
  usd: number;
  pct: number;
  pricedCount: number;
}

export function computeTodayChange(
  rows: TodayChangeInput[],
): TodayChange | null {
  let usd = 0;
  let prevTotal = 0;
  let pricedCount = 0;
  for (const r of rows) {
    if (r.market === null || r.dp === null) continue;
    if (!isFinite(r.market) || !isFinite(r.dp)) continue;
    // dp ≤ -100 would put the previous basis at or below zero — junk data.
    if (r.dp <= -100) continue;
    const prev = r.market / (1 + r.dp / 100);
    usd += r.market - prev;
    prevTotal += prev;
    pricedCount += 1;
  }
  if (pricedCount === 0) return null;
  return { usd, pct: prevTotal > 0 ? (usd / prevTotal) * 100 : 0, pricedCount };
}
