"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import { db } from "@/lib/firebase";

export interface UserProfile {
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

function defaultDisplayName(user: FirebaseUser): string {
  const email = user.email ?? "";
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length > 0) return cleaned.slice(0, 32);
  return "user-" + user.uid.slice(0, 6);
}

export async function ensureUserProfile(user: FirebaseUser): Promise<void> {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  const now = Date.now();
  await setDoc(ref, {
    displayName: defaultDisplayName(user),
    createdAt: now,
    updatedAt: now,
  });
}

export async function setDisplayName(
  uid: string,
  displayName: string
): Promise<void> {
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 32) {
    throw new Error("Display name must be 1-32 characters");
  }
  await updateDoc(doc(db, "users", uid), {
    displayName: trimmed,
    updatedAt: Date.now(),
  });
}

const nameCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const subscribers = new Map<string, Set<(name: string) => void>>();

function notify(uid: string, name: string): void {
  const subs = subscribers.get(uid);
  if (!subs) return;
  subs.forEach((cb) => cb(name));
}

export function getCachedDisplayName(uid: string): string | undefined {
  return nameCache.get(uid);
}

async function fetchDisplayName(uid: string): Promise<string> {
  const cached = nameCache.get(uid);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(uid);
  if (existing) return existing;
  const p = (async () => {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      const name = snap.exists()
        ? ((snap.data() as UserProfile).displayName ?? "")
        : "";
      nameCache.set(uid, name);
      notify(uid, name);
      return name;
    } catch {
      return "";
    } finally {
      inFlight.delete(uid);
    }
  })();
  inFlight.set(uid, p);
  return p;
}

export function useDisplayName(uid: string | null | undefined): string {
  const [name, setName] = useState<string>(() =>
    uid ? nameCache.get(uid) ?? "" : ""
  );

  useEffect(() => {
    if (!uid) {
      setName("");
      return;
    }
    const cached = nameCache.get(uid);
    if (cached !== undefined) {
      setName(cached);
    } else {
      setName("");
      fetchDisplayName(uid).then((n) => setName(n));
    }
    let subs = subscribers.get(uid);
    if (!subs) {
      subs = new Set();
      subscribers.set(uid, subs);
    }
    const cb = (n: string) => setName(n);
    subs.add(cb);
    return () => {
      subs!.delete(cb);
      if (subs!.size === 0) subscribers.delete(uid);
    };
  }, [uid]);

  return name;
}
