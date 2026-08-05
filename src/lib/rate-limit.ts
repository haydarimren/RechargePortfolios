/**
 * Rate-limit response handling for the insight fetchers.
 *
 * Finnhub's free tier allows 60 requests/minute and answers an overshoot with
 * HTTP 429 plus `x-ratelimit-reset` — an absolute epoch-second stamp for when
 * the window reopens. Observed windows are seconds, not the full minute, so a
 * short bounded wait usually clears it.
 */

/**
 * Milliseconds to wait before retrying, or `null` for "don't retry".
 *
 * Retries only on 429: any other failure is either permanent (403 on a
 * listing outside the free tier) or not helped by waiting. Returns `null`
 * when the reset is further out than `capMs` — holding a server action open
 * for most of a minute is worse than letting the next page view try again,
 * and because failures are never cached, that retry costs nothing.
 */
export function retryDelayMs(
  status: number,
  resetHeader: string | null,
  nowMs: number,
  capMs: number,
): number | null {
  if (status !== 429) return null;
  if (!resetHeader) return null;
  const resetSeconds = Number(resetHeader);
  if (!Number.isFinite(resetSeconds)) return null;
  const waitMs = resetSeconds * 1000 - nowMs;
  if (waitMs <= 0) return 0;         // window already reopened
  if (waitMs > capMs) return null;   // too far out to be worth blocking on
  return waitMs;
}
