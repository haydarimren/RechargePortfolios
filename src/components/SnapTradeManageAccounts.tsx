"use client";

/**
 * Add/remove SnapTrade accounts on an already-connected portfolio,
 * without disconnecting. Works on the STORED credential (decrypted by
 * the parent) — no re-pasting keys.
 *
 * The component owns selection UI only. The parent applies the change
 * in the spec's load-bearing order: credential write FIRST, then lot
 * deletion, then a chained sync (see the multi-account design doc for
 * why this ordering makes interrupted runs fail safe rather than
 * silently re-importing a removed account).
 */

import { useEffect, useMemo, useState } from "react";
import {
  listSnapTradeAccounts,
  type SnapTradeAccountSummary,
} from "@/lib/brokers/snaptrade/sync";

export interface ManageAccountsResult {
  /** The full new selection (≥ 1). */
  newAccountIds: string[];
  /** (C_old ∪ L) − newSet — accounts whose lots must be deleted. */
  removedAccountIds: string[];
}

interface Row {
  id: string;
  label: string;
  sub?: string;
  /** In C/L but no longer present at SnapTrade — can only be removed. */
  stale: boolean;
  /** Contributes lots (∈ L). */
  hasData: boolean;
}

export function SnapTradeManageAccounts({
  credentialJson,
  currentAccountIds,
  holdingsAccountIds,
  countLotsFor,
  busy,
  onApply,
  onClose,
}: {
  /** Decrypted stored credential (parent-supplied). */
  credentialJson: string;
  /** C — the credential's current account set. */
  currentAccountIds: string[];
  /** L — accounts contributing lots to holdings. */
  holdingsAccountIds: string[];
  /** Lot count across the given account ids — for the confirm copy. */
  countLotsFor: (accountIds: string[]) => number;
  busy: boolean;
  onApply: (result: ManageAccountsResult) => Promise<void>;
  onClose: () => void;
}) {
  const [live, setLive] = useState<SnapTradeAccountSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentAccountIds),
  );
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listSnapTradeAccounts(credentialJson)
      .then((accounts) => {
        if (!cancelled) setLive(accounts);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load accounts",
          );
          setLive([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [credentialJson]);

  // Rows = live accounts ∪ C ∪ L. Accounts only in C/L (no longer at
  // SnapTrade) render as stale; accounts only in L (orphaned tags from
  // an interrupted earlier run) surface here so unchecking heals them.
  const rows = useMemo<Row[]>(() => {
    if (live === null) return [];
    const liveById = new Map(live.map((a) => [a.id, a]));
    const known = new Set([
      ...live.map((a) => a.id),
      ...currentAccountIds,
      ...holdingsAccountIds,
    ]);
    return Array.from(known).map((id) => {
      const a = liveById.get(id);
      return {
        id,
        label: a ? a.name : `${id.slice(0, 8)}…`,
        sub: a?.brokerage && a.brokerage !== a.name ? a.brokerage : undefined,
        stale: !a,
        hasData: holdingsAccountIds.includes(id),
      };
    });
  }, [live, currentAccountIds, holdingsAccountIds]);

  const toggle = (id: string, stale: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (!stale) next.add(id); // stale accounts can only be removed
      return next;
    });
  };

  const handleApply = async () => {
    setError("");
    if (selected.size === 0) {
      setError(
        "At least one account must stay selected — use Disconnect to remove the broker entirely.",
      );
      return;
    }
    const removed = Array.from(
      new Set([...currentAccountIds, ...holdingsAccountIds]),
    ).filter((id) => !selected.has(id));
    const added = Array.from(selected).filter(
      (id) => !currentAccountIds.includes(id),
    );
    if (removed.length === 0 && added.length === 0) {
      onClose(); // no changes
      return;
    }
    if (removed.length > 0) {
      const lots = countLotsFor(removed);
      const labels = rows
        .filter((r) => removed.includes(r.id))
        .map((r) => r.label)
        .join(", ");
      if (
        !confirm(
          `Removing ${labels} deletes ${lots} imported lot${lots === 1 ? "" : "s"} and their trade history from this portfolio. Continue?`,
        )
      ) {
        return;
      }
    }
    try {
      await onApply({
        newAccountIds: Array.from(selected),
        removedAccountIds: removed,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't update accounts",
      );
    }
  };

  if (live === null) {
    return (
      <div className="text-sm text-fg-dim text-center py-6">
        Loading your SnapTrade accounts…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-sm text-fg-dim">
        Choose which SnapTrade accounts feed this portfolio:
      </div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            <label
              className={`flex items-center gap-2 bg-bg-3 border border-line rounded-lg px-3 py-2.5 ${
                r.stale ? "opacity-70" : "cursor-pointer hover:border-accent transition"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => toggle(r.id, r.stale)}
                disabled={busy}
              />
              <span className="text-sm flex-1">
                <span className="font-medium">{r.label}</span>
                {r.sub && <span className="text-fg-fade ml-1">· {r.sub}</span>}
                {r.stale && (
                  <span className="text-xs text-neg ml-1">
                    (no longer available at SnapTrade)
                  </span>
                )}
                {r.hasData && (
                  <span className="text-xs text-fg-fade ml-1">
                    (has imported data)
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <div className="border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-2.5">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="btn-ghost px-3 py-2 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleApply()}
          disabled={busy || selected.size === 0}
          className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
        >
          {busy ? "Applying…" : "Apply & Sync"}
        </button>
      </div>
    </div>
  );
}
