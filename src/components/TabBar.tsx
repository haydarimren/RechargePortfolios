// src/components/TabBar.tsx
"use client";

export interface TabBarItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabBarProps {
  items: TabBarItem[];
  active: string;
  onSelect: (id: string) => void;
  className?: string;
}

export function TabBar({ items, active, onSelect, className = "" }: TabBarProps) {
  return (
    <div role="tablist" className={`flex gap-0 border-b border-line ${className}`}>
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(it.id)}
            className={`px-4 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors ${
              isActive
                ? "text-fg border-accent"
                : "text-fg-mid border-transparent hover:text-fg"
            }`}
          >
            {it.label}
            {typeof it.count === "number" ? (
              <span className="ml-1.5 text-xs font-medium text-fg-fade tabular-nums">
                {it.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
