// src/lib/activity-repo.test.ts
import { describe, it, expect } from "vitest";
import {
  generatePortfolioKey,
  encryptActivity,
  decryptActivity,
} from "./crypto-client";

describe("activity payload round-trip", () => {
  it("encodes and decodes a buy event", async () => {
    const key = await generatePortfolioKey();
    const event = {
      kind: "buy" as const,
      occurredAt: 1700000000000,
      actorUid: "alice-uid",
      symbol: "NVDA",
      afterAllocationPct: 8.2,
    };
    const cipher = await encryptActivity(event, key);
    const decoded = await decryptActivity(cipher, key);
    expect(decoded).toEqual(event);
  });

  it("encodes and decodes a sell with realized pct", async () => {
    const key = await generatePortfolioKey();
    const event = {
      kind: "sell" as const,
      occurredAt: 1700000010000,
      actorUid: "alice-uid",
      symbol: "TSLA",
      realizedPct: -4.2,
      afterAllocationPct: 0,
    };
    const cipher = await encryptActivity(event, key);
    const decoded = await decryptActivity(cipher, key);
    expect(decoded).toEqual(event);
  });

  it("encodes and decodes a rename event", async () => {
    const key = await generatePortfolioKey();
    const event = {
      kind: "rename" as const,
      occurredAt: 1700000020000,
      actorUid: "alice-uid",
      newName: "Long Equity",
    };
    const cipher = await encryptActivity(event, key);
    const decoded = await decryptActivity(cipher, key);
    expect(decoded).toEqual(event);
  });

  it("preserves all optional fields when set", async () => {
    const key = await generatePortfolioKey();
    const event = {
      kind: "allocation-change" as const,
      occurredAt: 1700000030000,
      actorUid: "alice-uid",
      symbol: "AAPL",
      beforeAllocationPct: 12.0,
      afterAllocationPct: 9.0,
      positionGainPctSnapshot: 41.4,
    };
    const cipher = await encryptActivity(event, key);
    const decoded = await decryptActivity(cipher, key);
    expect(decoded).toEqual(event);
  });
});
