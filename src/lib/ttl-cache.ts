/**
 * TTL cache with in-flight coalescing.
 *
 * Exists because `fetch(url, { next: { revalidate } })` is INERT inside a
 * `"use server"` module — Server Actions are always dynamic and their fetches
 * never reach Next's Data Cache. Measured: two page loads seconds apart issue
 * two full sets of upstream requests, in dev and in a production build alike.
 * `historical-cache.ts` is the same workaround for `yahoo.ts`.
 *
 * Two properties matter beyond plain memoization:
 *
 * - **Coalescing.** Concurrent readers of one key share a single upstream
 *   call, so a component mounting twice (React Strict Mode) or two surfaces
 *   asking for the same symbol cost one request, not two.
 * - **Rejections are never cached.** A rate-limited response must not be
 *   stored as though it were a definitive answer; only a resolved value —
 *   including a legitimate `null` meaning "no coverage" — is retained.
 */

interface Entry<T> { value: T; expiresAt: number }

export interface TtlCache<T> {
  getOrCreate(key: string, factory: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createTtlCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
): TtlCache<T> {
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    getOrCreate(key, factory) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);

      const existing = inFlight.get(key);
      if (existing) return existing;

      const p = factory()
        .then((value) => {
          entries.set(key, { value, expiresAt: now() + ttlMs });
          return value;
        })
        .finally(() => {
          // Always clear, including on rejection — a retained rejected promise
          // would replay the same failure to every future caller.
          inFlight.delete(key);
        });

      inFlight.set(key, p);
      return p;
    },
    size() {
      return entries.size;
    },
  };
}
