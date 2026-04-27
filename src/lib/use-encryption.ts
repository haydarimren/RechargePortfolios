"use client";

/**
 * Hook for the encryption-state lifecycle. Watches Firebase auth + the
 * client-side key store and reports a single discriminated status:
 *
 *   - "loading"           — auth/state hasn't resolved yet
 *   - "no-user"           — signed out
 *   - "uninitialized"     — signed in but never enrolled (forced through
 *                           onboarding by EnrollmentGate)
 *   - "needs-recovery"    — enrolled on the server but no local key state
 *                           (new device, cleared cookies). User must enter
 *                           their recovery phrase.
 *   - "unlocked"          — happy path; in-memory key state populated.
 *
 * Note: under the Option B / WhatsApp-on-web design there's no separate
 * "locked" state visible to the user. When `getEncryptionStatus` returns
 * "locked" (server has publicKey + IndexedDB has localWrapKey), this hook
 * silently auto-unlocks via `unlockEncryption` and reports "unlocked"
 * directly. No password prompt.
 *
 * If auto-unlock fails (corrupt IndexedDB, schema mismatch, etc.), the
 * hook downgrades to "needs-recovery" so the user can re-establish their
 * keys via the recovery phrase.
 */

import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./firebase";
import {
  getEncryptionStatus,
  restoreFromPhrase,
  unlockEncryption,
} from "./encryption-setup";
import { getUnlocked } from "./key-store";

export type EncryptionUiState =
  | { kind: "loading" }
  | { kind: "no-user" }
  | { kind: "uninitialized"; uid: string }
  | { kind: "needs-recovery"; uid: string }
  | { kind: "unlocked"; uid: string };

export function useEncryption(): {
  state: EncryptionUiState;
  restore: (phrase: string) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [state, setState] = useState<EncryptionUiState>({ kind: "loading" });

  // Re-evaluate based on the current user + Firestore + IndexedDB + memory.
  const evaluate = useCallback(async (currentUser: User | null) => {
    if (!currentUser) {
      setState({ kind: "no-user" });
      return;
    }
    if (getUnlocked(currentUser.uid)) {
      setState({ kind: "unlocked", uid: currentUser.uid });
      return;
    }
    const status = await getEncryptionStatus(currentUser.uid);
    if (status.kind === "uninitialized") {
      setState({ kind: "uninitialized", uid: currentUser.uid });
      return;
    }
    if (status.kind === "needs-recovery") {
      setState({ kind: "needs-recovery", uid: currentUser.uid });
      return;
    }
    if (status.kind === "locked") {
      // Silent auto-unlock from IndexedDB. No password, no UI.
      try {
        await unlockEncryption(currentUser.uid);
        setState({ kind: "unlocked", uid: currentUser.uid });
      } catch (err) {
        // IndexedDB corrupt / schema mismatch / non-extractable key
        // unusable for some reason. Downgrade to recovery so the user
        // can re-establish from their phrase.
        console.warn("auto-unlock failed; falling back to recovery", err);
        setState({ kind: "needs-recovery", uid: currentUser.uid });
      }
      return;
    }
    // "error" — show recovery so user can retry. The error itself surfaces
    // if they try to restore.
    setState({ kind: "needs-recovery", uid: currentUser.uid });
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      evaluate(u);
    });
    return () => unsub();
  }, [evaluate]);

  const restore = useCallback(
    async (phrase: string) => {
      if (!user) throw new Error("not signed in");
      await restoreFromPhrase(user.uid, phrase);
      setState({ kind: "unlocked", uid: user.uid });
    },
    [user],
  );

  const refresh = useCallback(async () => {
    await evaluate(user ?? null);
  }, [evaluate, user]);

  return { state, restore, refresh };
}
