"use client";

import { useState } from "react";
import { arrayRemove, arrayUnion, doc, updateDoc } from "firebase/firestore";
import { X } from "lucide-react";
import { db } from "@/lib/firebase";
import { useDisplayName } from "@/lib/users";

interface SharePanelProps {
  portfolioId: string;
  sharedWith: string[];
  onClose: () => void;
}

export function SharePanel({ portfolioId, sharedWith, onClose: _onClose }: SharePanelProps) {
  void _onClose;
  const [uid, setUid] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = uid.trim();
    if (!trimmed) return;
    await updateDoc(doc(db, "portfolios", portfolioId), {
      sharedWith: arrayUnion(trimmed),
    });
    setUid("");
  };

  const handleRemove = async (target: string) => {
    await updateDoc(doc(db, "portfolios", portfolioId), {
      sharedWith: arrayRemove(target),
    });
  };

  return (
    <>
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
        <button type="submit" className="btn-primary w-full">
          Add friend
        </button>
      </form>
      {sharedWith.length > 0 && (
        <div className="mt-5 pt-5 border-t border-line">
          <div className="label mb-3">Currently shared with</div>
          <ul className="space-y-1.5">
            {sharedWith.map((friendUid) => (
              <SharedUserRow
                key={friendUid}
                uid={friendUid}
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
}: {
  uid: string;
  onRemove: () => void;
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
        className="text-fg-fade hover:text-neg transition shrink-0"
        aria-label={`Remove ${name || uid}`}
      >
        <X className="w-4 h-4" />
      </button>
    </li>
  );
}
