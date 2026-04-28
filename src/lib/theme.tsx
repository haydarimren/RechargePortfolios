"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

export type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") setThemeState(attr);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("theme", t);
    } catch {}
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className={`inline-flex items-center gap-px rounded-full border border-line p-0.5 text-xs ${className}`}
      role="group"
      aria-label="Theme"
    >
      <button
        onClick={() => setTheme("dark")}
        className={`px-2.5 py-1 rounded-full transition ${
          theme === "dark"
            ? "bg-fg text-bg"
            : "text-fg-fade hover:text-fg"
        }`}
        aria-pressed={theme === "dark"}
      >
        Dark
      </button>
      <button
        onClick={() => setTheme("light")}
        className={`px-2.5 py-1 rounded-full transition ${
          theme === "light"
            ? "bg-fg text-bg"
            : "text-fg-fade hover:text-fg"
        }`}
        aria-pressed={theme === "light"}
      >
        Light
      </button>
    </div>
  );
}

/**
 * Chart colors that follow the current theme. Use instead of hardcoded hex
 * so the Recharts SVGs update when the user toggles.
 */
export function useChartColors() {
  const { theme } = useTheme();
  if (theme === "light") {
    return {
      portfolio: "#2f4f7d",
      benchmark: "#7a8a9c",
      benchmark2: "#b0895a",
      ticker: "#2f4f7d",
      dot: "#c08a1a",
      dotStroke: "#f7f5f1",
      sellDot: "#b3432b",
      sellDotStroke: "#f7f5f1",
      grid: "#d8d3c8",
      axis: "#8a867e",
      tooltipBg: "#ffffff",
      tooltipBorder: "#d8d3c8",
      tooltipText: "#1a1a1a",
      tooltipLabel: "#8a867e",
      pos: "#3d7a4f",
      neg: "#a84a3e",
      // Tile palette is its own thing: tiles work like stained glass against
      // the card, all dark enough that one white text color always reads.
      // Borders match the card surface so the gaps look like negative space,
      // not extra strokes.
      tileNeutral: "#a89f8d",
      tilePos: "#2f6043",
      tileNeg: "#7e3a2f",
      tileBorder: "#efece6",
      tileText: "#ffffff",
      tileTextDim: "#e6e0d4",
      // Bright accent text for the % line: same color family as the tile,
      // amped up so it reads against the dark tile fill. These are reused
      // across themes since both theme variants render dark tiles.
      tileGainText: "#7be0b1",
      tileLossText: "#f29ea2",
    };
  }
  return {
    portfolio: "#5b8def",
    benchmark: "#6ea888",
    benchmark2: "#d4a05c",
    ticker: "#5b8def",
    dot: "#e8c168",
    dotStroke: "#111418",
    sellDot: "#e86a6a",
    sellDotStroke: "#111418",
    grid: "#242932",
    axis: "#6c7380",
    tooltipBg: "#161a1f",
    tooltipBorder: "#2f3642",
    tooltipText: "#e6e8eb",
    tooltipLabel: "#6c7380",
    pos: "#56c69c",
    neg: "#e87e83",
    // See comment in light-theme branch.
    tileNeutral: "#2a2f38",
    tilePos: "#1f5e3f",
    tileNeg: "#7a2f2c",
    tileBorder: "#161a1f",
    tileText: "#eef2f5",
    tileTextDim: "#9ba6b3",
    tileGainText: "#7be0b1",
    tileLossText: "#f29ea2",
  };
}
