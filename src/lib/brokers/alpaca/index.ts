"use client";

import type { BrokerAdapter } from "../types";
import { fetchAlpacaOrders } from "./sync";

export const alpacaAdapter: BrokerAdapter = {
  id: "alpaca",
  displayName: "Alpaca",
  credentialFields: [
    { id: "key", label: "API Key ID", placeholder: "Paste your API Key ID" },
    { id: "secret", label: "Secret Key", placeholder: "Paste your Secret Key" },
  ],
  credentialHint: "Alpaca: Dashboard → API Keys → Generate",
  buildCredential: (fields) => `${fields.key.trim()}:${fields.secret.trim()}`,
  fetchOrders: ({ credential, isOrderKnown }) =>
    fetchAlpacaOrders(credential, isOrderKnown),
};
