import { describe, it, expect } from "vitest";
import { createTtlCache } from "./ttl-cache";

/** Deferred promise so a test can hold a factory open and observe coalescing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createTtlCache", () => {
  it("calls the factory once and serves the second read from cache", async () => {
    let calls = 0;
    const cache = createTtlCache<number>(1000);
    const factory = async () => { calls++; return 42; };
    expect(await cache.getOrCreate("a", factory)).toBe(42);
    expect(await cache.getOrCreate("a", factory)).toBe(42);
    expect(calls).toBe(1);
  });

  it("refetches once the entry is older than the TTL", async () => {
    let now = 0;
    let calls = 0;
    const cache = createTtlCache<number>(1000, () => now);
    const factory = async () => { calls++; return calls; };
    expect(await cache.getOrCreate("a", factory)).toBe(1);
    now = 999;
    expect(await cache.getOrCreate("a", factory)).toBe(1);  // still fresh
    now = 1001;
    expect(await cache.getOrCreate("a", factory)).toBe(2);  // expired
    expect(calls).toBe(2);
  });

  it("coalesces concurrent reads of the same key into one factory call", async () => {
    let calls = 0;
    const d = deferred<string>();
    const cache = createTtlCache<string>(1000);
    const factory = () => { calls++; return d.promise; };

    const a = cache.getOrCreate("k", factory);
    const b = cache.getOrCreate("k", factory);
    const c = cache.getOrCreate("k", factory);
    expect(calls).toBe(1);

    d.resolve("value");
    expect(await Promise.all([a, b, c])).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
  });

  it("keeps separate keys independent", async () => {
    let calls = 0;
    const cache = createTtlCache<string>(1000);
    const factory = async () => { calls++; return "x"; };
    await Promise.all([cache.getOrCreate("a", factory), cache.getOrCreate("b", factory)]);
    expect(calls).toBe(2);
  });

  // The whole point of the rewrite: a 429 must never be cached as if it were
  // a definitive "no data" answer.
  it("does not cache a rejected factory", async () => {
    let calls = 0;
    const cache = createTtlCache<string>(1000);
    const failing = async () => { calls++; throw new Error("429"); };
    await expect(cache.getOrCreate("a", failing)).rejects.toThrow("429");
    await expect(cache.getOrCreate("a", failing)).rejects.toThrow("429");
    expect(calls).toBe(2);
  });

  it("recovers on the next call after a rejection", async () => {
    const cache = createTtlCache<string>(1000);
    await expect(cache.getOrCreate("a", async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(await cache.getOrCreate("a", async () => "ok")).toBe("ok");
  });

  it("clears the in-flight entry when the factory rejects", async () => {
    const cache = createTtlCache<string>(1000);
    const d = deferred<string>();
    const first = cache.getOrCreate("a", () => d.promise);
    d.reject(new Error("nope"));
    await expect(first).rejects.toThrow("nope");
    // A stuck in-flight promise would replay the rejection forever.
    expect(await cache.getOrCreate("a", async () => "recovered")).toBe("recovered");
  });

  it("caches a null result, since 'no coverage' is a real answer", async () => {
    let calls = 0;
    const cache = createTtlCache<string | null>(1000);
    const factory = async () => { calls++; return null; };
    expect(await cache.getOrCreate("a", factory)).toBeNull();
    expect(await cache.getOrCreate("a", factory)).toBeNull();
    expect(calls).toBe(1);
  });
});
