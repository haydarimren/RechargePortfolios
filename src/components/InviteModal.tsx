// src/components/InviteModal.tsx
"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase";

export function InviteModal({ onClose }: { onClose: () => void }) {
  const [uid, setUid] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUid(auth.currentUser?.uid ?? "");
  }, []);

  const handleCopy = async () => {
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // best effort
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-2 border border-line rounded-card p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-fg">Invite a friend</h2>
        <p className="mt-2 text-sm text-fg-mid leading-snug">
          Send your UID to a friend. They can paste it into their portfolio&apos;s
          Share dialog to add you as a viewer.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-bg border border-line rounded-btn text-xs text-fg font-mono break-all">
            {uid || "—"}
          </code>
          <button
            onClick={() => { void handleCopy(); }}
            disabled={!uid}
            className="btn-primary text-xs px-3 py-2 disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="flex justify-end mt-5">
          <button onClick={onClose} className="btn-ghost">Close</button>
        </div>
      </div>
    </div>
  );
}
