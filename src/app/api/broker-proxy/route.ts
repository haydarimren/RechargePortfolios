/**
 * Auth-gated dumb relay for broker APIs.
 *
 * Why this exists: brokers like Trading 212 don't set permissive CORS
 * headers on their public API, so the browser can't call them directly.
 * Under the E2E threat model we don't want our server to read or store
 * anything from the broker's response, so this route is intentionally
 * minimal:
 *
 *   1. Verify the caller has a valid Firebase ID token. Stops random
 *      internet traffic from using us as a free relay.
 *   2. Look up `brokerId` in the server-side registry to pick the
 *      outbound base URL, allowed path prefix, and auth-header builder.
 *   3. Forward the call with the resulting headers.
 *   4. Return the response untouched. Don't log bodies, don't persist
 *      anything.
 *
 * The route name is broker-agnostic so Vercel access logs and HTTP
 * debuggers don't broadcast which broker a request is going to. The
 * `brokerId` field in the request body is ephemeral — used only for
 * outbound routing, never persisted, never logged.
 *
 * The destination allowlist lives in `./brokers.ts` (server-only). Letting
 * the client pick the URL would let any user with a Firebase token use us
 * as an open HTTP forwarder.
 *
 * The auth header is supplied per-request by the browser, which has just
 * decrypted it from the user's master-secret-wrapped Firestore doc. The
 * server holds it in memory only for the duration of one HTTPS round
 * trip — same model as Bitwarden's "send" feature.
 *
 * Firebase ID-token verification uses Google's identity toolkit REST
 * endpoint with our public Firebase Web API key, avoiding a
 * `firebase-admin` dependency for what's effectively one network call
 * per sync.
 */

import { NextRequest, NextResponse } from "next/server";
import { SERVER_BROKERS, isServerBrokerId } from "./brokers";

const FIREBASE_API_KEY = "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o";

interface ProxyRequestBody {
  /** Registry key for the broker — `trading212`, `alpaca`, etc. */
  brokerId: string;
  /** Broker auth credential (shape varies by broker; e.g. `key:secret`). */
  auth: string;
  /** Path under the broker's API. Must start with the broker's allowed prefix. */
  path: string;
  method?: string;
  /**
   * Optional request body for non-GET methods. Forwarded verbatim to
   * the upstream broker. The auth builder can also see this string so
   * HMAC signers can sign over it.
   */
  body?: string;
}

/**
 * Verify a Firebase ID token via the public identitytoolkit endpoint.
 * Returns the user's UID on success, null on any failure.
 */
