"use client";

/**
 * Throttled front door for broker sync. Every automatic trigger (app-open
 * batch, on-view) calls in here; the manual Sync button bypasses via
 * runBrokerSync directly. One shared 15-min window keeps us inside the
 * brokers' rate limits (SnapTrade: ≤1 poll/5min/account; T212: 6/min).
 *
 * Throttle source: the latest syncLogs.createdAt (plaintext, already on
 * disk) — no data-model or rules change. Skip-fast from an in-memory
 * attempt cache; confirm against Firestore before actually syncing so a
 * different device's recent sync isn't undercut. Every attempt stamps the
 * in-memory clock (success OR failure) so a broken portfolio backs off
 * instead of retry-storming.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { runBrokerSync, type SyncContext } from "./run-sync";

export const THROTTLE_MS = 15 * 60 * 1000;
const BATCH_CONCURRENCY = 2;

/** Pure decision core — unit-tested. */
export function shouldSync(args: {
  now: number;
  lastSyncAt: number | null;
  inFlight: boolean;
  force?: boolean;
}): boolean {
  if (args.inFlight) return false;
  if (args.force) return true;
  if (args.lastSyncAt == null) return true;
  return args.now - args.lastSyncAt >= THROTTLE_MS;
}

// --- per-tab state ---
const lastAttemptAt = new Map<string, number>();
const inFlight = new Set<string>();
type StateListener = (running: boolean) => void;
const listeners = new Map<string, Set<StateListener>>();

function emit(portfolioId: string, running: boolean) {
  listeners.get(portfolioId)?.forEach((cb) => cb(running));
}

export function subscribeSyncState(portfolioId: string, cb: StateListener): () => void {
  let set = listeners.get(portfolioId);
  if (!set) {
    set = new Set();
    listeners.set(portfolioId, set);
  }
  set.add(cb);
  cb(inFlight.has(portfolioId));
  return () => {
    set!.delete(cb);
  };
}

async function latestSyncLogAt(portfolioId: string): Promise<number | null> {
  try {
    const snap = await getDocs(
      query(
        collection(db, "portfolios", portfolioId, "syncLogs"),
        orderBy("createdAt", "desc"),
        limit(1),
      ),
    );
    const d = snap.docs[0]?.data();
    return typeof d?.createdAt === "number" ? d.createdAt : null;
  } catch {
    return null;
  }
}

export interface AutoSyncCtx {
  uid: string;
  unlocked: SyncContext["unlocked"];
}

/** Sync one portfolio if the throttle allows (or force). Safe to call from
 *  any trigger; concurrent/redundant calls are de-duped by the in-flight set. */
export async function requestSync(
  portfolioId: string,
  ctx: AutoSyncCtx,
  opts: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  // Skip-fast from cache.
  if (
    !shouldSync({
      now,
      lastSyncAt: lastAttemptAt.get(portfolioId) ?? null,
      inFlight: inFlight.has(portfolioId),
      force: opts.force,
    })
  ) {
    return;
  }
  // Confirm against Firestore (cross-device) unless forced.
  if (!opts.force) {
    const fsAt = await latestSyncLogAt(portfolioId);
    // null = never synced; the `|| null` turns a 0 from either source
    // ("no data") back into the never-synced sentinel rather than treating
    // it as a real epoch-0 timestamp.
    const merged = Math.max(fsAt ?? 0, lastAttemptAt.get(portfolioId) ?? 0) || null;
    if (!shouldSync({ now, lastSyncAt: merged, inFlight: inFlight.has(portfolioId), force: false })) {
      if (merged) lastAttemptAt.set(portfolioId, merged);
      return;
    }
  }
  // Effective mutex across the async gap above: everything from this guard
  // through `inFlight.add` runs synchronously (no await/yield), so a
  // concurrent caller that also passed the awaited check cannot interleave
  // between the `has` test and the `add`. Don't remove this as "redundant".
  if (inFlight.has(portfolioId)) return;
  inFlight.add(portfolioId);
  lastAttemptAt.set(portfolioId, now); // stamp on attempt (success OR failure)
  emit(portfolioId, true);
  try {
    await runBrokerSync({ portfolioId, uid: ctx.uid, unlocked: ctx.unlocked });
  } catch {
    // best-effort; the syncLog (if written) and the in-memory stamp handle back-off
  } finally {
    inFlight.delete(portfolioId);
    emit(portfolioId, false);
  }
}

async function hasBrokerCredential(portfolioId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, "portfolios", portfolioId, "secrets", "credentials"));
    return snap.exists();
  } catch {
    return false;
  }
}

/** App-open batch: sync every owned broker-linked portfolio, throttled,
 *  at concurrency BATCH_CONCURRENCY. Skips when offline. */
export async function syncAllOwned(
  owned: { id: string }[],
  ctx: AutoSyncCtx,
): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // Filter to broker-linked portfolios (cheap existence check).
  const linked: string[] = [];
  for (const p of owned) {
    if (await hasBrokerCredential(p.id)) linked.push(p.id);
  }
  // Run with a small concurrency cap.
  let i = 0;
  async function worker() {
    while (i < linked.length) {
      const pid = linked[i++];
      await requestSync(pid, ctx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, linked.length) }, worker),
  );
}
