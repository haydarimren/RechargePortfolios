"use client";

/**
 * High-level encryption lifecycle: enroll, unlock, restore-from-phrase.
 *
 * This module is the seam between the crypto primitives (`crypto-client.ts`),
 * the IndexedDB persistence layer (`key-store.ts`), and Firestore. UI code
 * should never call those directly — call these three functions instead.
 *
 * The model in plain English (Option B / WhatsApp-on-web flow):
 *   - Enrollment generates the user's identity keypair + master secret +
 *     a non-extractable `localWrapKey` for this browser profile. The
 *     master secret is wrapped under the localWrapKey and persisted to
 *     IndexedDB. The user sees their 12-word recovery phrase once.
 *   - Daily login: every page load auto-unlocks from IndexedDB. No
 *     password prompt. Same behavior as opening WhatsApp.
 *   - New device or browser-data-cleared: IndexedDB is empty, server
 *     still has the wrapped private key. User enters their phrase →
 *     master secret derived from phrase → server-stored wrappedPrivateKey
 *     unwrapped → fresh localWrapKey generated → state seeded into the
 *     new IndexedDB.
 *
 * State machine driven by `getEncryptionStatus`:
 *   - "uninitialized" — no `users/{uid}.publicKey` doc. Path: signup →
 *     `enrollEncryption`.
 *   - "locked" — server has publicKey AND IndexedDB has localWrapKey.
 *     Path: `unlockEncryption` (silent; no UI).
 *   - "needs-recovery" — server has publicKey, IndexedDB is empty.
 *     Path: `restoreFromPhrase`.
 */

import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import {
  type Ciphertext,
  exportPublicKey,
  generateIdentityKeyPair,
  generateLocalWrapKey,
  importPublicKey,
  unwrapMasterSecretLocally,
  unwrapPrivateKeyWithMasterSecret,
  wrapMasterSecretLocally,
  wrapPrivateKeyWithMasterSecret,
} from "./crypto-client";
import {
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
  setUnlocked,
} from "./key-store";

/**
 * Server-side shape under `users/{uid}` once the user has enrolled.
 */
interface UserEncryptionDoc {
  publicKey?: string; // hex SPKI
  wrappedPrivateKey?: Ciphertext;
}

export type EncryptionStatus =
  | { kind: "uninitialized" }
  | { kind: "locked"; persisted: true } // local IndexedDB state present
  | { kind: "needs-recovery"; persisted: false } // server has profile, local doesn't
  | { kind: "error"; message: string };

/**
 * Inspect Firestore + IndexedDB to figure out which onboarding/unlock path
 * applies. Pure read; no side effects.
 */
export async function getEncryptionStatus(
  uid: string,
): Promise<EncryptionStatus> {
  try {
    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);
    const data = (snap.exists() ? snap.data() : {}) as UserEncryptionDoc;
    const hasServerKey = !!data.publicKey && !!data.wrappedPrivateKey;
    const local = await loadPersistedState(uid);
    if (!hasServerKey) return { kind: "uninitialized" };
    if (local) return { kind: "locked", persisted: true };
    return { kind: "needs-recovery", persisted: false };
  } catch (err) {
    return { kind: "error", message: (err as Error).message ?? "unknown" };
  }
}

/**
 * First-time enrollment for a new user. Wraps the supplied master secret
 * + a fresh identity keypair, persists locally under a non-extractable
 * localWrapKey, and uploads the public artefacts to Firestore. No password
 * required: this is the "open the app and it just works" flow.
 *
 * The caller is expected to have generated the master secret and shown
 * the user their recovery phrase first (so the displayed phrase matches
 * what's actually stored). See the onboarding page for the standard flow.
 */
