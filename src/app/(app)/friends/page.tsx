"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FriendPortfolioCard, FriendPortfolioCardSummary } from "@/components/FriendPortfolioCard";
import { InitialChip } from "@/components/InitialChip";
import { InviteModal } from "@/components/InviteModal";
import { useDisplayNamesForUids } from "@/lib/users";
import { MoreHorizontal, Plus } from "lucide-react";

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

  // 9. Invite modal
  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="px-6 md:px-8 py-7 max-w-5xl">
      <header className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">Friends</h1>
          {shared !== undefined && (
            <p className="mt-1 text-xs text-fg-mid tabular-nums">
              {grouped.length} {grouped.length === 1 ? "friend" : "friends"} · {shared.length} {shared.length === 1 ? "portfolio" : "portfolios"} shared with you
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

      {shared === undefined ? (
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
