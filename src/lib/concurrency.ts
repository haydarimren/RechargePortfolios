/**
 * Tiny worker-pool helper shared by the per-symbol insight fetchers
 * (`yahoo-insights.ts`, `finnhub-recs.ts`). Kept out of both so neither
 * has to own a copy — and out of any `"use server"` module, which may only
 * export async functions.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Reject with TimeoutError if `promise` hasn't settled within `ms`.
 * The underlying promise keeps running (Firestore reads can't be
 * cancelled) — callers that render a "still trying" state can let a
 * late success overwrite it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
