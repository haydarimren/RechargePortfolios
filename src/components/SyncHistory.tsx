// src/components/SyncHistory.tsx
"use client";

import { useEffect, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { decryptJson } from "@/lib/crypto-client";
import type { SnapTradeDiagnostics } from "@/lib/brokers/types";

interface SyncLogPayload {
  timestamp: number;
  imported: number;
  buys: number;
  sells: number;
  skipped: number;
  errors: string[];
  diagnostics?: SnapTradeDiagnostics | null;
}

interface DecodedLog {
  id: string;
  createdAt: number;
  body: SyncLogPayload | null; // null = couldn't decrypt with this key
}

const MAX_LOGS = 5;

/**
 * Read-only view over the encrypted `syncLogs` subcollection. Visible to
 * the owner AND shared viewers (the Firestore rule is relaxed to
 * owner-or-sharedWith) so a collaborator debugging a sync can read the
 * redacted SnapTrade decision trace in-app — no download, no server logs.
 * The doc body is decrypted client-side under the portfolio key.
 */
export function SyncHistory({
  portfolioId,
  portfolioKey,
  isOwner,
}: {
  portfolioId: string;
  portfolioKey: CryptoKey | null;
  // The redacted `diagnostics` trace is safe to show any viewer. The
  // sibling `errors` array is NOT — it can carry raw broker error
  // bodies (account/user ids, broker names). Render those to the owner
  // only; shared viewers see the redacted trace + counts only.
  isOwner: boolean;
}) {
  const [raw, setRaw] = useState<
    Array<{ id: string; payload: string; iv: string; createdAt: number }>
  >([]);
  const [logs, setLogs] = useState<DecodedLog[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, "portfolios", portfolioId, "syncLogs"),
      orderBy("createdAt", "desc"),
      limit(MAX_LOGS),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: Array<{
          id: string;
          payload: string;
          iv: string;
          createdAt: number;
        }> = [];
        for (const d of snap.docs) {
          const data = d.data();
          if (
            typeof data.payload === "string"
            && typeof data.iv === "string"
          ) {
            next.push({
              id: d.id,
              payload: data.payload,
              iv: data.iv,
              createdAt:
                typeof data.createdAt === "number" ? data.createdAt : 0,
            });
          }
        }
        setRaw(next);
      },
      // Read may be denied for shared viewers until the rule is relaxed;
      // fail quiet rather than throw in the UI.
      () => setRaw([]),
    );
    return () => unsub();
  }, [portfolioId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!portfolioKey) {
        if (!cancelled) setLogs(raw.map((r) => ({ id: r.id, createdAt: r.createdAt, body: null })));
        return;
      }
      const decoded = await Promise.all(
        raw.map(async (r) => {
          try {
            const body = await decryptJson<SyncLogPayload>(
              { payload: r.payload, iv: r.iv },
              portfolioKey,
            );
            return { id: r.id, createdAt: r.createdAt, body };
          } catch {
            return { id: r.id, createdAt: r.createdAt, body: null };
          }
        }),
      );
      if (!cancelled) setLogs(decoded);
    })();
    return () => {
      cancelled = true;
    };
    // `raw` is a fresh array each Firestore snapshot, but this is
    // loop-free: the subscription effect depends only on [portfolioId],
    // so a new `raw` re-decrypts (≤MAX_LOGS, cheap) without
    // re-subscribing, and `setLogs` never feeds back into `raw`. Do not
    // "optimize" this dep away — that would stale the decrypted view.
  }, [raw, portfolioKey]);

  if (logs.length === 0) return null;

  return (
    <div className="mt-3 border border-line rounded-lg bg-bg-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-fg-dim hover:text-fg transition"
      >
        <span className="label">Sync history</span>
        <span className="num text-xs text-fg-fade">
          {open ? "Hide" : `${logs.length} recent`}
        </span>
      </button>
      {open && (
        <div className="border-t border-line divide-y divide-line">
          {logs.map((l) => (
            <SyncLogRow key={l.id} log={l} isOwner={isOwner} />
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function SyncLogRow({
  log,
  isOwner,
}: {
  log: DecodedLog;
  isOwner: boolean;
}) {
  const b = log.body;
  if (!b) {
    return (
      <div className="px-4 py-3 text-xs text-fg-fade">
        <span className="num">{fmtTime(log.createdAt)}</span> — unlock the
        portfolio to read this entry.
      </div>
    );
  }
  const d = b.diagnostics;
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="num text-xs text-fg-dim">
          {fmtTime(b.timestamp || log.createdAt)}
        </span>
        <span className="num text-xs text-fg-fade">
          {b.buys} buys · {b.sells} sells · {b.skipped} existed
        </span>
      </div>

      {b.errors.length > 0 && (
        isOwner ? (
          <ul className="text-xs text-neg space-y-0.5">
            {b.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : (
          // Raw broker error strings may carry account/user ids — never
          // shown to shared viewers, only their count.
          <div className="text-xs text-neg">
            {b.errors.length} error{b.errors.length === 1 ? "" : "s"} (visible
            to the portfolio owner)
          </div>
        )
      )}

      {d && (
        <div className="space-y-2 text-xs">
          <div className="text-fg-fade num">
            raw: {d.rawOrderCount} orders · {d.rawPositionCount} positions ·
            kept {d.summary.ordersKept}o/{d.summary.positionsKept}p ·
            deduped {d.summary.ordersDeduped}o/{d.summary.positionsDeduped}p ·
            suppressed {d.summary.positionsSuppressed}p
          </div>

          {(() => {
            const mismatches = d.perSymbol.filter(
              (s) => s.ordersNetMatchesPositionUnits === false,
            );
            if (mismatches.length === 0) return null;
            return (
              <div className="text-neg num">
                orders≠position units:{" "}
                {mismatches.map((m) => m.symbolToken).join(", ")}
              </div>
            );
          })()}

          {d.orders.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full num text-[11px] text-fg-dim">
                <thead className="text-fg-fade label">
                  <tr>
                    <th className="text-left pr-3 py-1">sym</th>
                    <th className="text-left pr-3">action</th>
                    <th className="text-left pr-3">status</th>
                    <th className="text-left pr-3">qty±</th>
                    <th className="text-left pr-3">O/T/P/Q</th>
                    <th className="text-left">decision</th>
                  </tr>
                </thead>
                <tbody>
                  {d.orders.map((o, i) => (
                    <tr key={i}>
                      <td className="pr-3 py-0.5">{o.symbolToken ?? "—"}</td>
                      <td className="pr-3">{o.action ?? "—"}</td>
                      <td className="pr-3">{o.status ?? "—"}</td>
                      <td className="pr-3">{o.filledQtySign}</td>
                      <td className="pr-3">
                        {[
                          o.hasOrderId ? "O" : "·",
                          o.hasTimeExecuted ? "T" : "·",
                          o.hasExecutionPrice ? "P" : "·",
                          o.hasFilledQty ? "Q" : "·",
                        ].join("")}
                      </td>
                      <td
                        className={
                          o.decision === "skipped"
                            ? "text-neg"
                            : o.decision === "kept"
                              ? "text-pos"
                              : ""
                        }
                      >
                        {o.decision}
                        {o.skipReason ? ` (${o.skipReason})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {d.positions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full num text-[11px] text-fg-dim">
                <thead className="text-fg-fade label">
                  <tr>
                    <th className="text-left pr-3 py-1">sym</th>
                    <th className="text-left pr-3">units?</th>
                    <th className="text-left pr-3">price?</th>
                    <th className="text-left">decision</th>
                  </tr>
                </thead>
                <tbody>
                  {d.positions.map((p, i) => (
                    <tr key={i}>
                      <td className="pr-3 py-0.5">{p.symbolToken ?? "—"}</td>
                      <td className="pr-3">{p.hasUnits ? "y" : "n"}</td>
                      <td className="pr-3">{p.hasPrice ? "y" : "n"}</td>
                      <td
                        className={
                          p.decision === "skipped"
                            ? "text-neg"
                            : p.decision === "kept"
                              ? "text-pos"
                              : ""
                        }
                      >
                        {p.decision}
                        {p.skipReason ? ` (${p.skipReason})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
