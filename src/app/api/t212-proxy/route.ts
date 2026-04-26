/**
 * Auth-gated dumb relay for Trading 212's API.
 *
 * Why this exists: T212's API is server-to-server only — they don't set
 * permissive CORS headers, so the browser can't call them directly. Under
 * the E2E threat model we don't want our server to read or store anything
 * from the T212 response, so this route is intentionally minimal:
 *
 *   1. Verify the caller has a valid Firebase ID token. Stops random
 *      internet traffic from using us as a free relay.
 *   2. Forward the call to T212 with the auth header the client supplied.
 *   3. Return the response untouched. Don't log bodies, don't persist
 *      anything.
 *
 * The T212 auth header is supplied per-request by the browser, which has
 * just decrypted it from the user's master-secret-wrapped Firestore doc.
 * The server holds it in memory only for the duration of one HTTPS round
 * trip — same model as Bitwarden's "send" feature.
 *
 * Verification of the Firebase ID token uses Google's identity toolkit
 * REST endpoint with our public Firebase Web API key. This avoids pulling
 * in `firebase-admin` for what's effectively one network call per sync.
 */

import { NextRequest, NextResponse } from "next/server";

const T212_BASE = "https://live.trading212.com";
const FIREBASE_API_KEY = "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o";

// Restrict the proxy to T212's documented API root so an attacker can't
// repurpose us as a generic SSRF relay for the whole live.trading212.com
// domain.
const ALLOWED_PATH_PREFIX = "/api/v0/";

// We allow GET-shaped browses (orders, instruments, positions). T212's API
// is mostly read-only from our perspective; if we ever need POST/DELETE
// we'll add a per-method allowlist.
const ALLOWED_METHODS = new Set(["GET"]);

interface ProxyRequestBody {
  /** Bearer-token-style Trading 212 API key (key:secret pair). */
  t212Auth: string;
  /** Path under T212's API, e.g. "/api/v0/equity/history/orders?limit=50". */
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
    typeof body.t212Auth !== "string" ||
    body.t212Auth.length < 8
  ) {
    return NextResponse.json({ error: "bad proxy params" }, { status: 400 });
  }
  const method = (body.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json({ error: "method not allowed" }, { status: 405 });
  }

  // Forward to T212. We translate the user-supplied `key:secret` into the
  // HTTP Basic auth header T212 expects. The server sees this in memory
  // for the duration of this fetch — never written anywhere.
  const basic = Buffer.from(body.t212Auth).toString("base64");
  const t212Res = await fetch(`${T212_BASE}${body.path}`, {
    method,
    headers: { Authorization: `Basic ${basic}` },
    cache: "no-store",
  });

  // Pass through status + body verbatim. Don't read t212Res.text() unless
  // we need to — Web Streams keep the body off our heap.
  const passthrough = await t212Res.arrayBuffer();
  return new NextResponse(passthrough, {
    status: t212Res.status,
    headers: {
      "content-type": t212Res.headers.get("content-type") ?? "application/json",
      // Defensive: never let anything proxied back claim caching.
      "cache-control": "no-store",
    },
  });
}
