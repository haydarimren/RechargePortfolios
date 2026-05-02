"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { aggregateHoldings } from "@/lib/portfolio";
import { getQuotes, StockQuote } from "@/lib/finnhub";
import { useEncryption } from "@/lib/use-encryption";
import { getAllCachedPortfolioKeys, getUnlocked } from "@/lib/key-store";
import {
  loadPortfolioKeyWithRetry,
  subscribeHoldings,
} from "@/lib/holdings-repo";
import { subscribeActivity } from "@/lib/activity-repo";
import type { ActivityEvent } from "@/lib/activity-types";
import { ActivityRow } from "@/components/ActivityRow";
import { FriendPortfolioCard, FriendPortfolioCardSummary } from "@/components/FriendPortfolioCard";
import { InitialChip } from "@/components/InitialChip";
import { InviteModal } from "@/components/InviteModal";
import { TabBar } from "@/components/TabBar";
import { useDisplayNamesForUids } from "@/lib/users";
import { MoreHorizontal, Plus } from "lucide-react";

type FriendsView = "portfolios" | "activity";

export default function FriendsPage() {
  // 1. Auth state
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  const encryption = useEncryption();

  // 2. Shared-with-me portfolios subscription
  // `undefined` means the first snapshot hasn't arrived; renders skeleton.
  const [shared, setShared] = useState<Portfolio[] | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    const portfolios = collection(db, "portfolios");
    return onSnapshot(
      query(portfolios, where("sharedWith", "array-contains", user.uid)),
      (snap) => {
        setShared(
          snap.docs.map(
            (d) => ({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) }),
          ),
        );
      },
    );
  }, [user]);

  // 3. Portfolio keys resolution with retry — seeded from module-level cache
  // so an in-tab nav back to /friends doesn't re-resolve already known keys.
  const [portfolioKeys, setPortfolioKeys] = useState<Map<string, CryptoKey>>(
    () => getAllCachedPortfolioKeys(),
  );
  // Read-only ref mirror so the resolution effect can check resolved state
  // without closing over stale state.
  const portfolioKeysRef = useRef(portfolioKeys);
  useEffect(() => {
    portfolioKeysRef.current = portfolioKeys;
  }, [portfolioKeys]);

  const sharedIds = useMemo(
    () =>
      (shared ?? [])
        .map((p) => p.id)
        .sort()
        .join(","),
    [shared],
  );

  // Eagerly resolve K_portfolio for every encrypted shared portfolio.
  // Runs in parallel so worst case is bounded by slowest single Firestore read.
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;

    const needsResolve = (shared ?? []).filter(
      (p) => p.encrypted && !portfolioKeysRef.current.has(p.id),
    );
    if (needsResolve.length === 0) return;

    let cancelled = false;
    Promise.all(
      needsResolve.map(async (p) => {
        try {
          const k = await loadPortfolioKeyWithRetry(
            p.id,
            user.uid,
            unlocked.privateKey,
          );
          return [p.id, k] as const;
        } catch {
          // Owner hasn't written wrappedKey doc yet. Dropped — retry on next
          // render-trigger.
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const successes = results.filter(
        (r): r is readonly [string, CryptoKey] => r !== null,
      );
      if (successes.length === 0) return;
      setPortfolioKeys((prev) => {
        const next = new Map(prev);
        for (const [id, k] of successes) next.set(id, k);
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [user, shared, encryption.state.kind]);

  // Drop key cache when encryption session ends.
  useEffect(() => {
    if (encryption.state.kind !== "unlocked") {
      setPortfolioKeys(new Map());
    }
  }, [encryption.state.kind]);

  // 4. Holdings subscription per shared portfolio that has a resolved key
  const [holdingsByPortfolio, setHoldingsByPortfolio] = useState<
    Record<string, Holding[]>
  >({});
  useEffect(() => {
    if (!sharedIds) return;
    const ids = sharedIds.split(",");
    const subs = ids.map((id) =>
      subscribeHoldings(
        id,
        portfolioKeys.get(id) ?? null,
        (rows) =>
          setHoldingsByPortfolio((prev) => ({ ...prev, [id]: rows })),
        () => {
          setHoldingsByPortfolio((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        },
      ),
    );
    return () => subs.forEach((s) => s.unsubscribe());
  }, [sharedIds, portfolioKeys]);

  // 5. Quotes
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({});

  // Display symbol → Yahoo query symbol (for tickers with yahooSymbol override)
  const yahooBySymbol = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of Object.values(holdingsByPortfolio).flat()) {
      if (h.yahooSymbol && !m.has(h.symbol)) m.set(h.symbol, h.yahooSymbol);
    }
    return m;
  }, [holdingsByPortfolio]);

  const fetchQuotesFor = useCallback(
    async (symbols: string[]): Promise<Record<string, StockQuote | null>> => {
      if (symbols.length === 0) return {};
      const apiSymbols = symbols.map((s) => yahooBySymbol.get(s) ?? s);
      const map = await getQuotes(apiSymbols);
      const out: Record<string, StockQuote | null> = {};
      symbols.forEach((s, i) => {
        out[s] = map[apiSymbols[i]] ?? null;
      });
      return out;
    },
    [yahooBySymbol],
  );

  useEffect(() => {
    const symbols = Array.from(
      new Set(
        Object.values(holdingsByPortfolio)
          .flat()
          .map((h) => h.symbol),
      ),
    );
    const missing = symbols.filter((s) => !(s in quotes));
    if (missing.length === 0) return;
    let cancelled = false;
    fetchQuotesFor(missing).then((map) => {
      if (cancelled) return;
      setQuotes((prev) => ({ ...prev, ...map }));
    });
    return () => {
      cancelled = true;
    };
  }, [holdingsByPortfolio, quotes, fetchQuotesFor]);

  // Retry failed (null) quotes once after 30s.
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  useEffect(() => {
    const nulls = Object.entries(quotesRef.current)
      .filter(([, v]) => v === null)
      .map(([s]) => s);
    if (nulls.length === 0) return;
    const t = setTimeout(() => {
      fetchQuotesFor(nulls).then((map) => {
        const fresh = Object.fromEntries(
          Object.entries(map).filter(([, q]) => q !== null),
        );
        if (Object.keys(fresh).length === 0) return;
        setQuotes((prev) => ({ ...prev, ...fresh }));
      });
    }, 30_000);
    return () => clearTimeout(t);
  }, [quotes, fetchQuotesFor]);

  // Refresh live quotes every 2 minutes.
  useEffect(() => {
    const id = setInterval(() => {
      const keys = Object.keys(quotesRef.current);
      if (keys.length === 0) return;
      fetchQuotesFor(keys).then((map) => {
        const fresh = Object.fromEntries(
          Object.entries(map).filter(([, q]) => q !== null),
        );
        if (Object.keys(fresh).length === 0) return;
        setQuotes((prev) => ({ ...prev, ...fresh }));
      });
    }, 120_000);
    return () => clearInterval(id);
  }, [fetchQuotesFor]);

  // 6. Group by ownerId, sorted by ownerUid
  const grouped = useMemo(() => {
    if (!shared) return [];
    const byOwner = new Map<string, Portfolio[]>();
    for (const p of shared) {
      const existing = byOwner.get(p.ownerId) ?? [];
      existing.push(p);
      byOwner.set(p.ownerId, existing);
    }
    return Array.from(byOwner.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ownerUid, portfolios]) => ({ ownerUid, portfolios }));
  }, [shared]);

  // 7. Resolve owner display names
  const ownerUids = useMemo(
    () => grouped.map((g) => g.ownerUid),
    [grouped],
  );
  const ownerNames = useDisplayNamesForUids(ownerUids);

  // 8. Build FriendPortfolioCardSummary per portfolio
  const summariesByPortfolio = useMemo(() => {
    const out: Record<string, FriendPortfolioCardSummary> = {};
    for (const p of shared ?? []) {
      const holdings = holdingsByPortfolio[p.id] ?? [];
      const positions = aggregateHoldings(holdings);
      let totalCost = 0;
      let totalValue = 0;
      for (const pos of positions) {
        totalCost += pos.cost;
        const q = quotes[pos.symbol];
        if (q) totalValue += pos.shares * q.c;
      }
      const lifetimeGainPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
      out[p.id] = {
        id: p.id,
        name: p.name,
        pctVsBenchmark: lifetimeGainPct,
        positionsCount: positions.length,
        lifetimeGainPct,
      };
    }
    return out;
  }, [shared, holdingsByPortfolio, quotes]);

  // 9. Subtab state — driven by ?view=activity in the URL so deep-links and
  // back-button navigation preserve the user's place. Defaults to "portfolios".
  const router = useRouter();
  const searchParams = useSearchParams();
  const view: FriendsView =
    searchParams?.get("view") === "activity" ? "activity" : "portfolios";
  const setView = useCallback(
    (next: FriendsView) => {
      router.replace(next === "activity" ? "/friends?view=activity" : "/friends");
    },
    [router],
  );

  // 10. Activity events per shared portfolio. Subscribed only when the
  // Activity subtab is active so the Portfolios subtab pays nothing.
  const [eventsByPortfolio, setEventsByPortfolio] = useState<
    Record<string, ActivityEvent[]>
  >({});
  useEffect(() => {
    if (view !== "activity") return;
    if (!shared) return;
    const subs = shared
      .filter((p) => portfolioKeys.has(p.id))
      .map((p) =>
        subscribeActivity(p.id, portfolioKeys.get(p.id)!, (events) => {
          setEventsByPortfolio((prev) => ({ ...prev, [p.id]: events }));
        }),
      );
    return () => subs.forEach((u) => u());
  }, [view, shared, portfolioKeys]);

  // Merge events across portfolios, newest-first.
  const mergedEvents = useMemo(() => {
    const all: ActivityEvent[] = [];
    for (const list of Object.values(eventsByPortfolio)) all.push(...list);
    all.sort((a, b) => b.occurredAt - a.occurredAt);
    return all;
  }, [eventsByPortfolio]);

  // Actor display-name lookups for activity rows. Owner names are already
  // resolved above for the friend section headers.
  const actorUids = useMemo(
    () => Array.from(new Set(mergedEvents.map((e) => e.actorUid))),
    [mergedEvents],
  );
  const actorNames = useDisplayNamesForUids(actorUids);
  const portfolioNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of shared ?? []) m.set(p.id, p.name);
    return m;
  }, [shared]);

  // Group events by relative day for the section headers ("Today",
  // "Yesterday", etc.). Empty buckets are dropped.
  const dayGroups = useMemo(() => groupByDay(mergedEvents), [mergedEvents]);

  // 11. Invite modal
  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="px-6 md:px-8 py-7 max-w-5xl">
      <header className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">Friends</h1>
          {shared !== undefined && (
            <p className="mt-1 text-xs text-fg-mid tabular-nums">
              {view === "activity"
                ? "Recent moves from your network"
                : `${grouped.length} ${grouped.length === 1 ? "friend" : "friends"} · ${shared.length} ${shared.length === 1 ? "portfolio" : "portfolios"} shared with you`}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="btn-ghost inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" aria-hidden /> Invite
        </button>
      </header>

      <TabBar
        items={[
          { id: "portfolios", label: "Portfolios" },
          { id: "activity", label: "Activity" },
        ]}
        active={view}
        onSelect={(id) => setView(id as FriendsView)}
        className="mb-5"
      />

      {view === "activity" ? (
        // Activity subtab — chronological feed, day-grouped
        shared === undefined ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-12 bg-bg-2 border border-line rounded-md animate-pulse"
              />
            ))}
          </div>
        ) : mergedEvents.length === 0 ? (
          <p className="text-fg-mid">
            No activity yet. As your friends buy, sell, or rebalance, their
            moves will show up here.
          </p>
        ) : (
          <div className="max-w-[640px]">
            {dayGroups.map(({ day, events }) => (
              <section key={day}>
                <h2 className="text-[11px] tracking-[0.06em] uppercase font-semibold text-fg-fade mt-[18px] mb-2 first:mt-0">
                  {day}
                </h2>
                {events.map((e) => (
                  <ActivityRow
                    key={e.id}
                    event={e}
                    actorDisplayName={actorNames[e.actorUid]}
                    portfolioName={portfolioNameById.get(e.portfolioId) ?? ""}
                    relativeTime={relTime(e.occurredAt)}
                  />
                ))}
              </section>
            ))}
          </div>
        )
      ) : shared === undefined ? (
        <div className="bg-bg-2 border border-line rounded-card min-h-[140px] animate-pulse" />
      ) : grouped.length === 0 ? (
        <p className="text-fg-mid">No friends yet. Use the Invite button to get started.</p>
      ) : (
        grouped.map(({ ownerUid, portfolios }) => (
          <section key={ownerUid} className="mb-7 last:mb-0">
            {/* Friend header */}
            <header className="flex items-center gap-3.5 pb-3.5 mb-4 border-b border-line">
              <InitialChip uid={ownerUid} displayName={ownerNames[ownerUid]} size={36} />
              <div className="flex-1 min-w-0">
                <div className="text-[15.5px] font-semibold text-fg tracking-tight">
                  {ownerNames[ownerUid] || "Loading…"}
                </div>
                <div className="text-[11.5px] text-fg-fade font-medium mt-0.5">
                  {portfolios.length} portfolio{portfolios.length === 1 ? "" : "s"} shared
                </div>
              </div>
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center text-fg-fade hover:text-fg"
                aria-label="More"
              >
                <MoreHorizontal className="w-4 h-4" aria-hidden />
              </button>
            </header>
            {/* Portfolio cards */}
            {portfolios.length === 0 ? (
              <div className="text-fg-fade text-sm border border-dashed border-line rounded-md p-4">
                Hasn&apos;t shared a portfolio with you yet
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {portfolios.map((p) => (
                  <FriendPortfolioCard
                    key={p.id}
                    summary={
                      summariesByPortfolio[p.id] ?? {
                        id: p.id,
                        name: p.name,
                        pctVsBenchmark: 0,
                        positionsCount: 0,
                        lifetimeGainPct: 0,
                      }
                    }
                    href={`/p/${p.id}`}
                  />
                ))}
              </div>
            )}
          </section>
        ))
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity-feed helpers (day grouping + relative time labels). Inline here
// since this page is the only consumer; if a second page ever needs them
// they'll get pulled into src/lib/activity-format.ts.
// ---------------------------------------------------------------------------

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

function groupByDay(
  events: ActivityEvent[],
): { day: string; events: ActivityEvent[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const groups: Record<string, ActivityEvent[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Earlier: [],
  };
  for (const e of events) {
    const d = new Date(e.occurredAt);
    if (d >= today) groups.Today.push(e);
    else if (d >= yesterday) groups.Yesterday.push(e);
    else if (d >= weekAgo) groups["This week"].push(e);
    else groups.Earlier.push(e);
  }
  return Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([day, list]) => ({ day, events: list }));
}
