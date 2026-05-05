/**
 * Single source of truth for the `BrokerId` union. Type-only — no runtime
 * code in this module — so it's safe for the server-side proxy
 * (`src/app/api/broker-proxy/brokers.ts`) to import alongside the
 * client-side adapter registry. Keeps the two registries from drifting
 * out of sync without dragging adapter code into the server bundle.
 *
 * Adding a new broker: extend the union here, then add an entry to BOTH
 * `BROKERS` (client adapter map) AND `SERVER_BROKERS` (proxy registry).
 * TypeScript enforces both — `Record<BrokerId, ...>` consumers won't
 * compile until they cover the new arm.
 */

export type BrokerId = "trading212" | "alpaca" | "snaptrade";
