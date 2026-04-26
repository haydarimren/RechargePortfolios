"use client";

/**
 * Encryption-aware abstraction over the `portfolios/{id}/holdings` Firestore
 * subcollection. Hides the difference between legacy plaintext docs and
 * encrypted-payload docs from the rest of the app.
 *
 * Design points:
 *   - A holding doc is "encrypted" when it has a `payload` + `iv` envelope.
 *     Otherwise the plaintext fields (`symbol`, `shares`, ...) live at the
 *     top level — that's the legacy shape and the read path falls through
 *     to it transparently.
 *   - `createdAt` lives at the top level in BOTH shapes (plaintext) so the
 *     trade-notification feature continues to work without forcing
 *     decryption of every doc on every page load.
 *   - `id`, `t212OrderId`, and `importSource` are also kept plaintext so
 *     dedup/lookup queries work without decryption.
 *   - The plaintext-or-encrypted decision is made per-doc, not per-portfolio:
 *     during migration, a portfolio briefly contains a mix while the
 *     batch is in flight. This isn't observable to users — migrations are
 *     atomic per portfolio — but the read path tolerates it.
 *
 * Per-portfolio symmetric keys live in `portfolios/{id}/wrappedKeys/{uid}`,
 * each one encrypted under the named user's identity public key. The owner's
 * own wrappedKey is the one we read here. Phase 3 adds per-friend wrapping.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "./firebase";
import type { Holding } from "./types";
import {
  type Ciphertext,
  decryptHolding,
  encryptHolding,
  exportPortfolioKey,
  generatePortfolioKey,
  importPortfolioKey,
  importPublicKey,
  unwrapPortfolioKeyFromSender,
  wrapPortfolioKeyForRecipient,
  type HoldingPlaintext,
} from "./crypto-client";

/** What we store inside `portfolios/{id}/wrappedKeys/{uid}`. */
interface WrappedKeyDoc {
  wrappedKey: Ciphertext;
  /**
   * Public key of whoever performed the wrap. Needed for ECDH unwrap on the
   * recipient side — without it the recipient couldn't derive the shared
   * key. Plaintext hex SPKI.
   */
  wrappedBy: string;
  schemaVersion: number;
}

/** What the encrypted shape of a holding doc looks like in Firestore. */
interface EncryptedHoldingDoc {
  payload: string;
  iv: string;
  createdAt: number;
  schemaVersion: 1;
  // Plaintext lookup fields preserved across the encryption boundary:
  importSource?: string;
  t212OrderId?: string;
}

type RawHoldingDoc = EncryptedHoldingDoc | (Omit<Holding, "id">);

function isEncryptedDoc(d: DocumentData): d is EncryptedHoldingDoc {
  return typeof d.payload === "string" && typeof d.iv === "string";
}

// ---------- portfolio-key management -------------------------------------

/**
 * Look up the current user's wrapped portfolio key. Returns the in-memory
 * unwrapped key, ready for encrypt/decrypt. Throws on any failure — caller
 * decides whether to retry, prompt for unlock, or fall back to plaintext.
 */
export async function loadPortfolioKey(
  portfolioId: string,
  uid: string,
  userPrivateKey: CryptoKey,
): Promise<CryptoKey> {
  const ref = doc(db, "portfolios", portfolioId, "wrappedKeys", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error("no wrapped key for this user on this portfolio");
  }
  const data = snap.data() as WrappedKeyDoc;
  const senderPub = await importPublicKey(data.wrappedBy);
  return unwrapPortfolioKeyFromSender(
    data.wrappedKey,
    userPrivateKey,
    senderPub,
  );
}

/**
 * Generate a fresh K_portfolio, wrap it under the supplied user's public
 * key, and write the wrappedKey doc. Returns the in-memory key for
 * immediate use. Used during initial creation and during migration.
 */
export async function provisionPortfolioKey(
  portfolioId: string,
  uid: string,
  userPrivateKey: CryptoKey,
  userPublicKey: CryptoKey,
  userPublicKeyHex: string,
): Promise<CryptoKey> {
  const k = await generatePortfolioKey();
  const wrapped = await wrapPortfolioKeyForRecipient(
    k,
    userPrivateKey,
    userPublicKey,
  );
  const refDoc: WrappedKeyDoc = {
    wrappedKey: wrapped,
    wrappedBy: userPublicKeyHex,
    schemaVersion: 1,
  };
  await setDoc(
    doc(db, "portfolios", portfolioId, "wrappedKeys", uid),
    refDoc,
  );
  return k;
}

/**
 * Wrap an existing K_portfolio for an additional recipient (a friend).
 * Idempotent — re-wrapping is fine; the new doc supersedes the old.
 */
