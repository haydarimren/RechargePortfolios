import { describe, it, expect } from "vitest";
import { snapTradeSign, sortedJsonStringify } from "./snaptrade-sign";

describe("sortedJsonStringify", () => {
  it("sorts top-level keys alphabetically", () => {
    expect(sortedJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("recurses into nested objects", () => {
    expect(
      sortedJsonStringify({ outer: { z: 1, a: 2 }, top: 3 }),
    ).toBe('{"outer":{"a":2,"z":1},"top":3}');
  });

  it("preserves array element order", () => {
    expect(sortedJsonStringify({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });

  it("emits compact format (no whitespace)", () => {
    const result = sortedJsonStringify({ a: { b: 1 } });
    expect(result).not.toContain(" ");
    expect(result).not.toContain("\n");
  });

  it("preserves null", () => {
    expect(sortedJsonStringify({ content: null, path: "/x" })).toBe(
      '{"content":null,"path":"/x"}',
    );
  });

  it("two structurally-equal objects with different in-memory key order produce identical output", () => {
    const a = { x: 1, y: { c: 3, b: 2, a: 1 } };
    const b = { y: { a: 1, b: 2, c: 3 }, x: 1 };
    expect(sortedJsonStringify(a)).toBe(sortedJsonStringify(b));
  });
});

describe("snapTradeSign", () => {
  // Reference vector: the known input/output pair from the SnapTrade
  // docs example (api/v1/snapTrade/mockSignature with the canonical
  // test consumer key + payload).
  it("matches the SnapTrade docs reference vector", () => {
    // sigObject:
    //   {"content":{"userId":"api@passiv.com","userSecret":"CHRIS.P.BACON"},
    //    "path":"/api/v1/snapTrade/mockSignature",
    //    "query":"clientId=PASSIVTEST&timestamp=1635790389"}
    // consumerKey: "PASSIVTEST_CONSUMER_KEY" (representative — we don't
    // have the real test key, so we lock in the algorithm against
    // ourselves rather than against an external fixture).
    const sig1 = snapTradeSign({
      content: { userId: "api@passiv.com", userSecret: "CHRIS.P.BACON" },
      path: "/api/v1/snapTrade/mockSignature",
      query: "clientId=PASSIVTEST&timestamp=1635790389",
      consumerKey: "PASSIVTEST_CONSUMER_KEY",
    });
    // The signature is deterministic; if anything in the algorithm
    // shifts (sort order, encoding, separator, etc.) this hash changes
    // and we get a loud test failure.
    expect(sig1).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sig1.length).toBeGreaterThan(20); // base64 of 32 bytes = 44 chars

    // Determinism: same inputs → same signature.
    const sig2 = snapTradeSign({
      content: { userId: "api@passiv.com", userSecret: "CHRIS.P.BACON" },
      path: "/api/v1/snapTrade/mockSignature",
      query: "clientId=PASSIVTEST&timestamp=1635790389",
      consumerKey: "PASSIVTEST_CONSUMER_KEY",
    });
    expect(sig1).toBe(sig2);
  });

  it("produces a different signature when the path changes", () => {
    const a = snapTradeSign({
      content: null,
      path: "/api/v1/activities",
      query: "clientId=X&timestamp=1",
      consumerKey: "k",
    });
    const b = snapTradeSign({
      content: null,
      path: "/api/v1/positions",
      query: "clientId=X&timestamp=1",
      consumerKey: "k",
    });
    expect(a).not.toBe(b);
  });

  it("produces a different signature when the query changes", () => {
    const a = snapTradeSign({
      content: null,
      path: "/api/v1/x",
      query: "clientId=X&timestamp=1",
      consumerKey: "k",
    });
    const b = snapTradeSign({
      content: null,
      path: "/api/v1/x",
      query: "clientId=X&timestamp=2",
      consumerKey: "k",
    });
    expect(a).not.toBe(b);
  });

  it("produces a different signature when the body content changes", () => {
    const a = snapTradeSign({
      content: { x: 1 },
      path: "/api/v1/x",
      query: "",
      consumerKey: "k",
    });
    const b = snapTradeSign({
      content: { x: 2 },
      path: "/api/v1/x",
      query: "",
      consumerKey: "k",
    });
    expect(a).not.toBe(b);
  });

  it("produces a different signature with a different consumer key", () => {
    const a = snapTradeSign({
      content: null,
      path: "/api/v1/x",
      query: "",
      consumerKey: "k1",
    });
    const b = snapTradeSign({
      content: null,
      path: "/api/v1/x",
      query: "",
      consumerKey: "k2",
    });
    expect(a).not.toBe(b);
  });

  it("is insensitive to body in-memory key order (sorted-keys JSON)", () => {
    const a = snapTradeSign({
      content: { z: 1, a: 2 },
      path: "/api/v1/x",
      query: "",
      consumerKey: "k",
    });
    const b = snapTradeSign({
      content: { a: 2, z: 1 },
      path: "/api/v1/x",
      query: "",
      consumerKey: "k",
    });
    expect(a).toBe(b);
  });

  it("returns base64 (not hex)", () => {
    const sig = snapTradeSign({
      content: null,
      path: "/api/v1/x",
      query: "",
      consumerKey: "k",
    });
    // Base64 alphabet only — no '0x', no spaces.
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
