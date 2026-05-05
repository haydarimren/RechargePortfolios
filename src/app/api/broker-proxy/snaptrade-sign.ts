/**
 * SnapTrade request-signing helpers. Server-only — pulls in Node's
 * `crypto` module, which doesn't belong in the client bundle. Under
 * the BYO-credentials model the consumer key is supplied per-request
 * by the caller (read from the user's encrypted credential blob);
 * the signer never reads `process.env`.
 *
 * Signature scheme (verified against the official SnapTrade TS SDK at
 * passiv/snaptrade-sdks → sdks/typescript/requestAfterHook.ts):
 *
 *   1. Build the signature object:
 *      `{ content: <body or null>, path: <pathname>, query: <querystring without leading '?'> }`
 *   2. JSON-stringify with sorted keys (recursive — nested object keys
 *      are also sorted), compact format (no spaces).
 *   3. HMAC-SHA256 with the URI-encoded consumer key as the HMAC key.
 *   4. Base64-encode the digest.
 *   5. Send as the `Signature` header on the upstream request.
 *
 * The consumer key is never sent to the broker — it's the secret used
 * to sign, and it stays server-side. This is why the signer must run
 * on our server (not in the client adapter).
 */

import { createHmac } from "crypto";

/**
 * JSON.stringify with recursively sorted keys. Matches what the Python
 * SDK does via `json.dumps(..., sort_keys=True)` and what the official
 * TS SDK does via its bespoke `JSONstringifyOrder`. Compact format —
 * no whitespace between tokens — to match SnapTrade's expectation.
 *
 * Sorting recurses into nested objects so two structurally-equal
 * payloads produce identical strings regardless of in-memory key order.
 * Arrays preserve their element order (same as JSON.stringify).
 */
export function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(val).sort();
      for (const k of keys) sorted[k] = (val as Record<string, unknown>)[k];
      return sorted;
    }
    return val;
  });
}

export interface SnapTradeSignInput {
  /**
   * Path part of the upstream URL, without query string. E.g.
   * `/api/v1/activities`. Must match what SnapTrade re-derives on its
   * end — pre-normalized via WHATWG `URL` parsing by the route handler.
   */
  path: string;
  /**
   * Query string of the upstream URL, without leading `?`. E.g.
   * `clientId=ABC&timestamp=123&userId=foo`. Must include every
   * parameter that will appear in the final URL — the order doesn't
   * matter for HMAC validity (SnapTrade re-derives the signed string
   * from the inbound URL and the strings just need to match byte-for-
   * byte at sign + verify time).
   */
  query: string;
  /**
   * Request body if the upstream method has one (POST/PUT). For GETs
   * (the only method we need today), pass `null`. Body is the parsed
   * JSON object, not the stringified bytes — sortedJsonStringify
   * re-serializes it deterministically as part of the signed payload.
   */
  content: unknown;
  /** SnapTrade consumer key — secret. Server-side env. */
  consumerKey: string;
}

/**
 * Compute the SnapTrade request signature. Returns the base64-encoded
 * HMAC-SHA256 of the sorted-keys JSON of `{ content, path, query }`.
 *
 * Caller responsibilities:
 *   - Set this as the `Signature` header on the outbound upstream request.
 *   - Ensure the upstream request URL contains EXACTLY the same path +
 *     query string used here (post-WHATWG-URL normalization on our end).
 */
export function snapTradeSign(input: SnapTradeSignInput): string {
  const sigObject = {
    content: input.content,
    path: input.path,
    query: input.query,
  };
  const sigContent = sortedJsonStringify(sigObject);
  // Per the SDK: `encodeURI(consumerKey)` before HMAC. Almost always
  // a no-op for alphanumeric keys but included to match SDK behavior
  // exactly, so a key that ever contains URI-special chars produces
  // the same digest both sides.
  const key = encodeURI(input.consumerKey);
  return createHmac("sha256", key).update(sigContent).digest("base64");
}
