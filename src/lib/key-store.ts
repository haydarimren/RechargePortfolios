"use client";

/**
 * IndexedDB-backed session-state for end-to-end encryption keys.
 *
 * What lives here:
 *   - `localWrapKey` — a non-extractable AES-GCM key generated once on this
 *     device. Stored in IndexedDB as a structured-cloned CryptoKey. The
 *     browser keeps the actual bytes in a managed slot — JavaScript can
 *     use it for encrypt/decrypt but can never read its raw value.
 *   - `wrappedMasterSecret` — the user's 16-byte master secret encrypted
 *     under `localWrapKey`. Together with the key, this gives us
 *     "WhatsApp on web": the app auto-unlocks every time the user opens
 *     it, no password prompt.
 *   - `wrappedPrivateKey` — the user's identity private key, wrapped
 *     under master secret. Cached locally to avoid a round-trip to the
 *     server on each load.
 *   - In-memory cache (NOT in IndexedDB) — the unwrapped master secret
 *     and CryptoKey objects live in module-level memory once unlocked.
 *     Reset on tab close.
 *
 * Threat model alignment:
 *   - Server compromise: server only sees ciphertext (Firestore docs).
 *     The local IndexedDB blob is irrelevant to this attack. ✓
 *   - Friend / app-owner snooping: ciphertext-only on the server, no
 *     way to read holdings without a wrappedKey doc. ✓
 *   - Stolen unlocked device: same exposure as WhatsApp on an unlocked
 *     phone. We don't try to defend against this — it's beyond what the
 *     web platform can offer without per-session password prompts, which
 *     defeats the UX goal.
 *   - Disk forensics on a powered-off device: protected by (a) the OS's
 *     encryption of the browser profile and (b) the non-extractability
 *     of the localWrapKey. An attacker reading raw IndexedDB files gets
 *     the wrapped-secret blob but no way to decrypt without exploiting
 *     the browser itself.
 *
 * Naming: scoped per Firebase UID so a household with multiple accounts
 * on the same browser keeps its state separate.
 */

import type { Ciphertext } from "./crypto-client";

const DB_NAME = "recharge-e2e";
// Bumped from v1 → v2 when we changed PersistedKeyState's shape. Old v1
// rows (password-wrapped) are dropped on the upgrade — there are no
// production users on v1 yet (E2E hasn't shipped to anyone).
const DB_VERSION = 2;
const STORE = "user-state";

/** Persisted-per-user shape in IndexedDB. */
export interface PersistedKeyState {
  uid: string;
  /** Non-extractable AES-GCM key bound to this browser profile. Used to
   * unwrap `wrappedMasterSecret` on every app load. Generated once at
   * enrollment / phrase-restore time and never rotated within a single
   * IndexedDB lifetime. */
  localWrapKey: CryptoKey;
  /** Master secret, encrypted under localWrapKey. */
  wrappedMasterSecret: Ciphertext;
  /** Identity private key, wrapped under master secret. */
  wrappedPrivateKey: Ciphertext;
  /** Public key, hex-encoded SPKI. Mirrors the server doc; stored locally
   * for cheap sanity-checking. */
  publicKeyHex: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      // v1 → v2: schema changed from password-wrapped to localWrapKey.
      // Drop the old store rather than try to migrate; v1 records aren't
      // recoverable under the new flow without forcing the user through
      // recovery anyway. No-op for fresh installs (oldVersion === 0).
      if (oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "uid" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function loadPersistedState(
  uid: string,
): Promise<PersistedKeyState | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(uid);
    req.onsuccess = () =>
      resolve((req.result as PersistedKeyState | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function savePersistedState(
  state: PersistedKeyState,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      const req = tx.objectStore(STORE).put(state);
      // Some browsers report structured-clone errors via the request's
      // onerror rather than the transaction's. Catch both.
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB put failed"));
    } catch (err) {
      // IDBObjectStore.put() can throw synchronously when the value isn't
      // structured-cloneable. Without this catch, the Promise hangs forever.
      reject(err);
    }
  });
}

export async function clearPersistedState(uid: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(uid);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- in-memory unlocked state -------------------------------------

/**
 * In-memory cache of the unwrapped key material. Scoped per UID for the
 * same household-multiple-accounts reason. Reset on tab close; never
 * persisted.
 */
export interface UnlockedState {
  uid: string;
  masterSecret: Uint8Array;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Hex SPKI of the public key — convenience copy so callers don't have
   * to re-export every time they need to address themselves as a sender. */
  publicKeyHex: string;
}

let unlocked: UnlockedState | null = null;

/**
 * Listeners notified on any setUnlocked / clearUnlocked. Used by
 * useEncryption so React consumers (EnrollmentGate, home page, etc.)
 * immediately reflect lifecycle transitions — without this, the gate
 * doesn't know enrollment just completed and ping-pongs the user
 * between /onboarding/encryption and / until Firebase happens to fire
 * an unrelated auth-state event.
 */
type UnlockListener = (state: UnlockedState | null) => void;
const listeners = new Set<UnlockListener>();

export function subscribeToUnlock(listener: UnlockListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(state: UnlockedState | null): void {
  for (const l of listeners) {
    try {
      l(state);
    } catch (err) {
      console.warn("unlock listener threw", err);
    }
  }
}

export function getUnlocked(uid: string): UnlockedState | null {
  if (unlocked && unlocked.uid === uid) return unlocked;
  return null;
}

export function setUnlocked(state: UnlockedState): void {
  unlocked = state;
  notifyListeners(state);
}

export function clearUnlocked(): void {
  unlocked = null;
  notifyListeners(null);
}

export function isUnlocked(uid: string): boolean {
  return getUnlocked(uid) !== null;
}
