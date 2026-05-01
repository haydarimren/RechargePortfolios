// src/components/AppShell.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { User } from "firebase/auth";
import { InitialChip } from "./InitialChip";
import { useDisplayName } from "@/lib/users";

const NAV = [
  { href: "/mine", label: "Mine" },
  { href: "/activity", label: "Activity" },
  { href: "/friends", label: "Friends" },
  { href: "/me", label: "Me" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/mine") {
    // /mine is also the implicit home — any /p/... portfolio detail counts as Mine.
    return pathname === "/mine" || pathname === "/" || pathname.startsWith("/p/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/mine";
  const displayName = useDisplayName(user.uid) || user.displayName || "Me";

  return (
    <div className="flex flex-1 min-h-screen bg-bg">
      {/* Sidebar — md and up */}
      <aside className="hidden md:flex flex-col w-[180px] shrink-0 bg-bg-3 border-r border-line px-3 py-5 gap-1">
        <div className="text-sm font-semibold text-fg px-2.5 pt-1 pb-5">Recharge</div>
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors ${
                active
                  ? "bg-accent-soft text-accent"
                  : "text-fg-mid hover:text-fg"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <div className="flex-1" />
        <Link
          href="/me"
          className="flex items-center gap-2 px-2 py-2 text-xs text-fg-fade hover:text-fg"
        >
          <InitialChip uid={user.uid} displayName={displayName} size={22} />
          <span className="truncate">{displayName}</span>
        </Link>
      </aside>

      <main className="flex-1 min-w-0 pb-[68px] md:pb-0">{children}</main>

      {/* Bottom tab bar — below md */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-bg-3 grid grid-cols-4 px-1 pt-1.5 pb-[max(env(safe-area-inset-bottom),6px)]"
        aria-label="Primary"
      >
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center justify-center py-2 text-xs font-medium ${
                active ? "text-accent" : "text-fg-fade"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
