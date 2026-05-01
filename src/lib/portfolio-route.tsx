"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Ownership = "owner" | "viewer" | null;

interface PortfolioRouteContextValue {
  /**
   * Current portfolio's ownership relative to the signed-in user, or null
   * when not in a portfolio detail context (or portfolio hasn't loaded yet).
   */
  ownership: Ownership;
  setOwnership: (o: Ownership) => void;
}

const PortfolioRouteContext = createContext<PortfolioRouteContextValue>({
  ownership: null,
  setOwnership: () => {},
});

/**
 * Provider that lets the deepest portfolio detail / drilldown page tell
 * the AppShell which tab to highlight (`Mine` for owner, `Friends` for
 * viewer). Without this, the shell can't know — `/p/[id]` is the same URL
 * shape regardless of ownership.
 */
export function PortfolioRouteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [ownership, setOwnershipState] = useState<Ownership>(null);
  // Stabilize the setter so consumers can put it in deps without churn.
  const setOwnership = useCallback((o: Ownership) => {
    setOwnershipState(o);
  }, []);
  return (
    <PortfolioRouteContext.Provider value={{ ownership, setOwnership }}>
      {children}
    </PortfolioRouteContext.Provider>
  );
}

export function usePortfolioRoute(): PortfolioRouteContextValue {
  return useContext(PortfolioRouteContext);
}

/**
 * Convenience hook for portfolio pages: publishes ownership while mounted,
 * clears it on unmount. Pass `null` until the portfolio has loaded; once
 * ownership is known, pass `true` (owner) or `false` (viewer).
 */
export function usePublishPortfolioOwnership(isOwner: boolean | null): void {
  const { setOwnership } = usePortfolioRoute();
  useEffect(() => {
    if (isOwner === null) return;
    setOwnership(isOwner ? "owner" : "viewer");
    return () => setOwnership(null);
  }, [isOwner, setOwnership]);
}
