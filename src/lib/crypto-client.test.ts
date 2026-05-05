import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  generateMasterSecret,
  wrapMasterSecretWithPassword,
  unwrapMasterSecretWithPassword,
  generateLocalWrapKey,
  wrapMasterSecretLocally,
  unwrapMasterSecretLocally,
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
  encryptJson,
  decryptJson,
  encryptT212Secret,
  decryptT212Secret,
  encryptBrokerCredential,
  decryptBrokerCredential,
  inspectBrokerCredential,
  __testOnlyEncryptLegacyBareCredential,
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

describe("master secret + localWrapKey (Option B daily unlock)", () => {
  it("round-trips under the same localWrapKey", async () => {
    const secret = generateMasterSecret();
    const key = await generateLocalWrapKey();
    const wrapped = await wrapMasterSecretLocally(secret, key);
    const unwrapped = await unwrapMasterSecretLocally(wrapped, key);
    expect(unwrapped).toEqual(secret);
  });

  it("fails under a different localWrapKey", async () => {
    const secret = generateMasterSecret();
    const k1 = await generateLocalWrapKey();
    const k2 = await generateLocalWrapKey();
    const wrapped = await wrapMasterSecretLocally(secret, k1);
    await expect(unwrapMasterSecretLocally(wrapped, k2)).rejects.toThrow();
  });

  it("localWrapKey is non-extractable — cannot export raw bytes", async () => {
    const key = await generateLocalWrapKey();
    // Web Crypto throws on exportKey of a non-extractable key. This is
    // the property that makes the IndexedDB-on-disk attacker unable to
    // read the wrapping key out of a JS environment they control.
    await expect(
      globalThis.crypto.subtle.exportKey("raw", key),
    ).rejects.toThrow();
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
      brokerOrderId: "abc123",
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

describe("encryptJson / decryptJson", () => {
  it("round-trips arbitrary JSON values under a portfolio key", async () => {
    const key = await generatePortfolioKey();
    const value = {
      timestamp: 1234567890,
      buys: 3,
      sells: 1,
      errors: ["broker API error 429"],
      nested: { ok: true, items: [1, 2, 3] },
    };
    const ct = await encryptJson(value, key);
    expect(await decryptJson(ct, key)).toEqual(value);
  });

  it("round-trips primitive values too", async () => {
    const key = await generatePortfolioKey();
    expect(await decryptJson(await encryptJson("hello", key), key)).toBe("hello");
    expect(await decryptJson(await encryptJson(42, key), key)).toBe(42);
    expect(await decryptJson(await encryptJson(null, key), key)).toBe(null);
  });
});

describe("broker credential encryption", () => {
  it("round-trips the new {brokerId, credential} shape", async () => {
    const master = generateMasterSecret();
    const ct = await encryptBrokerCredential(
      { brokerId: "alpaca", credential: "PKABC:SECRET" },
      master,
    );
    expect(await decryptBrokerCredential(ct, master)).toEqual({
      brokerId: "alpaca",
      credential: "PKABC:SECRET",
    });
  });

  it("decrypts a genuinely-legacy bare-string credential as trading212", async () => {
    // Reproduces the pre-multi-broker on-disk shape via the test-only
    // primitive. The new decrypt path must still surface it as a
    // canonical {brokerId, credential} object — that's the migration's
    // forward-compat guarantee.
    const master = generateMasterSecret();
    const ct = await __testOnlyEncryptLegacyBareCredential(
      "legacy-key:legacy-secret",
      master,
    );
    expect(await decryptBrokerCredential(ct, master)).toEqual({
      brokerId: "trading212",
      credential: "legacy-key:legacy-secret",
    });
  });

  it("decryptT212Secret still returns the bare credential string for back-compat", async () => {
    const master = generateMasterSecret();
    // Even when the underlying payload is the new object shape, the
    // legacy wrapper must keep returning the credential half so any
    // call site that hasn't been updated still works.
    const ct = await encryptBrokerCredential(
      { brokerId: "trading212", credential: "key:secret" },
      master,
    );
    expect(await decryptT212Secret(ct, master)).toBe("key:secret");
  });

  it("fails under a different master secret", async () => {
    const m1 = generateMasterSecret();
    const m2 = generateMasterSecret();
    const ct = await encryptBrokerCredential(
      { brokerId: "trading212", credential: "x:y" },
      m1,
    );
    await expect(decryptBrokerCredential(ct, m2)).rejects.toThrow();
  });

  it("inspectBrokerCredential reports origin: canonical for new payloads", async () => {
    const master = generateMasterSecret();
    const ct = await encryptBrokerCredential(
      { brokerId: "alpaca", credential: "PK:SK" },
      master,
    );
    const inspected = await inspectBrokerCredential(ct, master);
    expect(inspected.origin).toBe("canonical");
    expect(inspected.payload).toEqual({ brokerId: "alpaca", credential: "PK:SK" });
  });

  it("inspectBrokerCredential reports origin: legacy for bare-string payloads", async () => {
    const master = generateMasterSecret();
    const ct = await __testOnlyEncryptLegacyBareCredential(
      "legacy-key:legacy-secret",
      master,
    );
    const inspected = await inspectBrokerCredential(ct, master);
    expect(inspected.origin).toBe("legacy");
    expect(inspected.payload).toEqual({
      brokerId: "trading212",
      credential: "legacy-key:legacy-secret",
    });
  });

  it("encryptT212Secret upgrades-on-write — its output is canonical, not legacy", async () => {
    // Confirms the deliberate behavior of the legacy wrapper: it now
    // writes the new shape. Means once this code ships, no fresh writes
    // produce the legacy form anywhere.
    const master = generateMasterSecret();
    const ct = await encryptT212Secret("k:s", master);
    const inspected = await inspectBrokerCredential(ct, master);
    expect(inspected.origin).toBe("canonical");
  });
});

// SnapTrade no longer has its own crypto helpers — credentials live
// in the per-portfolio `secrets/credentials` envelope alongside T212
// and Alpaca, exercised through encryptBrokerCredential /
// decryptBrokerCredential above. Nothing SnapTrade-specific to test
// in the crypto layer.
