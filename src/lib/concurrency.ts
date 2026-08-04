/**
 * Tiny worker-pool helper shared by the per-symbol insight fetchers
 * (`yahoo-insights.ts`, `finnhub-recs.ts`). Kept out of both so neither
 * has to own a copy — and out of any `"use server"` module, which may only
 * export async functions.
 */

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
