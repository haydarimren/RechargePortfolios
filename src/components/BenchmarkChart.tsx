"use client";

import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "@/lib/theme";
import type { SeriesPoint } from "@/lib/portfolio";
import { fmtMoney } from "@/lib/format";

/**
 * The portfolio-vs-hypothetical-SPY/QQQ chart. Owner variant plots dollars;
 * viewer variant plots normalized % (pass `normalizeSeries` output and
 * isOwner=false). SPY is dashed and QQQ dotted so the two benchmarks stay
 * distinguishable without color (they are ~ΔE 6 apart under protanopia).
 */
export function BenchmarkChart({
  data,
  isOwner,
  height,
}: {
  data: SeriesPoint[];
  isOwner: boolean;
  height: number;
}) {
  const chartColors = useChartColors();
  const gradId = useId();

  const tickFormatter = useMemo(() => {
    const spanMs =
      data.length > 1
        ? new Date(data[data.length - 1].date).getTime() -
          new Date(data[0].date).getTime()
        : 0;
    const spanDays = spanMs / 86_400_000;
    return (d: string) => {
      const date = new Date(d);
      if (spanDays <= 180) {
        return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
      if (spanDays <= 365 * 2) {
        return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      }
      return date.toLocaleDateString("en-US", { year: "numeric" });
    };
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartColors.portfolio} stopOpacity={0.25} />
            <stop offset="100%" stopColor={chartColors.portfolio} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
        <XAxis
          dataKey="date"
          stroke={chartColors.axis}
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: chartColors.grid }}
          minTickGap={50}
          tickFormatter={tickFormatter}
        />
        <YAxis
          stroke={chartColors.axis}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) =>
            isOwner
              ? v >= 1000
                ? `$${(v / 1000).toFixed(0)}k`
                : `$${v.toFixed(0)}`
              : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`
          }
        />
        <Tooltip
          contentStyle={{
            backgroundColor: chartColors.tooltipBg,
            borderColor: chartColors.tooltipBorder,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: chartColors.tooltipLabel, fontSize: 11 }}
          itemStyle={{ color: chartColors.tooltipText }}
          formatter={(v) =>
            typeof v === "number"
              ? isOwner
                ? fmtMoney(v)
                : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
              : String(v)
          }
        />
        <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12, color: chartColors.axis }} />
        <Area
          name="Portfolio"
          type="monotone"
          dataKey="portfolio"
          stroke={chartColors.portfolio}
          strokeWidth={2}
          fill={`url(#${gradId})`}
        />
        <Area
          name="Hypothetical SPY"
          type="monotone"
          dataKey="SPY"
          stroke={chartColors.benchmark}
          strokeWidth={1.5}
          strokeDasharray="5 4"
          fill="transparent"
        />
        <Area
          name="Hypothetical QQQ"
          type="monotone"
          dataKey="QQQ"
          stroke={chartColors.benchmark2}
          strokeWidth={1.5}
          strokeDasharray="1.5 3.5"
          strokeLinecap="round"
          fill="transparent"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
