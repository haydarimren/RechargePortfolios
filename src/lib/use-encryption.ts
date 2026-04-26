"use client";

/**
 * Hook for the encryption-state lifecycle. Watches Firebase auth + the
 * client-side key store and reports a single discriminated status:
 *
 *   - "loading"           — auth/state hasn't resolved yet
 *   - "no-user"           — signed out
 *   - "uninitialized"     — signed in but never enrolled (Phase 2: existing
 *                           pre-encryption users; the home page will route
 *                           them through onboarding)
 *   - "needs-recovery"    — enrolled on the server but no local key state
 *                           (new device, cleared cookies). User must enter
 *                           their recovery phrase.
 *   - "locked"            — enrolled + local state present, password not
 *                           yet entered this tab session.
 *   - "unlocked"          — happy path; `state` has the unlocked key
 *                           material.
 *
 * Exposes `unlock(password)` and `restore(phrase, newPassword)` to drive
 * state transitions; on success the hook re-evaluates.
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
  | { kind: "locked"; uid: string }
  | { kind: "unlocked"; uid: string };

export function useEncryption(): {
  state: EncryptionUiState;
  unlock: (password: string) => Promise<void>;
  restore: (phrase: string, newPassword: string) => Promise<void>;
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
    } else if (status.kind === "needs-recovery") {
      setState({ kind: "needs-recovery", uid: currentUser.uid });
    } else if (status.kind === "locked") {
      setState({ kind: "locked", uid: currentUser.uid });
    } else {
      // "error" status — show locked so user can retry. The error itself
      // surfaces if they try to unlock.
      setState({ kind: "locked", uid: currentUser.uid });
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      evaluate(u);
    });
    return () => unsub();
  }, [evaluate]);

  const unlock = useCallback(
    async (password: string) => {
      if (!user) throw new Error("not signed in");
      await unlockEncryption(user.uid, password);
      setState({ kind: "unlocked", uid: user.uid });
    },
    [user],
  );

  const restore = useCallback(
    async (phrase: string, newPassword: string) => {
      if (!user) throw new Error("not signed in");
      await restoreFromPhrase(user.uid, phrase, newPassword);
      setState({ kind: "unlocked", uid: user.uid });
    },
    [user],
  );

  const refresh = useCallback(async () => {
    await evaluate(user ?? null);
  }, [evaluate, user]);

  return { state, unlock, restore, refresh };
}
