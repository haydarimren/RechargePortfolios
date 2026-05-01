// src/lib/activity-types.ts
export type ActivityKind =
  | "buy"
  | "sell"
  | "share"
  | "rename"
  | "milestone"
  | "allocation-change";

/**
 * Activity event surface — what subscribers receive after decryption.
 * `id` and `portfolioId` are added by the read path (not stored in the
 * encrypted payload).
 *
 * Privacy hard rule (also enforced via design-system gating): no field on
 * this type should ever carry an absolute dollar amount. Allocation
 * percentages, position-gain percentages, and percentage milestones are
 * the only numbers allowed here.
 */
export interface ActivityEvent {
  id: string;
  portfolioId: string;
  kind: ActivityKind;
  occurredAt: number; // Unix ms
  actorUid: string;
  symbol?: string;
  beforeAllocationPct?: number;
  afterAllocationPct?: number;
  positionGainPctSnapshot?: number;
  realizedPct?: number;
  newName?: string;
  shareTargetUid?: string;
}

/**
 * Encrypted-on-the-wire shape — what we encrypt before write. Excludes
 * `id` (Firestore generates) and `portfolioId` (the path).
 */
export type ActivityEventPayload = Omit<ActivityEvent, "id" | "portfolioId">;
