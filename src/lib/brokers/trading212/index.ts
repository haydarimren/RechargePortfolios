"use client";

import type { BrokerAdapter } from "../types";
import { fetchTrading212Orders } from "./sync";

export const trading212Adapter: BrokerAdapter = {
  id: "trading212",
  displayName: "Trading 212",
  credentialFields: [
    { id: "key", label: "API key", placeholder: "Paste your API key" },
    { id: "secret", label: "API secret", placeholder: "Paste your API secret" },
  ],
  credentialHint: "Trading212: Settings → API (Beta) → Generate key",
  buildCredential: (fields) => `${fields.key.trim()}:${fields.secret.trim()}`,
  fetchOrders: ({ credential, isOrderKnown }) =>
    fetchTrading212Orders(credential, isOrderKnown),
};

// Convenience re-export for the page's dedup-known-orders predicate.
export { cleanT212Symbol } from "./symbols";
