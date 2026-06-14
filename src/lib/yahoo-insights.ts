"use server";

/**
 * Per-symbol insights (upcoming dates + analyst ratings/targets) from Yahoo
 * `quoteSummary` (v10). Unlike the v8 chart endpoint (prices), quoteSummary
 * needs a cookie+crumb handshake — the same auth that locked v7 in April
 * 2026 — so this degrades gracefully: a handshake failure returns all-null,
 * and the UI hides the affected cards. Daily server cache (data moves slowly).
 */

import { parseQuoteSummary, type StockInsight } from "./insights";

const CONCURRENCY = 5;
const DAY = 86400;

async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Session { cookie: string; crumb: string }

async function getSession(): Promise<Session | null> {
  try {
    const seed = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: DAY },
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
    if (!cookie) return null;
    const res = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      next: { revalidate: DAY },
    });
    if (!res.ok) return null;
    const crumb = (await res.text()).trim();
    // A valid crumb is a short opaque token; an HTML/empty body means we were blocked.
    if (!crumb || crumb.length > 64 || crumb.includes("<")) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

async function fetchOne(symbol: string, s: Session): Promise<StockInsight | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=calendarEvents,financialData&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: s.cookie },
      next: { revalidate: DAY },
    });
    if (!res.ok) return null;
    return parseQuoteSummary(await res.json());
  } catch {
    return null;
  }
}

export async function getStockInsights(
  symbols: string[],
): Promise<Record<string, StockInsight | null>> {
  const out: Record<string, StockInsight | null> = {};
  if (symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols));
  const session = await getSession();
  if (!session) {
    for (const s of uniq) out[s] = null;
    return out;
  }
  const results = await mapWithConcurrency(uniq, CONCURRENCY, (s) => fetchOne(s, session));
  uniq.forEach((s, i) => { out[s] = results[i]; });
  return out;
}
