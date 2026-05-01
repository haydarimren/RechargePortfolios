// src/lib/activity-repo.ts
"use client";

import {
  collection,
  addDoc,
  query,
  onSnapshot,
  orderBy,
  limit as fsLimit,
} from "firebase/firestore";
import { db } from "./firebase";
import { encryptActivity, decryptActivity } from "./crypto-client";
import type { ActivityEvent, ActivityEventPayload } from "./activity-types";

/**
 * Append an activity event to a portfolio. Best-effort: callers wrap in
 * try/catch — activity is metadata, never load-bearing.
 */
export async function appendActivity(
  portfolioId: string,
  event: ActivityEventPayload,
  key: CryptoKey,
): Promise<void> {
  const cipher = await encryptActivity(event, key);
  await addDoc(collection(db, "portfolios", portfolioId, "activity"), {
    payload: cipher.payload,
    iv: cipher.iv,
    createdAt: Date.now(),
    schemaVersion: 1,
  });
}

/**
 * Subscribe to a portfolio's activity, decrypted. Newest first. Caller
 * supplies K_portfolio (already unwrapped). Failed decrypts are silently
 * dropped — they shouldn't happen but if they do, we don't want to crash
 * the feed.
 */
export function subscribeActivity(
  portfolioId: string,
  key: CryptoKey,
  onChange: (events: ActivityEvent[]) => void,
  pageLimit: number = 50,
): () => void {
  const q = query(
    collection(db, "portfolios", portfolioId, "activity"),
    orderBy("createdAt", "desc"),
    fsLimit(pageLimit),
  );
  return onSnapshot(q, async (snap) => {
    const events: ActivityEvent[] = [];
    for (const d of snap.docs) {
      const data = d.data() as { payload: string; iv: string };
      try {
        const decoded = await decryptActivity(
          { payload: data.payload, iv: data.iv },
          key,
        );
        events.push({ id: d.id, portfolioId, ...decoded });
      } catch {
        // Drop undecryptable events silently.
      }
    }
    onChange(events);
  });
}
