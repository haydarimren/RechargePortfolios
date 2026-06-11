"use client";

/**
 * SnapTrade BYO connect flow — encapsulates the disclosure →
 * credential form → account picker sequence so page.tsx's modal
 * doesn't bloat.
 *
 * Flow:
 *   1. (optional) Disclosure panel — shown if the user hasn't
 *      acknowledged the SnapTrade privacy trade-off on this device.
 *      "Continue" → form. "Cancel" → bubbled to parent (returns to
 *      broker picker).
 *   2. Credential form — 4 inputs (clientId, consumerKey,
 *      snaptradeUserId, snaptradeUserSecret), all required.
 *      "Continue" → loading-accounts; calls listSnapTradeAccounts.
 *   3. Loading state — spinner while fetching the user's connected
 *      brokerage accounts via SnapTrade.
 *   4. Account picker — radio list of accounts. User picks one.
 *      "Connect & Sync" → builds the final 5-field credential
 *      (form values + selected accountId), bubbles up via
 *      `onSubmit`. Parent (page.tsx) is responsible for the actual
 *      sync + atomic rollback.
 *
 * Privacy stance: this component only writes secrets to its own
 * local state. The credential JSON it bubbles up via onSubmit is
 * what eventually gets encrypted into Firestore by the parent
 * via `handleSync`. We never call any Firestore API directly.
 */

import { useState } from "react";
import {
  SnapTradeDisclosure,
  snapTradeDisclosureAcknowledged,
} from "./SnapTradeDisclosure";
import { snaptradeAdapter } from "@/lib/brokers/snaptrade";
import {
  listSnapTradeAccounts,
  type SnapTradeAccountSummary,
} from "@/lib/brokers/snaptrade/sync";

type Step =
  | { kind: "disclosure" }
  | { kind: "form" }
  | { kind: "loading-accounts" }
  | {
      kind: "picker";
      accounts: SnapTradeAccountSummary[];
      selected: Set<string>;
    };

interface Props {
  /** Called when the user picks account(s). Argument is the final
   *  JSON-encoded `{clientId, consumerKey, snaptradeUserId,
   *  snaptradeUserSecret, snaptradeAccountIds}` credential. Parent
   *  runs `handleSync` with this and handles the atomic rollback. */
  onSubmit: (credential: string) => Promise<void>;
  /** Called when the user cancels (Disclosure step or empty picker).
   *  Parent should return the modal to its broker-dropdown state. */
  onCancel: () => void;
  /** Disable submit while a parent action (handleSync) is in flight. */
  syncLoading: boolean;
  /**
   * Accounts the portfolio is locked to (it already holds their data).
   * They render pre-checked and can't be deselected; additional
   * accounts may be added on top. Empty for a first connect.
   */
  lockedSnaptradeAccountIds: string[];
}

