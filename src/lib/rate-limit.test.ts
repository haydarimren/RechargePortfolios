import { describe, it, expect } from "vitest";
import { retryDelayMs } from "./rate-limit";

const NOW = 1_785_887_000_000;          // ms
const NOW_S = Math.floor(NOW / 1000);   // the units Finnhub's reset header uses

describe("retryDelayMs", () => {
  it("returns null for a successful response", () => {
    expect(retryDelayMs(200, String(NOW_S + 5), NOW, 5000)).toBeNull();
  });

  it("returns null for a non-429 failure — retrying won't help", () => {
    expect(retryDelayMs(403, String(NOW_S + 2), NOW, 5000)).toBeNull();
    expect(retryDelayMs(500, null, NOW, 5000)).toBeNull();
  });

  it("waits until the reset instant on a 429 inside the cap", () => {
    expect(retryDelayMs(429, String(NOW_S + 3), NOW, 5000)).toBe(3000);
  });

  it("returns null when the reset is further out than the cap", () => {
    // Better to give up and let the next page view retry than to hold a
    // server action open for most of a minute.
    expect(retryDelayMs(429, String(NOW_S + 45), NOW, 5000)).toBeNull();
  });

  it("retries immediately when the window has already reset", () => {
    expect(retryDelayMs(429, String(NOW_S - 10), NOW, 5000)).toBe(0);
  });

  it("returns null on a 429 with no usable reset header", () => {
    expect(retryDelayMs(429, null, NOW, 5000)).toBeNull();
    expect(retryDelayMs(429, "not-a-number", NOW, 5000)).toBeNull();
  });

  it("treats a reset exactly at the cap as retryable", () => {
    expect(retryDelayMs(429, String(NOW_S + 5), NOW, 5000)).toBe(5000);
  });
});
