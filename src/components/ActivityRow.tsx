"use client";

import { ArrowDown, ArrowRight, ArrowUp, Percent } from "lucide-react";
import { InitialChip } from "./InitialChip";
import type { ActivityEvent } from "@/lib/activity-types";

type VerbDescriptor = {
  Icon: React.ComponentType<{
    className?: string;
    "aria-hidden"?: boolean;
    strokeWidth?: number;
  }>;
  bg: string;
};

const VERB: Record<ActivityEvent["kind"], VerbDescriptor> = {
  buy: { Icon: ArrowUp, bg: "bg-pos" },
  sell: { Icon: ArrowDown, bg: "bg-neg" },
  "allocation-change": { Icon: Percent, bg: "bg-[#06b6d4]" },
};

export function ActivityRow({
  event,
  actorDisplayName,
  portfolioName,
  relativeTime,
}: {
  event: ActivityEvent;
  actorDisplayName?: string;
  portfolioName: string;
  relativeTime: string;
}) {
  const verb = VERB[event.kind];
  const VerbIcon = verb.Icon;
  return (
    <div className="flex items-start gap-3 py-3 border-b border-line last:border-b-0">
      <div className="relative shrink-0">
        <InitialChip
          uid={event.actorUid}
          displayName={actorDisplayName}
          size={30}
        />
        <span
          className={`absolute -right-0.5 -bottom-0.5 w-4 h-4 rounded-full inline-flex items-center justify-center text-white border-2 border-bg ${verb.bg}`}
          aria-hidden
        >
          <VerbIcon className="w-2.5 h-2.5" strokeWidth={3} />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] text-fg leading-tight">
          {renderLine1(event, actorDisplayName)}
        </div>
        <div className="text-xs text-fg-mid mt-0.5">
          {renderLine2(event, portfolioName)}
        </div>
      </div>
      <div className="text-[11.5px] text-fg-fade font-medium tabular-nums shrink-0">
        {relativeTime}
      </div>
    </div>
  );
}

function renderLine1(
  event: ActivityEvent,
  name: string | undefined,
): React.ReactNode {
  const actor = name ?? "Someone";
  switch (event.kind) {
    case "buy":
      return (
        <>
          <strong>{actor}</strong> bought <strong>{event.symbol}</strong>
        </>
      );
    case "sell":
      return (
        <>
          <strong>{actor}</strong> sold <strong>{event.symbol}</strong>
        </>
      );
    case "allocation-change":
      return (
        <>
          <strong>{actor}</strong> trimmed <strong>{event.symbol}</strong>
        </>
      );
  }
}

function renderLine2(
  event: ActivityEvent,
  portfolioName: string,
): React.ReactNode {
  switch (event.kind) {
    case "buy":
      return event.afterAllocationPct != null ? (
        <>
          {portfolioName} · now{" "}
          <strong>{event.afterAllocationPct.toFixed(1)}%</strong> of port.
        </>
      ) : (
        <>{portfolioName}</>
      );
    case "sell": {
      // Full exit. Realized % shown when present.
      const realized =
        event.realizedPct != null ? (
          <>
            {" · "}
            <span
              className={
                event.realizedPct >= 0 ? "text-pos" : "text-neg"
              }
            >
              {event.realizedPct >= 0 ? "+" : ""}
              {event.realizedPct.toFixed(1)}% realized
            </span>
          </>
        ) : null;
      return (
        <>
          {portfolioName} · full exit
          {realized}
        </>
      );
    }
    case "allocation-change": {
      // Partial sell — render "was X% → Y%". Realized % shown when present.
      const realized =
        event.realizedPct != null ? (
          <>
            {" · "}
            <span
              className={
                event.realizedPct >= 0 ? "text-pos" : "text-neg"
              }
            >
              {event.realizedPct >= 0 ? "+" : ""}
              {event.realizedPct.toFixed(1)}% realized
            </span>
          </>
        ) : null;
      return (
        <>
          was {event.beforeAllocationPct?.toFixed(0)}%{" "}
          <ArrowRight
            className="inline w-3 h-3 align-middle text-fg-fade"
            aria-hidden
          />{" "}
          {event.afterAllocationPct?.toFixed(0)}%
          {realized}
        </>
      );
    }
  }
}
