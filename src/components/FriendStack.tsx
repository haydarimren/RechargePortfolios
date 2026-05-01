// src/components/FriendStack.tsx
"use client";

import { InitialChip } from "./InitialChip";

export interface FriendStackPerson {
  uid: string;
  displayName?: string;
}

export interface FriendStackProps {
  people: FriendStackPerson[];
  /** Max chips to render before collapsing to "+N". Default 3. */
  max?: number;
  /** Per-chip diameter in px. Default 22. */
  size?: number;
  /** Right-side label, e.g. "3 friends following". Pass null to hide. */
  label?: string | null;
  /** Empty-state copy when `people.length === 0`. Pass null to hide entirely. */
  emptyLabel?: string | null;
}

/**
 * Stacked initial chips with descending z-index so the first chip reads
 * cleanest. When the count exceeds `max`, an additional neutral "+N" chip
 * caps the stack.
 */
export function FriendStack({
  people,
  max = 3,
  size = 22,
  label,
  emptyLabel = "Not shared yet",
}: FriendStackProps) {
  if (people.length === 0) {
    return emptyLabel ? (
      <span className="text-xs font-medium text-fg-fade">{emptyLabel}</span>
    ) : null;
  }
  const visible = people.slice(0, max);
  const overflow = people.length - visible.length;
  return (
    <div className="flex items-center">
      {visible.map((p, i) => (
        <span
          key={p.uid}
          style={{ zIndex: visible.length - i }}
          className="relative -ml-[7px] first:ml-0"
        >
          <InitialChip uid={p.uid} displayName={p.displayName} size={size} />
        </span>
      ))}
      {overflow > 0 ? (
        <span style={{ zIndex: 0 }} className="relative -ml-[7px]">
          <InitialChip
            uid="overflow"
            label={`+${overflow}`}
            size={size}
            background="var(--line)"
            foreground="var(--fg-mid)"
            title={`${overflow} more`}
          />
        </span>
      ) : null}
      {label ? (
        <span className="ml-3 text-xs font-medium text-fg-mid">{label}</span>
      ) : null}
    </div>
  );
}
