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
    expect(isServerBrokerId("snaptrade")).toBe(true);
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
    const result = SERVER_BROKERS.trading212.auth("key123:secret456", DUMMY_REQ);
    // Pre-registry route did exactly: `Basic ${Buffer.from(cred).toString("base64")}`.
    const expected = `Basic ${Buffer.from("key123:secret456").toString("base64")}`;
    expect(result.headers).toEqual({ Authorization: expected });
    // No URL mutation for static-auth brokers.
    expect(result.pathWithQueryOverride).toBeUndefined();
  });

  it("ignores request context (static credential)", () => {
    // Sanity check: same credential, different request → same headers.
    const r1 = SERVER_BROKERS.trading212.auth("k:s", DUMMY_REQ);
    const r2 = SERVER_BROKERS.trading212.auth("k:s", {
      method: "POST",
      pathWithQuery: "/api/v0/something/else?q=1",
      body: '{"x":1}',
    });
    expect(r1).toEqual(r2);
  });
});

describe("SERVER_BROKERS.alpaca.auth", () => {
  it("splits key:secret into APCA headers", () => {
    const { headers, pathWithQueryOverride } = SERVER_BROKERS.alpaca.auth(
      "PKABC123:SK_secret_xyz",
      DUMMY_REQ,
    );
    expect(headers).toEqual({
      "APCA-API-KEY-ID": "PKABC123",
      "APCA-API-SECRET-KEY": "SK_secret_xyz",
    });
    expect(pathWithQueryOverride).toBeUndefined();
  });

  it("preserves colons in the secret half", () => {
    // Alpaca secrets shouldn't contain colons in practice, but the
    // splitter uses `indexOf(":")` (not `split(":")`), so the secret
    // part keeps any later colons intact.
    const { headers } = SERVER_BROKERS.alpaca.auth(
      "KEYID:has:colons:in:it",
      DUMMY_REQ,
    );
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
    const r1 = SERVER_BROKERS.alpaca.auth("PK:SK", DUMMY_REQ);
    const r2 = SERVER_BROKERS.alpaca.auth("PK:SK", {
      method: "POST",
      pathWithQuery: "/v2/different",
      body: '{"y":2}',
    });
    expect(r1).toEqual(r2);
  });
});

describe("SERVER_BROKERS.snaptrade.auth", () => {
  // BYO model: every value comes from the credential JSON the user
  // pasted into our connect form. No env vars involved.
  const validCred = JSON.stringify({
    clientId: "TESTCLIENT",
    consumerKey: "TESTCONSUMER",
    snaptradeUserId: "test-user-123",
    snaptradeUserSecret: "test-secret-abc",
  });

  it("returns a Signature header", () => {
    const { headers } = SERVER_BROKERS.snaptrade.auth(validCred, {
      method: "GET",
      pathWithQuery: "/api/v1/accounts",
      body: null,
    });
    expect(headers).toHaveProperty("Signature");
    expect(typeof headers.Signature).toBe("string");
    expect(headers.Signature.length).toBeGreaterThan(20);
  });

  it("appends clientId and timestamp from the credential to the URL", () => {
    const { pathWithQueryOverride } = SERVER_BROKERS.snaptrade.auth(validCred, {
      method: "GET",
      pathWithQuery: "/api/v1/accounts",
      body: null,
    });
    expect(pathWithQueryOverride).toMatch(/^\/api\/v1\/accounts\?/);
    expect(pathWithQueryOverride).toMatch(/clientId=TESTCLIENT/);
    expect(pathWithQueryOverride).toMatch(/timestamp=\d+/);
  });

  it("uses the per-credential clientId, not a global one", () => {
    // Two callers with different clientIds must produce different
    // outbound URLs — confirms the BYO model isn't accidentally
    // collapsing to a shared clientId somewhere.
    const credA = JSON.stringify({
      clientId: "CLIENT_A",
      consumerKey: "k1",
      snaptradeUserId: "u",
      snaptradeUserSecret: "s",
    });
    const credB = JSON.stringify({
      clientId: "CLIENT_B",
      consumerKey: "k2",
      snaptradeUserId: "u",
      snaptradeUserSecret: "s",
    });
    const a = SERVER_BROKERS.snaptrade.auth(credA, {
      method: "GET",
      pathWithQuery: "/api/v1/accounts",
      body: null,
    });
    const b = SERVER_BROKERS.snaptrade.auth(credB, {
      method: "GET",
      pathWithQuery: "/api/v1/accounts",
      body: null,
    });
    expect(a.pathWithQueryOverride).toMatch(/clientId=CLIENT_A/);
    expect(b.pathWithQueryOverride).toMatch(/clientId=CLIENT_B/);
    // And different consumerKeys produce different signatures.
    expect(a.headers.Signature).not.toBe(b.headers.Signature);
  });

  it("preserves existing query params from the inbound request", () => {
    const { pathWithQueryOverride } = SERVER_BROKERS.snaptrade.auth(validCred, {
      method: "GET",
      pathWithQuery:
        "/api/v1/activities?userId=u1&userSecret=s1&startDate=2024-01-01",
      body: null,
    });
    expect(pathWithQueryOverride).toMatch(/userId=u1/);
    expect(pathWithQueryOverride).toMatch(/userSecret=s1/);
    expect(pathWithQueryOverride).toMatch(/startDate=2024-01-01/);
    expect(pathWithQueryOverride).toMatch(/clientId=TESTCLIENT/);
    expect(pathWithQueryOverride).toMatch(/timestamp=\d+/);
  });

  it("produces a different signature for different paths", () => {
    const r1 = SERVER_BROKERS.snaptrade.auth(validCred, {
      method: "GET",
      pathWithQuery: "/api/v1/accounts",
      body: null,
    });
    const r2 = SERVER_BROKERS.snaptrade.auth(validCred, {
      method: "GET",
      pathWithQuery: "/api/v1/positions",
      body: null,
    });
    expect(r1.headers.Signature).not.toBe(r2.headers.Signature);
  });

  it("throws on a credential that isn't valid JSON", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth("not-json", {
        method: "GET",
        pathWithQuery: "/api/v1/accounts",
        body: null,
      }),
    ).toThrow(/not JSON/);
  });

  it("throws on a credential missing clientId", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          consumerKey: "k",
          snaptradeUserId: "u",
          snaptradeUserSecret: "s",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/missing fields/);
  });

  it("throws on a credential missing consumerKey", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          clientId: "c",
          snaptradeUserId: "u",
          snaptradeUserSecret: "s",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/missing fields/);
  });

  it("throws on a credential missing user fields", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({ clientId: "c", consumerKey: "k" }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/missing fields/);
  });

  it("throws on empty clientId", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          clientId: "",
          consumerKey: "k",
          snaptradeUserId: "u",
          snaptradeUserSecret: "s",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/empty fields/);
  });

  it("throws on empty consumerKey", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          clientId: "c",
          consumerKey: "",
          snaptradeUserId: "u",
          snaptradeUserSecret: "s",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/empty fields/);
  });

  it("throws on empty snaptradeUserId", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          clientId: "c",
          consumerKey: "k",
          snaptradeUserId: "",
          snaptradeUserSecret: "s",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/empty fields/);
  });

  it("throws on empty snaptradeUserSecret", () => {
    expect(() =>
      SERVER_BROKERS.snaptrade.auth(
        JSON.stringify({
          clientId: "c",
          consumerKey: "k",
          snaptradeUserId: "u",
          snaptradeUserSecret: "",
        }),
        { method: "GET", pathWithQuery: "/api/v1/accounts", body: null },
      ),
    ).toThrow(/empty fields/);
  });
});

