/**
 * Client-side cryptographic primitives for end-to-end encrypted portfolios.
 *
 * Everything here uses the Web Crypto API (`globalThis.crypto.subtle`), which
 * is available in modern browsers and in Node 19+. No external crypto deps.
 *
 * The model in plain English:
 *   - Each user has a long-term ECDH P-256 keypair (their "identity key").
 *     Private half stays on device, public half is uploaded to the server.
 *   - Each user has a 16-byte "master secret" generated on signup. It's
 *     encoded as a 12-word BIP39 recovery phrase (see recovery-phrase.ts)
 *     and is the root of all the user's wrapped keys.
 *   - Daily login: master secret is encrypted-at-rest in IndexedDB under a
 *     password-derived key. Decrypted at unlock time only.
 *   - For cross-device recovery: the user's identity private key is stored
 *     server-side, encrypted under the master secret. Server holds only
 *     ciphertext.
 *   - Each portfolio has a fresh AES-GCM-256 key (`K_portfolio`). All
 *     holdings under that portfolio are encrypted with K_portfolio.
 *   - Sharing: K_portfolio is re-wrapped per recipient using ECDH between
 *     the owner's private key and the recipient's public key.
 *
 * Algorithm choices and trade-offs:
 *   - Symmetric: AES-GCM-256, 12-byte random IV per encryption, 16-byte
 *     auth tag. Encoded as `{ payload, iv }` hex strings for Firestore.
 *   - Identity keypair: ECDH P-256. Same curve also supports ECDSA if we
 *     ever need signing.
 *   - Password KDF: **PBKDF2-SHA-256, 600 000 iterations** (OWASP 2023
 *     recommendation). The design doc said Argon2id, but Web Crypto doesn't
 *     ship Argon2 and the goal was zero crypto dependencies. PBKDF2 is
 *     weaker against GPU/ASIC attackers than Argon2id but is the strongest
 *     option that doesn't pull in a wasm bundle. Re-evaluate if we add a
 *     dep budget.
 *
 * Wire format: every ciphertext is a `{ payload: hex, iv: hex }` object.
 * No mixed encodings, no length prefixes. Auth tag lives at the end of
 * `payload` per AES-GCM convention; `subtle.decrypt` extracts it transparently.
 */
const SUBTLE = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("Web Crypto API not available in this environment");
  }
  return c.subtle;
};

const RANDOM = (length: number): Uint8Array => {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
};

// ---------- hex helpers ---------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Odd-length hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("Invalid hex character");
    out[i] = b;
  }
  return out;
}

// ---------- ciphertext envelope -------------------------------------------

/**
 * Standard envelope for any AES-GCM ciphertext we persist. Hex-encoded so
 * Firestore round-trips it cleanly without needing Bytes conversion logic
 * at every read site.
 */
