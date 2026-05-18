"use client";

/**
 * SnapTrade sync orchestration. Pulls activity records (BUY/SELL
 * transactions) for a single connected brokerage account, normalizes,
 * and returns a broker-agnostic `ImportResult`.
 *
 * Differences from T212 / Alpaca:
 *   - BYO-credentials model: the end user signs up at SnapTrade
 *     themselves and pastes their full credential set into our
 *     connect form. We don't have any app-level SnapTrade identity.
 *   - Per-portfolio identity is the SnapTrade `accountId`, not a
 *     direct broker name. The same SnapTrade user can have multiple
 *     connected brokerages; each accountId is one of them.
 *   - No cursor-based pagination — date-range query params instead.
 *     First sync uses a wide window (7 years); subsequent syncs use
 *     a tighter `startDate` based on the most recent imported trade.
 *
 * The credential string passed to `fetchSnapTradeOrders` is JSON-encoded
 * `{ clientId, consumerKey, snaptradeUserId, snaptradeUserSecret,
 * snaptradeAccountId }`. The server-side proxy auth builder reads
 * `clientId` + `consumerKey` for HMAC signing; this module reads
 * `snaptradeUserId` + `snaptradeUserSecret` for the URL query
 * (SnapTrade's own user-auth check) and `snaptradeAccountId` to build
 * the path. Packaging them together lets one credential string carry
 * everything sync needs.
 */

import { proxyFetch } from "../proxy-fetch";
import type {
  DiagDecision,
  FilledQtySign,
  ImportedOrder,
  ImportResult,
  IsOrderKnownFn,
  SkipReason,
  SnapTradeDiagnostics,
  SnapTradeOrderDiag,
  SnapTradePositionDiag,
} from "../types";
import { snaptradeSymbolToYahoo } from "./symbols";

/**
 * Raw shape of one item from `GET /api/v1/activities`. Heavily
 * simplified — we only read the fields we map. SnapTrade returns
 * many more (option_symbol, fee, settlement_date, etc.) that we
 * ignore today.
 *
 * NOTE: this endpoint is daily-cached on SnapTrade's side and often
 * empty for freshly-connected accounts or recent paper trades. Our
 * primary sync source is `/positions` (real-time); activities-based
 * sync is no longer wired in but the type + mapper are kept so that
 * a future event-history feature can re-enable it.
 */
export interface SnaptradeActivity {
  id: string;
  trade_date: string | null;
  type: string;
  units: number | null;
  price: number | null;
  symbol: {
    symbol?: { symbol?: string; description?: string } | null;
  } | null;
  currency: { code?: string } | null;
}

/**
 * Raw shape of one item from the `positions` field of
 * `GET /api/v1/accounts/{accountId}/holdings`. Real-time. Each
 * position represents one current holding: units owned + avg cost.
 *
 * We use positions as a FALLBACK only — they have no per-lot
 * purchase date, so synthesizing orders from them treats every
 * holding as one synthetic lot bought today at avg cost. The
 * primary source is `orders` (real transactions with timestamps).
 */
export interface SnaptradePosition {
  units?: number | null;
  price?: number | null;
  average_purchase_price?: number | null;
  symbol?: {
    symbol?: { symbol?: string; description?: string } | null;
  } | null;
  currency?: { code?: string } | null;
}

/**
 * Raw shape of one item from the `orders` field of
 * `GET /api/v1/accounts/{accountId}/holdings`. Each record represents
 * one order leg with its execution status. We import only fully-
 * executed BUY/SELL legs with a real fill quantity + execution price.
 */
export interface SnaptradeOrder {
  brokerage_order_id?: string;
  status?: string;
  action?: string;
  filled_quantity?: string | null;
  execution_price?: number | null;
  time_executed?: string | null;
  universal_symbol?: {
    symbol?: string;
    description?: string;
  } | null;
  quote_currency?: { code?: string } | null;
}

/**
 * Raw shape of `GET /api/v1/accounts/{accountId}/holdings` response.
 * Wraps both `positions` (current snapshot) and `orders` (recent
 * transaction history). Other fields (balances, option_positions,
 * total_value) are returned by SnapTrade but unused here.
 */
