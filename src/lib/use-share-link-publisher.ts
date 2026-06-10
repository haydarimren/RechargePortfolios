"use client";

/**
 * Owner-side snapshot freshness. Mounted on every page where holdings
 * can mutate (portfolio detail, ticker drilldown). Debounce-rebuilds
 * the SnapshotV1 whenever holdings or the name change and republishes
 * only when content differs (republishSnapshotIfChanged compares
 * decrypted content, so interrupted writes self-heal on next mount).
 *
 * No link → no-op. Not the owner → no-op. Locked → no-op.
 */

import { useEffect, useMemo, useRef } from "react";
import { getUnlocked } from "./key-store";
import { useDisplayName } from "./users";
import {
  buildSnapshotForPortfolio,
  getShareLinkDocForOwner,
  republishSnapshotIfChanged,
} from "./share-links";
import type { Holding } from "./types";

const DEBOUNCE_MS = 2000;

export function useShareLinkPublisher(opts: {
  portfolioId: string;
  enabled: boolean; // isOwner && portfolio loaded
  ownerUid: string | null;
  portfolioName: string;
  holdings: Holding[];
}): void {
  const { portfolioId, enabled, ownerUid, portfolioName, holdings } = opts;
  const ownerName = useDisplayName(enabled ? ownerUid : null);

  // Content signature: the effect re-runs only when something snapshot-
  // relevant changes, not on every holdings array identity churn from
  // the live subscription.
  const signature = useMemo(
    () =>
      holdings
        .map(
          (h) =>
            `${h.symbol}|${h.shares}|${h.purchasePrice}|${h.purchaseDate}|${h.side ?? "BUY"}|${h.yahooSymbol ?? ""}`,
        )
        .sort()
        .join("~") + `#${portfolioName}`,
    [holdings, portfolioName],
  );
  const holdingsRef = useRef(holdings);
  useEffect(() => {
    holdingsRef.current = holdings;
  }, [holdings]);

  useEffect(() => {
    if (!enabled || !ownerUid) return;
    const unlocked = getUnlocked(ownerUid);
    if (!unlocked) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const link = await getShareLinkDocForOwner(portfolioId);
        if (!link || cancelled) return;
        const fresh = await buildSnapshotForPortfolio({
          holdings: holdingsRef.current,
          name: portfolioName,
          ownerName: ownerName || "A friend",
        });
        if (cancelled) return;
        await republishSnapshotIfChanged(
          portfolioId,
          link,
          unlocked.masterSecret,
          fresh,
        );
      } catch (err) {
        // Best-effort: next mount / next change retries.
        console.warn("share-link republish failed", err);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `signature` is the deliberate stand-in for holdings/name content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ownerUid, portfolioId, signature, ownerName]);
}
