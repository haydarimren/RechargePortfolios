"use client";

/**
 * Recovery modal: shown only when the user has enrolled on the server but
 * has no local key state on this device (new device or browser-data-
 * cleared). They paste their 12-word recovery phrase, we unwrap the
 * server-stored private key, and seed a fresh local state for this
 * browser profile.
 *
 * The "daily login" case never reaches this modal — it's handled by
 * silent auto-unlock in useEncryption.
 */

import { useState } from "react";

interface Props {
  uid: string;
  onRestore: (phrase: string) => Promise<void>;
}

export function UnlockModal({ uid, onRestore }: Props) {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onRestore(phrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't restore");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 backdrop-blur flex items-center justify-center p-6">
      <div className="w-full max-w-md card p-6 space-y-4 animate-fade-up">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Restore your portfolio
          </h2>
          <p className="text-sm text-fg-dim mt-1">
            We don&apos;t recognize this browser. Paste your 12-word recovery
            phrase to decrypt your data on this device. You only need to do
            this once per browser.
          </p>
        </div>

        {error && (
          <div className="border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            autoFocus
            placeholder="rabbit silver lion forest..."
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            className="field min-h-[4.5rem] resize-y font-mono text-sm"
            required
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full disabled:opacity-50"
          >
            {submitting ? "Working…" : "Restore"}
          </button>
        </form>

        <div className="text-[10px] text-fg-fade text-center pt-2 border-t border-line/50 num">
          UID: {uid.slice(0, 8)}…{uid.slice(-4)}
        </div>
      </div>
    </div>
  );
}
