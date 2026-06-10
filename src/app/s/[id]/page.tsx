"use client";

/**
 * Public share-link page. Reachable signed-out; performs a silent
 * anonymous sign-in so Firestore rules (which require auth) admit the
 * single shareLinks read. Reads exactly one doc; never touches the
 * portfolio doc or holdings (except the membership probe for real
 * accounts, which the rules decide). See the spec for the capability
 * model: docs/superpowers/specs/2026-06-10-share-links-design.md.
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  onAuthStateChanged,
  signInAnonymously,
  type User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import {
  parseShareTokenFromHash,
  readSnapshotByToken,
  redeemFollow,
  setPendingLinkToken,
  stashFollowIntent,
} from "@/lib/share-links";
import type { SnapshotV1 } from "@/lib/share-links-math";
import { SnapshotPortfolioView } from "@/components/SnapshotPortfolioView";
import { ThemeToggle } from "@/lib/theme";

type PageState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ready"; snapshot: SnapshotV1; token: string };

export default function ShareLinkPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [user, setUser] = useState<User | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // Load sequence: token → (anonymous) auth → snapshot read → decrypt.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = parseShareTokenFromHash(window.location.hash);
      if (!token) {
        setState({ kind: "invalid" });
        return;
      }
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
        // Membership probe for real accounts: owner/followers can read
        // the portfolio doc; anyone else gets permission-denied. Members
        // belong on the real page.
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          try {
            const probe = await getDoc(doc(db, "portfolios", id));
            if (probe.exists()) {
              router.replace(`/p/${id}`);
              return;
            }
          } catch {
            // permission denied — not a member; carry on to the snapshot.
          }
        }
        const snapshot = await readSnapshotByToken(id, token);
        if (!cancelled) setState({ kind: "ready", snapshot, token });
      } catch {
        // Missing doc, revoked link, or tampered ciphertext — one
        // generic state, deliberately indistinguishable (no oracle).
        if (!cancelled) setState({ kind: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const handleFollow = async () => {
    if (state.kind !== "ready") return;
    setFollowError("");
    if (!user || user.isAnonymous) {
      // Funnel: stash intent (OAuth redirects drop fragments), then the
      // (app) layout redeems post-enrollment.
      stashFollowIntent({ pid: id, token: state.token });
      router.push("/login");
      return;
    }
    setFollowBusy(true);
    try {
      await redeemFollow(id, state.token, user.uid);
      setPendingLinkToken(id, state.token);
      router.push(`/p/${id}`);
    } catch {
      setFollowError(
        "Couldn't follow — the link may have been revoked. Try reloading.",
      );
      setFollowBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col">
      <header className="px-6 lg:px-10 pt-6">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium tracking-tight">Recharge</div>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 lg:px-10 py-10">
        {state.kind === "loading" && (
          <div className="min-h-[40vh] flex items-center justify-center text-sm text-fg-dim">
            Loading…
          </div>
        )}
        {state.kind === "invalid" && (
          <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-lg text-fg">
              This link is invalid or has been revoked.
            </p>
            <p className="text-sm text-fg-dim">
              Ask the portfolio owner for a fresh link.
            </p>
            <Link
              href="/login"
              className="text-sm text-accent hover:underline mt-2"
            >
              Sign in to Recharge
            </Link>
          </div>
        )}
        {state.kind === "ready" && (
          <SnapshotPortfolioView
            snapshot={state.snapshot}
            footer={
              <div className="card p-5 flex items-center justify-between gap-4 flex-wrap">
                <div className="text-sm text-fg-dim">
                  Follow to see the full picture — trade history and live
                  updates — on your Friends page.
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <button
                    onClick={() => void handleFollow()}
                    disabled={followBusy}
                    className="btn-primary disabled:opacity-50"
                  >
                    {followBusy
                      ? "Following…"
                      : !user || user.isAnonymous
                        ? "Follow — create account"
                        : "Follow"}
                  </button>
                  {followError && (
                    <span className="text-xs text-neg">{followError}</span>
                  )}
                </div>
              </div>
            }
          />
        )}
      </main>
    </div>
  );
}