export function SnapTradeConnectFlow({
  onSubmit,
  onCancel,
  syncLoading,
  lockedSnaptradeAccountIds,
}: Props) {
  const [step, setStep] = useState<Step>(() => ({
    kind: snapTradeDisclosureAcknowledged() ? "form" : "disclosure",
  }));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const allFieldsFilled = snaptradeAdapter.credentialFields.every(
    (f) => (fields[f.id] ?? "").trim().length > 0,
  );

  const goToForm = () => {
    setError("");
    setStep({ kind: "form" });
  };

  /** Submit the credential form → fetch accounts → render picker. */
  const submitCredentialForm = async () => {
    if (!allFieldsFilled) return;
    setError("");
    setStep({ kind: "loading-accounts" });
    try {
      const credential = snaptradeAdapter.buildCredential(fields);
      const accounts = await listSnapTradeAccounts(credential);
      // If the portfolio is locked to accounts, refuse early when any
      // of them no longer exists in the user's SnapTrade.
      if (lockedSnaptradeAccountIds.length > 0) {
        const live = new Set(accounts.map((a) => a.id));
        const missing = lockedSnaptradeAccountIds.filter((id) => !live.has(id));
        if (missing.length > 0) {
          setError(
            "Your portfolio is locked to SnapTrade accounts that are no longer in your SnapTrade user. Reconnect them first.",
          );
          setStep({ kind: "form" });
          return;
        }
      }
      setStep({
        kind: "picker",
        accounts,
        selected: new Set(
          lockedSnaptradeAccountIds.length > 0
            ? lockedSnaptradeAccountIds
            : accounts[0]
              ? [accounts[0].id]
              : [],
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
      setStep({ kind: "form" });
    }
  };

  /** Picker submit → bubble final credential up to parent. */
  const submitAccountPick = async () => {
    if (step.kind !== "picker") return;
    if (step.selected.size === 0) {
      setError("Pick at least one account.");
      return;
    }
    const missingLocked = lockedSnaptradeAccountIds.filter(
      (id) => !step.selected.has(id),
    );
    if (missingLocked.length > 0) {
      setError(
        "Locked accounts can't be deselected — this portfolio already holds their data.",
      );
      return;
    }
    const credential = JSON.stringify({
      clientId: (fields.clientId ?? "").trim(),
      consumerKey: (fields.consumerKey ?? "").trim(),
      snaptradeUserId: (fields.snaptradeUserId ?? "").trim(),
      snaptradeUserSecret: (fields.snaptradeUserSecret ?? "").trim(),
      snaptradeAccountIds: Array.from(step.selected),
    });
    try {
      await onSubmit(credential);
    } catch (err) {
      // Parent's handleSync surfaces its own errors via the modal's
      // syncError state; we only catch here so an unhandled rejection
      // doesn't bubble out of the React event handler.
      setError(err instanceof Error ? err.message : "Connect & Sync failed");
    }
  };

  // ---- render ----

  if (step.kind === "disclosure") {
    return (
      <SnapTradeDisclosure
        onContinue={goToForm}
        onCancel={onCancel}
        busy={syncLoading}
      />
    );
  }

  if (step.kind === "form") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitCredentialForm();
        }}
        className="space-y-3"
      >
        {snaptradeAdapter.credentialFields.map((f) => (
          <div key={f.id}>
            <div className="label mb-1.5">{f.label}</div>
            <input
              value={fields[f.id] ?? ""}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [f.id]: e.target.value }))
              }
              placeholder={f.placeholder}
              className="field font-mono text-xs w-full"
              required
            />
          </div>
        ))}
        <p className="text-xs text-fg-fade">{snaptradeAdapter.credentialHint}</p>
        {error && (
          <div className="border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-2.5">
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={syncLoading}
            className="btn-ghost px-3 py-2 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!allFieldsFilled || syncLoading}
            className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === "loading-accounts") {
    return (
      <div className="text-sm text-fg-dim text-center py-6">
        Loading your SnapTrade accounts…
      </div>
    );
  }

  // step.kind === "picker"
  return (
    <div className="space-y-3">
      <div className="text-sm text-fg-dim">
        Pick the brokerage account(s) to attach to this portfolio —
        they&apos;ll be merged into one view:
      </div>
      {step.accounts.length === 0 ? (
        <div className="text-xs text-fg-fade text-center py-4">
          No connected accounts found in your SnapTrade. Connect one at
          snaptrade.com first, then try again.
        </div>
      ) : (
        <ul className="space-y-2">
          {step.accounts.map((a) => {
            // Locked accounts: pre-checked, can't be deselected — the
            // portfolio already holds their data. New accounts are
            // freely addable.
            const locked = lockedSnaptradeAccountIds.includes(a.id);
            return (
              <li key={a.id}>
                <label
                  className={`flex items-center gap-2 bg-bg-3 border border-line rounded-lg px-3 py-2.5 ${
                    locked
                      ? "cursor-not-allowed"
                      : "cursor-pointer hover:border-accent transition"
                  }`}
                >
                  <input
                    type="checkbox"
                    name="snaptrade-account"
                    value={a.id}
                    checked={step.selected.has(a.id)}
                    onChange={() =>
                      setStep((s) => {
                        if (s.kind !== "picker") return s;
                        const next = new Set(s.selected);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return { ...s, selected: next };
                      })
                    }
                    disabled={syncLoading || locked}
                  />
                  <span className="text-sm flex-1">
                    <span className="font-medium">{a.name}</span>
                    {a.brokerage && a.brokerage !== a.name && (
                      <span className="text-fg-fade ml-1">· {a.brokerage}</span>
                    )}
                    {a.number && (
                      <span className="text-xs text-fg-fade ml-1">
                        ({a.number})
                      </span>
                    )}
                    {locked && (
                      <span className="text-xs text-fg-fade ml-1">(locked)</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="border border-neg/40 bg-neg/10 text-neg text-xs rounded-md p-2.5">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={syncLoading}
          className="btn-ghost px-3 py-2 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submitAccountPick()}
          disabled={
            syncLoading || step.selected.size === 0 || step.accounts.length === 0
          }
          className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
        >
          {syncLoading ? "Connecting…" : "Connect & Sync"}
        </button>
      </div>
    </div>
  );
}