export interface SnaptradeHoldings {
  positions?: SnaptradePosition[] | null;
  orders?: SnaptradeOrder[] | null;
}

interface ParsedCredential {
  clientId: string;
  consumerKey: string;
  snaptradeUserId: string;
  snaptradeUserSecret: string;
  snaptradeAccountId: string;
}

interface ParsedConnectCredential {
  clientId: string;
  consumerKey: string;
  snaptradeUserId: string;
  snaptradeUserSecret: string;
}

function parseCredential(credential: string): ParsedCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new Error("SnapTrade credential is not valid JSON");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || typeof (parsed as { clientId?: unknown }).clientId !== "string"
    || typeof (parsed as { consumerKey?: unknown }).consumerKey !== "string"
    || typeof (parsed as { snaptradeUserId?: unknown }).snaptradeUserId !== "string"
    || typeof (parsed as { snaptradeUserSecret?: unknown }).snaptradeUserSecret !== "string"
    || typeof (parsed as { snaptradeAccountId?: unknown }).snaptradeAccountId !== "string"
  ) {
    throw new Error("SnapTrade credential missing required fields");
  }
  return parsed as ParsedCredential;
}

/**
 * Parse the 4-field connect-form credential (no accountId yet).
 * Used by `listSnapTradeAccounts` after the user submits the form
 * but before they've picked an account.
 */
function parseConnectCredential(credential: string): ParsedConnectCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new Error("SnapTrade credential is not valid JSON");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || typeof (parsed as { clientId?: unknown }).clientId !== "string"
    || typeof (parsed as { consumerKey?: unknown }).consumerKey !== "string"
    || typeof (parsed as { snaptradeUserId?: unknown }).snaptradeUserId !== "string"
    || typeof (parsed as { snaptradeUserSecret?: unknown }).snaptradeUserSecret !== "string"
  ) {
    throw new Error("SnapTrade credential missing required fields");
  }
  return parsed as ParsedConnectCredential;
}

export type MapSnaptradeActivityResult =
  | { kind: "keep"; order: ImportedOrder }
  | { kind: "skip" };

export type MapSnaptradeOrderResult =
  | { kind: "keep"; order: ImportedOrder }
  | { kind: "skip"; reason: SkipReason };

/**
 * Pure mapping: take one raw SnapTrade order leg, decide whether to
 * keep it, and produce the broker-agnostic `ImportedOrder` if so.
 *
 * Filters:
 *   - Action must be BUY or SELL. Variants like BUY_COVER, SELL_SHORT
 *     are skipped for v1 (they need additional bookkeeping the
 *     holdings model doesn't support today).
 *   - `filled_quantity > 0` is the real "did this order produce
 *     shares?" check — covers EXECUTED (fully filled), PARTIAL
 *     (still active, partially filled), and PARTIAL_CANCELED
 *     (partially filled, remaining cancelled). The shares from a
 *     partial fill are real — the user owns them — even if the
 *     remaining unfilled portion got cancelled later. We deliberately
 *     don't gate on `status` because SnapTrade's enum surfaces a
 *     dozen states (PENDING / FAILED / REJECTED / EXPIRED / ...) and
 *     filled_quantity is the load-bearing signal regardless.
 *   - Requires non-empty universal_symbol, valid time_executed,
 *     finite positive execution_price.
 *
 * Extracted as a pure function so tests can exercise every branch.
 */
