import { describe, it, expect } from "vitest";
import { resetLinkOutcome, RESET_SENT_TEXT } from "./auth-errors";

describe("resetLinkOutcome", () => {
  it("confirms on success", () => {
    expect(resetLinkOutcome()).toEqual({
      kind: "notice",
      text: RESET_SENT_TEXT,
    });
  });

  // The whole point of the module: an unknown address must be
  // indistinguishable from a known one.
  it("gives unknown accounts the exact same response as success", () => {
    expect(resetLinkOutcome("auth/user-not-found")).toEqual(
      resetLinkOutcome(),
    );
  });

  it("surfaces a malformed address", () => {
    const out = resetLinkOutcome("auth/invalid-email");
    expect(out.kind).toBe("error");
    expect(out.text).toMatch(/valid email/i);
  });

  it("surfaces rate limiting", () => {
    const out = resetLinkOutcome("auth/too-many-requests");
    expect(out.kind).toBe("error");
    expect(out.text).toMatch(/wait/i);
  });

  // A dropped connection must NOT be laundered into "we sent it" — that
  // would tell the user to go check an inbox that will stay empty.
  it("surfaces a network failure instead of claiming success", () => {
    const out = resetLinkOutcome("auth/network-request-failed");
    expect(out.kind).toBe("error");
    expect(out.text).not.toBe(RESET_SENT_TEXT);
  });

  it("falls back to a generic error for unrecognized codes", () => {
    const out = resetLinkOutcome("auth/internal-error");
    expect(out.kind).toBe("error");
    expect(out.text).not.toBe(RESET_SENT_TEXT);
  });

  it("never leaks the failing code into the message", () => {
    for (const code of [
      "auth/user-not-found",
      "auth/invalid-email",
      "auth/too-many-requests",
      "auth/network-request-failed",
      "auth/some-future-code",
    ]) {
      expect(resetLinkOutcome(code).text).not.toContain(code);
    }
  });
});
