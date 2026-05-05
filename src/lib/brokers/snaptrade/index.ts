"use client";

import type { BrokerAdapter } from "../types";
import { fetchSnapTradeOrders } from "./sync";

export const snaptradeAdapter: BrokerAdapter = {
  id: "snaptrade",
  displayName: "SnapTrade",
  // BYO-credentials model: end user signs up at SnapTrade themselves,
  // generates these four values from their developer dashboard, and
  // pastes them into our connect form. We never have an app-level
  // SnapTrade account; every request signs with the caller's own keys.
  credentialFields: [
    {
      id: "clientId",
      label: "SnapTrade Client ID",
      placeholder: "Paste your SnapTrade Client ID",
    },
    {
      id: "consumerKey",
      label: "SnapTrade Consumer Key",
      placeholder: "Paste your SnapTrade Consumer Key",
    },
    {
      id: "snaptradeUserId",
      label: "SnapTrade User ID",
      placeholder: "Paste your SnapTrade User ID",
    },
    {
      id: "snaptradeUserSecret",
      label: "SnapTrade User Secret",
      placeholder: "Paste your SnapTrade User Secret",
    },
  ],
  credentialHint:
    "Get all four values from snaptrade.com → Developer Dashboard. You'll also need to register a User and connect at least one brokerage there before syncing.",
  // Pack the four form values as JSON (no accountId yet — that gets
  // appended after the user picks one from the account picker).
  // The page calls this, then runs the credential through
  // listAccounts to populate the picker, then appends snaptradeAccountId
  // before handing the final 5-field blob to handleSync.
  buildCredential: (fields) =>
    JSON.stringify({
      clientId: (fields.clientId ?? "").trim(),
      consumerKey: (fields.consumerKey ?? "").trim(),
      snaptradeUserId: (fields.snaptradeUserId ?? "").trim(),
      snaptradeUserSecret: (fields.snaptradeUserSecret ?? "").trim(),
    }),
  fetchOrders: ({ credential, isOrderKnown }) =>
    fetchSnapTradeOrders(credential, isOrderKnown),
};

// Re-export listAccounts so the page's account-picker view can import
// it from the same SnapTrade adapter module rather than reaching
// directly into ./sync.
export { listSnapTradeAccounts, type SnapTradeAccountSummary } from "./sync";
