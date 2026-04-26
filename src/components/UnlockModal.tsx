"use client";

/**
 * Modal that gates the app on encryption unlock. Shown above content when
 * the current user is signed in + enrolled but the in-memory key state
 * isn't unlocked yet.
 *
 * Two paths:
 *   1. "I have my password" — the daily-login case. Calls `unlock`.
 *   2. "I lost my password" — the new-device or forgot-password case.
 *      Asks for the 12-word phrase + a fresh password, calls `restore`.
 */

import { useState } from "react";

interface Props {
  uid: string;
  needsRecovery: boolean;
  onUnlock: (password: string) => Promise<void>;
  onRestore: (phrase: string, newPassword: string) => Promise<void>;
}

export function UnlockModal({ uid, needsRecovery, onUnlock, onRestore }: Props) {
  const [mode, setMode] = useState<"unlock" | "restore">(
    needsRecovery ? "restore" : "unlock",
  );
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (mode === "unlock") {
        await onUnlock(password);
      } else {
        if (newPassword !== confirmPassword) {
          throw new Error("passwords don't match");
        }
        await onRestore(phrase, newPassword);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlock");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 backdrop-blur flex items-center justify-center p-6">
      <div className="w-full max-w-md card p-6 space-y-4 animate-fade-up">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {mode === "unlock" ? "Unlock your portfolio" : "Recover access"}
          </h2>
          <p className="text-sm text-fg-dim mt-1">
            {mode === "unlock"
              ? "Enter your encryption password to decrypt your data on this device."
              : "Enter your 12-word recovery phrase and choose a new password for this device."}
          </p>
        </div>

        {error && (
          <div className="border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "unlock" ? (
            <input
              type="password"
              autoFocus
              placeholder="Encryption password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field"
              required
              autoComplete="current-password"
            />
          ) : (
            <>
              <textarea
                placeholder="rabbit silver lion forest..."
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="field min-h-[4.5rem] resize-y font-mono text-sm"
                required
                autoComplete="off"
                spellCheck={false}
              />
              <input
                type="password"
                placeholder="New encryption password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="field"
                required
                autoComplete="new-password"
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="field"
                required
                autoComplete="new-password"
              />
            </>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full disabled:opacity-50"
          >
            {submitting
              ? "Working…"
              : mode === "unlock"
                ? "Unlock"
                : "Restore"}
          </button>
        </form>

        {!needsRecovery && (
          <button
            type="button"
            onClick={() => {
              setError("");
              setMode((m) => (m === "unlock" ? "restore" : "unlock"));
            }}
            className="w-full text-xs text-fg-dim hover:text-accent underline underline-offset-4 decoration-line transition"
          >
            {mode === "unlock"
              ? "Forgot password? Use recovery phrase"
              : "Back to password"}
          </button>
        )}

        <div className="text-[10px] text-fg-fade text-center pt-2 border-t border-line/50 num">
          UID: {uid.slice(0, 8)}…{uid.slice(-4)}
        </div>
      </div>
    </div>
  );
}
