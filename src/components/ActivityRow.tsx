"use client";

import { InitialChip } from "./InitialChip";
import type { ActivityEvent } from "@/lib/activity-types";

const VERB: Record<ActivityEvent["kind"], { glyph: string; bg: string }> = {
  "buy":               { glyph: "↑", bg: "bg-pos" },
  "sell":              { glyph: "↓", bg: "bg-neg" },
  "share":             { glyph: "↗", bg: "bg-accent" },
  "rename":            { glyph: "✎", bg: "bg-[#a855f7]" },
  "milestone":         { glyph: "★", bg: "bg-[#f59e0b]" },
  "allocation-change": { glyph: "%", bg: "bg-[#06b6d4]" },
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
  return (
    <div className="flex items-start gap-3 py-3 border-b border-line last:border-b-0">
      <div className="relative shrink-0">
        <InitialChip uid={event.actorUid} displayName={actorDisplayName} size={30} />
        <span
          className={`absolute -right-0.5 -bottom-0.5 w-4 h-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold text-white border-2 border-bg ${verb.bg}`}
          aria-hidden
        >
          {verb.glyph}
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

function renderLine1(event: ActivityEvent, name: string | undefined): React.ReactNode {
  const actor = name ?? "Someone";
  switch (event.kind) {
    case "buy":  return <><strong>{actor}</strong> bought <strong>{event.symbol}</strong></>;
    case "sell": return <><strong>{actor}</strong> sold <strong>{event.symbol}</strong></>;
    case "share":return <><strong>{actor}</strong> shared a portfolio</>;
    case "rename":return <><strong>{actor}</strong> renamed a portfolio</>;
    case "milestone": return <><strong>{actor}</strong> hit a milestone</>;
    case "allocation-change": return <><strong>{actor}</strong> rebalanced <strong>{event.symbol}</strong></>;
  }
}

function renderLine2(event: ActivityEvent, portfolioName: string): React.ReactNode {
  switch (event.kind) {
    case "buy":
    case "sell":
      return event.afterAllocationPct != null
        ? <>{portfolioName} · now <strong>{event.afterAllocationPct.toFixed(1)}%</strong> of port.</>
        : <>{portfolioName}</>;
    case "rename":
      return <>"{event.newName}"</>;
    case "share":
      return <>{portfolioName}</>;
    case "milestone":
      return event.positionGainPctSnapshot != null
        ? <>+{event.positionGainPctSnapshot.toFixed(1)}% · {portfolioName}</>
        : <>{portfolioName}</>;
    case "allocation-change":
      return <>was {event.beforeAllocationPct?.toFixed(0)}% → {event.afterAllocationPct?.toFixed(0)}%</>;
  }
}