async function verifyIdToken(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Array<{ localId?: string }> };
    return data.users?.[0]?.localId ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 },
    );
  }
  const uid = await verifyIdToken(match[1]);
  if (!uid) {
    return NextResponse.json(
      { error: "invalid bearer token" },
      { status: 401 },
    );
  }

  // Read raw bytes first so we can cap the request size before parsing.
  // Without this, a malicious client could send arbitrarily large
  // bodies and force us to parse them into the server heap. All
  // current brokers are GET-only at the proxy layer, but the
  // body-forwarding path remains wired for any future broker that
  // needs POST. Cap the inbound body at 64KB — far above any
  // legitimate broker call (typical bodies are sub-1KB).
  const MAX_BODY_BYTES = 64 * 1024;
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }
  if (rawText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request too large" }, { status: 413 });
  }
  let body: ProxyRequestBody;
  try {
    body = JSON.parse(rawText) as ProxyRequestBody;
  } catch {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }

  if (!isServerBrokerId(body.brokerId)) {
    return NextResponse.json({ error: "unknown broker" }, { status: 400 });
  }
  const broker = SERVER_BROKERS[body.brokerId];

  if (
    typeof body.path !== "string" ||
    typeof body.auth !== "string" ||
    body.auth.length < 8
  ) {
    return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
  }

  // Build and validate the outbound URL with the WHATWG parser so that
  // `..` segments are normalized BEFORE the prefix check. A naive
  // string-prefix check on the raw `path` would let
  // `/api/v0/../../internal/admin` slip through — the prefix matches,
  // but the actual request would resolve to an unintended endpoint on
  // the same host. We also pin the resolved origin against the broker's
  // base, so that an injected absolute URL like
  // `https://evil.com/api/v0/...` can't redirect us to a foreign host
  // even if it happens to match the prefix string-wise.
  let outboundUrl: URL;
  try {
    outboundUrl = new URL(body.path, broker.base);
  } catch {
    return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
  }
  const baseOrigin = new URL(broker.base).origin;
  if (
    outboundUrl.origin !== baseOrigin
    || !outboundUrl.pathname.startsWith(broker.pathPrefix)
  ) {
    return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
  }

  const method = (body.method ?? "GET").toUpperCase();
  if (!broker.methods.has(method)) {
    return NextResponse.json({ error: "method not allowed" }, { status: 405 });
  }

  // Body is only meaningful for methods that carry one. Reject a
  // non-empty body on a GET-shaped request — guards against confused
  // clients passing payloads that the auth builder might sign over
  // even though the upstream `fetch` will silently drop them.
  if (method === "GET" && typeof body.body === "string" && body.body.length > 0) {
    return NextResponse.json({ error: "body not allowed for GET" }, { status: 400 });
  }
  const outboundBody: string | null =
    method === "GET" ? null : (body.body ?? null);

  let headers: Record<string, string>;
  try {
    // Auth builder gets request context so HMAC signers (e.g. SnapTrade)
    // can sign over the full request. Static-auth builders ignore it.
    // Use `outboundUrl.pathname + outboundUrl.search` rather than
    // `body.path` so the signed path matches what's actually sent
    // (post-`URL` normalization, no `..` segments).
    const result = broker.auth(body.auth, {
      method,
      pathWithQuery: outboundUrl.pathname + outboundUrl.search,
      body: outboundBody,
    });
    headers = result.headers;
    // Auth builder may mutate the outbound URL (SnapTrade appends
    // `clientId` + `timestamp` query params before signing). Re-resolve
    // against the broker's base + re-validate origin AND pathname so a
    // buggy or compromised builder can't escape the SSRF guard.
    //
    // Tightening: builders may only mutate the QUERY STRING, not the
    // pathname itself. Path mutation would let a builder silently
    // retarget the upstream request to a different endpoint within the
    // same prefix — strictly more permissive than any real builder
    // needs (SnapTrade only adds query params). The pathname-equality
    // check below makes that future bug impossible.
    if (result.pathWithQueryOverride !== undefined) {
      let overridden: URL;
      try {
        overridden = new URL(result.pathWithQueryOverride, broker.base);
      } catch {
        return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
      }
      if (
        overridden.origin !== baseOrigin
        || !overridden.pathname.startsWith(broker.pathPrefix)
        || overridden.pathname !== outboundUrl.pathname
      ) {
        return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
      }
      outboundUrl = overridden;
    }
  } catch (err) {
    // Surface the auth builder's error verbatim. Builders throw on
    // malformed credentials or other structural failures — none of
    // these messages contain user secrets, broker responses, or
    // anything else sensitive (they're all about request shape).
    // A generic "bad credential" string was making real debugging
    // needlessly opaque (e.g. a malformed SnapTrade credential JSON
    // would surface as the same HTTP 400 as a malformed T212
    // key:secret pair, with no diagnostic clue).
    const msg =
      err instanceof Error
      && typeof err.message === "string"
      && err.message.length > 0
        ? err.message
        : "bad credential";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Outbound fetch options. Body is included only for non-GET methods.
  // `Content-Type` defaults to JSON when there's a body and the auth
  // builder didn't set one explicitly — most broker APIs (including
  // SnapTrade) expect JSON request bodies. The case-insensitive check
  // means a builder-supplied `content-type` (any casing) wins; we
  // deliberately preserve the builder's verbatim header object (and
  // its casing) in that branch rather than ever clobbering it.
  // Forward to the broker — auth header, credential, and body all live
  // in memory only for this fetch's duration. Never persisted.
  const fetchInit: RequestInit = {
    method,
    headers,
    cache: "no-store",
  };
  if (outboundBody !== null) {
    fetchInit.body = outboundBody;
    if (
      !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
    ) {
      fetchInit.headers = { ...headers, "Content-Type": "application/json" };
    }
  }

  const upstreamRes = await fetch(outboundUrl.toString(), fetchInit);

  // Pass through status + body verbatim. Don't read .text() unless we
  // need to — Web Streams keep the body off our heap.
  const passthrough = await upstreamRes.arrayBuffer();
  return new NextResponse(passthrough, {
    status: upstreamRes.status,
    headers: {
      "content-type":
        upstreamRes.headers.get("content-type") ?? "application/json",
      // Defensive: never let anything proxied back claim caching.
      "cache-control": "no-store",
    },
  });
}
