"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The standalone Activity tab was folded into Friends as a subtab.
 * Anyone hitting /activity (saved bookmark, in-app link from older
 * builds, deep-link from a notification) lands on the right place:
 * the Activity subtab inside Friends.
 */
export default function ActivityRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/friends?view=activity");
  }, [router]);
  return null;
}
