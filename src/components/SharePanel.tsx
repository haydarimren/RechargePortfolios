"use client";

/**
 * UI for sharing a portfolio. Link-centric since the share-links
 * feature: the owner creates/copies/regenerates/revokes a share link
 * (whose token decrypts only the percent-only snapshot — see
 * src/lib/share-links.ts), and manages the followers list below it.
 *
 * Followers arrive via the link's follow funnel (self-service
 * sharedWith append, rules-gated). Removing a follower keeps the
 * pre-existing semantics: for encrypted portfolios K_portfolio is
 * rotated and every holding re-encrypted; for legacy plaintext
 * portfolios it's a plain arrayRemove.
 *
 * The owner-only encryption context is supplied via props by the parent
 * page; this component reads the unlocked master secret itself (for
 * link-token wrap/unwrap) but never touches portfolio keys directly.
 */

import { useCallback, useEffect, useState } from "react";
import { arrayRemove, doc, updateDoc } from "firebase/firestore";
import { Check, Copy, RefreshCw, Trash2, X } from "lucide-react";
import { db } from "@/lib/firebase";
import { useDisplayName } from "@/lib/users";
import { revokeFromUser } from "@/lib/holdings-repo";
import { getUnlocked } from "@/lib/key-store";
import {
  buildSnapshotForPortfolio,
  createShareLink,
  getShareLinkDocForOwner,
  revokeShareLink,
  shareLinkUrl,
  unwrapTokenForOwner,
  type ShareLinkDoc,
} from "@/lib/share-links";
import type { Holding } from "@/lib/types";
import { InitialChip } from "@/components/InitialChip";

/**
 * Resolve the portfolio's link doc + displayable URL (when the owner's
 * master secret is unlocked). Plain async helper shared by the panel's
 * mount effect and the create/revoke handlers.
 */
async function fetchLinkState(
  portfolioId: string,
  ownerUid: string,
): Promise<{ link: ShareLinkDoc | null; url: string | null }> {
  try {
    const link = await getShareLinkDocForOwner(portfolioId);
    if (!link) return { link: null, url: null };
    const unlocked = getUnlocked(ownerUid);
    if (!unlocked) return { link, url: null };
    const token = await unwrapTokenForOwner(
      link.ownerTokenWrap,
      unlocked.masterSecret,
    );
    return {
      link,
      url: shareLinkUrl(window.location.origin, portfolioId, token),
    };
  } catch {
    return { link: null, url: null };
  }
}

interface SharePanelProps {
  portfolioId: string;
  ownerUid: string;
  portfolioName: string;
  /** Decoded holdings — needed to build the link's snapshot. */
  holdings: Holding[];
  sharedWith: string[];
  onClose: () => void;
  /**
   * Full encryption context for an encrypted portfolio. Required for
   * encrypted follower-removal (key rotation); omit for legacy
   * plaintext portfolios where removal just touches `sharedWith`.
   */
  encryption?: {
    portfolioKey: CryptoKey;
    ownerPrivateKey: CryptoKey;
    ownerPublicKey: CryptoKey;
    ownerPublicKeyHex: string;
  };
  /**
   * Called with the rotated K_portfolio after an encrypted follower
   * removal. Removing a follower re-encrypts every holding under a fresh
   * key; the parent must re-seed its in-component portfolio-key state
   * with this, or its live holdings subscription keeps trying the stale
   * key and the owner's holdings render as empty until a reload.
   */
  onKeyRotated?: (newKey: CryptoKey) => void;
}

