import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout, TimeoutError } from "./concurrency";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the underlying value when it settles before the deadline", async () => {
    const d = deferred<string>();
    const p = withTimeout(d.promise, 1000);
    d.resolve("snapshot");
    await expect(p).resolves.toBe("snapshot");
  });

  it("rejects with TimeoutError once the deadline passes", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const p = withTimeout(never, 8000);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
  });

  it("propagates the underlying rejection unchanged, not as a TimeoutError", async () => {
    const d = deferred<never>();
    const boom = new Error("permission-denied");
    const p = withTimeout(d.promise, 1000);
    d.reject(boom);
    await expect(p).rejects.toBe(boom);
  });

  it("does not reject after a successful resolution when the deadline later passes", async () => {
    vi.useFakeTimers();
    const d = deferred<number>();
    const p = withTimeout(d.promise, 5000);
    d.resolve(7);
    await expect(p).resolves.toBe(7);
    // Advancing past the deadline must not surface an unhandled rejection.
    await vi.advanceTimersByTimeAsync(6000);
  });
});
