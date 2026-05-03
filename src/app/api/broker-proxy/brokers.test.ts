import { describe, it, expect } from "vitest";
import { isServerBrokerId, SERVER_BROKERS } from "./brokers";

describe("isServerBrokerId", () => {
  it("accepts known broker keys", () => {
    expect(isServerBrokerId("trading212")).toBe(true);
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
    const headers = SERVER_BROKERS.trading212.auth("key123:secret456");
    // Pre-registry route did exactly: `Basic ${Buffer.from(cred).toString("base64")}`.
    const expected = `Basic ${Buffer.from("key123:secret456").toString("base64")}`;
    expect(headers).toEqual({ Authorization: expected });
  });
});
