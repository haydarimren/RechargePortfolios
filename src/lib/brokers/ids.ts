/**
 * Single source of truth for the `BrokerId` union. Type-only — no runtime
 * code in this module — so it's safe for the server-side proxy
 * (`src/app/api/broker-proxy/brokers.ts`) to import alongside the
 * client-side adapter registry. Keeps the two registries from drifting
 * out of sync without dragging adapter code into the server bundle.
 *
 * Phase 2 widens to `"trading212" | "alpaca"`. Both client and server
 * registries get an entry simultaneously; TypeScript enforces it.
 */

export type BrokerId = "trading212" | "alpaca";
