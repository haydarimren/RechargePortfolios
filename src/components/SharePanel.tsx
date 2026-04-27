"use client";

/**
 * UI for granting / revoking read access to a portfolio. Encryption-aware:
 *   - For pre-migration plaintext portfolios, falls back to the legacy
 *     arrayUnion/arrayRemove behavior.
 *   - For encrypted portfolios, also wraps K_portfolio under the friend's
 *     public key (add) or rotates K_portfolio + re-encrypts all holdings
 *     (revoke).
 *
 * The owner-only encryption context is supplied via props by the parent
 * portfolio page; this component never touches the unlocked key store
 * directly.
 */

import { useEffect, useState } from "react";
import { arrayRemove, arrayUnion, doc, updateDoc } from "firebase/firestore";
import { X } from "lucide-react";
import { db } from "@/lib/firebase";
import { useDisplayName } from "@/lib/users";
import { revokeFromUser, shareWithUser } from "@/lib/holdings-repo";

interface SharePanelProps {
  portfolioId: string;
  ownerUid: string;
  sharedWith: string[];
  onClose: () => void;
  /**
   * Full encryption context for an encrypted portfolio. Required for
   * encrypted shares; omit for legacy plaintext portfolios where add/
   * remove just touches `sharedWith`.
   */
  encryption?: {
    portfolioKey: CryptoKey;
    ownerPrivateKey: CryptoKey;
    ownerPublicKey: CryptoKey;
    ownerPublicKeyHex: string;
  };
}

export function SharePanel({
  portfolioId,
  ownerUid,
  sharedWith,
  onClose: _onClose,
  encryption,
}: SharePanelProps) {
  void _onClose;
  const [uid, setUid] = useState("");
  const [error, setError] = useState("");
  // Optimistic mirror of `sharedWith` so the list updates the moment a
  // share/revoke call resolves, rather than waiting for the Firestore
  // snapshot to round-trip back to the parent — that round-trip can lag
  // by seconds under long-polling. Synced from the prop whenever the
  // server-side value changes; our optimistic mutations land on top.
  const [localShared, setLocalShared] = useState<string[]>(sharedWith);
  useEffect(() => {
    setLocalShared(sharedWith);
  }, [sharedWith]);
  const [busy, setBusy] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = uid.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      if (encryption) {
        await shareWithUser(portfolioId, trimmed, {
          portfolioKey: encryption.portfolioKey,
          ownerPrivateKey: encryption.ownerPrivateKey,
          ownerPublicKeyHex: encryption.ownerPublicKeyHex,
        });
      } else {
        await updateDoc(doc(db, "portfolios", portfolioId), {
          sharedWith: arrayUnion(trimmed),
        });
      }
      // Optimistic add. Idempotent — re-syncs from prop on the next snapshot.
      setLocalShared((s) => (s.includes(trimmed) ? s : [...s, trimmed]));
      setUid("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't share");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (target: string) => {
    setBusy(true);
    setError("");
    try {
      if (encryption) {
        const remaining = localShared.filter((u) => u !== target);
        await revokeFromUser(portfolioId, target, {
          oldKey: encryption.portfolioKey,
          ownerUid,
          ownerPrivateKey: encryption.ownerPrivateKey,
          ownerPublicKey: encryption.ownerPublicKey,
          ownerPublicKeyHex: encryption.ownerPublicKeyHex,
          remainingSharerUids: remaining,
        });
      } else {
        await updateDoc(doc(db, "portfolios", portfolioId), {
          sharedWith: arrayRemove(target),
        });
      }
      // Optimistic remove — list updates instantly even if the Firestore
      // snapshot for the portfolio doc hasn't propagated back yet.
      setLocalShared((s) => s.filter((u) => u !== target));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <div className="mb-3 border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-2">
          {error}
        </div>
      )}
      {encryption && (
        <div className="mb-4 text-[11px] text-fg-fade">
          Sharing rotates an encryption key. Friends without encryption
          enabled need to log in once before you can share with them.
        </div>
      )}
      <form onSubmit={handleAdd} className="space-y-4">
        <div>
          <label className="label block mb-1.5">Friend&apos;s UID</label>
          <input
            autoFocus
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder="Firebase UID"
            className="field"
            required
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="btn-primary w-full disabled:opacity-50"
        >
          {busy ? "Working…" : "Add friend"}
        </button>
      </form>
      {localShared.length > 0 && (
        <div className="mt-5 pt-5 border-t border-line">
          <div className="label mb-3">Currently shared with</div>
          <ul className="space-y-1.5">
            {localShared.map((friendUid) => (
              <SharedUserRow
                key={friendUid}
                uid={friendUid}
                disabled={busy}
                onRemove={() => handleRemove(friendUid)}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function SharedUserRow({
  uid,
  onRemove,
  disabled,
}: {
  uid: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const name = useDisplayName(uid);
  return (
    <li className="flex items-center justify-between gap-2 bg-bg-3 border border-line rounded-md p-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg truncate">
          {name || <span className="text-fg-dim">Loading…</span>}
        </div>
        <div className="num text-[10px] text-fg-fade truncate">{uid}</div>
      </div>
      <button
        onClick={onRemove}
        disabled={disabled}
        className="text-fg-fade hover:text-neg transition shrink-0 disabled:opacity-50"
        aria-label={`Remove ${name || uid}`}
      >
        <X className="w-4 h-4" />
      </button>
    </li>
  );
}
