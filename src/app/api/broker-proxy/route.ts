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

  let body: ProxyRequestBody;
  try {
    body = (await req.json()) as ProxyRequestBody;
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

  let headers: Record<string, string>;
  try {
    headers = broker.auth(body.auth);
  } catch {
    return NextResponse.json({ error: "bad credential" }, { status: 400 });
  }

  // Forward to the broker. The auth header (and credential it carries) is
  // in memory for the duration of this fetch — never written anywhere.
  const upstreamRes = await fetch(outboundUrl.toString(), {
    method,
    headers,
    cache: "no-store",
  });

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
