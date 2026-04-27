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
 *   2. Forward the call to the broker with the auth header the client
 *      supplied.
 *   3. Return the response untouched. Don't log bodies, don't persist
 *      anything.
 *
 * The route name and request body are deliberately broker-agnostic
 * (`/api/broker-proxy`, body field `auth` rather than `t212Auth`) so
 * Vercel access logs and HTTP debuggers don't broadcast which broker
 * the user is syncing from. The actual outbound destination is
 * hardcoded server-side because that's the SSRF guard — letting the
 * client pick the URL would let any user with a Firebase token use us
 * as an open HTTP forwarder.
 *
 * The auth header is supplied per-request by the browser, which has
 * just decrypted it from the user's master-secret-wrapped Firestore
 * doc. The server holds it in memory only for the duration of one
 * HTTPS round trip — same model as Bitwarden's "send" feature.
 *
 * Firebase ID-token verification uses Google's identity toolkit REST
 * endpoint with our public Firebase Web API key, avoiding a
 * `firebase-admin` dependency for what's effectively one network call
 * per sync.
 */

import { NextRequest, NextResponse } from "next/server";

// Outbound destination. Hardcoded server-side as the SSRF guard. If we
// ever support a second broker, this becomes a per-request switch keyed
// by an opaque identifier in the request body — but the destination
// allowlist still lives here, in code, never under client control.
const OUTBOUND_BASE = "https://live.trading212.com";

const FIREBASE_API_KEY = "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o";

// Restrict the proxy to the broker's documented API root so a
// compromised auth token can't steer us at internal admin endpoints on
// the same host.
const ALLOWED_PATH_PREFIX = "/api/v0/";

// We allow GET-shaped browses only. Read-only against the broker; if
// we ever need POST/DELETE we'll add a per-method allowlist.
const ALLOWED_METHODS = new Set(["GET"]);

interface ProxyRequestBody {
  /** Broker auth credential (e.g. for T212, a `key:secret` pair). */
  auth: string;
  /** Path under the broker's API, e.g. "/api/v0/equity/history/orders?limit=50". */
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
  if (
    typeof body.path !== "string" ||
    !body.path.startsWith(ALLOWED_PATH_PREFIX) ||
    typeof body.auth !== "string" ||
    body.auth.length < 8
  ) {
    return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
  }
  const method = (body.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json({ error: "method not allowed" }, { status: 405 });
  }

  // Forward to the broker. We translate the user-supplied `key:secret`
  // into the HTTP Basic auth header. The server sees this in memory for
  // the duration of this fetch — never written anywhere.
  const basic = Buffer.from(body.auth).toString("base64");
  const upstreamRes = await fetch(`${OUTBOUND_BASE}${body.path}`, {
    method,
    headers: { Authorization: `Basic ${basic}` },
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
