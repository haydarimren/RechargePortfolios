"use client";

import { getHistoricalCloses, HistoricalPoint } from "@/lib/yahoo";

const TTL_MS = 60 * 60 * 1000; // 1h — matches server-side revalidate
const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  data: HistoricalPoint[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<HistoricalPoint[]>>();

function keyFor(symbol: string, fromMs: number, toMs: number): string {
  const from = Math.floor(fromMs / DAY_MS);
  const to = Math.floor(toMs / DAY_MS);
  return `${symbol}|${from}|${to}`;
}

export function getCachedHistoricalCloses(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<HistoricalPoint[]> {
  const key = keyFor(symbol, fromMs, toMs);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = getHistoricalCloses(symbol, fromMs, toMs)
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
