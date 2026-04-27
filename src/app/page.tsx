"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Holding, Portfolio } from "@/lib/types";
import { getQuotes, StockQuote } from "@/lib/finnhub";
import { aggregateHoldings } from "@/lib/portfolio";
import { ThemeToggle } from "@/lib/theme";
import { ensureUserProfile, useDisplayName } from "@/lib/users";
import {
  PortfolioView,
  seedPortfolioView,
  subscribeToPortfolioViews,
} from "@/lib/views";
import { SharePanel } from "@/components/SharePanel";
import { UnlockModal } from "@/components/UnlockModal";
import { useEncryption } from "@/lib/use-encryption";
import { getUnlocked } from "@/lib/key-store";
import {
  loadPortfolioKey,
  reconcileSharedWrappedKeys,
  runEagerMigrations,
  subscribeHoldings,
} from "@/lib/holdings-repo";
import { ArrowUpRight, Plus, Trash2, UserPlus, X } from "lucide-react";

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState<Portfolio[]>([]);
  const [shared, setShared] = useState<Portfolio[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [shareTarget, setShareTarget] = useState<Portfolio | null>(null);
  const [holdingsByPortfolio, setHoldingsByPortfolio] = useState<Record<string, Holding[]>>({});
  const [quotes, setQuotes] = useState<Record<string, StockQuote | null>>({});
  const [portfolioViews, setPortfolioViews] = useState<Map<string, PortfolioView>>(new Map());
  const router = useRouter();
  const encryption = useEncryption();

  // K_portfolio for every encrypted portfolio (mine OR shared with me).
  // Resolved opportunistically once the user is unlocked. Two reasons we
  // need this on the home page specifically:
  //   1. Rendering the per-portfolio summary cards needs decoded holdings,
  //      which means each encrypted portfolio's symmetric key must be in
  //      hand before subscribeHoldings can decode anything.
  //   2. Cache key: portfolioId. We never cache failures (a missing
  //      wrappedKey doc throws → entry stays absent), so the next render
  //      pass will retry. That's how the "owner ran reconcile after I
  //      enrolled" case auto-heals without an extra subscription.
  const [portfolioKeys, setPortfolioKeys] = useState<Map<string, CryptoKey>>(
    new Map(),
  );
  // Read-only mirror of `portfolioKeys` so the resolution effect can check
  // what's already resolved without depending on the state itself (which
  // would either re-run on every key arrival or wedge into a stale
  // closure). Updated in an effect to satisfy react-hooks/refs (don't
  // mutate refs during render).
  const portfolioKeysRef = useRef(portfolioKeys);
  useEffect(() => {
    portfolioKeysRef.current = portfolioKeys;
  }, [portfolioKeys]);

  // K_portfolio for the current share-modal target. Resolved when an
  // encrypted portfolio's share dialog opens, so SharePanel can wrap +
  // rotate without reaching into the key store itself.
  const [shareTargetKey, setShareTargetKey] = useState<CryptoKey | null>(null);
  useEffect(() => {
    setShareTargetKey(null);
    if (!shareTarget || !user) return;
    if (!shareTarget.encrypted) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    let cancelled = false;
    loadPortfolioKey(shareTarget.id, user.uid, unlocked.privateKey)
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.push("/login");
        return;
      }
      setUser(u);
      setLoading(false);
      void ensureUserProfile(u).catch(() => {});
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    const portfolios = collection(db, "portfolios");
    const unsubMine = onSnapshot(
      query(portfolios, where("ownerId", "==", user.uid)),
      (snap) => {
        setMine(
          snap.docs.map(
            (d) => ({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) })
          )
        );
      }
    );
    const unsubShared = onSnapshot(
      query(portfolios, where("sharedWith", "array-contains", user.uid)),
      (snap) => {
        setShared(
          snap.docs.map(
            (d) => ({ id: d.id, ...(d.data() as Omit<Portfolio, "id">) })
          )
        );
      }
    );
    return () => {
      unsubMine();
      unsubShared();
    };
  }, [user]);

  // Subscribe to this user's portfolio-view read state. Drives the "N new"
  // badge on shared cards and the unread dot on the Logbook tab.
  useEffect(() => {
    if (!user) return;
    return subscribeToPortfolioViews(user.uid, setPortfolioViews);
  }, [user]);

  // First-view baseline: when a portfolio is newly shared with the user and
  // has no `portfolioViews` record yet, seed it with "now" so the user isn't
  // surprised by a dump of pre-existing trades marked unread.
  useEffect(() => {
    if (!user || shared.length === 0) return;
    for (const p of shared) {
      if (!portfolioViews.has(p.id)) {
        seedPortfolioView(user.uid, p.id);
      }
    }
  }, [user, shared, portfolioViews]);

  const portfolioIds = useMemo(
    () => [...mine, ...shared].map((p) => p.id).sort().join(","),
    [mine, shared]
  );

  // Eagerly resolve K_portfolio for every encrypted portfolio in view.
  // We resolve in parallel so the worst case is bounded by the slowest
  // single Firestore read (~50ms), not the sum across N portfolios.
  // Failed resolutions are intentionally NOT cached: a sharer whose owner
  // hasn't run reconcile yet stays absent from the map, and the next
  // render pass (e.g. when the shared array updates from Firestore)
  // retries automatically. That's how "owner enrolled after me" auto-
  // heals without subscribing to wrappedKeys/{me}.
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;

    const all = [...mine, ...shared];
    const needsResolve = all.filter(
      (p) => p.encrypted && !portfolioKeysRef.current.has(p.id),
    );
    if (needsResolve.length === 0) return;

    let cancelled = false;
    Promise.all(
      needsResolve.map(async (p) => {
        try {
          const k = await loadPortfolioKey(p.id, user.uid, unlocked.privateKey);
          return [p.id, k] as const;
        } catch {
          // Owner hasn't wrapped K_portfolio for this viewer yet (sharer
          // who enrolled after the last owner-side reconcile). Drop —
          // we'll retry on the next render-trigger.
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
  }, [user, mine, shared, encryption.state.kind]);

  // Drop the key cache when the encryption session ends. CryptoKey
  // objects are tab-scoped JS handles — letting them survive a sign-out
  // is a footgun (next sign-in would briefly hold someone else's keys).
  useEffect(() => {
    if (encryption.state.kind !== "unlocked") {
      setPortfolioKeys(new Map());
    }
  }, [encryption.state.kind]);

  // Eager migrations on first unlock. Walks every owned portfolio and
  // brings each up to date on all current schema migrations:
  //   - plaintext → ciphertext (Phase 2)
  //   - v1 holding shape → v2 (move importSource/t212OrderId inside payload)
  //   - secrets/trading212 → secrets/credentials path rename
  //   - drop deprecated connectedBrokers field
  // Runs once per session via the ref-guarded flag below — re-renders
  // don't trigger re-migration. After a single successful pass, the
  // migration helpers all become idempotent no-ops on subsequent visits.
  const ranEagerMigrationsForUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user || encryption.state.kind !== "unlocked") return;
    if (ranEagerMigrationsForUidRef.current === user.uid) return;
    if (mine.length === 0) return; // wait for the portfolio list to land
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    ranEagerMigrationsForUidRef.current = user.uid;
    void runEagerMigrations(
      user.uid,
      mine.map((p) => ({ id: p.id, encrypted: p.encrypted })),
      unlocked.privateKey,
      unlocked.publicKey,
      unlocked.publicKeyHex,
    ).catch((err) => {
      console.warn("eager migrations failed", err);
      // Allow retry on next render after a failure.
      ranEagerMigrationsForUidRef.current = null;
    });
  }, [user, mine, encryption.state.kind]);

  // Owner-side reconcile: for every encrypted portfolio I own that has
  // sharers, walk sharedWith and write missing wrappedKey docs for any
  // friend that has a publicKey but no wrap yet. This catches the case
  // where a friend enrolls AFTER I migrated my portfolio — without it,
  // the friend would see "Waiting for owner's next sign-in" indefinitely
  // until I happened to click into that specific portfolio's detail page.
  // Running on every home load is ~one Firestore read per (sharer ×
  // unmigrated friend) — negligible at our scale, and it makes the
  // migration window painless for both sides.
  useEffect(() => {
    if (!user || encryption.state.kind !== "unlocked") return;
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) return;
    let cancelled = false;
    (async () => {
      for (const p of mine) {
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
          // Don't surface — failures are recoverable on next load. Most
          // common cause is a transient network blip.
          console.warn("reconcile from home failed", p.id, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, mine, portfolioKeys, encryption.state.kind]);

  // Holdings subscriptions. Routed through subscribeHoldings so the
  // encrypted shape (`payload`+`iv` envelopes) gets decoded when we have
  // the key, and the legacy plaintext shape passes through unchanged for
  // pre-migration portfolios. Re-runs when portfolioKeys changes; this
  // tears down + rebuilds all subscriptions, but at ≤10 portfolios the
  // cost is negligible.
  useEffect(() => {
    if (!portfolioIds) return;
    const ids = portfolioIds.split(",");
    const subs = ids.map((id) =>
      subscribeHoldings(
        id,
        portfolioKeys.get(id) ?? null,
        (rows) => setHoldingsByPortfolio((prev) => ({ ...prev, [id]: rows })),
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
  }, [portfolioIds, portfolioKeys]);

  // Display symbol → Yahoo query symbol, derived from any holding that
  // carries `yahooSymbol`. Used by every quote fetch path below so that
  // `quotes` stays keyed by the user-visible symbol.
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
    [yahooBySymbol]
  );

  useEffect(() => {
    const symbols = Array.from(
      new Set(Object.values(holdingsByPortfolio).flat().map((h) => h.symbol))
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
          Object.entries(map).filter(([, q]) => q !== null)
        );
        if (Object.keys(fresh).length === 0) return;
        setQuotes((prev) => ({ ...prev, ...fresh }));
      });
    }, 30_000);
    return () => clearTimeout(t);
  }, [quotes]);

  // Refresh live quotes every 2 minutes.
  useEffect(() => {
    const id = setInterval(() => {
      const keys = Object.keys(quotesRef.current);
      if (keys.length === 0) return;
      fetchQuotesFor(keys).then((map) => {
        const fresh = Object.fromEntries(
          Object.entries(map).filter(([, q]) => q !== null)
        );
        if (Object.keys(fresh).length === 0) return;
        setQuotes((prev) => ({ ...prev, ...fresh }));
      });
    }, 120_000);
    return () => clearInterval(id);
  }, [fetchQuotesFor]);

  const gainByPortfolio = useMemo(() => {
    // A single unresolvable ticker (e.g. a London ETF that Yahoo doesn't
    // answer for) shouldn't hide the card's % for every other position.
    // Compute gain from positions that DO have quotes; flag `partial` so the
    // UI can hint that some tickers are missing without the whole card
    // collapsing to "…".
    const out: Record<string, { cost: number; gain: number; gainPct: number; ready: boolean; partial: boolean }> = {};
    for (const [pid, holdings] of Object.entries(holdingsByPortfolio)) {
      const positions = aggregateHoldings(holdings);
      let cost = 0;
      let market = 0;
      let covered = 0;
      for (const p of positions) {
        const q = quotes[p.symbol];
        if (q) {
          cost += p.cost;
          market += p.shares * q.c;
          covered++;
        }
      }
      const gain = market - cost;
      const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
      // `ready` once we have at least one priced position; `partial` if some
      // tickers are still/never resolving.
      const ready = positions.length > 0 && covered > 0;
      const partial = ready && covered < positions.length;
      out[pid] = { cost, gain, gainPct, ready, partial };
    }
    return out;
  }, [holdingsByPortfolio, quotes]);

  // Per shared portfolio: count holdings created after the viewer's last
  // portfolio-open timestamp. Only populated for portfolios with a view
  // record (otherwise the baseline write is still in flight — skip).
  const unreadBySharedId = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of shared) {
      const view = portfolioViews.get(p.id);
      if (!view) continue; // baseline not yet written — show nothing
      const holdings = holdingsByPortfolio[p.id] ?? [];
      let count = 0;
      for (const h of holdings) {
        if ((h.createdAt ?? 0) > view.lastPortfolioViewAt) count++;
      }
      out[p.id] = count;
    }
    return out;
  }, [shared, portfolioViews, holdingsByPortfolio]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newName.trim()) return;
    // If the user is enrolled + unlocked, mint the new portfolio as
    // encrypted from day one — provision K_portfolio + wrap for self
    // before returning. Pre-encryption users (uninitialized) keep the
    // legacy plaintext path.
    const unlocked = getUnlocked(user.uid);
    const isEncryptedFromStart = encryption.state.kind === "unlocked" && !!unlocked;
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-sm text-fg-dim">Loading…</span>
      </div>
    );
  }

  // Encryption gate: shown over the home page when the user is enrolled
  // Recovery-only gate: shown when this browser doesn't have a local
  // wrap key for an enrolled user. Daily login auto-unlocks silently
  // (no modal). Pre-encryption users (uninitialized) are handled by
  // EnrollmentGate at the layout level.
  const needsRecovery = encryption.state.kind === "needs-recovery";

  return (
    <div className="min-h-screen">
      {needsRecovery && encryption.state.kind === "needs-recovery" && (
        <UnlockModal
          uid={encryption.state.uid}
          onRestore={encryption.restore}
        />
      )}
      <header className="px-6 lg:px-10 pt-6 pb-4 border-b border-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="font-semibold tracking-tight">Recharge</div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-fg-dim hidden md:inline truncate max-w-[220px]">
              {user?.email}
            </span>
            <Link
              href="/settings"
              className="text-sm text-fg-dim hover:text-accent transition"
            >
              Settings
            </Link>
            <ThemeToggle />
            <button
              onClick={() => signOut(auth)}
              className="text-sm text-fg-dim hover:text-accent transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 lg:px-10 py-10 space-y-12">
        <section className="animate-fade-up">
          <div className="flex items-baseline justify-between mb-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                My portfolios
              </h1>
              <p className="text-sm text-fg-dim mt-1">
                {mine.length === 0
                  ? "None yet. Create one below."
                  : `${mine.length} portfolio${mine.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <button
              onClick={() => setShowNew(true)}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> New
            </button>
          </div>

          {mine.length === 0 ? (
            <div className="card p-10 text-center text-fg-dim text-sm">
              Nothing here yet.
            </div>
          ) : (
            <ul className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {mine.map((p) => {
                const g = gainByPortfolio[p.id];
                const tint = tintForGain(g?.ready ? g.gain : null);
                return (
                <li key={p.id} className={`card p-5 group relative transition ${tint}`}>
                  <Link
                    href={`/portfolios/${p.id}`}
                    className="absolute inset-0 rounded-[inherit]"
                    aria-label={p.name}
                  />
                  <div className="flex items-start justify-between mb-8 relative z-10 pointer-events-none">
                    <div className="label">Portfolio</div>
                    <ArrowUpRight className="w-4 h-4 text-fg-fade group-hover:text-accent group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition" />
                  </div>
                  <h3 className="text-lg font-medium mb-1 relative z-10 pointer-events-none truncate">
                    {p.name}
                  </h3>
                  <div className="text-xs text-fg-fade mb-2 relative z-10 pointer-events-none">
                    {p.sharedWith.length
                      ? `Shared with ${p.sharedWith.length}`
                      : "Private"}
                  </div>
                  <div className="num text-sm mb-4 relative z-10 pointer-events-none min-h-[1.25rem]">
                    {g?.ready ? (
                      <span className={g.gain >= 0 ? "text-pos" : "text-neg"}>
                        {g.gain >= 0 ? "+" : ""}{fmtMoney(g.gain)} · {g.gain >= 0 ? "+" : ""}{g.gainPct.toFixed(2)}%
                        {g.partial && (
                          <span className="text-fg-fade text-xs ml-2">partial</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-fg-fade text-xs">
                        {holdingsByPortfolio[p.id]?.length === 0 ? "No holdings" : "…"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-1 relative z-10">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        setShareTarget(p);
                      }}
                      className="p-1.5 rounded-md text-fg-fade hover:text-accent hover:bg-bg-3 transition"
                      title="Share"
                    >
                      <UserPlus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        handleDelete(p);
                      }}
                      className="p-1.5 rounded-md text-fg-fade hover:text-neg hover:bg-bg-3 transition"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="animate-fade-up" style={{ animationDelay: "80ms" }}>
          <div className="mb-5">
            <h2 className="text-2xl font-semibold tracking-tight">
              Shared with me
            </h2>
            <p className="text-sm text-fg-dim mt-1">
              {shared.length === 0
                ? "Give friends your UID below to get access."
                : `${shared.length} from friends`}
            </p>
          </div>
          {shared.length === 0 ? null : (
            <ul className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {shared.map((p) => {
                const g = gainByPortfolio[p.id];
                const tint = tintForGain(g?.ready ? g.gain : null);
                // Encrypted-but-no-key state: distinguish "owner hasn't
                // shared K_portfolio with us yet" from "portfolio is
                // genuinely empty." Without this hint the card looks the
                // same in both cases, which is misleading.
                const encryptionPending =
                  !!p.encrypted &&
                  encryption.state.kind === "unlocked" &&
                  !portfolioKeys.has(p.id);
                return (
                <li key={p.id}>
                  <Link
                    href={`/portfolios/${p.id}`}
                    className={`card p-5 block transition group ${tint}`}
                  >
                    <div className="flex items-start justify-between mb-8">
                      <div className="label">Shared</div>
                      <ArrowUpRight className="w-4 h-4 text-fg-fade group-hover:text-accent transition" />
                    </div>
                    <h3 className="text-lg font-medium mb-1 truncate">{p.name}</h3>
                    <div className="text-xs text-fg-fade mb-2 flex items-center gap-2">
                      <span>by <OwnerLabel uid={p.ownerId} /></span>
                      {unreadBySharedId[p.id] ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                          {unreadBySharedId[p.id]} new
                        </span>
                      ) : null}
                    </div>
                    <div className="num text-sm min-h-[1.25rem]">
                      {encryptionPending ? (
                        <span className="text-fg-fade text-xs">
                          Waiting for owner&apos;s next sign-in to share
                          encryption
                        </span>
                      ) : g?.ready ? (
                        <span className={g.gain >= 0 ? "text-pos" : "text-neg"}>
                          {g.gain >= 0 ? "+" : ""}{g.gainPct.toFixed(2)}%
                          {g.partial && (
                            <span className="text-fg-fade text-xs ml-2">partial</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-fg-fade text-xs">
                          {holdingsByPortfolio[p.id]?.length === 0 ? "No holdings" : "…"}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          className="animate-fade-up pt-2"
          style={{ animationDelay: "160ms" }}
        >
          <div className="border-t border-line pt-5 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="label mb-1">Your UID</div>
              <div className="text-xs text-fg-dim">
                Share this so friends can add you to their portfolios.
              </div>
            </div>
            <code className="num text-xs text-fg-dim bg-bg-2 border border-line rounded-md px-2.5 py-1.5 break-all">
              {user?.uid}
            </code>
          </div>
        </section>
      </main>

      {showNew && (
        <Modal onClose={() => setShowNew(false)} title="New portfolio">
          <form onSubmit={handleCreate} className="space-y-4">
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

      {shareTarget && (
        <Modal
          onClose={() => setShareTarget(null)}
          title={`Share "${shareTarget.name}"`}
        >
          <SharePanel
            portfolioId={shareTarget.id}
            ownerUid={shareTarget.ownerId}
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
          <button
            onClick={onClose}
            className="text-fg-fade hover:text-fg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function OwnerLabel({ uid }: { uid: string }) {
  const name = useDisplayName(uid);
  if (name) return <>{name}</>;
  const short = uid.length > 8 ? `${uid.slice(0, 4)}…${uid.slice(-3)}` : uid;
  return <span className="num">user {short}</span>;
}

function tintForGain(gain: number | null): string {
  if (gain == null) return "hover:border-line-strong";
  if (gain >= 0) return "bg-pos/5 border-pos/30 hover:border-pos/50";
  return "bg-neg/5 border-neg/30 hover:border-neg/50";
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