export function mapSnaptradeOrder(
  raw: SnaptradeOrder,
): MapSnaptradeOrderResult {
  const action = raw.action;
  if (action !== "BUY" && action !== "SELL") {
    return { kind: "skip", reason: "unsupported-action" };
  }

  if (!raw.brokerage_order_id) return { kind: "skip", reason: "no-order-id" };
  if (!raw.time_executed) return { kind: "skip", reason: "no-time-executed" };
  if (raw.execution_price === null || raw.execution_price === undefined) {
    return { kind: "skip", reason: "no-execution-price" };
  }
  if (!raw.filled_quantity) return { kind: "skip", reason: "no-filled-qty" };

  const rawSymbol = raw.universal_symbol?.symbol;
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { kind: "skip", reason: "no-symbol" };
  }

  // SnapTrade returns filled_quantity as a string (decimal-friendly).
  // Use Number rather than parseFloat so trailing-junk strings fail
  // the finite check rather than silently truncate.
  const shares = Math.abs(Number(raw.filled_quantity));
  const price = raw.execution_price;
  if (!isFinite(shares) || shares <= 0) {
    return { kind: "skip", reason: "non-finite-shares" };
  }
  if (!isFinite(price) || price <= 0) {
    return { kind: "skip", reason: "non-positive-price" };
  }

  const symbol = snaptradeSymbolToYahoo(rawSymbol);
  return {
    kind: "keep",
    order: {
      id: raw.brokerage_order_id,
      symbol,
      shares,
      purchasePrice: price,
      purchaseDate: raw.time_executed.split("T")[0],
      currency: raw.quote_currency?.code,
      yahooSymbol: symbol,
      side: action,
    },
  };
}

export type MapSnaptradePositionResult =
  | { kind: "keep"; order: ImportedOrder }
  | { kind: "skip"; reason: SkipReason };

/**
 * Pure mapping: take one raw SnapTrade position, produce a synthetic
 * `ImportedOrder` representing the current holding.
 *
 * Trade-offs of synthesizing from positions instead of activities:
 *   - We don't have lot-level purchase dates; use today as a stand-in.
 *     Benchmark-vs-portfolio comparison and Section 104 pooling lose
 *     the original timeline (treats every position as bought today
 *     at avg cost).
 *   - The synthesized id is deterministic
 *     (`pos-{accountId}-{symbol}`) so resync via `isOrderKnown`
 *     dedups against itself. Trade-off: if the user buys MORE shares
 *     of an existing position later, our resync sees the same id and
 *     skips — the user's holding stays at the OLD share count until
 *     they disconnect+reconnect. Documented limitation; positions-as-
 *     transactions is fundamentally lossy.
 *
 * Extracted as a pure function so tests can exercise every branch
 * without mocking HTTP.
 */
export function mapSnaptradePosition(
  raw: SnaptradePosition,
  accountId: string,
  todayIsoDate: string,
): MapSnaptradePositionResult {
  const rawSymbol = raw.symbol?.symbol?.symbol;
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { kind: "skip", reason: "no-symbol" };
  }
  const units = raw.units;
  const price = raw.average_purchase_price ?? raw.price;
  if (typeof units !== "number" || !isFinite(units) || units <= 0) {
    // Skip empty or short positions for v1.
    return { kind: "skip", reason: "non-positive-units" };
  }
  if (typeof price !== "number" || !isFinite(price) || price <= 0) {
    return { kind: "skip", reason: "non-positive-price" };
  }
  const symbol = snaptradeSymbolToYahoo(rawSymbol);
  return {
    kind: "keep",
    order: {
      // Deterministic id = stable dedup key across syncs. The
      // adapter uses this both for the `isOrderKnown` predicate AND
      // for the `brokerOrderId` field on the persisted holding so
      // that updateHoldingFields can match by id.
      id: `pos-${accountId}-${rawSymbol}`,
      symbol,
      shares: units,
      purchasePrice: price,
      purchaseDate: todayIsoDate,
      currency: raw.currency?.code,
      yahooSymbol: symbol,
      side: "BUY",
    },
  };
}

/**
 * Pure mapping: take one raw SnapTrade activity, decide whether to
 * keep it, and produce the broker-agnostic `ImportedOrder` if so.
 * Filters:
 *   - Only `type === "BUY"` or `type === "SELL"` (skips DIVIDEND,
 *     CASH_TRANSFER, FEE, STOCK_SPLIT, etc.).
 *   - Requires a usable symbol, trade_date, units, and price.
 *
 * Extracted so it can be unit-tested without mocking HTTP.
 */
