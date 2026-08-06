import { describe, it, expect } from "vitest";
import { isEmbeddedWebView } from "./browser-env";

/**
 * Real user-agent strings, abbreviated only where irrelevant. The stakes
 * are asymmetric: a false positive shows a harmless hint under the Google
 * button; a false negative means the user hits Google's raw
 * `403 disallowed_useragent` page. Lean toward flagging.
 */

const REAL_BROWSERS: Record<string, string> = {
  "iOS Safari":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "iOS Chrome":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  "iOS Firefox":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  "macOS Chrome":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // Orion identifies as Safari — same engine, same UA shape.
  "macOS Safari / Orion":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Android Chrome":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
};

const WEBVIEWS: Record<string, string> = {
  // Instagram's iOS in-app browser: WKWebView — no `Safari/` token, plus
  // an explicit Instagram marker.
  "Instagram iOS":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.4.32.98 (iPhone16,1; iOS 17_5; en_GB; en; scale=3.00; 1179x2556)",
  "Facebook iOS":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/467.0.0.28.109;FBDV/iPhone15,3;FBSN/iOS]",
  // Android WebView keeps the `Safari/` token but carries the `; wv)`
  // build flag — detection must not rely on missing-Safari alone.
  "Facebook Android (WebView)":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240505.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/467.0.0.28.109]",
  "Generic Android WebView":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240505.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36",
  // Bare WKWebView (e.g. a mail client's built-in browser): no marker,
  // but `Mobile/` without a trailing `Safari/` token gives it away.
  "Generic iOS WKWebView":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "TikTok iOS":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_33.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/GB",
  "LinkedIn iOS":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.2492",
};

describe("isEmbeddedWebView", () => {
  for (const [name, ua] of Object.entries(REAL_BROWSERS)) {
    it(`does not flag ${name}`, () => {
      expect(isEmbeddedWebView(ua)).toBe(false);
    });
  }

  for (const [name, ua] of Object.entries(WEBVIEWS)) {
    it(`flags ${name}`, () => {
      expect(isEmbeddedWebView(ua)).toBe(true);
    });
  }

  it("does not flag an empty or nonsense UA", () => {
    expect(isEmbeddedWebView("")).toBe(false);
    expect(isEmbeddedWebView("curl/8.6.0")).toBe(false);
  });
});
