/**
 * Single source of truth for the `BrokerId` union. Exports a firebase-free
 * `BROKER_IDS` runtime tuple (safe for the server-side proxy
 * `src/app/api/broker-proxy/brokers.ts` to import alongside the
 * client-side adapter registry) and derives `BrokerId` from it. Keeps the
 * two registries from drifting out of sync without dragging adapter code
 * into the server bundle.
 *
 * Adding a new broker: extend the tuple here, then add an entry to BOTH
 * `BROKERS` (client adapter map) AND `SERVER_BROKERS` (proxy registry).
 * TypeScript enforces both — `Record<BrokerId, ...>` consumers won't
 * compile until they cover the new arm.
 */

/** Runtime list of supported broker ids — firebase-free, server-safe. */
export const BROKER_IDS = ["trading212", "alpaca", "snaptrade"] as const;

export type BrokerId = (typeof BROKER_IDS)[number];
