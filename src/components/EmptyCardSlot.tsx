// src/components/EmptyCardSlot.tsx
"use client";

export interface EmptyCardSlotProps {
  label: string;
  onClick?: () => void;
  /** Use this when the slot is the only thing on the page (empty state). */
  large?: boolean;
  className?: string;
}

/**
 * Dashed-border placeholder card with centered "+" + label. Used as the
 * trailing cell in the Mine grid (`+ New portfolio`) and as the all-empty
 * state when a user has no portfolios.
 */
export function EmptyCardSlot({
  label,
  onClick,
  large = false,
  className = "",
}: EmptyCardSlotProps) {
  const minH = large ? "min-h-[280px]" : "min-h-[240px]";
  const plusSize = large ? "w-12 h-12 text-3xl" : "w-10 h-10 text-2xl";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2.5 w-full rounded-card border border-dashed border-line-strong text-fg-fade hover:border-accent hover:text-accent transition-colors ${minH} ${className}`}
    >
      <span
        className={`flex items-center justify-center rounded-[10px] border border-dashed border-current font-light leading-none ${plusSize}`}
        aria-hidden
      >
        +
      </span>
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}
