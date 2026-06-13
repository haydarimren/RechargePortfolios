// src/app/(app)/layout.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useEncryption } from "@/lib/use-encryption";
import { getUnlocked } from "@/lib/key-store";
import {
  clearFollowIntent,
  readFollowIntent,
  redeemFollow,
  setPendingLinkToken,
} from "@/lib/share-links";
import { UnlockModal } from "@/components/UnlockModal";
import { AppShell } from "@/components/AppShell";
import { Portfolio } from "@/lib/types";
import { runEagerMigrations } from "@/lib/holdings-repo";
import { PortfolioRouteProvider } from "@/lib/portfolio-route";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const encryption = useEncryption();
  const [user, setUser] = useState<User | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const migrationsRanRef = useRef(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u || u.isAnonymous) {
        // Anonymous sessions exist only for /s/ share-link pages — the
        // app shell (and everything behind it, incl. encryption
        // enrollment) requires a real account.
        router.push("/login");
        return;
      }
      setUser(u);
      setAuthResolved(true);
    });
    return () => unsub();
  }, [router]);

  // Run idempotent migrations once per session, gated on unlock + owned-portfolios load.
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    if (migrationsRanRef.current) return;
    const q = query(
      collection(db, "portfolios"),
      where("ownerId", "==", user.uid),
    );
    const unsub = onSnapshot(q, (snap) => {
      const owned: Portfolio[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Portfolio, "id">),
      }));
      if (migrationsRanRef.current) return;
      const unlocked = getUnlocked(user.uid);
      if (!unlocked) return;
      migrationsRanRef.current = true;
      void runEagerMigrations(
        user.uid,
        owned.map((p) => ({ id: p.id, encrypted: p.encrypted })),
        unlocked.privateKey,
        unlocked.publicKey,
        unlocked.publicKeyHex,
        unlocked.masterSecret,
      ).catch(() => {
        migrationsRanRef.current = false;
      });
    });
    return () => unsub();
  }, [user, encryption.state.kind]);

  // Complete a share-link follow stashed before the signup funnel.
  // Runs once the user is fully enrolled + unlocked so the owner's
  // reconcile can wrap K_portfolio for them on its next pass. The stash
  // survives until redeem fully succeeds (both writes), so an
  // interrupted attempt retries on the next app load.
  const redeemRanRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (encryption.state.kind !== "unlocked") return;
    if (redeemRanRef.current) return;
    const intent = readFollowIntent();
    if (!intent) return;
    redeemRanRef.current = true;
    void (async () => {
      try {
        await redeemFollow(intent.pid, intent.token, user.uid);
        setPendingLinkToken(intent.pid, intent.token);
        clearFollowIntent();
        router.push(`/p/${intent.pid}`);
      } catch (err) {
        console.warn("follow redeem failed; will retry next load", err);
        redeemRanRef.current = false;
      }
    })();
  }, [user, encryption.state.kind, router]);

  if (!authResolved) {
    return <div className="min-h-screen bg-bg" aria-busy />;
  }
  if (encryption.state.kind === "uninitialized") {
    router.push("/onboarding/encryption");
    return <div className="min-h-screen bg-bg" aria-busy />;
  }
  if (encryption.state.kind === "needs-recovery") {
    return (
      <UnlockModal
        uid={encryption.state.uid}
        onRestore={encryption.restore}
      />
    );
  }

  return (
    <PortfolioRouteProvider>
      <AppShell user={user!}>{children}</AppShell>
    </PortfolioRouteProvider>
  );
}
