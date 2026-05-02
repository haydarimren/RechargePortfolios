/**
 * Eight-color rotation used for any "this represents a person" surface
 * (avatars, friend chips, activity-row author chips, sidebar footer).
 *
 * Hex values match the design spec at
 * docs/superpowers/specs/2026-05-01-ui-overhaul-design.md#person-palette.
 */
export const IDENTITY_PALETTE = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#ec4899", // pink
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#ef4444", // red
  "#84cc16", // lime
] as const;

/**
 * Returns the palette index for `uid`. Same UID → same index.
 * Uses a polynomial rolling hash (h = h * 31 + c), identical to Java String.hashCode.
 */
export function identityColorIndex(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) {
    h = (h * 31 + uid.charCodeAt(i)) | 0;
  }
  // Force non-negative before modulo so the result is always in range.
  return Math.abs(h) % IDENTITY_PALETTE.length;
}

/** Convenience accessor: hex string for a uid. */
export function identityColor(uid: string): string {
  return IDENTITY_PALETTE[identityColorIndex(uid)];
}

/**
 * Initials from a display name. Single letter for short forms, two letters
 * if the name has a clear first/last split. Falls back to first uid char if
 * the display name is empty.
 */
export function initialsFor(displayName: string | undefined, uid: string): string {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return (uid[0] ?? "?").toUpperCase();
  const parts = trimmed.split(/\s+/);
  // Index by code point, not code unit — a leading emoji is two UTF-16 code
  // units (a surrogate pair), and `parts[0][0]` would return a lone half.
  const firstChar = [...parts[0]][0];
  if (parts.length >= 2) {
    const lastChar = [...parts[parts.length - 1]][0];
    return (firstChar + lastChar).toUpperCase();
  }
  return firstChar.toUpperCase();
}
