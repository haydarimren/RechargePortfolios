/**
 * Shared types for broker adapters. Every supported broker exposes a
 * `BrokerAdapter` from its `index.ts`; the registry collects them.
 *
 * Privacy invariant: nothing in this module ends up persisted to Firestore
 * in plaintext. `BrokerId` strings appear inside the *encrypted* credential
 * payload and inside the encrypted `importSource` field of holdings, but
 * never as a top-level Firestore field.
 */

export type { BrokerId } from "./ids";
import type { BrokerId } from "./ids";

export interface ImportedOrder {
  id: string;
  symbol: string;
  shares: number;
  purchasePrice: number;
  purchaseDate: string;
  currency?: string;
  isin?: string;
  yahooSymbol?: string;
  side: "BUY" | "SELL";
}

export interface ImportResult {
  orders: ImportedOrder[];
  sellsSkipped: number;
  sellsImported: number;
}

/**
 * Predicate the page hands to an adapter so pagination can short-circuit
 * once it hits already-imported orders. Each adapter calls this per raw
 * order it sees during pagination; the implementation lives in the page,
 * which has the full holdings list.
 */
export type IsOrderKnownFn = (args: {
  orderId: string;
  rawTicker: string;
  purchaseDate: string;
  shares: number;
}) => boolean;

export interface CredentialField {
  /** Stable id used as form state key. */
  id: string;
  /** Visible label rendered above the input. */
  label: string;
  /** Placeholder text for the input. */
  placeholder: string;
}

export interface BrokerAdapter {
  id: BrokerId;
  /** Human-readable name for UI. Never persisted to Firestore plaintext. */
  displayName: string;
  /** Inputs the "Connect a broker" form should render for this broker. */
  credentialFields: CredentialField[];
  /** Hint copy shown beneath the form (e.g. where to generate the API key). */
  credentialHint: string;
  /**
   * Combine the form field values into the wire-format credential string.
   * That string is what gets encrypted into `secrets/credentials.payload`
   * and what the proxy receives in its request body. For both T212 and
   * Alpaca today this is `${key}:${secret}`; future brokers may differ.
   */
  buildCredential: (fields: Record<string, string>) => string;
  /** Run a full import pass against the broker. */
  fetchOrders: (opts: {
    credential: string;
    isOrderKnown?: IsOrderKnownFn;
  }) => Promise<ImportResult>;
}
