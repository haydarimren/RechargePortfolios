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

// ---------- T212 secret (encrypted under master secret) ------------------

export async function encryptT212Secret(
  secret: string,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  const key = await deriveAesKeyFromMaster(masterSecret, "t212-secret");
  return aesGcmEncrypt(key, new TextEncoder().encode(secret) as Uint8Array);
}

export async function decryptT212Secret(
  cipher: Ciphertext,
  masterSecret: Uint8Array,
): Promise<string> {
  const key = await deriveAesKeyFromMaster(masterSecret, "t212-secret");
  const bytes = await aesGcmDecrypt(key, cipher);
  return new TextDecoder().decode(bytes);
}