export async function wrapPortfolioKeyForUser(
  portfolioId: string,
  recipientUid: string,
  recipientPublicKeyHex: string,
  portfolioKey: CryptoKey,
  ownerPrivateKey: CryptoKey,
  ownerPublicKeyHex: string,
): Promise<void> {
  const recipientPub = await importPublicKey(recipientPublicKeyHex);
  const wrapped = await wrapPortfolioKeyForRecipient(
    portfolioKey,
    ownerPrivateKey,
    recipientPub,
  );
  const refDoc: WrappedKeyDoc = {
    wrappedKey: wrapped,
    wrappedBy: ownerPublicKeyHex,
    schemaVersion: 1,
  };
  await setDoc(
    doc(db, "portfolios", portfolioId, "wrappedKeys", recipientUid),
    refDoc,
  );
}

// ---------- decoding holding docs ----------------------------------------

/**
 * Decode one Firestore holding doc into an app-level `Holding`. If the doc
 * is encrypted, attempts to decrypt with `key`. If decryption fails (wrong
 * key, tampered, schema mismatch), returns null — caller decides whether
 * to surface this or just hide the row.
 */
export async function decodeHolding(
  snap: QueryDocumentSnapshot,
  key: CryptoKey | null,
): Promise<Holding | null> {
  const d = snap.data();
  if (isEncryptedDoc(d)) {
    if (!key) return null;
    try {
      const plain = await decryptHolding({ payload: d.payload, iv: d.iv }, key);
      return mergePlainAndPlaintextFields(snap.id, d, plain);
    } catch {
      return null;
    }
  }
  // Legacy plaintext doc — pass through.
  return { id: snap.id, ...(d as Omit<Holding, "id">) };
}

function mergePlainAndPlaintextFields(
  id: string,
  encrypted: EncryptedHoldingDoc,
  plain: HoldingPlaintext,
): Holding {
  return {
    id,
    createdAt: encrypted.createdAt,
    importSource: encrypted.importSource,
    t212OrderId: encrypted.t212OrderId,
    symbol: plain.symbol,
    shares: plain.shares,
    purchasePrice: plain.purchasePrice,
    purchaseDate: plain.purchaseDate,
    side: plain.side,
    currency: plain.currency,
    isin: plain.isin,
    yahooSymbol: plain.yahooSymbol,
  };
}

// ---------- subscribe / write helpers ------------------------------------

export interface HoldingsSubscription {
  unsubscribe: () => void;
}

/**
 * Subscribe to a portfolio's holdings, transparently decrypting encrypted
 * docs with `key` (which may be null for portfolios that aren't yet
 * encrypted — in which case only legacy plaintext docs surface).
 *
 * Decoded rows are sorted by purchaseDate ascending to match the existing
 * portfolio page rendering order.
 */
export function subscribeHoldings(
  portfolioId: string,
  key: CryptoKey | null,
  onUpdate: (holdings: Holding[]) => void,
  onError?: (err: unknown) => void,
): HoldingsSubscription {
  const unsub = onSnapshot(
    collection(db, "portfolios", portfolioId, "holdings"),
    async (snap) => {
      try {
        const decoded = await Promise.all(
          snap.docs.map((d) => decodeHolding(d, key)),
        );
        const filtered = decoded.filter((h): h is Holding => h !== null);
        filtered.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
        onUpdate(filtered);
      } catch (err) {
        onError?.(err);
      }
    },
    (err) => {
      onError?.(err);
      onUpdate([]);
    },
  );
  return { unsubscribe: unsub };
}

/**
 * Add a new holding. If `key` is provided, writes the encrypted shape;
 * otherwise writes the legacy plaintext shape (for pre-migration
 * portfolios).
 */
export async function addHolding(
  portfolioId: string,
  key: CryptoKey | null,
  plain: HoldingPlaintext & { createdAt: number; t212OrderId?: string; importSource?: string },
): Promise<void> {
  if (key) {
    const ct = await encryptHolding(stripPlaintextOnly(plain), key);
    const docPayload: EncryptedHoldingDoc = {
      payload: ct.payload,
      iv: ct.iv,
      createdAt: plain.createdAt,
      schemaVersion: 1,
    };
    if (plain.t212OrderId) docPayload.t212OrderId = plain.t212OrderId;
    if (plain.importSource) docPayload.importSource = plain.importSource;
    await addDoc(
      collection(db, "portfolios", portfolioId, "holdings"),
      docPayload,
    );
    return;
  }
  // Legacy path
  const data: Record<string, unknown> = { ...plain };
  await addDoc(collection(db, "portfolios", portfolioId, "holdings"), data);
}

/** Decrypted-data fields only, dropping fields that live plaintext. */
function stripPlaintextOnly(
  full: HoldingPlaintext & { createdAt?: number; t212OrderId?: string; importSource?: string },
): HoldingPlaintext {
  return {
    symbol: full.symbol,
    shares: full.shares,
    purchasePrice: full.purchasePrice,
    purchaseDate: full.purchaseDate,
    side: full.side,
    currency: full.currency,
    isin: full.isin,
    yahooSymbol: full.yahooSymbol,
  };
}