export interface Ciphertext {
  payload: string; // hex(ciphertext + auth tag)
  iv: string; // hex(12 bytes)
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<Ciphertext> {
  const iv = RANDOM(12);
  const ct = await SUBTLE().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { payload: bytesToHex(new Uint8Array(ct)), iv: bytesToHex(iv) };
}

async function aesGcmDecrypt(
  key: CryptoKey,
  cipher: Ciphertext,
): Promise<Uint8Array> {
  const iv = hexToBytes(cipher.iv);
  const ct = hexToBytes(cipher.payload);
  const pt = await SUBTLE().decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

// ---------- master secret -------------------------------------------------

/** 16 bytes of cryptographic randomness — root of all user-side derivations. */
export function generateMasterSecret(): Uint8Array {
  return RANDOM(16);
}

/**
 * Import a 16-byte master secret as an HKDF-able key for deriving subkeys.
 * We don't use this directly for encryption; instead derive purpose-specific
 * AES keys via HKDF.
 */
async function importMasterSecretAsHkdf(
  secret: Uint8Array,
): Promise<CryptoKey> {
  return SUBTLE().importKey(
    "raw",
    secret as BufferSource,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
}

async function deriveAesKeyFromMaster(
  masterSecret: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const base = await importMasterSecretAsHkdf(masterSecret);
  return SUBTLE().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode(info) as BufferSource,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------- device-bound local wrap key ----------------------------------

/**
 * Generate a non-extractable AES-GCM key bound to this browser's IndexedDB.
 * Our analogue to iOS Keychain / Android Keystore: the app can encrypt and
 * decrypt with it, but the raw bytes are never accessible to JavaScript or
 * to anyone reading the IndexedDB file off disk.
 *
 * The key is structured-cloneable so it can be stored in IndexedDB as-is.
 * Browsers keep it in a managed slot — even an attacker reading the disk
 * gets the wrapped blob but can't pull the wrapping key out without
 * exploiting the browser itself.
 *
 * Per-device: every browser profile generates its own localWrapKey on
 * enrollment OR on first recovery-phrase restore. They all wrap the same
 * cross-device master secret. The localWrapKey is purely an at-rest
 * scrambler for this one browser profile.
 *
 * On a future native mobile app, the localWrapKey moves to Keychain /
 * Keystore — same code shape, different backing store. The wire format
 * (wrappedMasterSecret, wrappedPrivateKey, etc.) is platform-agnostic so
 * a recovery-phrase restore works across web ↔ mobile.
 */
export async function generateLocalWrapKey(): Promise<CryptoKey> {
  return SUBTLE().generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: no JS access to raw bytes, ever
    ["encrypt", "decrypt"],
  );
}

export async function wrapMasterSecretLocally(
  masterSecret: Uint8Array,
  localWrapKey: CryptoKey,
): Promise<Ciphertext> {
  return aesGcmEncrypt(localWrapKey, masterSecret);
}

export async function unwrapMasterSecretLocally(
  wrapped: Ciphertext,
  localWrapKey: CryptoKey,
): Promise<Uint8Array> {
  return aesGcmDecrypt(localWrapKey, wrapped);
}

// ---------- password-derived key (legacy, currently unused) ---------------
// Kept around for tests + the option to opt into a paranoid mode later
// (e.g. a settings toggle "require password every session"). The default
// flow uses the localWrapKey path above so daily UX matches WhatsApp.

/** PBKDF2 iteration count. Picked via OWASP 2023 guidance for SHA-256. */
const PBKDF2_ITERATIONS = 600_000;

async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await SUBTLE().importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return SUBTLE().deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Wrap a master secret under a user's encryption password. Returns the
 * envelope plus the salt used (also hex). Caller stores all three in
 * IndexedDB.
 */
export interface PasswordWrappedSecret extends Ciphertext {
  salt: string; // hex(16 bytes)
}

export async function wrapMasterSecretWithPassword(
  masterSecret: Uint8Array,
  password: string,
): Promise<PasswordWrappedSecret> {
  const salt = RANDOM(16);
  const key = await deriveKeyFromPassword(password, salt);
  const env = await aesGcmEncrypt(key, masterSecret);
  return { ...env, salt: bytesToHex(salt) };
}

export async function unwrapMasterSecretWithPassword(
  wrapped: PasswordWrappedSecret,
  password: string,
): Promise<Uint8Array> {
  const salt = hexToBytes(wrapped.salt);
  const key = await deriveKeyFromPassword(password, salt);
  return aesGcmDecrypt(key, wrapped);
}

// ---------- identity keypair (ECDH P-256) ---------------------------------

export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return SUBTLE().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"],
  );
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  // SPKI is the standard public-key encoding; portable across JOSE/PKCS#8 worlds.
  const spki = await SUBTLE().exportKey("spki", publicKey);
  return bytesToHex(new Uint8Array(spki));
}

export async function importPublicKey(hex: string): Promise<CryptoKey> {
  return SUBTLE().importKey(
    "spki",
    hexToBytes(hex) as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

/**
 * Wrap a user's identity private key under their master secret, for
 * server-side storage so they can recover on a new device. Server holds
 * the ciphertext blob and cannot decrypt without the master secret.
 */
export async function wrapPrivateKeyWithMasterSecret(
  privateKey: CryptoKey,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  // PKCS#8 is the standard private-key encoding.
  const pkcs8 = await SUBTLE().exportKey("pkcs8", privateKey);
  const wrapKey = await deriveAesKeyFromMaster(masterSecret, "private-key-wrap");
  return aesGcmEncrypt(wrapKey, new Uint8Array(pkcs8));
}

export async function unwrapPrivateKeyWithMasterSecret(
  wrapped: Ciphertext,
  masterSecret: Uint8Array,
): Promise<CryptoKey> {
  const wrapKey = await deriveAesKeyFromMaster(masterSecret, "private-key-wrap");
  const pkcs8 = await aesGcmDecrypt(wrapKey, wrapped);
  return SUBTLE().importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"],
  );
}

// ---------- per-portfolio key ---------------------------------------------

export async function generatePortfolioKey(): Promise<CryptoKey> {
  return SUBTLE().generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportPortfolioKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await SUBTLE().exportKey("raw", key);
  return new Uint8Array(raw);
}

export async function importPortfolioKey(raw: Uint8Array): Promise<CryptoKey> {
  return SUBTLE().importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

// ---------- wrapping K_portfolio per recipient (ECDH) ---------------------

/**
 * Derive a 256-bit AES-GCM wrapping key from an ECDH shared secret between
 * the owner's private key and the recipient's public key. Both ends of a
 * pair compute the same wrapping key (this is the ECDH symmetry property),
 * which is how the recipient can later unwrap on read.
 */
async function deriveEcdhWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<CryptoKey> {
  return SUBTLE().deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapPortfolioKeyForRecipient(
  portfolioKey: CryptoKey,
  ownerPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<Ciphertext> {
  const wrapKey = await deriveEcdhWrappingKey(
    ownerPrivateKey,
    recipientPublicKey,
  );
  const raw = await exportPortfolioKey(portfolioKey);
  return aesGcmEncrypt(wrapKey, raw);
}

export async function unwrapPortfolioKeyFromSender(
  wrapped: Ciphertext,
  recipientPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
): Promise<CryptoKey> {
  const wrapKey = await deriveEcdhWrappingKey(
    recipientPrivateKey,
    senderPublicKey,
  );
  const raw = await aesGcmDecrypt(wrapKey, wrapped);
  return importPortfolioKey(raw);
}

// ---------- holding encryption -------------------------------------------

/**
 * Plaintext shape of a holding's secret fields. `createdAt` stays plaintext
 * outside this envelope so the trade-notification feature can flag unread
 * trades without forcing decryption of every doc.
 */
export interface HoldingPlaintext {
  symbol: string;
  shares: number;
  purchasePrice: number;
  purchaseDate: string;
  side?: "BUY" | "SELL";
  importSource?: string;
  currency?: string;
  /**
   * SnapTrade-only: which connected brokerage account this holding
   * came from. Lets the lock derivation enforce one-portfolio-one-
   * account granularity (a user with two SnapTrade-connected
   * portfolios shouldn't be able to cross-import). Present iff
   * `importSource === "snaptrade"`.
   */
  snaptradeAccountId?: string;
  /**
   * Broker-agnostic stable order id from the source broker (formerly
   * `t212OrderId` — renamed in the multi-broker migration so the field
   * works for Alpaca, IBKR, etc. Reader path falls back to
   * `t212OrderId` for unmigrated holdings until the eager migration
   * completes.
   */
  brokerOrderId?: string;
  /**
   * @deprecated Use `brokerOrderId`. Kept on the type so legacy
   * payloads still round-trip through encrypt/decrypt. Migration
   * Step 8 renames this to `brokerOrderId` in place.
   */
  t212OrderId?: string;
  isin?: string;
  yahooSymbol?: string;
}

export async function encryptHolding(
  plain: HoldingPlaintext,
  key: CryptoKey,
): Promise<Ciphertext> {
  const json = new TextEncoder().encode(JSON.stringify(plain));
  return aesGcmEncrypt(key, json as Uint8Array);
}

export async function decryptHolding(
  cipher: Ciphertext,
  key: CryptoKey,
): Promise<HoldingPlaintext> {
  const bytes = await aesGcmDecrypt(key, cipher);
  return JSON.parse(new TextDecoder().decode(bytes)) as HoldingPlaintext;
}

// ---------- generic JSON-under-portfolio-key envelope --------------------
// Used by syncLogs and any other per-portfolio JSON record we want
// encrypted at rest. Same crypto primitives as `encryptHolding` but
// the type is generic. Holdings keep their dedicated wrapper because
// the schema versioning + per-doc shape lives in holdings-repo.

export async function encryptJson(
  value: unknown,
  key: CryptoKey,
): Promise<Ciphertext> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  return aesGcmEncrypt(key, json as Uint8Array);
}

export async function decryptJson<T = unknown>(
  cipher: Ciphertext,
  key: CryptoKey,
): Promise<T> {
  const bytes = await aesGcmDecrypt(key, cipher);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------- broker credential (encrypted under master secret) ------------
// Schema: encrypted payload is a JSON object `{ brokerId, credential }`.
// Legacy payloads were a bare credential string with broker identity
// implicit ("trading212"). The decrypt path accepts both shapes; the
// encrypt path always emits the new object shape. Migration Step 7
// rewrites legacy docs in place.

export interface BrokerCredentialPayload {
  brokerId: string;
  credential: string;
}

export async function encryptBrokerCredential(
  payload: BrokerCredentialPayload,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  // Reuses the legacy "t212-secret" HKDF info string so already-
  // encrypted credential docs decrypt without a key rotation. The
  // string is just a labeling parameter; renaming it would invalidate
  // every existing user's credential doc.
  const key = await deriveAesKeyFromMaster(masterSecret, "t212-secret");
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return aesGcmEncrypt(key, json as Uint8Array);
}

/**
 * Decrypt a credential cipher and report which on-disk shape it had.
 * `origin: "canonical"` means the inner JSON was already
 * `{ brokerId, credential }`; `origin: "legacy"` means it was a bare
 * credential string from before the multi-broker fold (treated as
 * `brokerId: "trading212"`). Migrations use this to short-circuit
 * already-canonical docs without an extra round-trip.
 */
export async function inspectBrokerCredential(
  cipher: Ciphertext,
  masterSecret: Uint8Array,
): Promise<{ payload: BrokerCredentialPayload; origin: "canonical" | "legacy" }> {
  const key = await deriveAesKeyFromMaster(masterSecret, "t212-secret");
  const bytes = await aesGcmDecrypt(key, cipher);
  const text = new TextDecoder().decode(bytes);
  // New shape: JSON object with brokerId. Legacy: bare credential string.
  // Detect by attempting JSON.parse and checking shape.
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null
      && typeof parsed === "object"
      && typeof (parsed as { brokerId?: unknown }).brokerId === "string"
      && typeof (parsed as { credential?: unknown }).credential === "string"
    ) {
      return {
        payload: parsed as BrokerCredentialPayload,
        origin: "canonical",
      };
    }
  } catch {
    // Fall through to legacy treatment.
  }
  return {
    payload: { brokerId: "trading212", credential: text },
    origin: "legacy",
  };
}

export async function decryptBrokerCredential(
  cipher: Ciphertext,
  masterSecret: Uint8Array,
): Promise<BrokerCredentialPayload> {
  return (await inspectBrokerCredential(cipher, masterSecret)).payload;
}

// ---------- T212 secret (legacy aliases — kept for transition) -----------
// These wrappers preserve the pre-multi-broker function names so any
// in-flight branches don't break during the migration window. Internal
// callers should prefer `encryptBrokerCredential`/`decryptBrokerCredential`.
// Once all callers move over, these can be deleted.

export async function encryptT212Secret(
  secret: string,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  return encryptBrokerCredential(
    { brokerId: "trading212", credential: secret },
    masterSecret,
  );
}

export async function decryptT212Secret(
  cipher: Ciphertext,
  masterSecret: Uint8Array,
): Promise<string> {
  const { credential } = await decryptBrokerCredential(cipher, masterSecret);
  return credential;
}

// SnapTrade in this app uses a "Bring Your Own credentials" model —
// the user signs up at SnapTrade themselves and pastes their full
// credential set (clientId + consumerKey + userId + userSecret) into
// our connect form. Everything is encrypted into the per-portfolio
// `secrets/credentials` envelope via the existing
// `encryptBrokerCredential`/`decryptBrokerCredential` helpers; there
// is no separate per-user SnapTrade doc. No crypto primitives are
// needed here for SnapTrade.

// ---------- test-only -----------------------------------------------------
//
// These exports exist to let the migration test suite construct the
// genuinely-legacy on-disk shape (a bare credential string, not the
// canonical {brokerId, credential} object). Do not call from production
// code — `encryptBrokerCredential` is the only correct write path.

/**
 * @internal Test-only. Reproduces the pre-multi-broker write shape:
 * the AES-GCM-encrypted bytes are the bare credential string, not
 * a JSON object. Lets tests verify that `inspectBrokerCredential`
 * and the migration both correctly handle ciphertexts produced by
 * older versions of the app.
 */
export async function __testOnlyEncryptLegacyBareCredential(
  bareString: string,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  const key = await deriveAesKeyFromMaster(masterSecret, "t212-secret");
  return aesGcmEncrypt(key, new TextEncoder().encode(bareString) as Uint8Array);
}
