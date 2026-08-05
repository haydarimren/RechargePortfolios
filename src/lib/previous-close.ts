/**
 * Previous-session close, derived from a chart's daily bars.
 *
 * Yahoo's `meta.chartPreviousClose` is the close *before the chart's range
 * begins* — with `range=5d` that is roughly a week back, so computing a day
 * change against it reports a week's move. Measured 2026-08-05 on MU:
 * chartPreviousClose gave +24.90% while the actual session was +3.40%.
 *
 * The daily bars carry the truth. The last bar is the current session once
 * the market has opened today, so the previous close is the bar before it;
 * outside a session (weekend, pre-open) the last bar is already a completed
 * day and is itself the reference. Bar days are compared in market-local
 * time via `gmtoffset`, not UTC — a 13:30Z open is the previous UTC day for
 * some venues.
 */

export interface DailyBar {
  /** Bar open time, epoch seconds (Yahoo `timestamp[]`). */
  ts: number;
  /** Bar close in the same units as the quote's current price. */
  close: number;
}

/**
 * @param bars           chronological daily bars, nulls already dropped
 * @param marketTimeSec  `meta.regularMarketTime`, epoch seconds
 * @param gmtOffsetSec   `meta.gmtoffset`, seconds east of UTC
 * @returns the close to measure today's change against, or null when the
 *          bars can't answer (caller falls back to the meta fields)
 */
export function derivePreviousClose(
  bars: DailyBar[],
  marketTimeSec: number,
  gmtOffsetSec: number,
): number | null {
  if (bars.length === 0) return null;
  const localDay = (t: number) => Math.floor((t + gmtOffsetSec) / 86400);
  const last = bars[bars.length - 1];
  if (marketTimeSec > 0 && localDay(last.ts) === localDay(marketTimeSec)) {
    // Last bar is the session in progress (or the one that just closed
    // today) — the reference is the bar before it.
    return bars.length >= 2 ? bars[bars.length - 2].close : null;
  }
  return last.close;
}