export function SharePanel({
  portfolioId,
  ownerUid,
  portfolioName,
  holdings,
  sharedWith,
  onClose: _onClose,
  encryption,
  onKeyRotated,
}: SharePanelProps) {
  void _onClose;
  const ownerName = useDisplayName(ownerUid);
  const [error, setError] = useState("");
  // Optimistic mirror of `sharedWith` so the list updates the moment a
  // revoke call resolves, rather than waiting for the Firestore
  // snapshot to round-trip back to the parent — that round-trip can lag
  // by seconds under long-polling. Synced from the prop whenever the
  // server-side value changes; our optimistic mutations land on top.
  const [localShared, setLocalShared] = useState<string[]>(sharedWith);
  useEffect(() => {
    setLocalShared(sharedWith);
  }, [sharedWith]);
  const [busy, setBusy] = useState(false);

  // ---- share link state ----------------------------------------------
  // `undefined` = first load in flight; `null` = no link exists.
  const [link, setLink] = useState<ShareLinkDoc | null | undefined>(undefined);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadLink = useCallback(async () => {
    const state = await fetchLinkState(portfolioId, ownerUid);
    setLink(state.link);
    setLinkUrl(state.url);
  }, [portfolioId, ownerUid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await fetchLinkState(portfolioId, ownerUid);
      if (cancelled) return;
      setLink(state.link);
      setLinkUrl(state.url);
    })();
    return () => {
      cancelled = true;
    };
  }, [portfolioId, ownerUid]);

  const handleCreateLink = async () => {
    const unlocked = getUnlocked(ownerUid);
    if (!unlocked) {
      setError("Unlock first — refresh and try again.");
      return;
    }
    setLinkBusy(true);
    setError("");
    try {
      const snapshot = await buildSnapshotForPortfolio({
        holdings,
        name: portfolioName,
        ownerName: ownerName || "A friend",
      });
      await createShareLink(portfolioId, snapshot, unlocked.masterSecret);
      await loadLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create link");
    } finally {
      setLinkBusy(false);
    }
  };

  const handleRevokeLink = async (regenerate: boolean) => {
    if (!link) return;
    const msg = regenerate
      ? "Regenerate the link? The current URL will stop working."
      : "Revoke the link? Anyone holding it loses the preview (followers are unaffected).";
    if (!confirm(msg)) return;
    setLinkBusy(true);
    setError("");
    try {
      await revokeShareLink(portfolioId, link.tokenHash);
      setLink(null);
      setLinkUrl(null);
      if (regenerate) await handleCreateLink();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update link");
    } finally {
      setLinkBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // ---- follower removal (pre-existing semantics) -----------------------

  const handleRemove = async (target: string) => {
    setBusy(true);
    setError("");
    try {
      if (encryption) {
        const remaining = localShared.filter((u) => u !== target);
        const newKey = await revokeFromUser(portfolioId, target, {
          oldKey: encryption.portfolioKey,
          ownerUid,
          ownerPrivateKey: encryption.ownerPrivateKey,
          ownerPublicKey: encryption.ownerPublicKey,
          ownerPublicKeyHex: encryption.ownerPublicKeyHex,
          remainingSharerUids: remaining,
        });
        // Key rotated — hand it up so the parent's holdings subscription
        // re-decodes with the new key instead of showing an empty
        // portfolio until reload.
        if (newKey) onKeyRotated?.(newKey);
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
      <div className="mb-1">
        <div className="label mb-2">Share link</div>
        <p className="text-[11px] text-fg-fade mb-3 leading-snug">
          Anyone with the link sees a percentages-only preview (no trade
          history, no amounts). Following — which needs an account — adds
          them below and unlocks the full friend view.
        </p>
        {link === undefined ? (
          <div className="h-9 bg-bg-3 rounded-md animate-pulse" />
        ) : link === null ? (
          <button
            onClick={() => void handleCreateLink()}
            disabled={linkBusy}
            className="btn-primary w-full disabled:opacity-50"
          >
            {linkBusy ? "Creating…" : "Create share link"}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-bg border border-line rounded-btn text-xs text-fg font-mono break-all min-w-0">
                {linkUrl ?? "…"}
              </code>
              <button
                onClick={() => void handleCopy()}
                disabled={!linkUrl}
                className="btn-primary text-xs px-3 py-2 disabled:opacity-50 shrink-0"
                title="Copy link"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-fg-fade num">
                created{" "}
                {new Date(link.createdAt).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </span>
              <span className="flex-1" />
              <button
                onClick={() => void handleRevokeLink(true)}
                disabled={linkBusy}
                className="btn-ghost px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" /> Regenerate
              </button>
              <button
                onClick={() => void handleRevokeLink(false)}
                disabled={linkBusy}
                className="btn-ghost px-2 py-1 inline-flex items-center gap-1 text-neg disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" /> Revoke
              </button>
            </div>
          </div>
        )}
      </div>
      {localShared.length > 0 && (
        <div className="mt-5 pt-5 border-t border-line">
          <div className="label mb-3">Followers</div>
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
    <li className="flex items-center gap-3 bg-bg-3 border border-line rounded-md p-2 pr-1.5">
      <InitialChip uid={uid} displayName={name || undefined} size={28} />
      <span className="flex-1 min-w-0 text-sm text-fg truncate">
        {name || <span className="text-fg-fade">Loading…</span>}
      </span>
      <button
        onClick={onRemove}
        disabled={disabled}
        className="w-7 h-7 inline-flex items-center justify-center text-fg-fade hover:text-neg transition shrink-0 disabled:opacity-50"
        aria-label={`Remove ${name || uid}`}
        title={`Remove ${name || uid}`}
      >
        <X className="w-4 h-4" />
      </button>
    </li>
  );
}
