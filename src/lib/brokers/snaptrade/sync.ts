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

const FIRST_SYNC_WINDOW_DAYS = 365 * 7; // 7 years

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

function nDaysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/**
 * Issue the activities query and parse the response. The userId and
 * userSecret travel as URL query params (per SnapTrade's API for GETs);
 * the server-side proxy auth builder appends `clientId` and `timestamp`
 * before signing. Body is null.
 */
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

async function fetchActivitiesPage(
  cred: ParsedCredential,
  startDate: string,
  endDate: string,
): Promise<SnaptradeActivity[]> {
  const params = new URLSearchParams({
    userId: cred.snaptradeUserId,
    userSecret: cred.snaptradeUserSecret,
    accounts: cred.snaptradeAccountId,
    startDate,
    endDate,
    type: "BUY,SELL",
  });
  const path = `/api/v1/activities?${params.toString()}`;
  const res = await proxyFetch("snaptrade", buildAuthCredential(cred), path);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`SnapTrade API error ${res.status}: ${text}`);
  }
  return (await res.json()) as SnaptradeActivity[];
}

/**
 * Pull and normalize the user's BUY/SELL activity for a single
 * SnapTrade-connected brokerage account.
 *
 * The `isOrderKnown` predicate is supplied by the page (which has the
 * full holdings list) so subsequent syncs can short-circuit pagination
 * once we hit fully-known activity. SnapTrade doesn't paginate by
 * cursor, so the predicate informs the date-range narrowing on the
 * caller side, not directly here. For now we just pull a wide window
 * and let the caller dedup; future optimization can narrow `startDate`
 * based on the most recent known holding's `purchaseDate`.
 */
export async function fetchSnapTradeOrders(
  credential: string,
  isOrderKnown?: IsOrderKnownFn,
): Promise<ImportResult> {
  const cred = parseCredential(credential);
  const startDate = nDaysAgoIso(FIRST_SYNC_WINDOW_DAYS);
  const endDate = todayIso();

  const items = await fetchActivitiesPage(cred, startDate, endDate);

  const mapped: ImportedOrder[] = [];
  let sellsImported = 0;
  for (const raw of items) {
    const out = mapSnaptradeActivity(raw);
    if (out.kind === "skip") continue;
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

  return {
    orders: mapped,
    sellsSkipped: 0,
    sellsImported,
    partialFillsSkipped: 0, // SnapTrade pre-aggregates fills.
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
  const path = `/api/v1/snapTrade/listUserAccounts?${params.toString()}`;
  const res = await proxyFetch("snaptrade", buildAuthCredential(cred), path);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`SnapTrade listUserAccounts failed (${res.status}): ${text}`);
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
