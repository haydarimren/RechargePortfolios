"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";

import { useChartColors } from "@/lib/theme";
import type { TickerPosition } from "@/lib/portfolio";
import { fmtMoney, fmtPct } from "@/lib/format";

interface AllocationTreemapProps {
  positions: TickerPosition[];
  /**
   * Market value of a position in the display currency, or null when it
   * has no quote. Passed in rather than derived from raw quotes here:
   * a portfolio can hold a London line quoted in GBP next to a Milan
   * line quoted in EUR, and `shares * quote.c` would size the tiles by
   * two different currencies at once.
   */
  marketValue: (symbol: string, shares: number) => number | null;
  totalMarket: number;
  isOwner: boolean;
  portfolioId: string;
}

interface Tile {
  symbol: string;
  value: number;
  market: number;
  cost: number;
  shares: number;
  gain: number;
  gainPct: number | null;
  allocationPct: number;
  // Recharts' TreemapDataType requires an index signature.
  [key: string]: unknown;
}

// % return at which color saturation maxes out. Anything beyond clamps so a
// single 800%-gain outlier doesn't squash the rest of the palette.
const SAT_RANGE = 25;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * WCAG relative luminance, used to pick ink that actually reads on a tile.
 * Tiles lerp from a *light* neutral toward a saturated endpoint, so anything
 * near break-even lands pale — a single white text color could not read on
 * both ends, which is what made the map hard to scan. Ink is chosen per tile.
 */
function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two luminances. */
function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * One ink per tile — whichever of black/white actually contrasts better with
 * this fill, rather than a hand-picked lightness threshold. Self-correcting
 * across both themes and any future palette change; the mid-tone sage and
 * clay tiles sit exactly where a guessed cutoff gets it wrong.
 *
 * The gain figure deliberately does NOT get its own green/red: the tile's
 * fill already encodes direction and magnitude, and a saturated hue on a
 * mid-tone fill cannot clear 4.5:1 no matter which one is chosen. Hierarchy
 * comes from size and weight instead.
 */
function inkFor(fill: string): string {
  const l = luminance(fill);
  return contrast(l, 1) >= contrast(l, 0) ? "#ffffff" : "#000000";
}