export function mapSnaptradeActivity(
  raw: SnaptradeActivity,
): MapSnaptradeActivityResult {
  const sideRaw = raw.type;
  if (sideRaw !== "BUY" && sideRaw !== "SELL") return { kind: "skip" };

  if (!raw.trade_date) return { kind: "skip" };
  if (raw.units === null || raw.units === undefined) return { kind: "skip" };
  if (raw.price === null || raw.price === undefined) return { kind: "skip" };

  const rawSymbol = raw.symbol?.symbol?.symbol;
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { kind: "skip" };
  }

  // SnapTrade reports SELL units as positive; sign comes from `type`
  // alone. Defensive `Math.abs` matches T212/Alpaca treatment.
  const shares = Math.abs(raw.units);
  const price = raw.price;
  if (!isFinite(shares) || shares <= 0) return { kind: "skip" };
  if (!isFinite(price) || price <= 0) return { kind: "skip" };

  const symbol = snaptradeSymbolToYahoo(rawSymbol);
  return {
    kind: "keep",
    order: {
      id: raw.id,
      symbol,
      shares,
      purchasePrice: price,
      // SnapTrade's `trade_date` may be ISO-with-time or just a date.
      // Take only the date part to match the holdings model.
      purchaseDate: raw.trade_date.split("T")[0],
      currency: raw.currency?.code,
      yahooSymbol: symbol,
      side: sideRaw,
    },
  };
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Build the credential blob the server-side proxy auth builder
 * expects — the 4 fields used for HMAC signing + SnapTrade-side
 * user-auth. The accountId is intentionally omitted; it lives in
 * the URL, not in the auth payload.
 */
function buildAuthCredential(cred: ParsedConnectCredential): string {
  return JSON.stringify({
    clientId: cred.clientId,
    consumerKey: cred.consumerKey,
    snaptradeUserId: cred.snaptradeUserId,
    snaptradeUserSecret: cred.snaptradeUserSecret,
  });
}

/**
 * Fetch holdings for an account — both `positions` (current snapshot)
 * and `orders` (recent transaction history) in one call. Real-time
 * (no daily cache like /activities, which earlier prototypes used and
 * found unusable for fresh / paper-trading accounts).
 */
