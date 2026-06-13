import { describe, expect, it } from "vitest";
import {
  generateShareToken,
  shareLinkUrl,
  parseShareTokenFromHash,
  tokenHashHex,
  encryptSnapshot,
  decryptSnapshot,
  wrapTokenForOwner,
  unwrapTokenForOwner,
} from "./share-links";
import type { SnapshotV1 } from "./share-links-math";

const SNAP: SnapshotV1 = {
  schemaVersion: 1,
  name: "P",
  ownerName: "O",
  asOf: 1,
  positions: [{ symbol: "AAPL", weightPct: 100, avgCost: 150 }],
  series: [],
};

describe("token + URL", () => {
  it("generates 22-char base64url tokens (16 bytes, no padding)", () => {
    const t = generateShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateShareToken()).not.toBe(t);
  });

  it("URL round-trips through the fragment parser", () => {
    const url = shareLinkUrl("https://app.example", "pid123", "abc_-XYZ12345678901234");
    expect(url).toBe("https://app.example/s/pid123#t=abc_-XYZ12345678901234");
    expect(parseShareTokenFromHash("#t=abc_-XYZ12345678901234")).toBe("abc_-XYZ12345678901234");
    expect(parseShareTokenFromHash("#other=x")).toBeNull();
    expect(parseShareTokenFromHash("")).toBeNull();
  });

  it("tokenHashHex is a stable 64-char hex sha256 of the token string", async () => {
    const h1 = await tokenHashHex("sametoken");
    const h2 = await tokenHashHex("sametoken");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await tokenHashHex("other")).not.toBe(h1);
  });
});

describe("snapshot + owner-token crypto", () => {
  it("snapshot round-trips under the token; wrong token fails", async () => {
    const token = generateShareToken();
    const ct = await encryptSnapshot(SNAP, token);
    const back = await decryptSnapshot(ct, token);
    expect(back).toEqual(SNAP);
    await expect(decryptSnapshot(ct, generateShareToken())).rejects.toThrow();
  });

  it("ownerTokenWrap round-trips under the master secret", async () => {
    const master = new Uint8Array(16).fill(3);
    const token = generateShareToken();
    const wrapped = await wrapTokenForOwner(token, master);
    expect(await unwrapTokenForOwner(wrapped, master)).toBe(token);
    await expect(
      unwrapTokenForOwner(wrapped, new Uint8Array(16).fill(4)),
    ).rejects.toThrow();
  });
});