export async function enrollEncryption(
  uid: string,
  masterSecret: Uint8Array,
): Promise<void> {
  if (masterSecret.length !== 16) {
    throw new Error("masterSecret must be 16 bytes");
  }

  const keyPair = await generateIdentityKeyPair();
  const localWrapKey = await generateLocalWrapKey();
  const wrappedMasterSecret = await wrapMasterSecretLocally(
    masterSecret,
    localWrapKey,
  );
  const wrappedPrivateKey = await wrapPrivateKeyWithMasterSecret(
    keyPair.privateKey,
    masterSecret,
  );
  const publicKeyHex = await exportPublicKey(keyPair.publicKey);

  // Persist locally first. If this fails (e.g. private mode without
  // IndexedDB) we don't want to leave a half-configured server doc.
  await savePersistedState({
    uid,
    localWrapKey,
    wrappedMasterSecret,
    wrappedPrivateKey,
    publicKeyHex,
  });

  // Then upload public artefacts. Merge so we don't clobber the existing
  // displayName/createdAt fields written by `ensureUserProfile`.
  await setDoc(
    doc(db, "users", uid),
    {
      publicKey: publicKeyHex,
      wrappedPrivateKey,
      encryptionEnrolledAt: Date.now(),
    } satisfies UserEncryptionDoc & { encryptionEnrolledAt: number },
    { merge: true },
  );

  // Stash the unwrapped key material in memory so the user can immediately
  // start using their portfolio without a re-load round-trip.
  setUnlocked({
    uid,
    masterSecret,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyHex,
  });
}

/**
 * Auto-unlock from IndexedDB. Called on every signed-in page load when
 * local state is present. Silent — no UI, no user input.
 *
 * Throws on missing local state (caller falls back to recovery flow) or
 * decryption failure (which would indicate IndexedDB corruption — should
 * never happen, but caller should fall back to recovery flow if so).
 */
export async function unlockEncryption(uid: string): Promise<void> {
  const persisted = await loadPersistedState(uid);
  if (!persisted) {
    throw new Error("no local key state — use restoreFromPhrase instead");
  }

  const masterSecret = await unwrapMasterSecretLocally(
    persisted.wrappedMasterSecret,
    persisted.localWrapKey,
  );
  const privateKey = await unwrapPrivateKeyWithMasterSecret(
    persisted.wrappedPrivateKey,
    masterSecret,
  );
  const publicKey = await importPublicKey(persisted.publicKeyHex);

  setUnlocked({
    uid,
    masterSecret,
    privateKey,
    publicKey,
    publicKeyHex: persisted.publicKeyHex,
  });
}

/**
 * Cross-device / browser-cleared recovery: user enters their 12-word
 * phrase. Pulls the wrapped private key from Firestore (server holds
 * ciphertext only) and rebuilds local state with a fresh localWrapKey
 * for this browser profile.
 */
export async function restoreFromPhrase(
  uid: string,
  phrase: string,
): Promise<void> {
  const { phraseToSeed } = await import("./recovery-phrase");
  const masterSecret = await phraseToSeed(phrase);

  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error("user profile not found — try signing in again");
  }
  const data = snap.data() as UserEncryptionDoc;
  if (!data.publicKey || !data.wrappedPrivateKey) {
    throw new Error(
      "encryption not enrolled for this account — sign up flow needed",
    );
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await unwrapPrivateKeyWithMasterSecret(
      data.wrappedPrivateKey,
      masterSecret,
    );
  } catch {
    // Wrong phrase produces a decrypt failure here. Surface a clearer error.
    throw new Error("recovery phrase doesn't match this account");
  }
  const publicKey = await importPublicKey(data.publicKey);

  // Fresh localWrapKey for this device. Per-device by design — different
  // browsers / devices each have their own at-rest scrambler, all backed
  // by the same master secret.
  const localWrapKey = await generateLocalWrapKey();
  const wrappedMasterSecret = await wrapMasterSecretLocally(
    masterSecret,
    localWrapKey,
  );

  await savePersistedState({
    uid,
    localWrapKey,
    wrappedMasterSecret,
    wrappedPrivateKey: data.wrappedPrivateKey,
    publicKeyHex: data.publicKey,
  });
  setUnlocked({
    uid,
    masterSecret,
    privateKey,
    publicKey,
    publicKeyHex: data.publicKey,
  });
}

/**
 * Local logout — clears IndexedDB for this UID. The server doc is
 * untouched; user can restore from phrase later.
 */
export async function forgetLocalState(uid: string): Promise<void> {
  await clearPersistedState(uid);
}
