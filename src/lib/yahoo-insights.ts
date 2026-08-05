"use server";

/**
 * Per-symbol insights (upcoming dates + analyst ratings/targets) from Yahoo
 * `quoteSummary` (v10). Unlike the v8 chart endpoint (prices), quoteSummary
 * needs a cookie+crumb handshake — the same auth that locked v7 in April
 * 2026 — so this degrades gracefully: a handshake failure returns all-null,
 * and the UI hides the affected cards.
 *
 * Caching lives in `ttl-cache.ts`, NOT in `next: { revalidate }` — that
 * option is inert inside a Server Action (see that file's header). Before
 * this was understood, every single view re-ran the crumb handshake AND
 * re-fetched every symbol; a 30-holding portfolio cost 62 upstream requests
 * per view, which is a good way to get the v10 endpoint locked down too.
 *
 * As in `finnhub-recs.ts`, the fetchers reject on transient failure and
 * resolve on a definitive answer, so only real answers are ever cached.
 */

import { parseQuoteSummary, type StockInsight } from "./insights";
import { mapWithConcurrency } from "./concurrency";
import { createTtlCache } from "./ttl-cache";

const CONCURRENCY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Crumbs outlive this comfortably; short enough to recover from a rotation. */
const SESSION_TTL_MS = 30 * 60 * 1000;

interface Session { cookie: string; crumb: string }

/** Single-entry cache: the handshake is per-deployment, not per-user. */
const sessionCache = createTtlCache<Session>(SESSION_TTL_MS);
const insightCache = createTtlCache<StockInsight | null>(DAY_MS);

/** Rejects if the handshake fails, so a blocked attempt isn't cached for 30
 *  minutes. Coalescing means a cold portfolio load performs it exactly once
 *  no matter how many symbols are in flight. */
async function handshake(): Promise<Session> {
  const seed = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  // Forward ALL of Yahoo's seed cookies (it sets A1 + A3; the crumb
  // endpoint can need both). `getSetCookie()` returns them un-collapsed;
  // `get("set-cookie")` comma-joins them, so prefer the former and fall
  // back. Keep just the `name=value` head of each.
  const headers = seed.headers as Headers & { getSetCookie?(): string[] };
  const raw = headers.getSetCookie?.() ?? (() => {
    const joined = seed.headers.get("set-cookie");
    return joined ? [joined] : [];
  })();
  const cookie = raw
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("yahoo: no seed cookie");
  const res = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
  });
  if (!res.ok) throw new Error(`yahoo getcrumb ${res.status}`);
  const crumb = (await res.text()).trim();
  // A valid crumb is a short opaque token; an HTML/empty body means we were blocked.
  if (!crumb || crumb.length > 64 || crumb.includes("<")) {
    throw new Error("yahoo: crumb rejected");
  }
  return { cookie, crumb };
}

async function fetchInsight(symbol: string, s: Session): Promise<StockInsight | null> {
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=calendarEvents,financialData&crumb=${encodeURIComponent(s.crumb)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: s.cookie },
  });
  // 404 means Yahoo has no such symbol — a real answer, worth caching.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`yahoo quoteSummary ${res.status}: ${symbol}`);
  return parseQuoteSummary(await res.json());
}

export async function getStockInsights(
  symbols: string[],
): Promise<Record<string, StockInsight | null>> {
  const out: Record<string, StockInsight | null> = {};
  if (symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols));

  let session: Session;
  try {
    session = await sessionCache.getOrCreate("session", handshake);
  } catch {
    for (const s of uniq) out[s] = null;
    return out;
  }

  const results = await mapWithConcurrency(uniq, CONCURRENCY, (s) =>
    insightCache.getOrCreate(s, () => fetchInsight(s, session)).catch(() => null),
  );
  uniq.forEach((s, i) => { out[s] = results[i]; });
  return out;
}
