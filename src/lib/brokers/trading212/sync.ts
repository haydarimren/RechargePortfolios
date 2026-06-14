"use client";

/**
 * Trading 212 sync orchestration. Pulls the user's order history through
 * the broker proxy, normalizes symbols, and returns a broker-agnostic
 * `ImportResult` for the page to fold into Firestore.
 *
 * Concurrency / rate-limit policy is T212-specific and lives here:
 *   - Per-tab serial queue (T212 rate-limits some endpoints to 1 req/min;
 *     parallel calls would burn the same bucket).
 *   - 65s sleep on 429 with bounded retries.
 *   - 11s sleep between order-history pages to stay under the documented
 *     6/min cap on `/equity/history/orders`.
 */

import { proxyFetch as sharedProxyFetch } from "../proxy-fetch";
import type { ImportResult, IsOrderKnownFn } from "../types";
import { cleanT212Symbol, toYahooSymbol } from "./symbols";

export interface T212OrderItem {
  order: {
    id: number;
    ticker: string;
    status: string;
    side: string;
    createdAt: string;
    initiatedFrom: string;
    instrument: { currency: string; isin?: string };
  };
  fill: {
    quantity: number;
    price: number;
    filledAt: string;
  } | null;
}

interface T212OrdersResponse {
  items: T212OrderItem[];
  nextPagePath?: string;
}

/**
 * Would this raw order become a holding? Mirrors the import loop's filter
 * exactly so the dedup short-circuit can never drift from what's actually
 * imported. Cancelled/rejected/unfilled orders (fill === null) and
 * AutoInvest buys not in open positions are NOT importable.
 */
export function isImportableT212Order(
  item: T212OrderItem,
  openTickers: Set<string> | null,
): boolean {
  const { order, fill } = item;
  if (order.status !== "FILLED") return false;
  if (order.side !== "BUY" && order.side !== "SELL") return false;
  if (!fill || !fill.quantity || !fill.price || !fill.filledAt) return false;
  if (
    order.side === "BUY" &&
    openTickers &&
    order.initiatedFrom === "AUTOINVEST" &&
    !openTickers.has(order.ticker)
  ) {
    return false;
  }
  return true;
}

/**
 * A page is "fully imported" iff it has at least one importable order and
 * every importable order is already known. Non-importable orders (e.g.
 * cancelled) are ignored — they were the bug: they can never be "known",
 * so they used to block the stop and force full pagination.
 */
