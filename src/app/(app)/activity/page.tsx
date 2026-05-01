"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Portfolio } from "@/lib/types";
import { useEncryption } from "@/lib/use-encryption";
import { getAllCachedPortfolioKeys, getUnlocked } from "@/lib/key-store";
import { loadPortfolioKeyWithRetry } from "@/lib/holdings-repo";
import { subscribeActivity } from "@/lib/activity-repo";
import { ActivityEvent } from "@/lib/activity-types";
import { ActivityRow } from "@/components/ActivityRow";
import { useDisplayNamesForUids } from "@/lib/users";

export default function ActivityPage() {
  const [user, setUser] = useState<User | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[] | undefined>(undefined);
  const [eventsByPortfolio, setEventsByPortfolio] = useState<Record<string, ActivityEvent[]>>({});
  const [portfolioKeys, setPortfolioKeys] = useState<Map<string, CryptoKey>>(
    () => getAllCachedPortfolioKeys(),
  );
  const portfolioKeysRef = useRef(portfolioKeys);
  useEffect(() => { portfolioKeysRef.current = portfolioKeys; }, [portfolioKeys]);
  const encryption = useEncryption();

  // 1. Auth
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // 2. All readable portfolios (owned + shared) — two queries, merged.
  // Note: Firestore can't OR these in one query with array-contains, so we run both.
  useEffect(() => {
    if (!user) return;
    const owned: Portfolio[] = [];
    const shared: Portfolio[] = [];
    const merge = () => {
      const seen = new Set<string>();
      const merged: Portfolio[] = [];
      for (const p of [...owned, ...shared]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
      setPortfolios(merged);
    };
    const unsubOwned = onSnapshot(
      query(collection(db, "portfolios"), where("ownerId", "==", user.uid)),
      (snap) => {
        owned.length = 0;
        for (const d of snap.docs) owned.push({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) });
        merge();
      },
    );
    const unsubShared = onSnapshot(
      query(collection(db, "portfolios"), where("sharedWith", "array-contains", user.uid)),
      (snap) => {
        shared.length = 0;
        for (const d of snap.docs) shared.push({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) });
        merge();
      },
    );
    return () => { unsubOwned(); unsubShared(); };
  }, [user]);

  // 3. Resolve K_portfolio for every encrypted portfolio (port pattern from /mine)
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    const needsResolve = (portfolios ?? []).filter(
      (p) => p.encrypted && !portfolioKeysRef.current.has(p.id),
    );
    if (needsResolve.length === 0) return;
    let cancelled = false;
    Promise.all(
      needsResolve.map(async (p) => {
        try {
          const k = await loadPortfolioKeyWithRetry(p.id, user.uid, unlocked.privateKey);
          return [p.id, k] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const successes = results.filter((r): r is readonly [string, CryptoKey] => r !== null);
      if (successes.length === 0) return;
      setPortfolioKeys((prev) => {
        const next = new Map(prev);
        for (const [id, k] of successes) next.set(id, k);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [user, portfolios, encryption.state.kind]);

  // 4. Subscribe to activity per portfolio (only those with resolved keys)
  useEffect(() => {
    if (!portfolios) return;
    const unsubs = portfolios
      .filter((p) => portfolioKeys.has(p.id))
      .map((p) =>
        subscribeActivity(p.id, portfolioKeys.get(p.id)!, (events) => {
          setEventsByPortfolio((prev) => ({ ...prev, [p.id]: events }));
        }),
      );
    return () => { unsubs.forEach((u) => u()); };
  }, [portfolios, portfolioKeys]);

  // 5. Merge across portfolios, sort newest-first
  const merged = useMemo(() => {
    const all: ActivityEvent[] = [];
    for (const list of Object.values(eventsByPortfolio)) all.push(...list);
    all.sort((a, b) => b.occurredAt - a.occurredAt);
    return all;
  }, [eventsByPortfolio]);

  // 6. Resolve actor display names + portfolio names lookup
  const actorUids = useMemo(() => Array.from(new Set(merged.map((e) => e.actorUid))), [merged]);
  const actorNames = useDisplayNamesForUids(actorUids);
  const portfolioById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of portfolios ?? []) m.set(p.id, p.name);
    return m;
  }, [portfolios]);

  // 7. Group by relative day
  const grouped = useMemo(() => groupByDay(merged), [merged]);

  return (
    <div className="px-6 md:px-8 py-7 max-w-[640px] mx-auto">
      <h1 className="text-[22px] font-semibold tracking-tight text-fg">Activity</h1>
      <p className="text-xs text-fg-mid mt-1 mb-5">Recent moves from your network</p>

      {portfolios === undefined ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-bg-2 border border-line rounded-md animate-pulse" />
          ))}
        </div>
      ) : merged.length === 0 ? (
        <p className="text-fg-mid">No activity yet. Buys, sells, shares, and renames will appear here.</p>
      ) : (
        grouped.map(({ day, events }) => (
          <section key={day}>
            <h2 className="text-[11px] tracking-[0.06em] uppercase font-semibold text-fg-fade mt-[18px] mb-2 first:mt-0">
              {day}
            </h2>
            {events.map((e) => (
              <ActivityRow
                key={e.id}
                event={e}
                actorDisplayName={actorNames[e.actorUid]}
                portfolioName={portfolioById.get(e.portfolioId) ?? ""}
                relativeTime={relTime(e.occurredAt)}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

function groupByDay(events: ActivityEvent[]): { day: string; events: ActivityEvent[] }[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
  const groups: Record<string, ActivityEvent[]> = {
    "Today": [], "Yesterday": [], "This week": [], "Earlier": [],
  };
  for (const e of events) {
    const d = new Date(e.occurredAt);
    if (d >= today) groups["Today"].push(e);
    else if (d >= yesterday) groups["Yesterday"].push(e);
    else if (d >= weekAgo) groups["This week"].push(e);
    else groups["Earlier"].push(e);
  }
  return Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([day, list]) => ({ day, events: list }));
}
