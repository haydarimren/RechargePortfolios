"use server";

import { stripT212Suffix, toYahooSymbol } from "./trading212-utils";

const BASE_URL = "https://live.trading212.com/api/v0";

/**
 * Trading212 order history item.
 * See: https://t212public-api-docs.redoc.ly/
 * Observed `initiatedFrom` values: AUTOINVEST, IOS, ANDROID, WEB, API.
 * Observed `side` values: BUY, SELL.
 */
interface T212OrderItem {
  order: {
    id: number;
    ticker: string;
    status: string;
    side: string;
    createdAt: string;
    initiatedFrom: string;
    instrument: {
      currency: string;
      isin?: string;
    };
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
  /** Retained for compatibility (always 0 now that sells are imported). */
  sellsSkipped: number;
  /** Count of SELL orders successfully mapped into `orders`. */
  sellsImported: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Module-local concurrency-1 queue. All Trading212 HTTP calls route through
// `enqueue` so we never burn the same rate-limit bucket with parallel requests.
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

async function fetchWithRetry(url: string, headers: Record<string, string>, retries = 3): Promise<Response> {
  return enqueue(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, { headers, cache: "no-store" });
      if (res.status !== 429) return res;
      if (attempt < retries) await sleep(65_000);
    }
    throw new Error("Trading212 API rate limit exceeded. Please try again in a minute.");
  });
}

async function fetchIsinToSymbol(headers: Record<string, string>): Promise<Map<string, string>> {
  const res = await fetchWithRetry(`${BASE_URL}/equity/metadata/instruments`, headers);
  if (!res.ok) return new Map();
  const instruments: Array<{ ticker: string; isin: string; shortName: string; currencyCode: string }> = await res.json();
  const map = new Map<string, string>();
  for (const inst of instruments) {
    if (!inst.isin) continue;
    const symbol = inst.currencyCode === "USD" ? inst.shortName : stripT212Suffix(inst.ticker);
    // USD entry wins over any non-USD duplicate for the same ISIN
    if (!map.has(inst.isin) || inst.currencyCode === "USD") {
      map.set(inst.isin, symbol);
    }
  }
  return map;
}

async function fetchOpenPositionTickers(headers: Record<string, string>): Promise<Set<string> | null> {
  // Advisory only: used to filter AutoInvest buys to still-open positions.
  // If the key lacks the "Positions" scope (403) or the call otherwise fails,
  // return null — callers skip the filter rather than treating "no data" as
  // "empty set" (which would drop every AutoInvest buy).
  try {
    const res = await fetchWithRetry(`${BASE_URL}/equity/positions`, headers);
    if (!res.ok) return null;
    const positions: Array<{ instrument: { ticker: string; isin: string; name: string; currency: string } }> = await res.json();
    return new Set(positions.map((p) => p.instrument.ticker));
  } catch {
    return null;
  }
}

export async function fetchTrading212Orders(apiKey: string): Promise<ImportResult> {
  validateApiKey(apiKey);
  const auth = `Basic ${Buffer.from(apiKey).toString("base64")}`;
  const headers = { Authorization: auth };

  const openTickers = await fetchOpenPositionTickers(headers);
  const isinToSymbol = await fetchIsinToSymbol(headers);
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
    const res = await fetchWithRetry(`https://live.trading212.com${path}`, headers);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Trading212 API error ${res.status}: ${text}`);
    }

    const data: T212OrdersResponse = await res.json();
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

    // AUTOINVEST filter only makes sense for buys (sells shouldn't come from autoinvest,
    // but be defensive — never filter sells on open-ticker check).
    if (isBuy && openTickers) {
      const isAutoInvest = order.initiatedFrom === "AUTOINVEST";
      if (isAutoInvest && !openTickers.has(order.ticker)) continue;
    }

    const rawPrice = fill.price;
    const purchasePrice = order.instrument?.currency === "GBX"
      ? rawPrice / 100
      : rawPrice;

    const isinSymbol = isinToSymbol.get(order.instrument.isin ?? "");
    const symbol = isinSymbol ?? stripT212Suffix(order.ticker);
    // For USD instruments we trust the shortName from T212's metadata call
    // for Yahoo too — it's up-to-date and survives corporate renames
    // (e.g. ASTS pre-merger lots where T212's ticker is a stale NPAa, but
    // shortName is ASTS). For non-USD we still need an exchange suffix,
    // so parse the ticker via toYahooSymbol.
    // `null` means we couldn't confidently pick an exchange — fall back to
    // the bare symbol at read time (works for unambiguous US listings).
    const yahooSymbol =
      order.instrument?.currency === "USD" && isinSymbol
        ? isinSymbol
        : toYahooSymbol(order.ticker, order.instrument?.currency) ?? undefined;

    // T212 sell fills may report quantity as a negative number; normalize.
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

