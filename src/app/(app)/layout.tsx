// src/app/(app)/layout.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useEncryption } from "@/lib/use-encryption";
import { getUnlocked } from "@/lib/key-store";
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
      if (!u) {
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
      ).catch(() => {
        migrationsRanRef.current = false;
      });
    });
    return () => unsub();
  }, [user, encryption.state.kind]);

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
