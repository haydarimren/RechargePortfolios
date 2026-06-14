"use client";

/**
 * Alpaca sync orchestration. Pulls the user's order history through the
 * broker proxy, filters/normalizes, and returns a broker-agnostic
 * `ImportResult` for the page to fold into Firestore.
 *
 * Differences from the T212 adapter:
 *   - No serial queue. Alpaca's documented limit is 200 req/min, well
 *     above what a sync needs.
 *   - No 65s-on-429 retry; Alpaca returns Retry-After when throttled.
 *     For the modest call counts here (a couple of pages), the throttle
 *     is unlikely to fire.
 *   - Pagination is `until` cursor-based, descending by `submitted_at`,
 *     same shape as T212 (newest-first) so the dedup-and-stop short-
 *     circuit works the same way.
 *   - Asset class is filtered to `us_equity` only. Crypto and options
 *     are skipped — the Holding model and Yahoo price fetcher don't
 *     handle them; future work, separate spec.
 */

import { proxyFetch } from "../proxy-fetch";
import type { ImportResult, ImportedOrder, IsOrderKnownFn } from "../types";
import { alpacaSymbolToYahoo } from "./symbols";

interface AlpacaOrder {
  id: string;
  symbol: string;
  asset_class: string;
  side: "buy" | "sell";
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  submitted_at: string;
  status: string;
}

const PAGE_LIMIT = 500;
const MAX_PAGES = 50;

/**
 * Client-side early-fail on a malformed credential. The same rule lives
 * server-side in `SERVER_BROKERS.alpaca.auth` (api/broker-proxy/brokers.ts);
 * the server is the load-bearing check (it produces the actual headers),
 * this just gives the user a friendlier error before the network round
 * trip. If you change one, change the other.
 */
function validateCredential(credential: string): void {
  const idx = credential.indexOf(":");
  if (idx <= 0 || idx === credential.length - 1) {
    throw new Error("Alpaca API key and secret required");
  }
}

export type MapAlpacaOrderResult =
  | { kind: "keep"; order: ImportedOrder }
  | { kind: "skip" }
  | { kind: "partial-fill-skipped" };

/**
 * Pure mapping: take one raw Alpaca order, decide what to do with it,
 * and produce the broker-agnostic `ImportedOrder` if we keep it. Returns
 * a discriminated result so the caller can count partial-fill drops
 * separately from generic skips.
 *
 * Extracted so it can be unit-tested without mocking HTTP.
 */
export function mapAlpacaOrder(raw: AlpacaOrder): MapAlpacaOrderResult {
  // v1: US equities only. Crypto pairs ("BTC/USD") and options need
  // their own asset model and price-feed wiring.
  if (raw.asset_class !== "us_equity") return { kind: "skip" };

  // Use `Number` rather than `parseFloat` so trailing-junk strings
  // (e.g. "10abc") become NaN and fail the finite check, not silently
  // truncate to 10. Alpaca returns canonical decimals, so this is
  // belt-and-braces.
  const shares = Number(raw.filled_qty);

  // Partial-fill-then-cancelled: `status === "canceled"` with
  // `filled_qty > 0` means the user actually owns shares from the
  // fills that did happen before cancellation. Representing those
  // faithfully as lots needs its own design; for v1 we count them so
  // the sync UI can warn rather than silently lose shares.
  if (raw.status === "canceled" && isFinite(shares) && shares > 0) {
    return { kind: "partial-fill-skipped" };
  }

  // v1: only fully-filled orders.
  if (raw.status !== "filled") return { kind: "skip" };

  if (!raw.filled_at || !raw.filled_avg_price) return { kind: "skip" };

  const price = Number(raw.filled_avg_price);
  if (!isFinite(shares) || shares <= 0) return { kind: "skip" };
  if (!isFinite(price) || price <= 0) return { kind: "skip" };

  const yahooSymbol = alpacaSymbolToYahoo(raw.symbol);
  return {
    kind: "keep",
    order: {
      id: raw.id,
      symbol: yahooSymbol,
      shares,
      purchasePrice: price,
      purchaseDate: raw.filled_at.split("T")[0],
      currency: "USD",
      yahooSymbol,
      side: raw.side === "sell" ? "SELL" : "BUY",
    },
  };
}

/**
 * A page is "fully imported" iff it has ≥1 importable order (kind ===
 * "keep") and every importable order is known. Non-importable orders
 * (skips, partial-fill-cancelled) no longer block the stop.
 */
export function alpacaPageFullyImported(
  items: AlpacaOrder[],
  isOrderKnown?: IsOrderKnownFn,
): boolean {
  if (!isOrderKnown) return false;
  const importable = items.filter((it) => mapAlpacaOrder(it).kind === "keep");
  if (importable.length === 0) return false;
  return importable.every((it) =>
    isOrderKnown({
      orderId: it.id,
      rawTicker: it.symbol,
      purchaseDate: it.filled_at!.split("T")[0],
      // Number (not parseFloat) per this module's convention — "10abc" →
      // NaN rather than a silently-truncated 10. See mapAlpacaOrder.
      shares: Number(it.filled_qty),
    }),
  );
}

async function fetchPage(
  credential: string,
  until?: string,
): Promise<AlpacaOrder[]> {
  const params = new URLSearchParams({
    status: "closed",
    limit: String(PAGE_LIMIT),
    direction: "desc",
  });
  if (until) params.set("until", until);
  const res = await proxyFetch("alpaca", credential, `/v2/orders?${params}`);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Alpaca API error ${res.status}: ${text}`);
  }
  return (await res.json()) as AlpacaOrder[];
}

export async function fetchAlpacaOrders(
  credential: string,
  /**
   * Optional dedup-and-stop predicate. Same contract as T212 — page
   * stops once every item on a page is already known. Alpaca is
   * descending by submitted_at, so older pages are by definition
   * already imported.
   */
  isOrderKnown?: IsOrderKnownFn,
): Promise<ImportResult> {
  validateCredential(credential);

  const collected: AlpacaOrder[] = [];
  let until: string | undefined;
  let pageCount = 0;

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      throw new Error(
        `Alpaca orders pagination exceeded ${MAX_PAGES} pages`,
      );
    }
    const items = await fetchPage(credential, until);
    if (items.length === 0) break;

    for (const item of items) collected.push(item);

    const pageFullyExisting = alpacaPageFullyImported(items, isOrderKnown);
    if (pageFullyExisting || items.length < PAGE_LIMIT) break;

    // Cursor for next page: oldest order's submitted_at on this page.
    // Alpaca's `until` is exclusive, so the oldest order won't be re-fetched.
    until = items[items.length - 1].submitted_at;
  }

  let sellsImported = 0;
  let partialFillsSkipped = 0;
  const mapped: ImportedOrder[] = [];
  for (const raw of collected) {
    const out = mapAlpacaOrder(raw);
    if (out.kind === "partial-fill-skipped") {
      partialFillsSkipped++;
      continue;
    }
    if (out.kind === "skip") continue;
    mapped.push(out.order);
    if (out.order.side === "SELL") sellsImported++;
  }

  return {
    orders: mapped,
    sellsSkipped: 0,
    sellsImported,
    partialFillsSkipped,
  };
}