export function AllocationTreemap({
  positions,
  marketValue,
  totalMarket,
  isOwner,
  portfolioId,
}: AllocationTreemapProps) {
  const router = useRouter();
  const colors = useChartColors();

  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];
    for (const p of positions) {
      const market = marketValue(p.symbol, p.shares);
      if (market === null || market <= 0) continue;
      const gain = market - p.cost;
      const gainPct = p.cost > 0 ? (gain / p.cost) * 100 : null;
      const allocationPct =
        totalMarket > 0 ? (market / totalMarket) * 100 : 0;
      out.push({
        symbol: p.symbol,
        value: market,
        market,
        cost: p.cost,
        shares: p.shares,
        gain,
        gainPct,
        allocationPct,
      });
    }
    return out.sort((a, b) => b.market - a.market);
  }, [positions, marketValue, totalMarket]);

  function colorFor(gainPct: number | null): string {
    if (gainPct === null) return colors.tileNeutral;
    const clamped = Math.max(-SAT_RANGE, Math.min(SAT_RANGE, gainPct));
    const t = Math.abs(clamped) / SAT_RANGE;
    const endpoint = clamped >= 0 ? colors.tilePos : colors.tileNeg;
    return lerpHex(colors.tileNeutral, endpoint, t);
  }

  if (tiles.length === 0) {
    return (
      <div className="card p-10 text-center text-fg-dim text-sm">
        Allocation map will appear once live quotes load.
      </div>
    );
  }

  // Recharts passes the data fields as top-level props on the content render,
  // plus the layout-computed x/y/width/height/depth. Lib types aren't strict
  // here, so we keep this loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TileContent = (props: any) => {
    const {
      x,
      y,
      width,
      height,
      depth,
      symbol,
      gainPct,
      allocationPct,
    }: {
      x: number;
      y: number;
      width: number;
      height: number;
      depth: number;
      symbol?: string;
      gainPct?: number | null;
      allocationPct?: number;
    } = props;

    if (depth !== 1 || !symbol) return null;

    const fill = colorFor(gainPct ?? null);
    const ink = inkFor(fill);

    // Type scales with the tile so small slices still get a ticker instead of
    // rendering as anonymous colored blocks. The label only appears once it
    // actually fits: a symbol needs roughly 0.62em per character.
    const symbolSize = width >= 110 && height >= 56 ? 13 : width >= 70 ? 11 : 9.5;
    const pad = symbolSize >= 13 ? 12 : symbolSize >= 11 ? 8 : 5;
    const showLabel =
      width >= symbol.length * symbolSize * 0.62 + pad * 2 &&
      height >= symbolSize + pad * 2;
    // The sub-line needs a second row plus room for "100.0% +999.99%".
    const subSize = symbolSize >= 13 ? 11 : 9.5;
    const showSub =
      showLabel && width >= 88 && height >= symbolSize + subSize + pad * 2 + 8;

    return (
      <g
        style={{ cursor: "pointer" }}
        onClick={() => router.push(`/p/${portfolioId}/${symbol}`)}
      >
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={fill}
          stroke={colors.tileBorder}
          strokeWidth={2}
        />
        {showLabel && (
          <text
            x={x + pad}
            y={y + pad + symbolSize * 0.85}
            fill={ink}
            stroke="none"
            fontSize={symbolSize}
            fontWeight={600}
            letterSpacing="0.02em"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            {symbol}
          </text>
        )}
        {showSub && (
          <text
            x={x + pad}
            y={y + pad + symbolSize * 0.85 + subSize + 5}
            stroke="none"
            fontSize={subSize}
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.01em",
            }}
          >
            <tspan fill={ink} fillOpacity={0.88}>
              {`${(allocationPct ?? 0).toFixed(1)}%`}
            </tspan>
            {gainPct !== null && gainPct !== undefined && (
              <tspan dx="6" fill={ink} fillOpacity={0.88}>
                {fmtPct(gainPct)}
              </tspan>
            )}
          </text>
        )}
      </g>
    );
  };

  // Recharts Tooltip's `payload` for Treemap is an array with the active
  // cell's data spread under `payload`. We render entirely custom content.
  const TooltipContent = ({
    active,
    payload,
  }: {
    active?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any[];
  }) => {
    if (!active || !payload || payload.length === 0) return null;
    const t = (payload[0]?.payload ?? {}) as Partial<Tile>;
    if (!t.symbol) return null;

    const gainPct = t.gainPct ?? null;
    const gainColor =
      gainPct === null
        ? colors.tooltipLabel
        : gainPct >= 0
        ? colors.pos
        : colors.neg;

    return (
      <div
        className="px-3 py-2 rounded-md text-xs"
        style={{
          background: colors.tooltipBg,
          border: `1px solid ${colors.tooltipBorder}`,
          color: colors.tooltipText,
          minWidth: 200,
          fontFamily: "var(--font-sans)",
          boxShadow:
            "0 8px 24px -10px rgba(0,0,0,0.4), 0 2px 6px -2px rgba(0,0,0,0.2)",
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-semibold tracking-tight text-sm">
            {t.symbol}
          </span>
          <span className="num text-[11px]" style={{ color: gainColor }}>
            {gainPct === null ? "—" : fmtPct(gainPct)}
          </span>
        </div>
        <div
          className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 num text-[11px]"
          style={{ color: colors.tooltipLabel }}
        >
          <span>Allocation</span>
          <span
            className="text-right"
            style={{ color: colors.tooltipText }}
          >
            {(t.allocationPct ?? 0).toFixed(1)}%
          </span>
          {isOwner && (
            <>
              <span>Shares</span>
              <span
                className="text-right"
                style={{ color: colors.tooltipText }}
              >
                {(t.shares ?? 0).toLocaleString("en-US", {
                  maximumFractionDigits: 4,
                })}
              </span>
              <span>Market</span>
              <span
                className="text-right"
                style={{ color: colors.tooltipText }}
              >
                {fmtMoney(t.market ?? 0)}
              </span>
              <span>Gain</span>
              <span
                className="text-right"
                style={{
                  color:
                    (t.gain ?? 0) >= 0 ? colors.pos : colors.neg,
                }}
              >
                {`${(t.gain ?? 0) >= 0 ? "+" : ""}${fmtMoney(t.gain ?? 0)}`}
              </span>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="card overflow-hidden">
      <ResponsiveContainer width="100%" height={420}>
        <Treemap
          data={tiles}
          dataKey="value"
          nameKey="symbol"
          aspectRatio={16 / 9}
          isAnimationActive={false}
          content={<TileContent />}
        >
          <Tooltip
            content={<TooltipContent />}
            wrapperStyle={{ outline: "none" }}
          />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
