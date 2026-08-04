"use client";

import {
  getHistoricalSeries,
  HistoricalPoint,
  HistoricalSeries,
} from "@/lib/yahoo";

const TTL_MS = 60 * 60 * 1000; // 1h — matches server-side revalidate
const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  data: HistoricalSeries;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<HistoricalSeries>>();

function keyFor(symbol: string, fromMs: number, toMs: number): string {
  const from = Math.floor(fromMs / DAY_MS);
  const to = Math.floor(toMs / DAY_MS);
  return `${symbol}|${from}|${to}`;
}

/**
 * Closes plus the currency they're quoted in. Callers that sum across
 * symbols need the currency to convert first — a chart that adds a
 * London close to a Milan close without converting is drawing a number
 * that doesn't exist.
 */
export function getCachedHistoricalSeries(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<HistoricalSeries> {
  const key = keyFor(symbol, fromMs, toMs);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = getHistoricalSeries(symbol, fromMs, toMs)
    .then((data) => {
      cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

export function getCachedHistoricalCloses(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<HistoricalPoint[]> {
  return getCachedHistoricalSeries(symbol, fromMs, toMs).then((s) => s.points);
}
