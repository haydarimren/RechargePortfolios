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
import type { ImportedOrder, ImportResult, IsOrderKnownFn } from "../types";
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
  | { kind: "skip" };

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
  if (action !== "BUY" && action !== "SELL") return { kind: "skip" };

  if (!raw.brokerage_order_id) return { kind: "skip" };
  if (!raw.time_executed) return { kind: "skip" };
  if (raw.execution_price === null || raw.execution_price === undefined) {
    return { kind: "skip" };
  }
  if (!raw.filled_quantity) return { kind: "skip" };

  const rawSymbol = raw.universal_symbol?.symbol;
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    return { kind: "skip" };
  }

  // SnapTrade returns filled_quantity as a string (decimal-friendly).
  // Use Number rather than parseFloat so trailing-junk strings fail
  // the finite check rather than silently truncate.
  const shares = Math.abs(Number(raw.filled_quantity));
  const price = raw.execution_price;
  if (!isFinite(shares) || shares <= 0) return { kind: "skip" };
  if (!isFinite(price) || price <= 0) return { kind: "skip" };

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
  | { kind: "skip" };

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
    return { kind: "skip" };
  }
  const units = raw.units;
  const price = raw.average_purchase_price ?? raw.price;
  if (typeof units !== "number" || !isFinite(units) || units <= 0) {
    // Skip empty or short positions for v1.
    return { kind: "skip" };
  }
  if (typeof price !== "number" || !isFinite(price) || price <= 0) {
    return { kind: "skip" };
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

  // Primary: real orders. Each executed BUY/SELL leg becomes its own
  // lot with the broker-side timestamp + execution price.
  const orderRecords = holdings.orders ?? [];
  for (const raw of orderRecords) {
    const out = mapSnaptradeOrder(raw);
    if (out.kind === "skip") continue;
    symbolsCoveredByOrders.add(out.order.symbol);
    if (
      isOrderKnown
      && isOrderKnown({
        orderId: out.order.id,
        rawTicker: out.order.symbol,
        purchaseDate: out.order.purchaseDate,
        shares: out.order.shares,
      })
    ) {
      continue;
    }
    mapped.push(out.order);
    if (out.order.side === "SELL") sellsImported++;
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
    if (out.kind === "skip") continue;
    if (symbolsCoveredByOrders.has(out.order.symbol)) continue;
    if (
      isOrderKnown
      && isOrderKnown({
        orderId: out.order.id,
        rawTicker: out.order.symbol,
        purchaseDate: out.order.purchaseDate,
        shares: out.order.shares,
      })
    ) {
      continue;
    }
    mapped.push(out.order);
  }

  return {
    orders: mapped,
    sellsSkipped: 0,
    sellsImported,
    partialFillsSkipped: 0,
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
