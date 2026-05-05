/**
 * Server-side broker registry. Maps an opaque `brokerId` from the request
 * body to the broker's outbound base URL, allowed path prefix, allowed
 * HTTP methods, and an auth-header builder.
 *
 * SSRF guard: outbound destinations are hardcoded here, never sourced
 * from client input. The client only picks an entry KEY (`trading212`,
 * `alpaca`, ...). Unknown keys → 400.
 *
 * Privacy: broker identity is per-request and ephemeral. The proxy logs
 * nothing about which broker a given UID is calling. Same model as the
 * single-broker version — the only difference is that the destination is
 * now picked by registry lookup instead of being hardcoded in one place.
 *
 * This module is server-only. The `BrokerId` type is shared with the
 * client adapter registry via `src/lib/brokers/ids.ts` (type-only, no
 * runtime code) so the two registries can't drift on broker keys without
 * a TypeScript error. We intentionally do NOT import the adapter
 * implementations themselves (which are `"use client"` and pull in
 * browser APIs).
 *
 * Auth builder contract: each broker's `auth(credential, req)` MUST
 * throw on any malformed credential. The route handler relies on the
 * throw to return 400 instead of forwarding garbage upstream. The
 * `req` arg gives the builder access to the request method, path
 * (with query string), and body — required for HMAC signers (e.g.
 * SnapTrade) that sign over the full request, not just attach a
 * static credential. Builders for brokers that use static auth
 * (T212, Alpaca) can ignore the `req` arg.
 */

import type { BrokerId } from "@/lib/brokers/ids";

export type ServerBrokerId = BrokerId;

/**
 * Request context passed to auth builders. `pathWithQuery` is the
 * outbound path including any `?...` segment, exactly as the upstream
 * URL will see it. `body` is the raw outbound body (for `POST`/`PUT`)
 * or `null` for body-less methods. Pre-resolved by the route handler
 * so builders don't need to think about URL parsing or body framing.
 */
export interface ServerBrokerAuthRequest {
  method: string;
  pathWithQuery: string;
  body: string | null;
}

export interface ServerBroker {
  /** Outbound origin. Hardcoded — never client-controlled. */
  base: string;
  /**
   * Required prefix for the client-supplied `path`. Stops a compromised
   * auth token from steering us at internal admin endpoints on the same
   * host.
   */
  pathPrefix: string;
  /** HTTP methods the proxy is willing to forward. */
  methods: ReadonlySet<string>;
  /**
   * Build the auth headers for the upstream request from the client's
   * opaque credential string. The shape of the credential is broker-
   * specific and known only to the matching client adapter; the server
   * just translates it into headers.
   *
   * The `req` arg gives request context (method, full path with query,
   * body) so builders that produce a signature over the request — not
   * just a static credential header — have everything they need. Static-
   * auth builders (T212 Basic, Alpaca custom headers) can ignore it.
   */
  auth: (
    credential: string,
    req: ServerBrokerAuthRequest,
  ) => Record<string, string>;
}

export const SERVER_BROKERS: Record<ServerBrokerId, ServerBroker> = {
  trading212: {
    base: "https://live.trading212.com",
    pathPrefix: "/api/v0/",
    methods: new Set(["GET"]),
    auth: (cred) => ({
      // Static credential — no need to look at request context.
      Authorization: `Basic ${Buffer.from(cred).toString("base64")}`,
    }),
  },
  alpaca: {
    base: "https://api.alpaca.markets",
    pathPrefix: "/v2/",
    methods: new Set(["GET"]),
    auth: (cred) => {
      // Static credential — no need to look at request context.
      // Alpaca uses two custom headers (key id + secret) instead of
      // HTTP Basic. Wire format from the client is `key:secret`. Throw
      // on malformed input — the route handler relies on the throw to
      // return 400 instead of forwarding garbage upstream.
      // The same rule is duplicated client-side in
      // src/lib/brokers/alpaca/sync.ts:validateCredential as an early
      // friendlier error; if you change one, change the other.
      const idx = cred.indexOf(":");
      if (idx <= 0 || idx === cred.length - 1) {
        throw new Error("malformed alpaca credential");
      }
      return {
        "APCA-API-KEY-ID": cred.slice(0, idx),
        "APCA-API-SECRET-KEY": cred.slice(idx + 1),
      };
    },
  },
};

/**
 * Strict registry-key check. Uses `hasOwnProperty` (not the `in` operator)
 * so that inherited Object prototype keys like `"toString"`,
 * `"constructor"`, `"__proto__"` are rejected. Without this guard, those
 * keys would resolve to `Object.prototype` members and downstream code
 * would read `undefined` fields off them, partially defeating the
 * SSRF/method/path checks before throwing on the missing methods. No
 * exploitable today, but a one-line fix that closes the latent footgun.
 */
export function isServerBrokerId(id: unknown): id is ServerBrokerId {
  return (
    typeof id === "string"
    && Object.prototype.hasOwnProperty.call(SERVER_BROKERS, id)
  );
}
