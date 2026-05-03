"use client";

/**
 * Client-side broker registry. Single source of truth for which brokers
 * the app supports and how to render their connection forms.
 *
 * Privacy note: this module ends up in the public client bundle, which
 * means anyone visiting the site can see "this app supports brokers
 * X, Y, Z" by reading the JS. That's intentional product surface
 * (same as a marketing page listing supported brokers), not user data.
 * It is NOT a leak of any specific user's broker.
 *
 * The server-side proxy keeps its own separate registry
 * (`src/app/api/broker-proxy/brokers.ts`) that holds outbound URLs and
 * auth-header builders. The two registries are intentionally not
 * shared modules — adapter sync logic depends on browser APIs and
 * must stay out of server bundles.
 */

import type { BrokerAdapter, BrokerId } from "./types";
import { trading212Adapter } from "./trading212";

// Both `BROKERS` and `SUPPORTED_BROKERS` are unused until Phase 4's UI
// changes — the page still calls `fetchTrading212Orders` directly. Defining
// them now establishes the abstraction so Phase 2 (Alpaca adapter) and
// Phase 4 (modal swap) can wire up via the registry without further
// shape churn.
export const BROKERS: Record<BrokerId, BrokerAdapter> = {
  trading212: trading212Adapter,
  // alpaca adapter lands in Phase 2.
};

/** Brokers in alphabetical order — used by the connection picker. */
export const SUPPORTED_BROKERS: readonly BrokerId[] = (
  Object.keys(BROKERS) as BrokerId[]
).sort();
