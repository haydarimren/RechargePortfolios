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
 *   - In schema v2 (current), every other field — including `importSource`
 *     and `t212OrderId` — lives inside the encrypted `payload`. Schema v1
 *     (legacy) kept those two at the top level for sync-time dedup; they
 *     leaked the broker identity. Eager migration upgrades v1 to v2.
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
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
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

/**
 * Encrypted shape of a holding doc in Firestore.
 *
 * Two schema versions exist in the wild:
 *
 *   - **v1** (legacy): `importSource` and `t212OrderId` lived as plaintext
 *     top-level fields, alongside the encrypted payload. They were kept
 *     plaintext for sync-time dedup before sync orchestration moved
 *     client-side. Their presence leaked the broker identity (e.g.
 *     `"trading212"`) to anyone reading the database.
 *
 *   - **v2** (current): only `{ payload, iv, createdAt, schemaVersion }`
 *     at the top level. All other fields — including importSource and
 *     t212OrderId — live inside the encrypted payload. Server can no
 *     longer infer the broker identity from doc fields.
 *
 * The reader path (`decodeHolding`) handles both versions; the writer
 * path always emits v2. Eager migration on login upgrades v1 docs in
 * place.
 */
interface EncryptedHoldingDoc {
  payload: string;
  iv: string;
  createdAt: number;
  /** `1` for legacy docs (top-level v1 fields may be present);
   *  `2` for current docs (no broker-identifying top-level fields). */
  schemaVersion: 1 | 2;
  /** v1 only — top-level lookup fields preserved during the original
   *  Phase 2 plaintext→ciphertext migration. v2 docs omit these. */
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
  // For v2 docs, importSource/t212OrderId live inside the decrypted
  // payload (i.e. on `plain`). For v1 docs they're at the top level on
  // the encrypted envelope. Take from `plain` first, fall back to the
  // legacy top-level — the eager migration removes the latter eventually.
  return {
    id,
    createdAt: encrypted.createdAt,
    importSource: plain.importSource ?? encrypted.importSource,
    t212OrderId: plain.t212OrderId ?? encrypted.t212OrderId,
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
 * Add a new holding. If `key` is provided, writes the v2 encrypted shape
 * (everything except `createdAt` lives inside the encrypted payload).
 * Otherwise writes the legacy plaintext shape — only used for pre-Phase-2
 * portfolios that haven't been migrated yet.
 */
export async function addHolding(
  portfolioId: string,
  key: CryptoKey | null,
  plain: HoldingPlaintext & { createdAt: number },
): Promise<void> {
  if (key) {
    // v2: importSource and t212OrderId go inside the encrypted payload
    // along with every other holding field. The Firestore doc top level
    // contains nothing that names a broker.
    const { createdAt, ...payloadFields } = plain;
    const ct = await encryptHolding(payloadFields, key);
    const docPayload: EncryptedHoldingDoc = {
      payload: ct.payload,
      iv: ct.iv,
      createdAt,
      schemaVersion: 2,
    };
    await addDoc(
      collection(db, "portfolios", portfolioId, "holdings"),
      docPayload,
    );
    return;
  }
  // Legacy path — pre-migration plaintext portfolios.
  const data: Record<string, unknown> = { ...plain };
  await addDoc(collection(db, "portfolios", portfolioId, "holdings"), data);
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
  // Decrypt + merge. For v1 docs, top-level importSource/t212OrderId are
  // pulled into the merged plaintext so they survive the rewrite — and
  // then we drop them from the top level to upgrade the doc to v2 in one
  // go. For v2 docs, all fields already live inside `current`.
  const current = await decryptHolding({ payload: d.payload, iv: d.iv }, key);
  const merged: HoldingPlaintext = { ...current, ...patch };
  if (!merged.importSource && d.importSource) merged.importSource = d.importSource;
  if (!merged.t212OrderId && d.t212OrderId) merged.t212OrderId = d.t212OrderId;
  const ct = await encryptHolding(merged, key);
  await updateDoc(ref, {
    payload: ct.payload,
    iv: ct.iv,
    schemaVersion: 2,
    importSource: deleteField(),
    t212OrderId: deleteField(),
  });
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
    // v2 shape: every holding field lives inside the encrypted payload.
    // The Firestore doc top level only carries `payload`, `iv`,
    // `createdAt`, `schemaVersion`. Nothing identifies the broker.
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
    const ct = await encryptHolding(plain, portfolioKey);
    const newShape: EncryptedHoldingDoc = {
      payload: ct.payload,
      iv: ct.iv,
      createdAt: data.createdAt ?? Date.now(),
      schemaVersion: 2,
    };
    // Replacement: write a fresh doc shape. Firestore's `set` (without
    // merge) atomically swaps the doc contents, so we don't need to
    // enumerate the deletes individually.
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

/**
 * Upgrade v1 encrypted holdings (top-level `importSource` and
 * `t212OrderId`) to v2 (those fields live inside the encrypted payload,
 * top level only carries `payload`/`iv`/`createdAt`/`schemaVersion`).
 *
 * Idempotent: docs already at v2 are skipped. Safe to re-run; runs in a
 * single Firestore batch when there's anything to migrate.
 */
export async function migrateHoldingsToSchemaV2(
  portfolioId: string,
  portfolioKey: CryptoKey,
): Promise<{ migrated: number }> {
  const holdingsCol = collection(db, "portfolios", portfolioId, "holdings");
  const snap = await getDocs(holdingsCol);
  const batch = writeBatch(db);
  let migrated = 0;
  for (const d of snap.docs) {
    const data = d.data();
    if (!isEncryptedDoc(data)) continue;
    if (data.schemaVersion === 2) continue;
    // v1 → v2: decrypt, fold the top-level lookup fields into the
    // plaintext, re-encrypt, replace the doc shape.
    const current = await decryptHolding(
      { payload: data.payload, iv: data.iv },
      portfolioKey,
    );
    const upgraded: HoldingPlaintext = {
      ...current,
      importSource: current.importSource ?? data.importSource,
      t212OrderId: current.t212OrderId ?? data.t212OrderId,
    };
    const ct = await encryptHolding(upgraded, portfolioKey);
    const newShape: EncryptedHoldingDoc = {
      payload: ct.payload,
      iv: ct.iv,
      createdAt: data.createdAt ?? Date.now(),
      schemaVersion: 2,
    };
    batch.set(d.ref, newShape);
    migrated++;
  }
  if (migrated > 0) {
    await batch.commit();
  }
  return { migrated };
}

/**
 * Server-side legacy doc names used for credentials before this commit.
 * Used only by `migrateLegacyCredentialsDoc` to find a doc that needs
 * renaming.
 */
const LEGACY_CREDENTIAL_DOC_IDS = ["trading212"] as const;

/**
 * Move a legacy `secrets/{provider}` doc to the new generic
 * `secrets/credentials` path. The doc body is already-encrypted ciphertext
 * (we don't re-encrypt). The provider name is preserved inside the
 * payload — callers know which broker to talk to once they decrypt.
 *
 * Idempotent: if `secrets/credentials` already exists OR no legacy doc
 * exists, returns without touching anything.
 */
export async function migrateLegacyCredentialsDoc(
  portfolioId: string,
): Promise<{ migrated: boolean }> {
  const newRef = doc(db, "portfolios", portfolioId, "secrets", "credentials");
  const newSnap = await getDoc(newRef);
  if (newSnap.exists()) return { migrated: false };
  for (const legacyId of LEGACY_CREDENTIAL_DOC_IDS) {
    const oldRef = doc(db, "portfolios", portfolioId, "secrets", legacyId);
    const oldSnap = await getDoc(oldRef);
    if (!oldSnap.exists()) continue;
    const data = oldSnap.data();
    // Carry over the existing fields verbatim, plus stamp the provider
    // (the legacy doc ID was the provider name).
    await setDoc(newRef, { ...data, provider: legacyId });
    await deleteDoc(oldRef);
    return { migrated: true };
  }
  return { migrated: false };
}

/**
 * Drop the deprecated `connectedBrokers` field from a portfolio doc.
 * Idempotent — `FieldValue.delete()` on an absent field is a no-op.
 */
export async function clearLegacyConnectedBrokers(
  portfolioId: string,
): Promise<void> {
  const ref = doc(db, "portfolios", portfolioId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  if (!("connectedBrokers" in data)) return;
  await updateDoc(ref, { connectedBrokers: deleteField() });
}

/**
 * Eager-on-login orchestrator. Called once per session from the home page
 * when the user is unlocked. Walks every portfolio the user owns and
 * brings each up to date with all current schema migrations:
 *
 *   1. Phase 2 (existing): plaintext → ciphertext if needed.
 *   2. v1 → v2 upgrade for any encrypted holding still on v1.
 *   3. Legacy `secrets/trading212` → `secrets/credentials` rename.
 *   4. Drop the deprecated `connectedBrokers` field from portfolio docs.
 *
 * All four are idempotent; users who're already current pay only a small
 * read cost (one getDoc per portfolio per migration check).
 *
 * Failures on individual portfolios are logged and don't stop the rest.
 * The next call to this function will retry — there's nothing destructive
 * about partial completion.
 */
export async function runEagerMigrations(
  uid: string,
  ownedPortfolios: Array<{ id: string; encrypted?: boolean }>,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  publicKeyHex: string,
): Promise<void> {
  for (const p of ownedPortfolios) {
    try {
      // Step 1: plaintext → encrypted, if not yet.
      if (!p.encrypted) {
        await migratePortfolioToEncrypted(
          p.id,
          uid,
          privateKey,
          publicKey,
          publicKeyHex,
        );
      }
      // Step 2: v1 → v2 holding-shape upgrade. Only meaningful for
      // already-encrypted portfolios. We need K_portfolio for this.
      const portfolioKey = await loadPortfolioKey(p.id, uid, privateKey);
      await migrateHoldingsToSchemaV2(p.id, portfolioKey);
      // Step 3: secrets doc path rename.
      await migrateLegacyCredentialsDoc(p.id);
      // Step 4: drop deprecated portfolio field.
      await clearLegacyConnectedBrokers(p.id);
    } catch (err) {
      console.warn("eager migration failed for portfolio", p.id, err);
    }
  }
}

// ---------- sharing operations -------------------------------------------

/**
 * Read the public key (hex SPKI) of a user from `users/{uid}.publicKey`.
 * Returns null if the user hasn't enrolled yet — callers use that as the
 * "ask them to log in once" signal.
 */
export async function readUserPublicKeyHex(uid: string): Promise<string | null> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  const data = snap.data() as { publicKey?: string };
  return data.publicKey ?? null;
}

/**
 * Add a friend to a portfolio. For encrypted portfolios this also wraps
 * K_portfolio under the friend's public key. Throws (with a helpful
 * message) if the friend hasn't enrolled yet on an encrypted portfolio —
 * callers surface this in the UI.
 *
 * For pre-migration plaintext portfolios, falls back to the legacy
 * arrayUnion-only update.
 */
export async function shareWithUser(
  portfolioId: string,
  friendUid: string,
  // Encryption context: omit for pre-migration plaintext shares.
  ctx?: {
    portfolioKey: CryptoKey;
    ownerPrivateKey: CryptoKey;
    ownerPublicKeyHex: string;
  },
): Promise<void> {
  const portfolioRef = doc(db, "portfolios", portfolioId);
  if (!ctx) {
    await updateDoc(portfolioRef, { sharedWith: arrayUnion(friendUid) });
    return;
  }
  const friendPublicKeyHex = await readUserPublicKeyHex(friendUid);
  if (!friendPublicKeyHex) {
    throw new Error(
      `${friendUid.slice(0, 8)}… hasn't enabled encryption — ask them to log in once, then try again.`,
    );
  }
  await wrapPortfolioKeyForUser(
    portfolioId,
    friendUid,
    friendPublicKeyHex,
    ctx.portfolioKey,
    ctx.ownerPrivateKey,
    ctx.ownerPublicKeyHex,
  );
  await updateDoc(portfolioRef, { sharedWith: arrayUnion(friendUid) });
}

/**
 * Remove a friend from a portfolio and rotate K_portfolio so the removed
 * user can't read future updates. Re-encrypts every holding under a fresh
 * key, re-wraps that key for the owner + every remaining sharer, deletes
 * the removed user's wrappedKey doc, and updates `sharedWith`. All in a
 * single Firestore batch.
 *
 * UI honesty: anything the removed user has already viewed is in their
 * browser's memory; we can't reach in and shred it. This matches WhatsApp's
 * "no future reads" promise — not "memory wipe."
 *
 * For pre-migration plaintext portfolios, just removes from `sharedWith`
 * (no encryption to rotate).
 */
export async function revokeFromUser(
  portfolioId: string,
  removeUid: string,
  // Encryption context: omit for pre-migration plaintext.
  ctx?: {
    oldKey: CryptoKey;
    ownerUid: string;
    ownerPrivateKey: CryptoKey;
    ownerPublicKey: CryptoKey;
    ownerPublicKeyHex: string;
    remainingSharerUids: string[];
  },
): Promise<void> {
  const portfolioRef = doc(db, "portfolios", portfolioId);
  if (!ctx) {
    await updateDoc(portfolioRef, { sharedWith: arrayRemove(removeUid) });
    return;
  }

  // Look up remaining sharers' public keys before any writes — that way
  // a missing publicKey aborts cleanly without leaving the portfolio in a
  // half-rotated state.
  const remaining: Array<{ uid: string; publicKeyHex: string }> = [];
  for (const friendUid of ctx.remainingSharerUids) {
    const hex = await readUserPublicKeyHex(friendUid);
    if (!hex) {
      // Skip silently — they couldn't read before either. Phase 5 cleanup
      // could prune `sharedWith` of these stale entries.
      continue;
    }
    remaining.push({ uid: friendUid, publicKeyHex: hex });
  }

  // Generate the new K_portfolio + wrap for owner upfront.
  const newKey = await generatePortfolioKey();
  const ownerWrap = await wrapPortfolioKeyForRecipient(
    newKey,
    ctx.ownerPrivateKey,
    ctx.ownerPublicKey,
  );

  // Re-encrypt every holding under the new key. Done outside the batch
  // because each encrypt is async; we accumulate the writes into a batch
  // afterward.
  const holdingsCol = collection(db, "portfolios", portfolioId, "holdings");
  const snap = await getDocs(holdingsCol);
  const writes: Array<{ id: string; payload: string; iv: string }> = [];
  for (const d of snap.docs) {
    const data = d.data();
    if (!isEncryptedDoc(data)) continue;
    const plain = await decryptHolding(
      { payload: data.payload, iv: data.iv },
      ctx.oldKey,
    );
    const ct = await encryptHolding(plain, newKey);
    writes.push({ id: d.id, payload: ct.payload, iv: ct.iv });
  }

  // Wrap for each remaining sharer.
  const friendWraps: Array<{ uid: string; payload: Ciphertext; senderHex: string }> = [];
  for (const r of remaining) {
    const recipientPub = await importPublicKey(r.publicKeyHex);
    const wrapped = await wrapPortfolioKeyForRecipient(
      newKey,
      ctx.ownerPrivateKey,
      recipientPub,
    );
    friendWraps.push({
      uid: r.uid,
      payload: wrapped,
      senderHex: ctx.ownerPublicKeyHex,
    });
  }

  // Single Firestore batch for the swap. We can't use updateDoc across
  // multiple subcollection paths in one transaction without a batch.
  const batch = writeBatch(db);

  for (const w of writes) {
    batch.update(
      doc(db, "portfolios", portfolioId, "holdings", w.id),
      { payload: w.payload, iv: w.iv },
    );
  }
  // Owner's wrappedKey overwrite
  batch.set(
    doc(db, "portfolios", portfolioId, "wrappedKeys", ctx.ownerUid),
    {
      wrappedKey: ownerWrap,
      wrappedBy: ctx.ownerPublicKeyHex,
      schemaVersion: 1,
    },
  );
  for (const fw of friendWraps) {
    batch.set(
      doc(db, "portfolios", portfolioId, "wrappedKeys", fw.uid),
      {
        wrappedKey: fw.payload,
        wrappedBy: fw.senderHex,
        schemaVersion: 1,
      },
    );
  }
  // Removed user's wrappedKey doc
  batch.delete(
    doc(db, "portfolios", portfolioId, "wrappedKeys", removeUid),
  );
  batch.update(portfolioRef, { sharedWith: arrayRemove(removeUid) });

  await batch.commit();
  // Cleanup: ensure deleteDoc succeeded even if the batch got reordered.
  // (No-op if already deleted.)
  await deleteDoc(
    doc(db, "portfolios", portfolioId, "wrappedKeys", removeUid),
  ).catch(() => {});
}

/**
 * Reconcile the wrappedKeys subcollection against the current `sharedWith`
 * list. For any sharer that has a publicKey on the server but no wrappedKey
 * doc yet, write the wrap silently. This is the "re-share reconnection"
 * step — runs whenever the owner opens an encrypted portfolio so that
 * friends who finally enrolled get access without an explicit re-share
 * action.
 *
 * Friends without a publicKey are left alone — they need to enroll first.
 */
export async function reconcileSharedWrappedKeys(
  portfolioId: string,
  sharedWith: string[],
  ctx: {
    portfolioKey: CryptoKey;
    ownerPrivateKey: CryptoKey;
    ownerPublicKeyHex: string;
  },
): Promise<{ added: number; pending: number }> {
  let added = 0;
  let pending = 0;
  for (const friendUid of sharedWith) {
    const wkRef = doc(db, "portfolios", portfolioId, "wrappedKeys", friendUid);
    const existing = await getDoc(wkRef);
    if (existing.exists()) continue;
    const friendPublicKeyHex = await readUserPublicKeyHex(friendUid);
    if (!friendPublicKeyHex) {
      pending++;
      continue;
    }
    await wrapPortfolioKeyForUser(
      portfolioId,
      friendUid,
      friendPublicKeyHex,
      ctx.portfolioKey,
      ctx.ownerPrivateKey,
      ctx.ownerPublicKeyHex,
    );
    added++;
  }
  return { added, pending };
}
