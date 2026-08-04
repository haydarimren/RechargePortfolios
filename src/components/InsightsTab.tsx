"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TickerPosition } from "@/lib/portfolio";
import type { StockQuote } from "@/lib/finnhub";
import { getStockInsights } from "@/lib/yahoo-insights";
import { getAnalystSpreads } from "@/lib/finnhub-recs";
import {
  buildUpcomingDates, buildAnalystRatings, topMovers,
  type StockInsight, type AnalystSpread, type Movers,
} from "@/lib/insights";
import {
  RatingPill, AnalystSpreadBar, SkeletonRows, Empty, Unavailable,
  fmtMoney, signed, signedClass,
} from "./insights-ui";

const EVENT_LABEL: Record<string, string> = {
  earnings: "Earnings", "ex-dividend": "Ex-dividend", dividend: "Dividend pay",
};


export function InsightsTab({
  portfolioId, positions, quotes, marketValue,
}: {
  portfolioId: string;
  positions: TickerPosition[];
  quotes: Record<string, StockQuote | null>;
  /**
   * Position market value in the display currency, or null when
   * unpriced. Portfolio weights have to be computed from a single
   * currency; `shares * quote.c` mixes whatever venues the holdings
   * happen to sit on.
   */
  marketValue: (symbol: string, shares: number) => number | null;
}) {
  const router = useRouter();

  // Stable scalar dep: only re-fetch when the SET of symbols changes, not on
  // every quote tick (positions memo gets a new identity each Firestore/quote
  // round-trip — the documented effect-loop trap). See p/[id]/page.tsx.
  const symbolKey = useMemo(
    () => positions.map((p) => p.symbol).sort().join(","),
    [positions],
  );

  // One result object tagged with the symbol set it was fetched for. Loading
  // and the two degraded flags are then derived rather than stored, which
  // keeps setState out of the effect body (cascading-render lint rule) and
  // means a symbol-set change can't briefly show the previous set's data.
  const [data, setData] = useState<{
    key: string;
    insights: Record<string, StockInsight | null>;
    spreads: Record<string, AnalystSpread | null>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const syms = symbolKey ? symbolKey.split(",") : [];
    if (syms.length === 0) return; // nothing to fetch; handled by `loaded` below
    // Map each cleaned symbol to its Yahoo-compatible symbol via the lots.
    const yahooFor = (sym: string) => {
      const pos = positions.find((p) => p.symbol === sym);
      return pos?.lots.find((l) => l.yahooSymbol)?.yahooSymbol ?? sym;
    };
    const apiSymbols = syms.map(yahooFor);
    Promise.all([
      getStockInsights(apiSymbols).catch(() => ({} as Record<string, StockInsight | null>)),
      getAnalystSpreads(apiSymbols).catch(() => ({} as Record<string, AnalystSpread | null>)),
    ])
      .then(([insMap, sprMap]) => {
        if (cancelled) return;
        const rekeyedIns: Record<string, StockInsight | null> = {};
        const rekeyedSpr: Record<string, AnalystSpread | null> = {};
        syms.forEach((s, i) => {
          rekeyedIns[s] = insMap[apiSymbols[i]] ?? null;
          rekeyedSpr[s] = sprMap[apiSymbols[i]] ?? null;
        });
        setData({ key: symbolKey, insights: rekeyedIns, spreads: rekeyedSpr });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scalar dep on purpose
  }, [symbolKey]);

  // Memoized so the empty-portfolio branch doesn't mint a new object identity
  // on every render and retrigger every downstream memo.
  const loaded = useMemo(
    () => (symbolKey === ""
      ? { key: "", insights: {}, spreads: {} }
      : data?.key === symbolKey ? data : null),
    [symbolKey, data],
  );
  const loading = loaded === null;
  const insights = loaded?.insights ?? null;
  const spreads = useMemo(() => loaded?.spreads ?? {}, [loaded]);

  // Two flags, not one: dates only ever come from Yahoo, but the analyst card
  // survives a dead crumb handshake as long as Finnhub answered.
  const { datesDegraded, ratingsDegraded } = useMemo(() => {
    const syms = symbolKey ? symbolKey.split(",") : [];
    if (!loaded || syms.length === 0) return { datesDegraded: false, ratingsDegraded: false };
    const noYahoo = syms.every((s) => loaded.insights[s] == null); // crumb path failed
    return {
      datesDegraded: noYahoo,
      ratingsDegraded: noYahoo && syms.every((s) => loaded.spreads[s] == null),
    };
  }, [loaded, symbolKey]);

  const todayISO = new Date().toISOString().split("T")[0];

  // Derive prices, weights, and mover rows from positions + live quotes.
  const { priceBySymbol, weightBySymbol, moverRows } = useMemo(() => {
    let totalMarket = 0;
    for (const p of positions) {
      totalMarket += marketValue(p.symbol, p.shares) ?? 0;
    }
    const price: Record<string, number | undefined> = {};
    const weight: Record<string, number> = {};
    const rows: Array<{ symbol: string; dailyPct: number; returnPct: number }> = [];
    for (const p of positions) {
      const q = quotes[p.symbol];
      // Deliberately the NATIVE quote price: it's only compared against
      // Yahoo's analyst target, which is quoted in the same listing
      // currency. Converting one side and not the other would be worse
      // than leaving both alone.
      price[p.symbol] = q?.c;
      const market = marketValue(p.symbol, p.shares);
      weight[p.symbol] =
        market !== null && totalMarket > 0 ? market / totalMarket : 0;
      if (q && market !== null && p.cost > 0) {
        rows.push({
          symbol: p.symbol,
          dailyPct: q.dp,
          // Both sides in the display currency — `p.cost` comes from the
          // converted pool, so comparing it to a native quote would read
          // the FX difference as return.
          returnPct: ((market - p.cost) / p.cost) * 100,
        });
      }
    }
    return { priceBySymbol: price, weightBySymbol: weight, moverRows: rows };
  }, [positions, quotes, marketValue]);

  const upcoming = useMemo(
    () => (insights ? buildUpcomingDates(insights, todayISO).slice(0, 8) : []),
    [insights, todayISO],
  );
  const ratings = useMemo(
    () => (insights ? buildAnalystRatings(insights, priceBySymbol, weightBySymbol, spreads) : []),
    [insights, priceBySymbol, weightBySymbol, spreads],
  );
  const movers = useMemo(() => topMovers(moverRows), [moverRows]);

  const go = (sym: string) => router.push(`/p/${portfolioId}/${sym}`);
  const rowProps = (sym: string) => ({
    onClick: () => go(sym),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") go(sym); },
    role: "button" as const,
    tabIndex: 0,
    className:
      "flex items-center gap-3 px-1 py-2 rounded-md cursor-pointer hover:bg-bg-3 " +
      "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  });

  return (
    <div className="space-y-4 animate-fade-up">
      {/* 1. Upcoming dates */}
      <section className="card p-4 md:p-5">
        <h3 className="label mb-3">Upcoming dates</h3>
        {loading ? (
          <SkeletonRows />
        ) : datesDegraded ? (
          <Unavailable />
        ) : upcoming.length === 0 ? (
          <Empty>No upcoming events.</Empty>
        ) : (
          <div className="divide-y divide-line">
            {upcoming.map((e) => (
              <div key={`${e.symbol}-${e.kind}-${e.date}`} {...rowProps(e.symbol)}>
                <span className="font-semibold">{e.symbol}</span>
                <span className="text-fg-fade text-sm flex-1">{EVENT_LABEL[e.kind]}</span>
                <span className="num text-sm text-fg-dim">{e.date}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Analyst ratings */}
      <section className="card p-4 md:p-5">
        <h3 className="label mb-3">Analyst ratings</h3>
        {loading ? (
          <SkeletonRows />
        ) : ratingsDegraded ? (
          <Unavailable />
        ) : ratings.length === 0 ? (
          <Empty>No analyst coverage.</Empty>
        ) : (
          <div className="divide-y divide-line">
            {ratings.map((r) => (
              <div key={r.symbol} {...rowProps(r.symbol)}>
                <span className="font-semibold w-16">{r.symbol}</span>
                {/* Fixed pill column so every bar starts at the same x — a
                    fixed-width track that floats left/right with the pill's
                    label length can't be read as a column. */}
                <span className="w-[92px] shrink-0">
                  <RatingPill ratingKey={r.ratingKey} label={r.ratingLabel} />
                </span>
                {r.spread && <AnalystSpreadBar spread={r.spread} compact />}
                {r.analystCount !== undefined && r.analystCount > 0 && (
                  <span className="num text-xs text-fg-fade w-6 text-right shrink-0">
                    {r.analystCount}
                  </span>
                )}
                <span className="flex-1" />
                <div className="text-right">
                  {r.target !== undefined && (
                    <div className="num text-sm text-fg-dim">Target ${fmtMoney(r.target)}</div>
                  )}
                  {r.upsidePct !== undefined && (
                    <div className={`num text-sm ${signedClass(r.upsidePct)}`}>
                      {signed(r.upsidePct)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Top movers */}
      <MoversCard movers={movers} onPick={go} />
    </div>
  );
}

function MoversCard({ movers, onPick }: { movers: { today: Movers; sincePurchase: Movers }; onPick: (s: string) => void }) {
  const [metric, setMetric] = useState<"today" | "sincePurchase">("today");
  const m = movers[metric];
  const empty = m.gainers.length === 0 && m.losers.length === 0;
  return (
    <section className="card p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="label">Top movers</h3>
        <div className="flex rounded-md border border-line overflow-hidden text-xs">
          {(["today", "sincePurchase"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setMetric(k)}
              className={`px-2.5 py-1 transition-colors ${metric === k ? "bg-bg-3 text-fg" : "text-fg-fade hover:text-fg-dim"}`}
            >
              {k === "today" ? "Today" : "Since purchase"}
            </button>
          ))}
        </div>
      </div>
      {empty ? (
        <Empty>Not enough priced positions yet.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <MoverList title="Gainers" rows={m.gainers} tone="text-pos" onPick={onPick} />
          <MoverList title="Losers" rows={m.losers} tone="text-neg" onPick={onPick} />
        </div>
      )}
    </section>
  );
}

function MoverList({ title, rows, tone, onPick }: { title: string; rows: Movers["gainers"]; tone: string; onPick: (s: string) => void }) {
  return (
    <div>
      <div className="text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade mb-1">{title}</div>
      {rows.length === 0 ? (
        <div className="text-fg-fade text-sm py-1">—</div>
      ) : (
        rows.map((r) => (
          <button
            key={r.symbol}
            onClick={() => onPick(r.symbol)}
            className="flex w-full items-center justify-between px-1 py-1.5 rounded-md cursor-pointer hover:bg-bg-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="font-semibold">{r.symbol}</span>
            <span className={`num text-sm ${tone}`}>{signed(r.pct)}</span>
          </button>
        ))
      )}
    </div>
  );
}

