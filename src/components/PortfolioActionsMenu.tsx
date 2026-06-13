"use client";

/**
 * Kebab (⋯) actions menu for a portfolio card on the home grid. Always
 * visible — tap or click opens the same Rename / Share / Delete menu on
 * every device, so the touch and desktop experiences are identical. The
 * previous design revealed the actions on hover only, which left them
 * completely unreachable on mobile (no hover → no delete).
 *
 * Rendered as a sibling overlay on top of the card's <Link>, so opening
 * the menu never navigates. Each action stops propagation + prevents
 * default defensively and closes the menu before firing its callback.
 */

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export function PortfolioActionsMenu({
  onRename,
  onShare,
  onDelete,
}: {
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click + Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="absolute top-3 right-3 z-20">
      <button
        type="button"
        aria-label="Portfolio actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition ${
          open
            ? "text-fg bg-bg-3 border-line"
            : "text-fg-fade border-transparent hover:text-fg hover:bg-bg-3 hover:border-line"
        }`}
      >
        <MoreHorizontal className="w-4 h-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-36 bg-bg-2 border border-line rounded-md shadow-lg py-1 animate-fade-up"
        >
          <MenuItem onClick={pick(onRename)}>Rename</MenuItem>
          <MenuItem onClick={pick(onShare)}>Share</MenuItem>
          <MenuItem onClick={pick(onDelete)} danger>
            Delete
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-sm transition ${
        danger
          ? "text-neg hover:bg-neg/10"
          : "text-fg-dim hover:text-accent hover:bg-bg-3"
      }`}
    >
      {children}
    </button>
  );
}