/**
 * Update an encrypted holding's secret fields. Caller passes the patch as
 * partial plaintext (typically backfilling `yahooSymbol` after a T212 sync
 * realises the stored symbol is stale). Implementation: read the doc,
 * decrypt, merge, re-encrypt, update.
 *
 * For pre-migration plaintext docs, falls through to a normal updateDoc.
 */
export async function updateHoldingFields(
  portfolioId: string,
  holdingId: string,
  key: CryptoKey | null,
  patch: Partial<HoldingPlaintext>,
): Promise<void> {
  const ref = doc(db, "portfolios", portfolioId, "holdings", holdingId);
  if (!key) {
    await updateDoc(ref, patch);
    return;
  }
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const d = snap.data();
  if (!isEncryptedDoc(d)) {
    // Doc is somehow plaintext despite key being available — keep it as-is
    // and update plaintext fields.
    await updateDoc(ref, patch);
    return;
  }
  const current = await decryptHolding({ payload: d.payload, iv: d.iv }, key);
  const merged: HoldingPlaintext = { ...current, ...patch };
  const ct = await encryptHolding(merged, key);
  await updateDoc(ref, { payload: ct.payload, iv: ct.iv });
}

// ---------- migration ----------------------------------------------------

/**
 * One-shot migration: take a portfolio with plaintext holdings and convert
 * everything to ciphertext. Generates K_portfolio, wraps for owner, and
 * re-encrypts every holding doc in a single batch.
 *
 * Idempotent in the safe direction — calling on an already-encrypted
 * portfolio returns early. Not safe to call concurrently from multiple
 * tabs (would race the wrappedKey doc + the holding rewrites). For our 5–6
 * users this isn't worth defending against.
 *
 * On failure, the portfolio is left in a half-migrated state: K_portfolio
 * may exist on the wrappedKeys subcollection but holdings are still
 * plaintext. Re-running the migration is safe (the existing wrappedKey is
 * overwritten with a fresh one — but then the freshly encrypted holdings
 * use the new key, which matches the wrappedKey, so reads work).
 */
export async function migratePortfolioToEncrypted(
  portfolioId: string,
  uid: string,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  publicKeyHex: string,
): Promise<{ migrated: number; alreadyEncrypted: number }> {
  // Are we already done?
  const portfolioRef = doc(db, "portfolios", portfolioId);
  const portfolioSnap = await getDoc(portfolioRef);
  const portfolioData = portfolioSnap.data() ?? {};
  if (portfolioData.encrypted === true) {
    return { migrated: 0, alreadyEncrypted: 1 };
  }

  // Provision (or refresh) the per-portfolio key for the owner.
  const portfolioKey = await provisionPortfolioKey(
    portfolioId,
    uid,
    privateKey,
    publicKey,
    publicKeyHex,
  );

  // Pull all holding docs once. We filter out anything that's already in
  // the encrypted shape — in the unlikely event of a partial prior run.
  const holdingsCol = collection(db, "portfolios", portfolioId, "holdings");
  const snap = await getDocs(holdingsCol);

  const batch = writeBatch(db);
  let migrated = 0;
  let alreadyEncrypted = 0;
  for (const d of snap.docs) {
    const data = d.data();
    if (isEncryptedDoc(data)) {
      alreadyEncrypted++;
      continue;
    }
    const plain: HoldingPlaintext = {
      symbol: data.symbol,
      shares: data.shares,
      purchasePrice: data.purchasePrice,
      purchaseDate: data.purchaseDate,
      side: data.side,
      currency: data.currency,
      isin: data.isin,
      yahooSymbol: data.yahooSymbol,
      importSource: data.importSource,
      t212OrderId: data.t212OrderId,
    };
    const ct = await encryptHolding(stripPlaintextOnly(plain), portfolioKey);
    const newShape: EncryptedHoldingDoc = {
      payload: ct.payload,
      iv: ct.iv,
      createdAt: data.createdAt ?? Date.now(),
      schemaVersion: 1,
    };
    if (data.t212OrderId) newShape.t212OrderId = data.t212OrderId;
    if (data.importSource) newShape.importSource = data.importSource;

    // Replacement: delete plaintext fields by writing a fresh doc shape.
    // Firestore's `set` (without merge) atomically swaps the doc contents,
    // so we don't need to enumerate the deletes individually.
    batch.set(d.ref, newShape);
    migrated++;
  }

  // Mark the portfolio fully encrypted as part of the same batch.
  batch.update(portfolioRef, { encrypted: true });

  await batch.commit();

  // Export the key into raw bytes; we don't return it here but caller may
  // pass `portfolioKey` to subsequent operations within the same session.
  await exportPortfolioKey(portfolioKey);
  return { migrated, alreadyEncrypted };
}
