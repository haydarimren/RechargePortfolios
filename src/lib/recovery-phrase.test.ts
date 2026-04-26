import { describe, it, expect } from "vitest";
import { seedToPhrase, phraseToSeed } from "./recovery-phrase";

describe("recovery-phrase", () => {
  it("round-trips random 16-byte seeds", async () => {
    for (let i = 0; i < 20; i++) {
      const seed = new Uint8Array(16);
      globalThis.crypto.getRandomValues(seed);
      const phrase = await seedToPhrase(seed);
      const recovered = await phraseToSeed(phrase);
      expect(recovered).toEqual(seed);
    }
  });

  it("produces a 12-word phrase", async () => {
    const seed = new Uint8Array(16);
    const phrase = await seedToPhrase(seed);
    expect(phrase.split(" ")).toHaveLength(12);
  });

  it("BIP39 official test vector — all-zero entropy yields the canonical phrase", async () => {
    // 16 bytes of 0x00 → "abandon abandon ... about" (the most-cited BIP39
    // reference vector). Confirms our encoding matches the standard.
    const seed = new Uint8Array(16);
    expect(await seedToPhrase(seed)).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
  });

  it("BIP39 official test vector — all-FF entropy yields the canonical phrase", async () => {
    const seed = new Uint8Array(16).fill(0xff);
    expect(await seedToPhrase(seed)).toBe(
      "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    );
  });

  it("rejects non-16-byte input", async () => {
    await expect(seedToPhrase(new Uint8Array(15))).rejects.toThrow();
    await expect(seedToPhrase(new Uint8Array(17))).rejects.toThrow();
  });

  it("rejects wrong word count", async () => {
    await expect(phraseToSeed("abandon abandon")).rejects.toThrow();
  });

  it("rejects unknown words", async () => {
    await expect(
      phraseToSeed(
        "notaword abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).rejects.toThrow(/unknown word/);
  });

  it("rejects bad checksum (typo)", async () => {
    // Take a valid phrase and swap the last word — checksum will mismatch.
    await expect(
      phraseToSeed(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
      ),
    ).rejects.toThrow(/checksum/);
  });

  it("tolerates extra whitespace and case", async () => {
    const phrase =
      "  ABANDON  abandon\nabandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT  ";
    const seed = await phraseToSeed(phrase);
    expect(seed).toEqual(new Uint8Array(16));
  });
});
