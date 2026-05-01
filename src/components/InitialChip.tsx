// src/components/InitialChip.tsx
"use client";

import {
  identityColorIndex,
  initialsFor,
} from "@/lib/identity-color";

export interface InitialChipProps {
  uid: string;
  /** Display name; used to derive initials. */
  displayName?: string;
  /** Pixel size of the chip. Common sizes: 22, 26, 30, 36, 56. */
  size?: number;
  /** Override label text (e.g. "+5" for overflow chips). */
  label?: string;
  /** Override background color (used by overflow / neutral chips). */
  background?: string;
  /** Override foreground (white by default). */
  foreground?: string;
  className?: string;
  title?: string;
}

/**
 * Colored circle with 1–2 letter initials. Color is deterministic from the
 * UID so the same person always reads as the same color across the app.
 *
 * For non-person chips (e.g. the "+5" overflow indicator) pass `background`
 * to opt out of the person palette.
 */
export function InitialChip({
  uid,
  displayName,
  size = 26,
  label,
  background,
  foreground = "#ffffff",
  className = "",
  title,
}: InitialChipProps) {
  const bg = background ?? `var(--person-${identityColorIndex(uid)})`;
  const text = label ?? initialsFor(displayName, uid);
  const fontSize = Math.max(9, Math.round(size * 0.42));
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold select-none shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: bg,
        color: foreground,
        fontSize,
        lineHeight: 1,
      }}
      title={title ?? displayName ?? uid}
      aria-hidden={!title}
    >
      {text}
    </span>
  );
}
