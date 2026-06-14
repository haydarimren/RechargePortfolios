import type { Holding } from "@/lib/types";
import { BROKER_IDS, type BrokerId } from "./ids";

const KNOWN_BROKER_IDS: ReadonlySet<string> = new Set(BROKER_IDS);

/** The broker a portfolio is locked to: the first holding whose
 *  `importSource` is a known broker. Null = manual-only (no lock). */
export function deriveLockedBroker(holdings: Holding[]): BrokerId | null {
  for (const h of holdings) {
    if (h.importSource && KNOWN_BROKER_IDS.has(h.importSource)) {
      return h.importSource as BrokerId;
    }
  }
  return null;
}

/** Distinct SnapTrade source-account ids present across holdings — the
 *  lock set L. Each tagged lot contributes its account; untagged merged
 *  reconciler lots contribute nothing. */
export function snaptradeAccountIdsFromHoldings(holdings: Holding[]): Set<string> {
  const set = new Set<string>();
  for (const h of holdings) {
    if (
      h.importSource === "snaptrade" &&
      typeof h.snaptradeAccountId === "string" &&
      h.snaptradeAccountId.length > 0
    ) {
      set.add(h.snaptradeAccountId);
    }
  }
  return set;
}
