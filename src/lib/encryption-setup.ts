"use client";

/**
 * High-level encryption lifecycle: enroll, unlock, restore-from-phrase.
 *
 * This module is the seam between the crypto primitives (`crypto-client.ts`),
 * the IndexedDB persistence layer (`key-store.ts`), and Firestore. UI code
 * should never call those directly — call these three functions instead.
 *
 * State machine:
 *   - "uninitialized" — no `users/{uid}.publicKey` doc, no IndexedDB state.
 *     Path: signup/migration → `enrollEncryption`.
 *   - "locked" — `users/{uid}.publicKey` exists AND IndexedDB state exists.
 *     Path: daily login → `unlockEncryption`.
 *   - "needs-recovery" — `users/{uid}.publicKey` exists but IndexedDB is
 *     empty (new device, cleared cookies, etc.). Path: `restoreFromPhrase`.
 *   - "unlocked" — `getUnlocked(uid)` returns a non-null state. Reads/writes
 *     can proceed.
 *
 * Caller is responsible for picking which path based on Firestore + IndexedDB
 * inspection (see `getEncryptionStatus`).
 */

import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import {
  type Ciphertext,
  type PasswordWrappedSecret,
  exportPublicKey,
  generateIdentityKeyPair,
  importPublicKey,
  unwrapMasterSecretWithPassword,
  unwrapPrivateKeyWithMasterSecret,
  wrapMasterSecretWithPassword,
  wrapPrivateKeyWithMasterSecret,
} from "./crypto-client";
import {
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
  setUnlocked,
} from "./key-store";

/**
 * Server-side shape under `users/{uid}` once the user has enrolled. Both
 * fields are added in Phase 1 alongside the existing `displayName`/
 * `createdAt`/`updatedAt` profile fields.
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
 * First-time enrollment for a new (or freshly migrating) user. Wraps the
 * supplied master secret + a fresh identity keypair, persists locally, and
 * uploads the public artefacts to Firestore.
 *
 * The caller is expected to have already generated the master secret and
 * shown the user their recovery phrase (so it's the same secret that's
 * actually stored). See the onboarding page for the standard flow.
 */
export async function enrollEncryption(
  uid: string,
  encryptionPassword: string,
  masterSecret: Uint8Array,
): Promise<void> {
  if (encryptionPassword.length < 6) {
    // We don't enforce a strong password policy server-side because the
    // master secret has full 128-bit entropy — but a 1-char password would
    // be unwrapped instantly. 6 is a soft floor that catches obvious mistakes.
    throw new Error("encryption password must be at least 6 characters");
  }
  if (masterSecret.length !== 16) {
    throw new Error("masterSecret must be 16 bytes");
  }

  const keyPair = await generateIdentityKeyPair();

  const wrappedMasterSecret = await wrapMasterSecretWithPassword(
    masterSecret,
    encryptionPassword,
  );
  const wrappedPrivateKey = await wrapPrivateKeyWithMasterSecret(
    keyPair.privateKey,
    masterSecret,
  );
  const publicKeyHex = await exportPublicKey(keyPair.publicKey);

  // Persist locally first — if this fails we don't want to leave a half-
  // configured server doc behind.
  await savePersistedState({
    uid,
    wrappedMasterSecret,
    wrappedPrivateKey,
    publicKeyHex,
  });

  // Then upload the public artefacts. Merge so we don't clobber the
  // existing displayName/createdAt fields written by `ensureUserProfile`.
  await setDoc(
    doc(db, "users", uid),
    {
      publicKey: publicKeyHex,
      wrappedPrivateKey,
      encryptionEnrolledAt: Date.now(),
    } satisfies UserEncryptionDoc & { encryptionEnrolledAt: number },
    { merge: true },
  );

  // Stash the unwrapped key material in memory so the user doesn't have to
  // re-enter their password immediately after enrolling.
  setUnlocked({
    uid,
    masterSecret,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyHex,
  });
}

/**
 * Daily-login unlock on a device that already has IndexedDB state.
 * Throws on wrong password.
 */
export async function unlockEncryption(
  uid: string,
  encryptionPassword: string,
): Promise<void> {
  const persisted = await loadPersistedState(uid);
  if (!persisted) {
    throw new Error("no local key state — use restoreFromPhrase instead");
  }

  const masterSecret = await unwrapMasterSecretWithPassword(
    persisted.wrappedMasterSecret,
    encryptionPassword,
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
 * New-device path: user enters their 12-word phrase + a new password.
 * Pulls the wrapped private key from Firestore (server holds ciphertext
 * only) and rebuilds local state.
 *
 * Note: this both unlocks the session AND re-wraps the master secret under
 * the new password — i.e. it doubles as the "forgot password" recovery
 * flow.
 */
export async function restoreFromPhrase(
  uid: string,
  phrase: string,
  newEncryptionPassword: string,
): Promise<void> {
  if (newEncryptionPassword.length < 6) {
    throw new Error("encryption password must be at least 6 characters");
  }

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

  const wrappedMasterSecret: PasswordWrappedSecret =
    await wrapMasterSecretWithPassword(masterSecret, newEncryptionPassword);

  await savePersistedState({
    uid,
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
