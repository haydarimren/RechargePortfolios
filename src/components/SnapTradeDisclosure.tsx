"use client";

/**
 * SnapTrade privacy-disclosure panel. Shown above the BYO connect
 * form when the user picks SnapTrade in the broker dropdown. Makes
 * the threat-model trade-off explicit: SnapTrade-connected portfolios
 * mean SnapTrade themselves see the user's broker data, even though
 * our server still cannot.
 *
 * Different from the bespoke brokers' connect flow: the user has
 * already signed up at SnapTrade themselves and given them broker
 * access — they know SnapTrade has their data. This panel is a
 * gentle reminder + acknowledgment gate, not first-time consent.
 *
 * "Don't show again on this device" persists to `localStorage` (NOT
 * Firestore — UX preference, not security state). Versioned key so a
 * future copy update can invalidate prior acknowledgments.
 *
 * Caller wires `onContinue` to reveal the credential form;
 * `onCancel` returns the modal to its broker picker.
 */

import { useState } from "react";

const ACK_KEY = "snaptrade-disclosure-acknowledged-v2";

export function snapTradeDisclosureAcknowledged(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ACK_KEY) === "true";
  } catch {
    return false;
  }
}

interface Props {
  onContinue: () => void;
  onCancel: () => void;
  /** Disable both buttons while a parent action is in flight. */
  busy?: boolean;
}

export function SnapTradeDisclosure({ onContinue, onCancel, busy }: Props) {
  const [dontShow, setDontShow] = useState(false);

  const handleContinue = () => {
    if (dontShow && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(ACK_KEY, "true");
      } catch {
        // Fail silent — the disclosure will just show again next time.
      }
    }
    onContinue();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 text-sm text-fg-dim leading-relaxed">
        <p>
          SnapTrade is a third-party aggregator that connects to brokers
          we don&apos;t support directly (Fidelity, Schwab, Robinhood,
          and others).
        </p>
        <p className="text-fg">
          <strong>Heads up:</strong> SnapTrade has your broker login
          (you signed up with them and connected your broker through
          their site). Our app uses your SnapTrade credentials to read
          that data on your behalf. We never see your broker password;
          SnapTrade does. By continuing, you accept this trade-off.
        </p>
      </div>

      <label className="flex items-center gap-2 text-xs text-fg-fade cursor-pointer">
        <input
          type="checkbox"
          checked={dontShow}
          onChange={(e) => setDontShow(e.target.checked)}
          className="rounded"
        />
        Don&apos;t show this again on this device
      </label>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn-ghost px-3 py-2 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={busy}
          className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
