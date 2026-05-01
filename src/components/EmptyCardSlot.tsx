// src/components/EmptyCardSlot.tsx
"use client";

import { Plus } from "lucide-react";

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
  const tileSize = large ? "w-12 h-12" : "w-10 h-10";
  const iconSize = large ? "w-7 h-7" : "w-6 h-6";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2.5 w-full rounded-card border border-dashed border-line-strong text-fg-fade hover:border-accent hover:text-accent transition-colors ${minH} ${className}`}
    >
      <span
        className={`flex items-center justify-center rounded-[10px] border border-dashed border-current ${tileSize}`}
        aria-hidden
      >
        <Plus className={iconSize} strokeWidth={1.5} />
      </span>
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}
