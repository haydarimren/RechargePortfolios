"use client";

import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Per-user-per-portfolio read state. Lives at
 * `users/{uid}/portfolioViews/{portfolioId}`.
 *
 * - `lastPortfolioViewAt` — bumped when the viewer loads `/portfolios/{id}`.
 * - `lastLogbookViewAt` — bumped when the viewer clicks the Logbook tab.
 *
 * Holdings with `createdAt` greater than the relevant timestamp count as
 * unread. A missing doc means "never seen" — callers should seed it with
 * a "now" baseline on first sight so a freshly-shared portfolio doesn't
 * dump its whole history as unread.
 */
export interface PortfolioView {
  lastPortfolioViewAt: number;
  lastLogbookViewAt: number;
}

/**
 * Subscribe to the user's `portfolioViews` subcollection. Calls `onChange`
 * with a fresh `Map<portfolioId, PortfolioView>` every time the collection
 * updates. Returns the Firestore unsubscribe function.
 */
export function subscribeToPortfolioViews(
  uid: string,
  onChange: (map: Map<string, PortfolioView>) => void,
): () => void {
  const col = collection(db, "users", uid, "portfolioViews");
  return onSnapshot(
    col,
    (snap) => {
      const map = new Map<string, PortfolioView>();
      for (const d of snap.docs) {
        const data = d.data() as Partial<PortfolioView>;
        map.set(d.id, {
          lastPortfolioViewAt: data.lastPortfolioViewAt ?? 0,
          lastLogbookViewAt: data.lastLogbookViewAt ?? 0,
        });
      }
      onChange(map);
    },
    () => onChange(new Map()),
  );
}

function viewRef(uid: string, portfolioId: string) {
  return doc(db, "users", uid, "portfolioViews", portfolioId);
}

/** Bump `lastPortfolioViewAt` to now. Fire-and-forget. */
export function touchPortfolioView(uid: string, portfolioId: string): void {
  setDoc(
    viewRef(uid, portfolioId),
    { lastPortfolioViewAt: Date.now() },
    { merge: true },
  ).catch(() => {});
}

/** Bump `lastLogbookViewAt` to now. Fire-and-forget. */
export function touchLogbookView(uid: string, portfolioId: string): void {
  setDoc(
    viewRef(uid, portfolioId),
    { lastLogbookViewAt: Date.now() },
    { merge: true },
  ).catch(() => {});
}

/**
 * Seed a baseline view record when the viewer first encounters a portfolio
 * — prevents a freshly-shared portfolio's full history from showing up as
 * unread. Safe to call repeatedly; writes are only made when the caller
 * determines the doc is missing (check `viewsMap.has(id)` before calling).
 */
export function seedPortfolioView(uid: string, portfolioId: string): void {
  const now = Date.now();
  setDoc(
    viewRef(uid, portfolioId),
    { lastPortfolioViewAt: now, lastLogbookViewAt: now },
    { merge: true },
  ).catch(() => {});
}
