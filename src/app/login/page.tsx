"use client";

import { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { ensureUserProfile } from "@/lib/users";
import { getEncryptionStatus } from "@/lib/encryption-setup";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/lib/theme";

const ONBOARDING_HANDOFF_KEY = "recharge-signup-pw";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Decide where to send the user after auth resolves.
  //   - Brand-new email/password signup: hand off the password and go
  //     to onboarding directly. Saves a redirect bounce through the
  //     EnrollmentGate.
  //   - Anyone signing in with email/password who isn't enrolled yet:
  //     also hand off the password (for transparent reuse during
  //     onboarding) and let the EnrollmentGate redirect them from "/".
  //   - Anyone already enrolled, or any Google user: just go home and
  //     let the gate / unlock modal take it from there.
  const routeAfterAuth = async (
    uid: string,
    cachedPasswordForHandoff?: string,
  ) => {
    const status = await getEncryptionStatus(uid);
    const needsOnboarding = status.kind === "uninitialized";
    if (needsOnboarding && cachedPasswordForHandoff) {
      try {
        sessionStorage.setItem(
          ONBOARDING_HANDOFF_KEY,
          cachedPasswordForHandoff,
        );
      } catch {
        // sessionStorage unavailable in private modes — onboarding will
        // just prompt explicitly.
      }
    }
    // Always push to "/" — the EnrollmentGate decides if the user
    // should be funneled through onboarding from there. Single source
    // of truth for the unenrolled-redirect.
    router.push("/");
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const cred = isRegister
        ? await createUserWithEmailAndPassword(auth, email, password)
        : await signInWithEmailAndPassword(auth, email, password);
      await ensureUserProfile(cred.user);
      await routeAfterAuth(cred.user.uid, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to authenticate");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError("");
    try {
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      await ensureUserProfile(cred.user);
      // Google users have no Firebase password to hand off — onboarding
      // will prompt explicitly.
      await routeAfterAuth(cred.user.uid);
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
              {isRegister ? "Create account" : "Welcome back"}
            </h1>
            <p className="text-sm text-fg-dim">
              {isRegister
                ? "Start tracking your portfolio."
                : "Sign in to continue."}
            </p>
          </div>

          <div className="card p-6">
            {error && (
              <div className="mb-4 border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
                {error}
              </div>
            )}

            <form onSubmit={handleEmailAuth} className="space-y-3">
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
              <div>
                <label className="label block mb-1.5">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="field"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full disabled:opacity-50"
              >
                {loading
                  ? "…"
                  : isRegister
                  ? "Create account"
                  : "Sign in"}
              </button>
            </form>

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
          </div>

          <p className="mt-5 text-center text-sm text-fg-dim">
            {isRegister ? "Already have an account? " : "Don't have an account? "}
            <button
              onClick={() => setIsRegister(!isRegister)}
              className="text-fg hover:text-accent underline underline-offset-4 decoration-line transition"
            >
              {isRegister ? "Sign in" : "Create one"}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
