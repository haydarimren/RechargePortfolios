"use client";

/**
 * IndexedDB-backed session-state for end-to-end encryption keys.
 *
 * What lives here:
 *   - `wrappedSecret` — the user's 16-byte master secret, encrypted under a
 *     password-derived key (PBKDF2). Persisted across reloads. Survives a
 *     refresh, lost on browser-data clear.
 *   - In-memory cache (NOT in IndexedDB) — once the user enters their
 *     encryption password, the unwrapped master secret + the unwrapped
 *     identity private key live in memory only, scoped to the tab session.
 *     Closing the tab forgets them; opening a new tab requires re-unlock.
 *
 * Why split persistence and runtime state:
 *   - We never want plaintext key material on disk. IndexedDB is on disk.
 *     Therefore: only ciphertext goes in IndexedDB, plaintext stays in JS
 *     memory.
 *   - The "unlock" UX is "enter your password once per session." If we kept
 *     plaintext in IndexedDB users would never need to unlock — but that
 *     defeats the entire threat model (someone who steals your laptop with
 *     an open browser session could already see plaintext, but at least the
 *     IndexedDB-on-disk attack vector is gone).
 *
 * Naming: scoped per Firebase UID so a household with multiple accounts on
 * the same browser keeps its state separate.
 */

import type { Ciphertext, PasswordWrappedSecret } from "./crypto-client";

const DB_NAME = "recharge-e2e";
const DB_VERSION = 1;
const STORE = "user-state";

/** Persisted-per-user shape in IndexedDB. */
export interface PersistedKeyState {
  uid: string;
  wrappedMasterSecret: PasswordWrappedSecret;
  /** The user's identity private key, wrapped under master secret. Cached
   * locally so we don't have to round-trip the server on every reload. */
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
    req.onupgradeneeded = () => {
      const db = req.result;
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
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(state);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

export function getUnlocked(uid: string): UnlockedState | null {
  if (unlocked && unlocked.uid === uid) return unlocked;
  return null;
}

export function setUnlocked(state: UnlockedState): void {
  unlocked = state;
}

export function clearUnlocked(): void {
  unlocked = null;
}

export function isUnlocked(uid: string): boolean {
  return getUnlocked(uid) !== null;
}
