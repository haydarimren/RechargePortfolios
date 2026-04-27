"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";

import { useChartColors } from "@/lib/theme";
import type { TickerPosition } from "@/lib/portfolio";
import type { StockQuote } from "@/lib/finnhub";

interface AllocationTreemapProps {
  positions: TickerPosition[];
  quotes: Record<string, StockQuote | null | undefined>;
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

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function AllocationTreemap({
  positions,
  quotes,
  totalMarket,
  isOwner,
  portfolioId,
}: AllocationTreemapProps) {
  const router = useRouter();
  const colors = useChartColors();

  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];
    for (const p of positions) {
      const q = quotes[p.symbol];
      if (!q) continue;
      const market = p.shares * q.c;
      if (market <= 0) continue;
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
  }, [positions, quotes, totalMarket]);

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
    const showLabel = width >= 64 && height >= 36;
    const showSub = width >= 96 && height >= 58;

    return (
      <g
        style={{ cursor: "pointer" }}
        onClick={() => router.push(`/portfolios/${portfolioId}/${symbol}`)}
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
            x={x + 12}
            y={y + 22}
            fill={colors.tileText}
            stroke="none"
            fontSize={13}
            fontWeight={600}
            letterSpacing="0.02em"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            {symbol}
          </text>
        )}
        {showSub && (
          <text
            x={x + 12}
            y={y + 40}
            stroke="none"
            fontSize={11}
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.01em",
            }}
          >
            <tspan fill={colors.tileTextDim}>
              {`${(allocationPct ?? 0).toFixed(1)}%`}
            </tspan>
            {gainPct !== null && gainPct !== undefined && (
              <tspan
                dx="8"
                fill={
                  gainPct >= 0 ? colors.tileGainText : colors.tileLossText
                }
              >
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
