import { describe, it, expect } from "vitest";
import { isServerBrokerId, SERVER_BROKERS } from "./brokers";

// Default request context for static-auth builders (T212, Alpaca) that
// ignore it. SnapTrade and other request-aware signers get their own
// fixtures in their respective test suites.
const DUMMY_REQ = { method: "GET", pathWithQuery: "/api/v0/foo", body: null };

describe("isServerBrokerId", () => {
  it("accepts known broker keys", () => {
    expect(isServerBrokerId("trading212")).toBe(true);
    expect(isServerBrokerId("alpaca")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isServerBrokerId("unknown")).toBe(false);
    expect(isServerBrokerId("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isServerBrokerId(undefined)).toBe(false);
    expect(isServerBrokerId(null)).toBe(false);
    expect(isServerBrokerId(42)).toBe(false);
    expect(isServerBrokerId({})).toBe(false);
  });

  // Regression: the type guard previously used the `in` operator, which
  // walks the prototype chain. That meant `"toString"`, `"constructor"`,
  // `"__proto__"` would all pass — and `SERVER_BROKERS["toString"]` would
  // return `Object.prototype.toString` rather than `undefined`,
  // partially defeating the SSRF guard before the missing fields threw.
  it("rejects inherited Object prototype keys", () => {
    expect(isServerBrokerId("toString")).toBe(false);
    expect(isServerBrokerId("constructor")).toBe(false);
    expect(isServerBrokerId("__proto__")).toBe(false);
    expect(isServerBrokerId("hasOwnProperty")).toBe(false);
    expect(isServerBrokerId("valueOf")).toBe(false);
  });
});

describe("SERVER_BROKERS.trading212.auth", () => {
  it("produces the same Basic header the pre-registry route used to emit", () => {
    const headers = SERVER_BROKERS.trading212.auth("key123:secret456", DUMMY_REQ);
    // Pre-registry route did exactly: `Basic ${Buffer.from(cred).toString("base64")}`.
    const expected = `Basic ${Buffer.from("key123:secret456").toString("base64")}`;
    expect(headers).toEqual({ Authorization: expected });
  });

  it("ignores request context (static credential)", () => {
    // Sanity check: same credential, different request → same headers.
    const headers1 = SERVER_BROKERS.trading212.auth("k:s", DUMMY_REQ);
    const headers2 = SERVER_BROKERS.trading212.auth("k:s", {
      method: "POST",
      pathWithQuery: "/api/v0/something/else?q=1",
      body: '{"x":1}',
    });
    expect(headers1).toEqual(headers2);
  });
});

describe("SERVER_BROKERS.alpaca.auth", () => {
  it("splits key:secret into APCA headers", () => {
    const headers = SERVER_BROKERS.alpaca.auth("PKABC123:SK_secret_xyz", DUMMY_REQ);
    expect(headers).toEqual({
      "APCA-API-KEY-ID": "PKABC123",
      "APCA-API-SECRET-KEY": "SK_secret_xyz",
    });
  });

  it("preserves colons in the secret half", () => {
    // Alpaca secrets shouldn't contain colons in practice, but the
    // splitter uses `indexOf(":")` (not `split(":")`), so the secret
    // part keeps any later colons intact.
    const headers = SERVER_BROKERS.alpaca.auth("KEYID:has:colons:in:it", DUMMY_REQ);
    expect(headers).toEqual({
      "APCA-API-KEY-ID": "KEYID",
      "APCA-API-SECRET-KEY": "has:colons:in:it",
    });
  });

  it("throws on a credential with no colon", () => {
    expect(() => SERVER_BROKERS.alpaca.auth("nocolon", DUMMY_REQ)).toThrow();
  });

  it("throws on a credential that ends with a colon (empty secret)", () => {
    expect(() => SERVER_BROKERS.alpaca.auth("keyid:", DUMMY_REQ)).toThrow();
  });

  it("throws on a credential that starts with a colon (empty key)", () => {
    expect(() => SERVER_BROKERS.alpaca.auth(":justasecret", DUMMY_REQ)).toThrow();
  });

  it("ignores request context (static credential)", () => {
    const headers1 = SERVER_BROKERS.alpaca.auth("PK:SK", DUMMY_REQ);
    const headers2 = SERVER_BROKERS.alpaca.auth("PK:SK", {
      method: "POST",
      pathWithQuery: "/v2/different",
      body: '{"y":2}',
    });
    expect(headers1).toEqual(headers2);
  });
});

describe("URL normalization (route-level contract)", () => {
  // The route hands the auth builder a `pathWithQuery` derived from
  // `outboundUrl.pathname + outboundUrl.search` (i.e. AFTER the WHATWG
  // URL parser normalizes `..` segments), not the raw client-supplied
  // `body.path`. This pins the contract so a future request-aware
  // signer (Phase 2's SnapTrade HMAC) can rely on the path it signs
  // matching what the upstream actually receives.
  function normalize(rawPath: string, base: string): string {
    const u = new URL(rawPath, base);
    return u.pathname + u.search;
  }

  it("collapses `..` segments before signing", () => {
    expect(
      normalize("/api/v0/foo/../bar", "https://live.trading212.com"),
    ).toBe("/api/v0/bar");
  });

  it("preserves query strings", () => {
    expect(
      normalize("/api/v0/equity/history/orders?limit=50", "https://live.trading212.com"),
    ).toBe("/api/v0/equity/history/orders?limit=50");
  });

  it("normalizes percent-encoding consistently", () => {
    // `%2F` (encoded slash) survives normalization — `URL` doesn't
    // decode it back to `/`. So a signer's path string is stable.
    expect(
      normalize("/v2/orders%2Fextra?x=1", "https://api.alpaca.markets"),
    ).toBe("/v2/orders%2Fextra?x=1");
  });
});
