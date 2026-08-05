"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, TrendingDown, TrendingUp } from "lucide-react";
import type { Movers, UpcomingDate } from "@/lib/insights";

const EVENT_LABEL: Record<UpcomingDate["kind"], string> = {
  earnings: "Earnings",
  "ex-dividend": "Ex-dividend",
  dividend: "Dividend pay",
};

const ROTATE_MS = 6000;

/** Fades the chip row's right edge instead of hard-clipping a chip. */
const FADE_MASK: React.CSSProperties = {
  maskImage: "linear-gradient(90deg, #000 88%, transparent)",
  WebkitMaskImage: "linear-gradient(90deg, #000 88%, transparent)",
};

export function InsightsBand({
  movers,
  upcoming,
  onPickSymbol,
  className = "",
}: {
  movers: Movers;
  upcoming: UpcomingDate[];
  onPickSymbol: (symbol: string) => void;
  className?: string;
}) {
  const views = useMemo(() => {
    const out: Array<"movers" | "upcoming"> = [];
    if (movers.gainers.length > 0 || movers.losers.length > 0) out.push("movers");
    if (upcoming.length > 0) out.push("upcoming");
    return out;
  }, [movers, upcoming]);

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedRef = useRef(false);

  useEffect(() => {
    reducedRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }, []);

  useEffect(() => {
    if (views.length < 2 || paused || reducedRef.current) return;
    const t = setInterval(
      () => setIdx((i) => (i + 1) % views.length),
      ROTATE_MS,
    );
    return () => clearInterval(t);
  }, [views.length, paused]);

  if (views.length === 0) return null;
  const active = views[Math.min(idx, views.length - 1)];

  const chip = (key: string, icon: React.ReactNode, body: React.ReactNode, symbol: string) => (
    <button
      key={key}
      type="button"
      onClick={() => onPickSymbol(symbol)}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-bg px-2.5 py-1 text-[12.5px] hover:border-accent transition"
    >
      {icon}
      {body}
    </button>
  );

  return (
    <section
      aria-label="Portfolio insights"
      className={`relative h-[52px] overflow-hidden rounded-xl border border-line bg-bg-2 ${className}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {(["movers", "upcoming"] as const).map((view) => {
        const on = view === active;
        return (
          <div
            key={view}
            aria-hidden={!on}
            className={`absolute inset-0 flex items-center gap-3.5 px-4 pr-9 transition-all duration-300 ${
              on
                ? "opacity-100 translate-y-0"
                : "pointer-events-none opacity-0 translate-y-2"
            }`}
          >
            <span className="label w-[104px] shrink-0">
              {view === "movers" ? "Today's movers" : "Upcoming"}
            </span>
            <div
              className="flex flex-1 items-center gap-2.5 overflow-hidden"
              style={FADE_MASK}
            >
              {view === "movers"
                ? [...movers.gainers, ...movers.losers].map((m) =>
                    chip(
                      `m-${m.symbol}`,
                      m.pct >= 0 ? (
                        <TrendingUp className="w-3.5 h-3.5 text-pos" aria-hidden />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5 text-neg" aria-hidden />
                      ),
                      <>
                        <span className="font-semibold text-fg">{m.symbol}</span>
                        <span
                          className={`num font-semibold ${m.pct >= 0 ? "text-pos" : "text-neg"}`}
                        >
                          {m.pct >= 0 ? "+" : ""}
                          {m.pct.toFixed(1)}%
                        </span>
                      </>,
                      m.symbol,
                    ),
                  )
                : upcoming.map((e) =>
                    chip(
                      `u-${e.symbol}-${e.kind}-${e.date}`,
                      <CalendarDays className="w-3.5 h-3.5 text-fg-fade" aria-hidden />,
                      <>
                        <span className="font-semibold text-fg">{e.symbol}</span>
                        <span className="text-fg-mid">{EVENT_LABEL[e.kind]}</span>
                        <span className="num text-fg-dim">{e.date}</span>
                      </>,
                      e.symbol,
                    ),
                  )}
            </div>
          </div>
        );
      })}
      {views.length > 1 && (
        <div className="absolute right-3.5 top-1/2 flex -translate-y-1/2 gap-1.5">
          {views.map((view, i) => (
            <button
              key={view}
              type="button"
              aria-label={view === "movers" ? "Show today's movers" : "Show upcoming dates"}
              aria-pressed={view === active}
              onClick={() => setIdx(i)}
              className={`h-[7px] w-[7px] rounded-full transition ${
                view === active ? "bg-accent" : "bg-line-strong hover:bg-fg-fade"
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
