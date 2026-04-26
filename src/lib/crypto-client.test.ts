import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  generateMasterSecret,
  wrapMasterSecretWithPassword,
  unwrapMasterSecretWithPassword,
  generateIdentityKeyPair,
  exportPublicKey,
  importPublicKey,
  wrapPrivateKeyWithMasterSecret,
  unwrapPrivateKeyWithMasterSecret,
  generatePortfolioKey,
  exportPortfolioKey,
  importPortfolioKey,
  wrapPortfolioKeyForRecipient,
  unwrapPortfolioKeyFromSender,
  encryptHolding,
  decryptHolding,
  encryptT212Secret,
  decryptT212Secret,
} from "./crypto-client";

describe("hex helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 0xff, 0x10, 0xab, 0xcd]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
  });

  it("rejects invalid characters", () => {
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("master secret + password wrap", () => {
  it("round-trips with the right password", async () => {
    const secret = generateMasterSecret();
    const wrapped = await wrapMasterSecretWithPassword(secret, "hunter2");
    const unwrapped = await unwrapMasterSecretWithPassword(wrapped, "hunter2");
    expect(unwrapped).toEqual(secret);
  });

  it("fails with the wrong password", async () => {
    const secret = generateMasterSecret();
    const wrapped = await wrapMasterSecretWithPassword(secret, "hunter2");
    await expect(
      unwrapMasterSecretWithPassword(wrapped, "wrong-password"),
    ).rejects.toThrow();
  });

  it("uses a fresh salt per wrap (deterministic password yields different ciphertexts)", async () => {
    const secret = generateMasterSecret();
    const a = await wrapMasterSecretWithPassword(secret, "same-pw");
    const b = await wrapMasterSecretWithPassword(secret, "same-pw");
    expect(a.salt).not.toBe(b.salt);
    expect(a.payload).not.toBe(b.payload);
  });
});

describe("identity keypair", () => {
  it("exports + reimports a public key without losing structure", async () => {
    const kp = await generateIdentityKeyPair();
    const exported = await exportPublicKey(kp.publicKey);
    const reimported = await importPublicKey(exported);
    expect(reimported.algorithm.name).toBe("ECDH");
  });

  it("private key round-trips through master-secret wrap", async () => {
    const kp = await generateIdentityKeyPair();
    const master = generateMasterSecret();
    const wrapped = await wrapPrivateKeyWithMasterSecret(kp.privateKey, master);
    const unwrapped = await unwrapPrivateKeyWithMasterSecret(wrapped, master);
    // Sanity: derive the same shared secret with both unwrapped and original
    // private keys against an arbitrary partner. If the unwrap worked, both
    // wrapping keys produced from ECDH(unwrapped, partnerPub) and
    // ECDH(original, partnerPub) must be the same.
    const partner = await generateIdentityKeyPair();
    const portfolio = await generatePortfolioKey();
    const ct = await wrapPortfolioKeyForRecipient(
      portfolio,
      kp.privateKey,
      partner.publicKey,
    );
    // Unwrap with the recovered private key — must succeed and yield same key
    const recovered = await unwrapPortfolioKeyFromSender(
      ct,
      partner.privateKey,
      // SPKI roundtrip on public key works the same regardless of which
      // private key was used to wrap, because the wrapping key derives from
      // the shared secret (commutative).
      kp.publicKey,
    );
    const orig = await exportPortfolioKey(portfolio);
    const got = await exportPortfolioKey(recovered);
    expect(got).toEqual(orig);
    // And confirm the unwrapped private key works directly
    const ct2 = await wrapPortfolioKeyForRecipient(
      portfolio,
      unwrapped,
      partner.publicKey,
    );
    const recovered2 = await unwrapPortfolioKeyFromSender(
      ct2,
      partner.privateKey,
      kp.publicKey,
    );
    expect(await exportPortfolioKey(recovered2)).toEqual(orig);
  });
});

describe("portfolio key + ECDH wrapping", () => {
  it("owner can wrap, recipient can unwrap, key matches", async () => {
    const owner = await generateIdentityKeyPair();
    const recipient = await generateIdentityKeyPair();
    const portfolio = await generatePortfolioKey();

    const wrapped = await wrapPortfolioKeyForRecipient(
      portfolio,
      owner.privateKey,
      recipient.publicKey,
    );
    const recovered = await unwrapPortfolioKeyFromSender(
      wrapped,
      recipient.privateKey,
      owner.publicKey,
    );

    expect(await exportPortfolioKey(recovered)).toEqual(
      await exportPortfolioKey(portfolio),
    );
  });

  it("third party cannot unwrap with their own private key", async () => {
    const owner = await generateIdentityKeyPair();
    const recipient = await generateIdentityKeyPair();
    const eve = await generateIdentityKeyPair();
    const portfolio = await generatePortfolioKey();

    const wrapped = await wrapPortfolioKeyForRecipient(
      portfolio,
      owner.privateKey,
      recipient.publicKey,
    );
    await expect(
      unwrapPortfolioKeyFromSender(wrapped, eve.privateKey, owner.publicKey),
    ).rejects.toThrow();
  });

  it("portfolio key raw bytes survive export/import", async () => {
    const original = await generatePortfolioKey();
    const raw = await exportPortfolioKey(original);
    const restored = await importPortfolioKey(raw);
    expect(await exportPortfolioKey(restored)).toEqual(raw);
  });
});

describe("holding encryption", () => {
  it("round-trips with all fields preserved", async () => {
    const key = await generatePortfolioKey();
    const plain = {
      symbol: "AAPL",
      shares: 12.5,
      purchasePrice: 145.67,
      purchaseDate: "2024-03-15",
      side: "BUY" as const,
      currency: "USD",
      t212OrderId: "abc123",
    };
    const ct = await encryptHolding(plain, key);
    const recovered = await decryptHolding(ct, key);
    expect(recovered).toEqual(plain);
  });

  it("uses fresh IV per encryption — same plaintext, different ciphertext", async () => {
    const key = await generatePortfolioKey();
    const plain = { symbol: "AAPL", shares: 1, purchasePrice: 1, purchaseDate: "2024-01-01" };
    const a = await encryptHolding(plain, key);
    const b = await encryptHolding(plain, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.payload).not.toBe(b.payload);
  });

  it("decrypt fails with wrong key", async () => {
    const k1 = await generatePortfolioKey();
    const k2 = await generatePortfolioKey();
    const ct = await encryptHolding(
      { symbol: "AAPL", shares: 1, purchasePrice: 1, purchaseDate: "2024-01-01" },
      k1,
    );
    await expect(decryptHolding(ct, k2)).rejects.toThrow();
  });

  it("tampered ciphertext fails authentication", async () => {
    const key = await generatePortfolioKey();
    const ct = await encryptHolding(
      { symbol: "AAPL", shares: 1, purchasePrice: 1, purchaseDate: "2024-01-01" },
      key,
    );
    // Flip one byte in the ciphertext
    const flipped = {
      ...ct,
      payload: ct.payload.slice(0, -2) + (ct.payload.endsWith("0") ? "1" : "0"),
    };
    await expect(decryptHolding(flipped, key)).rejects.toThrow();
  });
});

describe("T212 secret encryption", () => {
  it("round-trips under same master secret", async () => {
    const master = generateMasterSecret();
    const ct = await encryptT212Secret("12345:abcdef", master);
    expect(await decryptT212Secret(ct, master)).toBe("12345:abcdef");
  });

  it("fails under a different master secret", async () => {
    const m1 = generateMasterSecret();
    const m2 = generateMasterSecret();
    const ct = await encryptT212Secret("hello", m1);
    await expect(decryptT212Secret(ct, m2)).rejects.toThrow();
  });
});