describe("Path-mutation guard (route-level contract)", () => {
  // The route enforces that `pathWithQueryOverride` from an auth
  // builder may only mutate the QUERY STRING, not the pathname. This
  // is a defense-in-depth guarantee: a buggy or compromised builder
  // can't silently retarget the upstream request to a different
  // endpoint within the broker's allowed prefix.
  //
  // The check sits in route.ts, which is hard to unit-test directly
  // without standing up a full Next request. We exercise the
  // underlying invariant here by simulating what the builder returns
  // and what the route's URL+pathname comparison would compute.

  function simulateRouteCheck(
    inboundPathWithQuery: string,
    builderOverride: string | undefined,
    base: string,
    pathPrefix: string,
  ): { allowed: boolean; reason?: string } {
    const inbound = new URL(inboundPathWithQuery, base);
    const baseOrigin = new URL(base).origin;
    if (builderOverride === undefined) return { allowed: true };
    let overridden: URL;
    try {
      overridden = new URL(builderOverride, base);
    } catch {
      return { allowed: false, reason: "unparseable" };
    }
    if (overridden.origin !== baseOrigin) {
      return { allowed: false, reason: "wrong origin" };
    }
    if (!overridden.pathname.startsWith(pathPrefix)) {
      return { allowed: false, reason: "wrong prefix" };
    }
    if (overridden.pathname !== inbound.pathname) {
      return { allowed: false, reason: "pathname changed" };
    }
    return { allowed: true };
  }

  const base = "https://api.snaptrade.com";
  const prefix = "/api/v1/";

  it("allows query-string-only mutation (the SnapTrade case)", () => {
    const r = simulateRouteCheck(
      "/api/v1/accounts",
      "/api/v1/accounts?clientId=ABC&timestamp=123",
      base,
      prefix,
    );
    expect(r.allowed).toBe(true);
  });

  it("rejects pathname mutation even within the allowed prefix", () => {
    // Builder tries to retarget /api/v1/accounts → /api/v1/positions.
    // Same prefix, same origin — but a different endpoint.
    const r = simulateRouteCheck(
      "/api/v1/accounts",
      "/api/v1/positions",
      base,
      prefix,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("pathname changed");
  });

  it("rejects pathname mutation that escapes the prefix", () => {
    const r = simulateRouteCheck(
      "/api/v1/accounts",
      "/api/v1/../v0/admin",
      base,
      prefix,
    );
    expect(r.allowed).toBe(false);
    // URL parsing normalizes `..` so the pathname becomes /v0/admin —
    // wrong prefix is the first failure.
    expect(r.reason).toBe("wrong prefix");
  });

  it("rejects an absolute URL targeting a foreign host", () => {
    const r = simulateRouteCheck(
      "/api/v1/accounts",
      "https://evil.com/api/v1/accounts",
      base,
      prefix,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("wrong origin");
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
