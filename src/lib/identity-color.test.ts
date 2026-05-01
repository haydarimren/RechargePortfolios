import { describe, it, expect } from "vitest";
import { identityColorIndex, IDENTITY_PALETTE } from "./identity-color";

describe("identityColorIndex", () => {
  it("is deterministic for the same uid", () => {
    expect(identityColorIndex("alice-uid-123")).toBe(
      identityColorIndex("alice-uid-123"),
    );
  });

  it("returns an index in [0, palette.length)", () => {
    for (const uid of ["a", "bob", "longer-uid-foo-bar", "9j8K2hX7p"]) {
      const idx = identityColorIndex(uid);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(IDENTITY_PALETTE.length);
    }
  });

  it("distributes across at least half the palette over 100 uids", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(identityColorIndex(`user-${i}`));
    expect(seen.size).toBeGreaterThanOrEqual(IDENTITY_PALETTE.length / 2);
  });

  it("treats empty string as a valid input (returns index 0)", () => {
    expect(identityColorIndex("")).toBe(0);
  });
});
