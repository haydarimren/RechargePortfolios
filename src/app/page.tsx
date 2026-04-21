"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { getQuote, StockQuote } from "@/lib/finnhub";
import { aggregateHoldings } from "@/lib/portfolio";
import { ThemeToggle } from "@/lib/theme";
import { ensureUserProfile, useDisplayName } from "@/lib/users";
import { SharePanel } from "@/components/SharePanel";
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
  const router = useRouter();

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

  const portfolioIds = useMemo(
    () => [...mine, ...shared].map((p) => p.id).sort().join(","),
    [mine, shared]
  );

  useEffect(() => {
    if (!portfolioIds) return;
    const ids = portfolioIds.split(",");
    const unsubs = ids.map((id) =>
      onSnapshot(
        collection(db, "portfolios", id, "holdings"),
        (snap) => {
          const rows = snap.docs.map(
            (d) => ({ id: d.id, ...(d.data() as Omit<Holding, "id">) })
          );
          setHoldingsByPortfolio((prev) => ({ ...prev, [id]: rows }));
        },
        () => {
          setHoldingsByPortfolio((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      )
    );
    return () => unsubs.forEach((u) => u());
  }, [portfolioIds]);

  useEffect(() => {
    const symbols = Array.from(
      new Set(Object.values(holdingsByPortfolio).flat().map((h) => h.symbol))
    );
    const missing = symbols.filter((s) => !(s in quotes));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((s) => getQuote(s).then((q) => [s, q] as const))).then(
      (pairs) => {
        if (cancelled) return;
        setQuotes((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [holdingsByPortfolio, quotes]);

  // Retry failed (null) quotes once after 30s to avoid a tight retry loop.
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  useEffect(() => {
    const nulls = Object.entries(quotesRef.current)
      .filter(([, v]) => v === null)
      .map(([s]) => s);
    if (nulls.length === 0) return;
    const t = setTimeout(() => {
      Promise.all(nulls.map((s) => getQuote(s).then((q) => [s, q] as const))).then(
        (pairs) => {
          const fresh = pairs.filter(([, q]) => q !== null);
          if (fresh.length === 0) return;
          setQuotes((prev) => ({ ...prev, ...Object.fromEntries(fresh) }));
        }
      );
    }, 30_000);
    return () => clearTimeout(t);
  }, [quotes]);

  // Refresh live quotes every 2 minutes.
  useEffect(() => {
    const id = setInterval(() => {
      const keys = Object.keys(quotesRef.current);
      if (keys.length === 0) return;
      Promise.all(keys.map((s) => getQuote(s).then((q) => [s, q] as const))).then(
        (pairs) => {
          const fresh = pairs.filter(([, q]) => q !== null);
          if (fresh.length === 0) return;
          setQuotes((prev) => ({ ...prev, ...Object.fromEntries(fresh) }));
        }
      );
    }, 120_000);
    return () => clearInterval(id);
  }, []);

  const gainByPortfolio = useMemo(() => {
    const out: Record<string, { cost: number; gain: number; gainPct: number; ready: boolean }> = {};
    for (const [pid, holdings] of Object.entries(holdingsByPortfolio)) {
      const positions = aggregateHoldings(holdings);
      let cost = 0;
      let market = 0;
      let ready = positions.length > 0;
      for (const p of positions) {
        cost += p.cost;
        const q = quotes[p.symbol];
        if (q) market += p.shares * q.c;
        else ready = false;
      }
      const gain = market - cost;
      const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
      out[pid] = { cost, gain, gainPct, ready };
    }
    return out;
  }, [holdingsByPortfolio, quotes]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newName.trim()) return;
    await addDoc(collection(db, "portfolios"), {
      ownerId: user.uid,
      ownerEmail: user.email ?? "",
      name: newName.trim(),
      sharedWith: [],
      createdAt: Date.now(),
    });
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

  return (
    <div className="min-h-screen">
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
                    <div className="text-xs text-fg-fade mb-2">
                      by <OwnerLabel uid={p.ownerId} />
                    </div>
                    <div className="num text-sm min-h-[1.25rem]">
                      {g?.ready ? (
                        <span className={g.gain >= 0 ? "text-pos" : "text-neg"}>
                          {g.gain >= 0 ? "+" : ""}{g.gainPct.toFixed(2)}%
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
            sharedWith={shareTarget.sharedWith}
            onClose={() => setShareTarget(null)}
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
