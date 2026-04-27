"use client";

/**
 * Browser-side port of the Trading 212 sync logic. Mirrors the original
 * `src/lib/trading212.ts` server action but routes every HTTP call through
 * `/api/broker-proxy` so the server stays a TLS-terminating relay rather
 * than a data processor.
 *
 * The orchestration (pagination, ISIN map, exchange-letter normalization,
 * 429 retries, sequential rate-limit queue) all lives here. Tests against
 * the original logic still apply; only the transport layer differs.
 *
 * The proxy URL and request body field names are deliberately broker-
 * agnostic so server access logs don't broadcast that the user is using
 * Trading 212 specifically. The actual outbound destination is hardcoded
 * server-side; this client just speaks "broker-proxy" to it.
 */

import { auth } from "./firebase";
import { cleanT212Symbol, toYahooSymbol } from "./trading212-utils";

interface T212OrderItem {
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

export interface ImportResult {
  orders: Array<{
    id: string;
    symbol: string;
    shares: number;
    purchasePrice: number;
    purchaseDate: string;
    currency?: string;
    isin?: string;
    yahooSymbol?: string;
    side: "BUY" | "SELL";
  }>;
  sellsSkipped: number;
  sellsImported: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-tab concurrency-1 queue. T212 rate-limits aggressively (1 req/min for
 * some endpoints, plus burst limits) and parallel calls would burn the
 * same bucket. This used to be module-local in the server action; it stays
 * module-local here too, scoped per browser tab.
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
 * Issue a single proxy call. Always uses POST to `/api/broker-proxy`
 * with a generic body shape; the proxy translates into the appropriate
 * GET to the broker (destination hardcoded server-side).
 *
 * Retries once on 429 after a 65s sleep — T212's rate window is 60s, so
 * one extra wait usually unblocks subsequent requests. Beyond that we
 * surface an error so the user knows to wait.
 */
async function proxyFetch(
  apiKey: string,
  path: string,
  retries = 3,
): Promise<Response> {
  return enqueue(async () => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("not signed in");
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch("/api/broker-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ auth: apiKey, path }),
        cache: "no-store",
      });
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

export async function fetchTrading212OrdersClient(
  apiKey: string,
): Promise<ImportResult> {
  validateApiKey(apiKey);

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
    orders.push(...(data.items ?? []));
    if (!data.nextPagePath) break;
    path = data.nextPagePath;
    await sleep(500);
  }

  let sellsImported = 0;
  const mapped: ImportResult["orders"] = [];

  for (const item of orders) {
    const { order, fill } = item;
    if (order.status !== "FILLED") continue;
    const isSell = order.side === "SELL";
    const isBuy = order.side === "BUY";
    if (!isSell && !isBuy) continue;
    if (!fill || !fill.quantity || !fill.price) continue;

    if (isBuy && openTickers) {
      const isAutoInvest = order.initiatedFrom === "AUTOINVEST";
      if (isAutoInvest && !openTickers.has(order.ticker)) continue;
    }

    const rawPrice = fill.price;
    const purchasePrice =
      order.instrument?.currency === "GBX" ? rawPrice / 100 : rawPrice;

    const isinSymbol = isinToSymbol.get(order.instrument.isin ?? "");
    const symbol = isinSymbol ?? cleanT212Symbol(order.ticker);
    const yahooSymbol =
      order.instrument?.currency === "USD" && isinSymbol
        ? isinSymbol
        : toYahooSymbol(order.ticker, order.instrument?.currency) ?? undefined;

    const shares = Math.abs(fill.quantity);

    mapped.push({
      id: String(order.id),
      symbol,
      shares,
      purchasePrice,
      purchaseDate: fill.filledAt.split("T")[0],
      currency: order.instrument?.currency,
      isin: order.instrument?.isin,
      yahooSymbol,
      side: isSell ? "SELL" : "BUY",
    });
    if (isSell) sellsImported++;
  }

  return { orders: mapped, sellsSkipped: 0, sellsImported };
}
