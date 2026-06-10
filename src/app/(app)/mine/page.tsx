"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { Plus, X } from "lucide-react";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { aggregateHoldings } from "@/lib/portfolio";
import { getQuotes, StockQuote } from "@/lib/finnhub";
import { useEncryption } from "@/lib/use-encryption";
import {
  getAllCachedPortfolioKeys,
  getUnlocked,
} from "@/lib/key-store";
import {
  loadPortfolioKeyWithRetry,
  reconcileSharedWrappedKeys,
  subscribeHoldings,
} from "@/lib/holdings-repo";
import { seedPortfolioView } from "@/lib/views";
import { PortfolioCard, PortfolioCardSummary } from "@/components/PortfolioCard";
import { EmptyCardSlot } from "@/components/EmptyCardSlot";
import { SharePanel } from "@/components/SharePanel";
import { useDisplayNamesForUids } from "@/lib/users";

export default function MinePage() {
  // 1. Auth state (just the user object — redirect handled by (app)/layout.tsx)
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  const encryption = useEncryption();

  // 2. Owned portfolios subscription
  // `undefined` means the first Firestore snapshot hasn't arrived yet —
  // render skeleton. Once a snapshot lands, value is always a (possibly
  // empty) array.
  const [mine, setMine] = useState<Portfolio[] | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    const portfolios = collection(db, "portfolios");
    return onSnapshot(
      query(portfolios, where("ownerId", "==", user.uid)),
      (snap) => {
        setMine(
          snap.docs.map(
            (d) => ({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) }),
          ),
        );
      },
    );
  }, [user]);

  // 3. Seed baseline view records for owned portfolios that have sharedWith
  // entries so the "N new" badge on the friend's side starts counting from
  // now. seedPortfolioView is fire-and-forget with merge:true — calling it
  // repeatedly is safe.
  useEffect(() => {
    if (!user || !mine || mine.length === 0) return;
    for (const p of mine) {
      if (p.sharedWith.length > 0) {
        seedPortfolioView(user.uid, p.id);
      }
    }
  }, [user, mine]);

  // 4. Portfolio keys resolution with retry
  // Seeded from the module-level cache so an in-tab nav back to /mine
  // doesn't re-resolve keys we already have in memory.
  const [portfolioKeys, setPortfolioKeys] = useState<Map<string, CryptoKey>>(
    () => getAllCachedPortfolioKeys(),
  );
  // Tracks which encrypted portfolios have completed a key-resolution
  // attempt — success OR final failure. Without this the UI can't tell
  // "still resolving" from "owner hasn't reconciled yet" (both appear as
  // !portfolioKeys.has(p.id)). Cards consult this to choose between
  // pulse-skeleton (resolving) vs. genuine "…" (attempted-but-failed).
  const [keyResolutionAttempted, setKeyResolutionAttempted] = useState<
    Set<string>
  >(() => new Set(getAllCachedPortfolioKeys().keys()));
  // Read-only ref mirror of portfolioKeys so the resolution effect can
  // check what's already resolved without closing over stale state.
  const portfolioKeysRef = useRef(portfolioKeys);
  useEffect(() => {
    portfolioKeysRef.current = portfolioKeys;
  }, [portfolioKeys]);

  const mineIds = useMemo(
    () =>
      (mine ?? [])
        .map((p) => p.id)
        .sort()
        .join(","),
    [mine],
  );

  // Eagerly resolve K_portfolio for every encrypted portfolio I own.
  // Runs in parallel so the worst case is bounded by the slowest single
  // Firestore read, not the sum across N portfolios.
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;

    const needsResolve = (mine ?? []).filter(
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
          // Owner hasn't written wrappedKey doc yet (race on first
          // portfolio creation). Dropped — we'll retry on the next
          // render-trigger.
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      // Mark every portfolio we tried to resolve as attempted, regardless
      // of success. This is what the UI consults to know the resolution
      // window has closed and it can stop rendering the pulse-skeleton.
      setKeyResolutionAttempted((prev) => {
        const next = new Set(prev);
        for (const p of needsResolve) next.add(p.id);
        return next;
      });
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
  }, [user, mine, encryption.state.kind]);

  // Drop the key cache when the encryption session ends.
  // CryptoKey objects are tab-scoped JS handles — letting them survive a
  // sign-out is a footgun (next sign-in would briefly hold someone else's
  // keys).
  useEffect(() => {
    if (encryption.state.kind !== "unlocked") {
      setPortfolioKeys(new Map());
      setKeyResolutionAttempted(new Set());
    }
  }, [encryption.state.kind]);

  // Owner-side reconcile: for every encrypted portfolio I own that has
  // sharedWith entries, ensure each friend has a wrappedKey doc. This
  // catches the case where a friend enrolls after I migrated my portfolio.
  useEffect(() => {
    if (!user || encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    let cancelled = false;
    (async () => {
      for (const p of mine ?? []) {
        if (cancelled) return;
        if (!p.encrypted || p.sharedWith.length === 0) continue;
        const key = portfolioKeys.get(p.id);
        if (!key) continue; // key resolution effect hasn't filled this in yet
        try {
          await reconcileSharedWrappedKeys(p.id, p.sharedWith, {
            portfolioKey: key,
            ownerPrivateKey: unlocked.privateKey,
            ownerPublicKeyHex: unlocked.publicKeyHex,
          });
        } catch (err) {
          console.warn("reconcile from /mine failed", p.id, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, mine, portfolioKeys, encryption.state.kind]);

  // 5. Holdings subscription per portfolio
  const [holdingsByPortfolio, setHoldingsByPortfolio] = useState<
    Record<string, Holding[]>
  >({});
  useEffect(() => {
    if (!mineIds) return;
    const ids = mineIds.split(",");
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
  }, [mineIds, portfolioKeys]);

  // 6. Quotes
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({});

  // Display symbol → Yahoo query symbol (for tickers with yahooSymbol override).
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

  // Retry failed (null) quotes once after 30s to avoid a tight retry loop.
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

  // 7. New portfolio modal
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newName.trim()) return;
    // If the user is enrolled + unlocked, mint the portfolio encrypted
    // from day one — provision K_portfolio + wrap for self before
    // returning. Pre-encryption users keep the legacy plaintext path.
    const unlocked = getUnlocked(user.uid);
    const isEncryptedFromStart =
      encryption.state.kind === "unlocked" && !!unlocked;
    const ref = await addDoc(collection(db, "portfolios"), {
      ownerId: user.uid,
      ownerEmail: user.email ?? "",
      name: newName.trim(),
      sharedWith: [],
      createdAt: Date.now(),
      ...(isEncryptedFromStart ? { encrypted: true } : {}),
    });
    if (isEncryptedFromStart && unlocked) {
      const { provisionPortfolioKey } = await import("@/lib/holdings-repo");
      await provisionPortfolioKey(
        ref.id,
        user.uid,
        unlocked.privateKey,
        unlocked.publicKey,
        unlocked.publicKeyHex,
      );
    }
    setNewName("");
    setShowNew(false);
  };

  const handleDelete = async (p: Portfolio) => {
    if (!confirm(`Delete "${p.name}"? All holdings will be lost.`)) return;
    await deleteDoc(doc(db, "portfolios", p.id));
  };

  // 8. Share modal
  const [shareTarget, setShareTarget] = useState<Portfolio | null>(null);
  const [shareTargetKey, setShareTargetKey] = useState<CryptoKey | null>(null);
  useEffect(() => {
    setShareTargetKey(null);
    if (!shareTarget || !user) return;
    if (!shareTarget.encrypted) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    let cancelled = false;
    loadPortfolioKeyWithRetry(shareTarget.id, user.uid, unlocked.privateKey)
      .then((k) => {
        if (!cancelled) setShareTargetKey(k);
      })
      .catch(() => {
        // Owner doesn't have a wrappedKey doc — shouldn't happen post-
        // migration. SharePanel will refuse to share without context.
      });
    return () => {
      cancelled = true;
    };
  }, [shareTarget, user, encryption.state.kind]);

  // 9. Rename modal
  const [renameTarget, setRenameTarget] = useState<Portfolio | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !renameTarget || !renameValue.trim()) return;
    const newName = renameValue.trim();
    const portfolioRef = doc(db, "portfolios", renameTarget.id);
    await updateDoc(portfolioRef, { name: newName });
    setRenameTarget(null);
    setRenameValue("");
  };

  // 10. Build PortfolioCardSummary array
  const summaries: PortfolioCardSummary[] = useMemo(() => {
    if (!mine) return [];
    return mine.map((p) =>
      buildSummary(p, holdingsByPortfolio[p.id] ?? [], quotes),
    );
  }, [mine, holdingsByPortfolio, quotes]);

  // 10. Resolve follower display names
  const followerUids = useMemo(
    () => Array.from(new Set(mine?.flatMap((p) => p.sharedWith) ?? [])),
    [mine],
  );
  const displayNames = useDisplayNamesForUids(followerUids);

  return (
    <div className="px-6 md:px-8 py-7 max-w-5xl">
      <header className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">
            Mine
          </h1>
          {mine ? (
            <p className="mt-1 text-xs text-fg-dim tabular-nums">
              {summaryLine(summaries)}
            </p>
          ) : null}
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="btn-primary inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" aria-hidden /> New portfolio
        </button>
      </header>

      {mine === undefined ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[18px]">
          <div className="bg-bg-2 border border-line rounded-card min-h-[240px] animate-pulse" />
          <div className="bg-bg-2 border border-line rounded-card min-h-[240px] animate-pulse" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[18px]">
          {summaries.map((s) => {
            const p = mine.find((m) => m.id === s.id)!;
            return (
              <div key={s.id} className="relative group">
                <PortfolioCard
                  summary={enrichWithNames(s, displayNames)}
                  href={`/p/${s.id}`}
                  resolving={
                    p.encrypted &&
                    !portfolioKeys.has(p.id) &&
                    !keyResolutionAttempted.has(p.id)
                  }
                />
                {/* action buttons — visible on hover, positioned inside the card area */}
                <div className="absolute bottom-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      setRenameTarget(p);
                      setRenameValue(p.name);
                    }}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-bg-3 border border-line text-fg-dim hover:text-accent hover:border-accent transition"
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      setShareTarget(p);
                    }}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-bg-3 border border-line text-fg-dim hover:text-accent hover:border-accent transition"
                    title="Share"
                  >
                    Share
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      void handleDelete(p);
                    }}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-bg-3 border border-line text-fg-dim hover:text-neg hover:border-neg transition"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          <EmptyCardSlot
            label="New portfolio"
            large={summaries.length === 0}
            onClick={() => setShowNew(true)}
            className={summaries.length === 0 ? "col-span-full" : undefined}
          />
        </div>
      )}

      {showNew && (
        <Modal onClose={() => { setShowNew(false); setNewName(""); }} title="New portfolio">
          <form onSubmit={(e) => { void handleCreate(e); }} className="space-y-4">
            <div>
              <label className="label block mb-1.5">Name</label>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Long-term growth"
                className="field"
                required
              />
            </div>
            <button type="submit" className="btn-primary w-full">
              Create portfolio
            </button>
          </form>
        </Modal>
      )}

      {renameTarget && (
        <Modal
          onClose={() => { setRenameTarget(null); setRenameValue(""); }}
          title="Rename portfolio"
        >
          <form onSubmit={(e) => { void handleRename(e); }} className="space-y-4">
            <div>
              <label className="label block mb-1.5">New name</label>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Portfolio name"
                className="field"
                required
              />
            </div>
            <button type="submit" className="btn-primary w-full">
              Save
            </button>
          </form>
        </Modal>
      )}

      {shareTarget && (
        <Modal
          onClose={() => setShareTarget(null)}
          title={`Share "${shareTarget.name}"`}
        >
          <SharePanel
            portfolioId={shareTarget.id}
            ownerUid={shareTarget.ownerId}
            portfolioName={shareTarget.name}
            holdings={holdingsByPortfolio[shareTarget.id] ?? []}
            sharedWith={shareTarget.sharedWith}
            onClose={() => setShareTarget(null)}
            encryption={
              shareTarget.encrypted &&
              shareTargetKey &&
              user &&
              getUnlocked(user.uid)
                ? {
                    portfolioKey: shareTargetKey,
                    ownerPrivateKey: getUnlocked(user.uid)!.privateKey,
                    ownerPublicKey: getUnlocked(user.uid)!.publicKey,
                    ownerPublicKeyHex: getUnlocked(user.uid)!.publicKeyHex,
                  }
                : undefined
            }
          />
        </Modal>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md p-6 animate-fade-up">
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-fg-fade hover:text-fg transition">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function buildSummary(
  p: Portfolio,
  holdings: Holding[],
  quotes: Record<string, StockQuote | null>,
): PortfolioCardSummary {
  const positions = aggregateHoldings(holdings);
  let totalCost = 0;
  let totalValue = 0;
  for (const pos of positions) {
    // `cost` on TickerPosition is the aggregated cost basis.
    totalCost += pos.cost;
    const q = quotes[pos.symbol];
    if (q) totalValue += pos.shares * q.c;
  }
  const pl = totalValue - totalCost;
  const plPct = totalCost > 0 ? (pl / totalCost) * 100 : 0;
  // pctVsBenchmark: placeholder — shows P/L pct vs cost until Phase 4
  // adds per-card benchmark comparison.
  return {
    id: p.id,
    name: p.name,
    ownerUid: p.ownerId,
    totalValue,
    pctVsBenchmark: plPct,
    benchmarkLabel: "vs cost",
    positionsCount: positions.length,
    pl: { amount: pl, pct: plPct },
    followers: p.sharedWith.map((uid) => ({ uid })),
  };
}

function enrichWithNames(
  s: PortfolioCardSummary,
  names: Record<string, string>,
): PortfolioCardSummary {
  return {
    ...s,
    followers: s.followers.map((f) => ({
      ...f,
      displayName: names[f.uid] || undefined,
    })),
  };
}

function summaryLine(summaries: PortfolioCardSummary[]): string {
  const totalPositions = summaries.reduce((sum, s) => sum + s.positionsCount, 0);
  const allUp = summaries.every((s) => s.pl.amount >= 0);
  const allDown = summaries.every((s) => s.pl.amount < 0);
  const trend =
    summaries.length === 0
      ? ""
      : allUp
        ? " · all up"
        : allDown
          ? " · all down"
          : " · mixed";
  return `${summaries.length} portfolio${summaries.length === 1 ? "" : "s"} · ${totalPositions} position${totalPositions === 1 ? "" : "s"}${trend}`;
}