async function fetchSnaptradeHoldings(
  cred: ParsedCredential,
): Promise<SnaptradeHoldings> {
  const params = new URLSearchParams({
    userId: cred.snaptradeUserId,
    userSecret: cred.snaptradeUserSecret,
  });
  const accountId = encodeURIComponent(cred.snaptradeAccountId);
  const path = `/api/v1/accounts/${accountId}/holdings?${params.toString()}`;
  const res = await proxyFetch("snaptrade", buildAuthCredential(cred), path);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`SnapTrade holdings failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as SnaptradeHoldings;
  return {
    positions: Array.isArray(json.positions) ? json.positions : [],
    orders: Array.isArray(json.orders) ? json.orders : [],
  };
}

/**
 * Sync the current SnapTrade-connected brokerage account's holdings
 * into our portfolio.
 *
 * Two-tier strategy:
 *   - **Primary: orders.** SnapTrade's /holdings response includes
 *     `orders` — the actual transaction history. We import each
 *     executed BUY/SELL leg with its real timestamp + price + share
 *     count. This is what the Logbook (Section 104 pooling) and the
 *     benchmark-vs-portfolio chart need.
 *   - **Fallback: positions.** When `orders` is empty (account
 *     transferred in from elsewhere; SnapTrade hasn't backfilled
 *     order history; older trades pre-date SnapTrade's window), fall
 *     back to synthesizing one BUY per position. Less accurate (no
 *     real lot dates / prices), but at least the user sees their
 *     current holdings.
 *
 * The `isOrderKnown` predicate dedups against existing holdings by
 * id, so resyncs don't re-import the same orders. Synthesized
 * positions use `pos-{accountId}-{symbol}` as a deterministic id
 * for the same dedup behavior.
 */
/**
 * Sign of a SnapTrade `filled_quantity` (string|null) — magnitude is
 * deliberately discarded so the diagnostics trace can record direction
 * without exporting any share count.
 */
function filledQtySign(v: string | null | undefined): FilledQtySign {
  if (v === null || v === undefined || v === "") return "absent";
  const n = Number(v);
  if (Number.isNaN(n)) return "absent";
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "zero";
}

/**
 * Stable opaque symbol→token mapper for the redacted trace. The real
 * ticker never appears in the diagnostics; correlation across orders
 * and positions is preserved via the token only.
 */
function makeSymbolTokenizer(): (symbol: string | null) => string | null {
  const map = new Map<string, string>();
  let n = 0;
  return (symbol) => {
    if (!symbol) return null;
    const existing = map.get(symbol);
    if (existing) return existing;
    n += 1;
    const token = `SYM_${n}`;
    map.set(symbol, token);
    return token;
  };
}

export async function fetchSnapTradeOrders(
  credential: string,
  isOrderKnown?: IsOrderKnownFn,
): Promise<ImportResult> {
  const cred = parseCredential(credential);
  const holdings = await fetchSnaptradeHoldings(cred);

  const mapped: ImportedOrder[] = [];
  let sellsImported = 0;
  // Track which symbols we already covered via real orders. Used
  // below to avoid double-counting when a position is also represented
  // by orders. Symbols are stored in their normalized (Yahoo-shape)
  // form to match what mapSnaptradePosition emits.
  const symbolsCoveredByOrders = new Set<string>();

  // --- Redacted diagnostics accumulators (no holdings data) ---
  const tokenFor = makeSymbolTokenizer();
  const orderDiags: SnapTradeOrderDiag[] = [];
  const positionDiags: SnapTradePositionDiag[] = [];
  // Net signed order shares + position units per token, kept ONLY to
  // derive a boolean; the numbers themselves never enter the trace.
  const ordersNetByToken = new Map<string, number>();
  const positionUnitsByToken = new Map<string, number>();
  // Same net, keyed by the real normalized symbol — used to reconcile
  // each position against its in-window order legs (NOT exported).
  const ordersNetBySymbol = new Map<string, number>();
  const ordersSkipped: Partial<Record<SkipReason, number>> = {};
  const positionsSkipped: Partial<Record<SkipReason, number>> = {};
  let ordersKept = 0;
  let ordersDeduped = 0;
  let positionsKept = 0;
  let positionsSuppressed = 0;
  let positionsDeduped = 0;
  const bump = (
    acc: Partial<Record<SkipReason, number>>,
    r: SkipReason,
  ) => {
    acc[r] = (acc[r] ?? 0) + 1;
  };

  // Primary: real orders. Each executed BUY/SELL leg becomes its own
  // lot with the broker-side timestamp + execution price.
  const orderRecords = holdings.orders ?? [];
  for (const raw of orderRecords) {
    const out = mapSnaptradeOrder(raw);
    const rawOrderSymbol = raw.universal_symbol?.symbol;
    const normSymbol =
      typeof rawOrderSymbol === "string" && rawOrderSymbol.length > 0
        ? snaptradeSymbolToYahoo(rawOrderSymbol)
        : null;
    const symbolToken = tokenFor(normSymbol);
    let decision: DiagDecision;
    let skipReason: SkipReason | null = null;

    if (out.kind === "skip") {
      decision = "skipped";
      skipReason = out.reason;
      bump(ordersSkipped, out.reason);
    } else {
      symbolsCoveredByOrders.add(out.order.symbol);
      const known =
        !!isOrderKnown
        && isOrderKnown({
          orderId: out.order.id,
          rawTicker: out.order.symbol,
          purchaseDate: out.order.purchaseDate,
          shares: out.order.shares,
        });
      // Net is over all mappable orders in the window (kept OR already
      // imported) so it can be compared against the position snapshot.
      const signed =
        (out.order.side === "SELL" ? -1 : 1) * out.order.shares;
      if (symbolToken) {
        ordersNetByToken.set(
          symbolToken,
          (ordersNetByToken.get(symbolToken) ?? 0) + signed,
        );
      }
      ordersNetBySymbol.set(
        out.order.symbol,
        (ordersNetBySymbol.get(out.order.symbol) ?? 0) + signed,
      );
      if (known) {
        decision = "deduped";
        ordersDeduped += 1;
      } else {
        decision = "kept";
        ordersKept += 1;
        mapped.push(out.order);
        if (out.order.side === "SELL") sellsImported++;
      }
    }

    orderDiags.push({
      action: typeof raw.action === "string" ? raw.action : null,
      status: typeof raw.status === "string" ? raw.status : null,
      hasOrderId: !!raw.brokerage_order_id,
      hasTimeExecuted: !!raw.time_executed,
      hasExecutionPrice:
        raw.execution_price !== null && raw.execution_price !== undefined,
      hasFilledQty: !!raw.filled_quantity,
      filledQtySign: filledQtySign(raw.filled_quantity),
      rawKeys: Object.keys(raw as Record<string, unknown>).sort(),
      symbolToken,
      decision,
      skipReason,
    });
  }

  // Fill the gaps from positions: any position whose symbol isn't
  // already represented in the orders we just imported gets a
  // synthesized BUY (today-dated, at average purchase price). Common
  // case: brokerage order history doesn't cover the position
  // (transferred-in stock, very old buy, broker hasn't backfilled
  // the order yet). The deterministic id `pos-{accountId}-{symbol}`
  // means resync dedups against itself; the same position won't get
  // re-imported as duplicate.
  const today = todayIso();
  const positions = holdings.positions ?? [];
  for (const raw of positions) {
    const out = mapSnaptradePosition(raw, cred.snaptradeAccountId, today);
    const rawPosSymbol = raw.symbol?.symbol?.symbol;
    const normSymbol =
      typeof rawPosSymbol === "string" && rawPosSymbol.length > 0
        ? snaptradeSymbolToYahoo(rawPosSymbol)
        : null;
    const symbolToken = tokenFor(normSymbol);
    let decision: DiagDecision;
    let skipReason: SkipReason | null = null;

    if (out.kind === "skip") {
      decision = "skipped";
      skipReason = out.reason;
      bump(positionsSkipped, out.reason);
    } else {
      // Position mapped with real units. Record units for the
      // perSymbol diagnostic (pre-reconciliation comparison).
      if (symbolToken) positionUnitsByToken.set(symbolToken, out.order.shares);
      const unitsTrue = out.order.shares;

      if (symbolsCoveredByOrders.has(out.order.symbol)) {
        // Orders touched this symbol. The position is the authoritative
        // CURRENT holding; the order legs supply the timeline. If the
        // in-window order net already equals the broker units, the
        // orders fully cover it — nothing to add. If they diverge
        // (SnapTrade's order window is partial — older sells/buys aged
        // out), emit ONE reconciling adjustment lot so the pooled
        // current shares equal the broker's units. Deterministic id =>
        // idempotent across resyncs; the page updates it in place when
        // units drift, so it self-corrects instead of suppressing the
        // truth forever.
        const net = ordersNetBySymbol.get(out.order.symbol) ?? 0;
        const delta = unitsTrue - net;
        if (Math.abs(delta) <= 1e-4) {
          decision = "suppressed-by-orders";
          positionsSuppressed += 1;
        } else {
          decision = "kept";
          positionsKept += 1;
          mapped.push({
            id: `pos-recon-${cred.snaptradeAccountId}-${out.order.symbol}`,
            symbol: out.order.symbol,
            shares: Math.abs(delta),
            purchasePrice: out.order.purchasePrice,
            purchaseDate: today,
            currency: out.order.currency,
            yahooSymbol: out.order.yahooSymbol,
            side: delta > 0 ? "BUY" : "SELL",
          });
          if (delta < 0) sellsImported++;
        }
      } else {
        // No order history for this symbol at all — synthesize the
        // whole position (existing fallback). ALWAYS emit it (no
        // isOrderKnown dedup-skip): the page matches the deterministic
        // `pos-` id and updates the stored holding in place when units
        // drift, fixing the old "synthesized position never
        // self-corrects" limitation. `known` only affects the trace.
        const known =
          !!isOrderKnown
          && isOrderKnown({
            orderId: out.order.id,
            rawTicker: out.order.symbol,
            purchaseDate: out.order.purchaseDate,
            shares: out.order.shares,
          });
        if (known) {
          decision = "deduped";
          positionsDeduped += 1;
        } else {
          decision = "kept";
          positionsKept += 1;
        }
        mapped.push(out.order);
      }
    }

    positionDiags.push({
      symbolToken,
      hasUnits: raw.units !== null && raw.units !== undefined,
      hasPrice:
        (raw.average_purchase_price ?? raw.price ?? null) !== null,
      decision,
      skipReason,
    });
  }

  const tokens = new Set<string>([
    ...ordersNetByToken.keys(),
    ...positionUnitsByToken.keys(),
  ]);
  const perSymbol = Array.from(tokens).map((symbolToken) => {
    const units = positionUnitsByToken.get(symbolToken);
    if (units === undefined) {
      return { symbolToken, ordersNetMatchesPositionUnits: null };
    }
    const net = ordersNetByToken.get(symbolToken) ?? 0;
    return {
      symbolToken,
      ordersNetMatchesPositionUnits: Math.abs(net - units) < 1e-4,
    };
  });

  const diagnostics: SnapTradeDiagnostics = {
    schemaVersion: 1,
    httpOk: true,
    rawOrderCount: orderRecords.length,
    rawPositionCount: positions.length,
    orders: orderDiags,
    positions: positionDiags,
    perSymbol,
    summary: {
      ordersKept,
      ordersDeduped,
      ordersSkipped,
      positionsKept,
      positionsSuppressed,
      positionsDeduped,
      positionsSkipped,
    },
  };

  return {
    orders: mapped,
    sellsSkipped: 0,
    sellsImported,
    partialFillsSkipped: 0,
    diagnostics,
  };
}

// ---- Account listing (used by the BYO connect-flow account picker) ----

/**
 * One entry from `GET /api/v1/snapTrade/listUserAccounts`. We surface
 * only what the picker UI needs — id, brokerage name, account label.
 */
export interface SnapTradeAccountSummary {
  id: string;
  /** Broker-side display name for the account (e.g. "Roth IRA"). */
  name: string;
  /** Brokerage name (e.g. "Fidelity", "Alpaca Paper"). */
  brokerage?: string;
  /** Account number / label as shown by the broker. */
  number?: string;
}

/**
 * Pull the user's SnapTrade-connected accounts so the modal's
 * picker can render them. The credential here is the 4-field
 * connect-form blob (no accountId yet) — that's how the page
 * calls this between "user submits the credential form" and
 * "user picks an account." The accountId gets appended later,
 * before handleSync.
 *
 * GET — userId/userSecret travel as URL query params (per
 * SnapTrade's API for GETs). The proxy auth builder reads
 * clientId/consumerKey from the credential and HMAC-signs.
 */
export async function listSnapTradeAccounts(
  credential: string,
): Promise<SnapTradeAccountSummary[]> {
  const cred = parseConnectCredential(credential);
  const params = new URLSearchParams({
    userId: cred.snaptradeUserId,
    userSecret: cred.snaptradeUserSecret,
  });
  // SnapTrade exposes account listing at `/api/v1/accounts` (not the
  // older `/api/v1/snapTrade/listUserAccounts` path some docs still
  // mention; that one returns 404). Verified against the official
  // Python SDK at passiv/snaptrade-sdks/sdks/python/snaptrade_client/
  // paths/accounts/get.py.
  const path = `/api/v1/accounts?${params.toString()}`;
  const res = await proxyFetch("snaptrade", buildAuthCredential(cred), path);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`SnapTrade list accounts failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Array<{
    id?: string;
    name?: string;
    institution_name?: string;
    number?: string;
  }>;
  return json
    .filter((a) => typeof a.id === "string")
    .map((a) => ({
      id: a.id as string,
      name: a.name ?? a.institution_name ?? "Account",
      brokerage: a.institution_name,
      number: a.number,
    }));
}
