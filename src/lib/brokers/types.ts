/**
 * Shared types for broker adapters. Every supported broker exposes a
 * `BrokerAdapter` from its `index.ts`; the registry collects them.
 *
 * Privacy invariant: nothing in this module ends up persisted to Firestore
 * in plaintext. `BrokerId` strings appear inside the *encrypted* credential
 * payload and inside the encrypted `importSource` field of holdings, but
 * never as a top-level Firestore field.
 */

export type { BrokerId } from "./ids";
import type { BrokerId } from "./ids";

export interface ImportedOrder {
  id: string;
  symbol: string;
  shares: number;
  purchasePrice: number;
  purchaseDate: string;
  currency?: string;
  isin?: string;
  yahooSymbol?: string;
  side: "BUY" | "SELL";
  /**
   * SnapTrade-only: which connected brokerage account this leg came
   * from. Multi-account portfolios persist it per holding so the lock
   * set and account-removal cleanup can be derived from holdings.
   */
  snaptradeAccountId?: string;
}

/**
 * Why a raw SnapTrade order/position was not turned into a holding.
 * Every existing guard in the SnapTrade mappers maps to one of these.
 * Recorded in the redacted diagnostics trace so a silently-dropped
 * record becomes explainable without exporting any holdings data.
 */
export type SkipReason =
  | "unsupported-action"
  | "no-order-id"
  | "no-time-executed"
  | "no-execution-price"
  | "no-filled-qty"
  | "no-symbol"
  | "non-finite-shares"
  | "non-positive-price"
  | "non-positive-units";

/** Sign of `filled_quantity` — the magnitude is deliberately never recorded. */
export type FilledQtySign = "positive" | "negative" | "zero" | "absent";

/** What the sync pipeline did with one raw record. */
export type DiagDecision =
  | "kept"
  | "deduped"
  | "suppressed-by-orders"
  | "skipped";

/**
 * Per-order diagnostic. Redacted by construction: enums, presence
 * booleans, a sign, an opaque symbol token, and the set of raw field
 * *names*. No shares magnitude, price, date, currency amount, order id,
 * or raw ticker — ever.
 */
export interface SnapTradeOrderDiag {
  action: string | null;
  status: string | null;
  hasOrderId: boolean;
  hasTimeExecuted: boolean;
  hasExecutionPrice: boolean;
  hasFilledQty: boolean;
  filledQtySign: FilledQtySign;
  /** Sorted property names present on the raw order (values omitted). */
  rawKeys: string[];
  /** Stable opaque token (`SYM_1`, …) — never the real ticker. */
  symbolToken: string | null;
  /** Opaque per-sync account token (`ACC_1`, …) — never the real id.
   *  Absent on v1 traces (single-account era). */
  accountToken?: string | null;
  decision: DiagDecision;
  skipReason: SkipReason | null;
}

/** Per-position diagnostic. Same redaction guarantees as orders. */
export interface SnapTradePositionDiag {
  symbolToken: string | null;
  /** Opaque per-sync account token (`ACC_1`, …) — never the real id.
   *  Absent on v1 traces (single-account era). */
  accountToken?: string | null;
  hasUnits: boolean;
  hasPrice: boolean;
  decision: DiagDecision;
  skipReason: SkipReason | null;
}

/**
 * Redacted SnapTrade sync trace. Persisted (encrypted under the
 * portfolio key) in the `syncLogs` doc so the operator can read *why*
 * records were skipped/suppressed without any holdings data leaving the
 * E2E boundary. Contains no symbols, share counts, prices, dates,
 * account ids, or order ids.
 */
export interface SnapTradeDiagnostics {
  /** 1 = single-account era (no accountToken fields); 2 = multi-account. */
  schemaVersion: 1 | 2;
  httpOk: boolean;
  rawOrderCount: number;
  rawPositionCount: number;
  orders: SnapTradeOrderDiag[];
  positions: SnapTradePositionDiag[];
  /**
   * Per opaque symbol token: did the net of mappable orders match the
   * position snapshot's units? Boolean only — never the share numbers.
   * `null` when there's no position to compare against.
   */
  perSymbol: Array<{
    symbolToken: string;
    ordersNetMatchesPositionUnits: boolean | null;
  }>;
  summary: {
    ordersKept: number;
    ordersDeduped: number;
    ordersSkipped: Partial<Record<SkipReason, number>>;
    positionsKept: number;
    positionsSuppressed: number;
    positionsDeduped: number;
    positionsSkipped: Partial<Record<SkipReason, number>>;
  };
}

/**
 * The broker's authoritative *current* holding for one symbol — the
 * position snapshot already reflects every sale. Reconciliation uses
 * this as the source of truth for the current share count; the order
 * legs only supply the timeline. Surfaced to the page (not the
 * adapter) because the page is where stored holdings live and where
 * the UI's pooling function can be applied to enforce the invariant.
 */
export interface ReconcilePosition {
  symbol: string;
  units: number;
  price: number;
  currency?: string;
  yahooSymbol?: string;
}

export interface ImportResult {
  orders: ImportedOrder[];
  sellsSkipped: number;
  sellsImported: number;
  /**
   * SnapTrade-only: the broker's authoritative current positions. The
   * page reconciles stored holdings to these via
   * `reconcileToPositionUnits`. Other adapters leave it undefined.
   */
  positions?: ReconcilePosition[];
  /**
   * Orders we silently dropped because they were partially-filled-then-
   * cancelled (Alpaca's `status === "canceled"` with `filled_qty > 0`).
   * Faithfully representing partial fills as lots needs its own design;
   * for v1 we count them so the sync UI can surface "skipped N partial
   * fills" rather than silently losing shares. Always 0 for brokers
   * (e.g. T212) that don't expose this state shape.
   */
  partialFillsSkipped: number;
  /**
   * SnapTrade-only redacted decision trace. Optional/broker-specific
   * like `partialFillsSkipped`; other adapters leave it undefined.
   */
  diagnostics?: SnapTradeDiagnostics;
}

/**
 * Predicate the page hands to an adapter so pagination can short-circuit
 * once it hits already-imported orders. Each adapter calls this per raw
 * order it sees during pagination; the implementation lives in the page,
 * which has the full holdings list.
 */
export type IsOrderKnownFn = (args: {
  orderId: string;
  rawTicker: string;
  purchaseDate: string;
  shares: number;
}) => boolean;

export interface CredentialField {
  /** Stable id used as form state key. */
  id: string;
  /** Visible label rendered above the input. */
  label: string;
  /** Placeholder text for the input. */
  placeholder: string;
}

export interface BrokerAdapter {
  id: BrokerId;
  /** Human-readable name for UI. Never persisted to Firestore plaintext. */
  displayName: string;
  /** Inputs the "Connect a broker" form should render for this broker. */
  credentialFields: CredentialField[];
  /** Hint copy shown beneath the form (e.g. where to generate the API key). */
  credentialHint: string;
  /**
   * Combine the form field values into the wire-format credential string.
   * That string is what gets encrypted into `secrets/credentials.payload`
   * and what the proxy receives in its request body. For both T212 and
   * Alpaca today this is `${key}:${secret}`; future brokers may differ.
   */
  buildCredential: (fields: Record<string, string>) => string;
  /** Run a full import pass against the broker. */
  fetchOrders: (opts: {
    credential: string;
    isOrderKnown?: IsOrderKnownFn;
  }) => Promise<ImportResult>;
}
