"use client";

import { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function MeSettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-bg-2 border border-line rounded-card mb-[18px] overflow-hidden">
      <div className="px-[22px] py-3.5 text-[11px] tracking-[0.1em] uppercase font-semibold text-fg-fade border-b border-line">
        {title}
      </div>
      {children}
    </div>
  );
}

export function MeSettingsRow({
  name,
  description,
  right,
  onClick,
  danger = false,
}: {
  name: string;
  description?: string;
  right?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between w-full px-[22px] py-3.5 border-b border-line last:border-b-0 hover:bg-accent-soft text-left"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div
          className={`text-[13.5px] font-medium ${danger ? "text-neg" : "text-fg"}`}
        >
          {name}
        </div>
        {description ? (
          <div className="text-xs text-fg-fade leading-snug">{description}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {right}
        <ChevronRight className="w-4 h-4 text-fg-fade" aria-hidden />
      </div>
    </button>
  );
}
