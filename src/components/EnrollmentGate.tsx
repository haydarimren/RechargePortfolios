"use client";

/**
 * App-wide enforcement gate: any signed-in user who hasn't yet enrolled in
 * end-to-end encryption is funneled into the onboarding flow before they
 * can reach any protected route.
 *
 * Why a hard gate (not a soft prompt or a settings toggle):
 *   - The whole product promise is "your friends can't see your holdings."
 *     A user who skips enrollment defeats that promise quietly.
 *   - Mixed state (some users enrolled, some not) creates a long tail of
 *     edge cases — e.g. an unenrolled user can't be added as a sharer on
 *     someone else's encrypted portfolio. Forcing enrollment on first
 *     login eliminates that whole class.
 *
 * Behavior:
 *   - On `/login` and any `/onboarding/...` path: pass through. Those
 *     pages handle their own auth flow, and gating onboarding itself
 *     would loop.
 *   - On every other route, when encryption state is `uninitialized`
 *     (signed in, no `users/{uid}.publicKey`): redirect to
 *     `/onboarding/encryption` AND block render in the meantime so the
 *     user doesn't briefly see the protected page contents.
 *   - All other states (loading / no-user / locked / needs-recovery /
 *     unlocked) pass through to the page itself, where the existing
 *     UnlockModal handles in-place unlocking.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useEncryption } from "@/lib/use-encryption";

const ONBOARDING_PATH = "/onboarding/encryption";

function isPublicPath(pathname: string): boolean {
  // /login is a separate auth flow with its own redirect logic.
  // /onboarding/... is where unenrolled users go — gating it would loop.
  return pathname === "/login" || pathname.startsWith("/onboarding/");
}

export function EnrollmentGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const encryption = useEncryption();

  const onPublic = isPublicPath(pathname);

  useEffect(() => {
    if (onPublic) return;
    if (encryption.state.kind === "uninitialized") {
      router.replace(ONBOARDING_PATH);
    }
  }, [encryption.state.kind, onPublic, router]);

  // Block render of protected pages until the redirect fires. Without
  // this, the user briefly sees the protected page (often with a loading
  // spinner) before bouncing — looks like a flash.
  if (!onPublic && encryption.state.kind === "uninitialized") {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-fg-dim">
        Setting up encryption…
      </div>
    );
  }

  return <>{children}</>;
}
