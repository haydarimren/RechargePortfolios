// src/lib/activity-types.ts
//
// Activity events are synthesized client-side from the live holdings
// subscription on the Friends page (Activity subtab). They are not
// persisted — the source of truth is the holdings docs themselves.
// Keeping a typed surface here so renderers and synthesis share one
// interface.
export type ActivityKind = "buy" | "sell" | "allocation-change";

/**
 * Privacy hard rule: no field on this type should ever carry an
 * absolute dollar amount. Allocation percentages, position-gain
 * percentages, and realized percentages are the only numbers allowed.
 */
export interface ActivityEvent {
  /** Stable per-event identifier — used as the React list key. */
  id: string;
  portfolioId: string;
  kind: ActivityKind;
  occurredAt: number; // Unix ms
  actorUid: string;
  symbol: string;
  /** Symbol's allocation share (% of portfolio cost basis) before the event. */
  beforeAllocationPct?: number;
  /** Symbol's allocation share (% of portfolio cost basis) after the event. */
  afterAllocationPct?: number;
  /** Realized return % vs. pool average cost — sells only. */
  realizedPct?: number;
}
