/**
 * Presentation shared by the portfolio Insights tab and the ticker-page
 * insights card: the rating pill, the analyst spread bar, and the three
 * placeholder states. One implementation each, so the two surfaces can't
 * drift apart.
 */

import { ratingTone, spreadSegments, type AnalystSpread, type SpreadKey } from "@/lib/insights";

const TONE_CLASS: Record<string, string> = {
  pos: "text-pos bg-pos/10", neutral: "text-fg-dim bg-bg-3",
  neg: "text-neg bg-neg/10", fade: "text-fg-fade bg-bg-3",
};

/** Solid ends, tints in between. Text color is picked per fill so both
 *  themes clear 4.5:1 — `text-fg` reads on a tint (which stays near the
 *  background luminance), `text-bg` reads on a saturated fill. */
const SEG_CLASS: Record<SpreadKey, string> = {
  strongBuy: "bg-pos text-bg",
  buy: "bg-pos/45 text-fg",
  // Not `bg-bg-3` — against the card it's near-invisible and the segment
  // reads as a gap in the bar. A neutral tint of the foreground stays
  // legible in both themes without implying a direction.
  hold: "bg-fg/20 text-fg",
  sell: "bg-neg/45 text-fg",
  strongSell: "bg-neg text-bg",
};

const SEG_LABEL: Record<SpreadKey, string> = {
  strongBuy: "Strong buy", buy: "Buy", hold: "Hold",
  sell: "Sell", strongSell: "Strong sell",
};
const SEG_LABEL_SHORT: Record<SpreadKey, string> = {
  strongBuy: "Str buy", buy: "Buy", hold: "Hold",
  sell: "Sell", strongSell: "Str sell",
};

export function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Below this a percent rounds to 0.0 and is treated as flat, so the sign and
 *  the color agree with the digits actually on screen. */
const FLAT_PCT = 0.05;

/** Signed percent to one decimal. Anything that rounds to zero is shown as
 *  `+0.0%` — a target a hair under the price would otherwise render the
 *  jarring `−0.0%`. */
export function signed(n: number): string {
  const v = Math.abs(n) < FLAT_PCT ? 0 : n;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

/** Color token matching what `signed` prints — never red on a `+0.0%`. */
export function signedClass(n: number): string {
  return Math.abs(n) < FLAT_PCT || n >= 0 ? "text-pos" : "text-neg";
}

export function RatingPill({ ratingKey, label }: { ratingKey?: string; label: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${TONE_CLASS[ratingTone(ratingKey)]}`}>
      {label}
    </span>
  );
}

/**
 * Analyst spread as a fixed-width stacked bar. The track is always the same
 * width, so segment widths encode the *distribution* and never the number of
 * analysts — two rows are directly comparable as shapes, and the analyst
 * total is shown separately by the caller. Buckets at zero are dropped
 * rather than drawn as slivers, and a segment too narrow for its own count
 * goes bare (the full breakdown is in the tooltip / aria-label).
 */
export function AnalystSpreadBar({
  spread, compact = false,
}: {
  spread: AnalystSpread;
  compact?: boolean;
}) {
  const segments = spreadSegments(spread);
  if (segments.length === 0) return null;
  const breakdown = segments.map((s) => `${SEG_LABEL[s.key]}: ${s.count}`).join(" · ");

  return (
    // Below `sm` the compact bar would be a few pixels per segment next to a
    // pill and a price target, so it drops out and the count carries the row.
    <div className={compact ? "hidden sm:block w-[140px] shrink-0" : "w-full"}>
      <div
        className={`flex overflow-hidden rounded-sm ${compact ? "h-4" : "h-7"}`}
        role="img"
        aria-label={`Analyst ratings — ${breakdown}`}
        title={breakdown}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${s.pct}%` }}
            className={`flex items-center justify-center ${SEG_CLASS[s.key]}`}
          >
            {s.showLabel && (
              <span className={`num font-semibold leading-none ${compact ? "text-[9.5px]" : "text-xs"}`}>
                {s.count}
              </span>
            )}
          </div>
        ))}
      </div>
      {!compact && (
        <div className="flex mt-1" aria-hidden>
          {segments.map((s) => (
            <div key={s.key} style={{ width: `${s.pct}%` }} className="text-center px-0.5">
              {s.showLabel && (
                <span className="text-[10px] text-fg-fade tracking-tight">
                  {SEG_LABEL_SHORT[s.key]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkeletonRows() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-6 rounded bg-bg-3 animate-pulse motion-reduce:animate-none" />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-fg-dim text-sm py-2">{children}</p>;
}

export function Unavailable() {
  return <p className="text-fg-fade text-sm py-2">Market data unavailable right now.</p>;
}
