"use client";

import { useMemo } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useChartColors } from "@/lib/theme";
import type { SeriesPoint } from "@/lib/portfolio";

const W = 108;
const H = 36;

/** Downsample + scale the portfolio series into an SVG polyline path. */
function buildPaths(data: SeriesPoint[]): { line: string; area: string } | null {
  const vals = data
    .map((p) => p.portfolio)
    .filter((v): v is number => typeof v === "number" && isFinite(v));
  if (vals.length < 2) return null;
  // Cap points so a 3-year series doesn't emit thousands of segments.
  const MAX = 60;
  const step = Math.max(1, Math.floor(vals.length / MAX));
  const pts = vals.filter((_, i) => i % step === 0 || i === vals.length - 1);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * (W - 6) + 3;
    const y = H - 4 - ((v - min) / span) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${coords.join("L")}`;
  const [lastX] = coords[coords.length - 1].split(",");
  const [firstX] = coords[0].split(",");
  const area = `${line}L${lastX},${H - 1}L${firstX},${H - 1}Z`;
  return { line, area };
}

export function SparklineButton({
  data,
  expanded,
  onToggle,
  className = "",
}: {
  data: SeriesPoint[];
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const colors = useChartColors();
  const paths = useMemo(() => buildPaths(data), [data]);
  if (!paths) return null;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? "Hide benchmark chart" : "Show benchmark chart"}
      className={`flex flex-col items-center gap-0.5 rounded-lg border border-transparent px-2 py-1.5 min-h-[44px] hover:border-line hover:bg-bg-2 transition ${className}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
        <path d={paths.area} fill={colors.portfolio} opacity={0.15} />
        <path
          d={paths.line}
          fill="none"
          stroke={colors.portfolio}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
      <span className="flex items-center gap-1 text-[10.5px] text-fg-fade">
        <Chevron className="w-3 h-3" aria-hidden /> chart
      </span>
    </button>
  );
}
