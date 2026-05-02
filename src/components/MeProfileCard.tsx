"use client";

import { InitialChip } from "./InitialChip";

export function MeProfileCard({
  uid,
  displayName,
  email,
  onEdit,
}: {
  uid: string;
  displayName: string;
  email: string;
  onEdit: () => void;
}) {
  const shortUid =
    uid.length > 12 ? `${uid.slice(0, 5)}…${uid.slice(-5)}` : uid;
  return (
    <div className="flex items-center gap-[18px] p-[22px] bg-bg-2 border border-line rounded-card mb-6">
      <InitialChip uid={uid} displayName={displayName} size={56} />
      <div className="flex-1 min-w-0">
        <div className="text-[18px] font-semibold tracking-tight text-fg">
          {displayName}
        </div>
        <div className="text-[11.5px] font-mono text-fg-fade mt-1 truncate">
          uid: {shortUid} · {email}
        </div>
      </div>
      <button onClick={onEdit} className="btn-ghost">
        Edit profile
      </button>
    </div>
  );
}
