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
import { snapTradeSign } from "./snaptrade-sign";

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

/**
 * Auth builder result. `headers` is always set (even if empty); the
 * optional `pathWithQueryOverride` lets a builder mutate the outbound
 * URL — needed for SnapTrade, which appends `clientId` and `timestamp`
 * query params before signing. The route handler uses the override
 * (when present) for both the upstream `fetch` and the signed path.
 *
 * Static-auth brokers (T212, Alpaca) just return `{ headers }` and
 * leave the path alone.
 */
export interface ServerBrokerAuthResult {
  headers: Record<string, string>;
  pathWithQueryOverride?: string;
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
   * Build the auth headers (and optionally a path override) for the
   * upstream request from the client's opaque credential string. The
   * shape of the credential is broker-specific and known only to the
   * matching client adapter; the server just translates it into headers.
   *
   * The `req` arg gives request context (method, full path with query,
   * body) so builders that produce a signature over the request — not
   * just a static credential header — have everything they need.
   * Static-auth builders (T212 Basic, Alpaca custom headers) can
   * ignore it.
   *
   * Returning a `pathWithQueryOverride` mutates the outbound URL
   * before fetch — used by SnapTrade to append `clientId` and
   * `timestamp` query params (which must be in the URL the upstream
   * receives, not just in the signed payload). Other brokers omit it.
   */
  auth: (
    credential: string,
    req: ServerBrokerAuthRequest,
  ) => ServerBrokerAuthResult;
}

export const SERVER_BROKERS: Record<ServerBrokerId, ServerBroker> = {
  trading212: {
    base: "https://live.trading212.com",
    pathPrefix: "/api/v0/",
    methods: new Set(["GET"]),
    auth: (cred) => ({
      // Static credential — no need to look at request context.
      headers: {
        Authorization: `Basic ${Buffer.from(cred).toString("base64")}`,
      },
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
        headers: {
          "APCA-API-KEY-ID": cred.slice(0, idx),
          "APCA-API-SECRET-KEY": cred.slice(idx + 1),
        },
      };
    },
  },
  snaptrade: {
    base: "https://api.snaptrade.com",
    pathPrefix: "/api/v1/",
    // SnapTrade BYO mode: only GET is exercised. Activities + account
    // listing are GET; registration / login portal don't run from our
    // app (the user does those at SnapTrade themselves before pasting
    // their credentials in our connect form). POST stays disallowed
    // to keep the surface narrow.
    methods: new Set(["GET"]),
    /**
     * SnapTrade auth (BYO-credentials model): HMAC-SHA256 over a
     * sorted-keys JSON of `{ content, path, query }` using the
     * user's own consumer key as the HMAC secret. Result goes in the
     * `Signature` header. `clientId` and `timestamp` are appended to
     * the URL query string before signing.
     *
     * `cred` is JSON-encoded `{ clientId, consumerKey,
     * snaptradeUserId, snaptradeUserSecret }` — the four values the
     * end user pasted into our connect form (taken from THEIR own
     * SnapTrade developer account). Unlike the operator-managed model,
     * we never use server env vars; every request is signed with the
     * caller's own keys. The userId/userSecret fields aren't part of
     * the HMAC inputs themselves — they travel in the URL where
     * SnapTrade's app-layer auth reads them. The HMAC just signs over
     * the assembled request.
     */
    auth: (cred, req) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cred);
      } catch {
        throw new Error("malformed snaptrade credential (not JSON)");
      }
      if (
        parsed === null
        || typeof parsed !== "object"
        || typeof (parsed as { clientId?: unknown }).clientId !== "string"
        || typeof (parsed as { consumerKey?: unknown }).consumerKey !== "string"
        || typeof (parsed as { snaptradeUserId?: unknown }).snaptradeUserId !== "string"
        || typeof (parsed as { snaptradeUserSecret?: unknown }).snaptradeUserSecret !== "string"
      ) {
        throw new Error("malformed snaptrade credential (missing fields)");
      }
      const {
        clientId,
        consumerKey,
        snaptradeUserId,
        snaptradeUserSecret,
      } = parsed as {
        clientId: string;
        consumerKey: string;
        snaptradeUserId: string;
        snaptradeUserSecret: string;
      };
      // All four must be non-empty. The client-side `buildCredential`
      // already trims, but server can't trust the client — and an
      // empty userId/userSecret would still produce a valid HMAC,
      // failing only at SnapTrade's own auth layer with a less
      // diagnostic error. Surface the bad-shape failure here instead.
      if (
        clientId.length === 0
        || consumerKey.length === 0
        || snaptradeUserId.length === 0
        || snaptradeUserSecret.length === 0
      ) {
        throw new Error("malformed snaptrade credential (empty fields)");
      }

      // Append clientId + timestamp to the URL's query string. The
      // upstream URL must contain BOTH params, and the signature
      // must sign over the same query string. We use a dummy base
      // URL just to get URLSearchParams' serialization for free.
      const dummy = new URL(req.pathWithQuery, "https://x.invalid");
      dummy.searchParams.set("clientId", clientId);
      dummy.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
      const overriddenPath = dummy.pathname + dummy.search;
      const queryStringOnly = dummy.search.replace(/^\?/, "");

      // GETs only today (see `methods` above) → body is always null.
      // We still tolerate an empty / "{}" string defensively.
      let content: unknown = null;
      if (req.body !== null && req.body !== "" && req.body !== "{}") {
        try {
          content = JSON.parse(req.body);
        } catch {
          throw new Error("malformed snaptrade body (not JSON)");
        }
      }

      const signature = snapTradeSign({
        content,
        path: dummy.pathname,
        query: queryStringOnly,
        consumerKey,
      });

      return {
        headers: { Signature: signature },
        pathWithQueryOverride: overriddenPath,
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
