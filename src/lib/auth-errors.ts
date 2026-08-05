/**
 * Firebase auth error codes → what the login card should show.
 *
 * Split out from the page so the disclosure policy is testable on its own.
 * The rule that matters: a password-reset request must never reveal whether
 * an account exists for the address. `auth/user-not-found` therefore maps to
 * the SAME confirmation as success.
 *
 * We don't collapse *every* failure into that confirmation, though — a
 * dropped connection would then silently lie to the user. Only the
 * enumeration-sensitive code is laundered; transport and rate-limit
 * failures surface honestly, because neither says anything about whether
 * the address is registered.
 *
 * (Firebase projects with Email Enumeration Protection enabled never throw
 * `auth/user-not-found` here — the SDK resolves as if it sent. That's the
 * same user-visible outcome as the mapping below, so the flow behaves
 * identically whether or not the setting is on.)
 */

export interface AuthMessage {
  /** "notice" renders in the accent box, "error" in the negative box. */
  kind: "notice" | "error";
  text: string;
}

/** Shown on success AND on unknown-account. Deliberately identical. */
export const RESET_SENT_TEXT =
  "If an account exists for that email, we've sent a reset link. Check your spam folder.";

/**
 * Map the outcome of `sendPasswordResetEmail` to a message.
 * Call with no argument for the success path.
 */
export function resetLinkOutcome(code?: string): AuthMessage {
  switch (code) {
    case undefined:
    // Not-found is laundered into the success confirmation: telling the
    // user "no account for that email" turns this form into an oracle
    // for which addresses are registered.
    case "auth/user-not-found":
      return { kind: "notice", text: RESET_SENT_TEXT };

    case "auth/invalid-email":
    case "auth/missing-email":
      return {
        kind: "error",
        text: "That doesn't look like a valid email address.",
      };

    case "auth/too-many-requests":
      return {
        kind: "error",
        text: "Too many attempts. Wait a few minutes and try again.",
      };

    case "auth/network-request-failed":
      return {
        kind: "error",
        text: "Couldn't reach the server. Check your connection and try again.",
      };

    default:
      return {
        kind: "error",
        text: "Couldn't send the reset link. Try again.",
      };
  }
}
