import { describe, it, expect } from "vitest";
import { shouldSync, THROTTLE_MS } from "./auto-sync";

const NOW = 1_000_000_000_000;

describe("shouldSync", () => {
  it("syncs when never synced and not in flight", () => {
    expect(shouldSync({ now: NOW, lastSyncAt: null, inFlight: false })).toBe(true);
  });
  it("skips when in flight", () => {
    expect(shouldSync({ now: NOW, lastSyncAt: null, inFlight: true })).toBe(false);
  });
  it("skips inside the throttle window", () => {
    expect(shouldSync({ now: NOW, lastSyncAt: NOW - (THROTTLE_MS - 1), inFlight: false })).toBe(false);
  });
  it("syncs at exactly the throttle boundary", () => {
    expect(shouldSync({ now: NOW, lastSyncAt: NOW - THROTTLE_MS, inFlight: false })).toBe(true);
  });
  it("force bypasses the window but never an in-flight sync", () => {
    expect(shouldSync({ now: NOW, lastSyncAt: NOW, inFlight: false, force: true })).toBe(true);
    expect(shouldSync({ now: NOW, lastSyncAt: NOW, inFlight: true, force: true })).toBe(false);
  });
});

describe("THROTTLE_MS", () => {
  it("is 15 minutes", () => {
    expect(THROTTLE_MS).toBe(15 * 60 * 1000);
  });
});