export function pageFullyImported(
  items: T212OrderItem[],
  openTickers: Set<string> | null,
  isOrderKnown?: IsOrderKnownFn,
): boolean {
  if (!isOrderKnown) return false;
  const importable = items.filter((it) => isImportableT212Order(it, openTickers));
  if (importable.length === 0) return false;
  return importable.every((it) =>
    isOrderKnown({
      orderId: String(it.order.id),
      rawTicker: it.order.ticker,
      purchaseDate: it.fill!.filledAt.split("T")[0],
      shares: Math.abs(it.fill!.quantity),
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-tab concurrency-1 queue. T212 rate-limits aggressively (1 req/min for
 * some endpoints, plus burst limits) and parallel calls would burn the
 * same bucket. Module-local, scoped per browser tab.
 */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p as Promise<T>;
}

function validateApiKey(apiKey: string): void {
  const [key, secret] = (apiKey ?? "").split(":");
  if (!key || !secret) {
    throw new Error("Trading212 API key and secret required");
  }
}

/**
 * T212-flavored proxy call: serial-queued, with a 65s sleep + bounded
 * retry on 429. The shared `proxyFetch` underneath is dumb — all the
 * pacing is here.
 */
async function proxyFetch(
  apiKey: string,
  path: string,
  retries = 3,
): Promise<Response> {
  return enqueue(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await sharedProxyFetch("trading212", apiKey, path);
      if (res.status !== 429) return res;
      if (attempt < retries) await sleep(65_000);
    }
    throw new Error(
      "Trading212 API rate limit exceeded. Please try again in a minute.",
    );
  });
}

/**
 * Pull T212's instrument metadata once per sync to build an ISIN→Yahoo-
 * compatible-symbol map. Used to heal stale tickers that T212 still
 * reports as their pre-merger names (ASTS ← NPA, etc.).
 */
async function fetchIsinToSymbol(apiKey: string): Promise<Map<string, string>> {
  const res = await proxyFetch(apiKey, "/api/v0/equity/metadata/instruments");
  if (!res.ok) return new Map();
  const instruments = (await res.json()) as Array<{
    ticker: string;
    isin: string;
    shortName: string;
    currencyCode: string;
  }>;
  const map = new Map<string, string>();
  for (const inst of instruments) {
    if (!inst.isin) continue;
    const symbol =
      inst.currencyCode === "USD" ? inst.shortName : cleanT212Symbol(inst.ticker);
    if (!map.has(inst.isin) || inst.currencyCode === "USD") {
      map.set(inst.isin, symbol);
    }
  }
  return map;
}

async function fetchOpenPositionTickers(
  apiKey: string,
): Promise<Set<string> | null> {
  try {
    const res = await proxyFetch(apiKey, "/api/v0/equity/positions");
    if (!res.ok) return null;
    const positions = (await res.json()) as Array<{
      instrument: { ticker: string; isin: string; name: string; currency: string };
    }>;
    return new Set(positions.map((p) => p.instrument.ticker));
  } catch {
    return null;
  }
}

export async function fetchTrading212Orders(
  apiKey: string,
  /**
   * Optional predicate: returns true for orders we've already imported.
   * When supplied, pagination stops as soon as a page is fully made up
   * of known orders — T212 returns orders newest-first, so any older
   * orders on subsequent pages are by definition also already imported.
   * Repeat syncs of an active account drop from N pages to 1.
   */
  isOrderKnown?: IsOrderKnownFn,
): Promise<ImportResult> {
  validateApiKey(apiKey);
  const startedAt = Date.now();

  const openTickers = await fetchOpenPositionTickers(apiKey);
  const isinToSymbol = await fetchIsinToSymbol(apiKey);
  await sleep(500);

  const orders: T212OrderItem[] = [];
  let path = "/api/v0/equity/history/orders?limit=50";
  const MAX_PAGES = 200;
  let pageCount = 0;

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      throw new Error(
        `Trading212 orders pagination exceeded ${MAX_PAGES} pages (last path: ${path})`,
      );
    }
    const res = await proxyFetch(apiKey, path);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Trading212 API error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as T212OrdersResponse;
    const items = data.items ?? [];
    for (const item of items) orders.push(item);
    // Stop only when EVERY item on this page is already imported. T212
    // pagination is documented as newest-first by id, but a defensive
    // page-level threshold tolerates any out-of-order delivery within
    // a window equal to the page size (50). Mixed pages (some new,
    // some old) keep paginating; only a fully-existing page is the
    // signal that we've reached already-known territory.
    const pageFullyExisting = pageFullyImported(items, openTickers, isOrderKnown);
    if (!data.nextPagePath || pageFullyExisting) break;
    path = data.nextPagePath;
    // T212's documented rate limit on /equity/history/orders is 6/min
    // (1 every 10s). Sleep 11s to leave a small safety margin so a
    // multi-page first sync runs to completion without ever tripping
    // 429. For repeat syncs the dedup-and-stop above usually keeps
    // us at 1-2 pages, so this only matters on initial imports.
    await sleep(11_000);
  }

  let sellsImported = 0;
  const mapped: ImportResult["orders"] = [];

  for (const item of orders) {
    if (!isImportableT212Order(item, openTickers)) continue;
    const { order, fill } = item;
    const isSell = order.side === "SELL";
    // fill is guaranteed non-null by isImportableT212Order
    const rawPrice = fill!.price;
    const purchasePrice =
      order.instrument?.currency === "GBX" ? rawPrice / 100 : rawPrice;

    const isinSymbol = isinToSymbol.get(order.instrument.isin ?? "");
    const symbol = isinSymbol ?? cleanT212Symbol(order.ticker);
    const yahooSymbol =
      order.instrument?.currency === "USD" && isinSymbol
        ? isinSymbol
        : toYahooSymbol(order.ticker, order.instrument?.currency) ?? undefined;

    const shares = Math.abs(fill!.quantity);

    mapped.push({
      id: String(order.id),
      symbol,
      shares,
      purchasePrice,
      purchaseDate: fill!.filledAt.split("T")[0],
      currency: order.instrument?.currency,
      isin: order.instrument?.isin,
      yahooSymbol,
      side: isSell ? "SELL" : "BUY",
    });
    if (isSell) sellsImported++;
  }

  return {
    orders: mapped,
    sellsSkipped: 0,
    sellsImported,
    partialFillsSkipped: 0,
    timing: { pages: pageCount, elapsedMs: Date.now() - startedAt },
  };
}
