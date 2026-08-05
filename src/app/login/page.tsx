"use client";

import { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  linkWithPopup,
  linkWithCredential,
  EmailAuthProvider,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { ensureUserProfile } from "@/lib/users";
import { resetLinkOutcome } from "@/lib/auth-errors";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/lib/theme";

/** The card is one component in three modes rather than three routes. */
type Mode = "signin" | "register" | "reset";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Mode>("signin");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const isRegister = mode === "register";
  const isReset = mode === "reset";

  // Stale messages from the previous mode are confusing at best and
  // misleading at worst ("we sent a reset link" sitting above a sign-in
  // form), so every mode switch clears them.
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setNotice("");
  };

  // After auth resolves, just push home — the EnrollmentGate handles
  // routing to onboarding for unenrolled users, and useEncryption
  // silently auto-unlocks anyone who's already enrolled. Login itself
  // doesn't need to know about encryption state.
  //
  // Anonymous sessions (a visitor arriving from a share link) are
  // UPGRADED in place where possible — linkWithCredential/linkWithPopup
  // keeps the same UID so nothing about the session is lost. If the
  // credential already belongs to a real account, fall back to a plain
  // sign-in (the anonymous session is discarded; it owned nothing).
  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const anon = auth.currentUser?.isAnonymous ? auth.currentUser : null;
      let user;
      if (isRegister) {
        if (anon) {
          try {
            const cred = await linkWithCredential(
              anon,
              EmailAuthProvider.credential(email, password),
            );
            user = cred.user;
          } catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (
              code === "auth/email-already-in-use" ||
              code === "auth/credential-already-in-use"
            ) {
              user = (await signInWithEmailAndPassword(auth, email, password))
                .user;
            } else {
              throw err;
            }
          }
        } else {
          user = (await createUserWithEmailAndPassword(auth, email, password))
            .user;
        }
      } else {
        user = (await signInWithEmailAndPassword(auth, email, password)).user;
      }
      await ensureUserProfile(user);
      router.push("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to authenticate");
    } finally {
      setLoading(false);
    }
  };

  // Password reset. The account password and the encryption key hierarchy
  // are independent — resetting one does nothing to the other — so there's
  // no key material to touch here, just the Firebase call.
  //
  // Outcome mapping (incl. the deliberate no-account-oracle) lives in
  // auth-errors.ts.
  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    try {
      await sendPasswordResetEmail(auth, email);
      const out = resetLinkOutcome();
      setNotice(out.text);
    } catch (err: unknown) {
      const out = resetLinkOutcome((err as { code?: string }).code);
      if (out.kind === "notice") setNotice(out.text);
      else setError(out.text);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError("");
    try {
      const anon = auth.currentUser?.isAnonymous ? auth.currentUser : null;
      let user;
      if (anon) {
        try {
          user = (await linkWithPopup(anon, new GoogleAuthProvider())).user;
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (
            code === "auth/credential-already-in-use" ||
            code === "auth/email-already-in-use"
          ) {
            user = (await signInWithPopup(auth, new GoogleAuthProvider())).user;
          } else {
            throw err;
          }
        }
      } else {
        user = (await signInWithPopup(auth, new GoogleAuthProvider())).user;
      }
      await ensureUserProfile(user);
      router.push("/");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to sign in with Google"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col">
      <header className="px-6 lg:px-10 pt-6">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium tracking-tight">Recharge</div>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm animate-fade-up">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold tracking-tight mb-2">
              {isRegister
                ? "Create account"
                : isReset
                ? "Reset password"
                : "Welcome back"}
            </h1>
            <p className="text-sm text-fg-dim">
              {isRegister
                ? "Start tracking your portfolio."
                : isReset
                ? "We'll email you a link to set a new one."
                : "Sign in to continue."}
            </p>
          </div>

          <div className="card p-6">
            {error && (
              <div className="mb-4 border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
                {error}
              </div>
            )}

            {notice && (
              <div className="mb-4 border border-accent/40 bg-accent/10 text-fg text-sm rounded-md p-3 space-y-2">
                <p>{notice}</p>
                {/* Someone mid-reset will reasonably fear they're about to
                    lose their portfolio. They aren't — say so here. */}
                <p className="text-xs text-fg-dim">
                  Resetting your password doesn&apos;t affect your encrypted
                  data. You&apos;ll stay unlocked on this browser; on a new one
                  you&apos;ll need your 12-word recovery phrase.
                </p>
              </div>
            )}

            <form
              onSubmit={isReset ? handleResetRequest : handleEmailAuth}
              className="space-y-3"
            >
              <div>
                <label className="label block mb-1.5">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@domain.com"
                  className="field"
                  required
                />
              </div>
              {!isReset && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="label">Password</label>
                    {mode === "signin" && (
                      <button
                        type="button"
                        onClick={() => switchMode("reset")}
                        className="text-xs text-fg-dim hover:text-accent underline underline-offset-4 decoration-line transition"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="field"
                    required
                  />
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full disabled:opacity-50"
              >
                {loading
                  ? "…"
                  : isRegister
                  ? "Create account"
                  : isReset
                  ? "Send reset link"
                  : "Sign in"}
              </button>
            </form>

            {/* Google is an alternative way to *sign in*; it has no meaning
                on a form whose only job is to email a link. */}
            {!isReset && (
              <>
            <div className="my-5 flex items-center gap-3">
              <div className="flex-1 h-px bg-line" />
              <span className="text-xs text-fg-fade">or</span>
              <div className="flex-1 h-px bg-line" />
            </div>

            <button
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="btn-ghost w-full flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 24c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 21.53 7.7 24 12 24z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.43 14.97 0 12 0 7.7 0 3.99 2.47 2.18 6.07l3.66 2.84c.87-2.6 3.3-4.16 6.16-4.16z"
                />
              </svg>
              Continue with Google
            </button>
              </>
            )}
          </div>

          <p className="mt-5 text-center text-sm text-fg-dim">
            {isReset
              ? "Remembered it? "
              : isRegister
              ? "Already have an account? "
              : "Don't have an account? "}
            <button
              onClick={() =>
                switchMode(isRegister || isReset ? "signin" : "register")
              }
              className="text-fg hover:text-accent underline underline-offset-4 decoration-line transition"
            >
              {isRegister || isReset ? "Sign in" : "Create one"}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
