/**
 * In-app browser (embedded WebView) detection.
 *
 * Why it matters: Google refuses OAuth inside embedded webviews
 * (`403 disallowed_useragent`), so "Continue with Google" is a dead end
 * there no matter how our auth is configured. The login card uses this
 * to show an "open in your browser" hint instead of letting the user
 * hit Google's raw error page. System-browser shells
 * (SFSafariViewController, Chrome Custom Tabs — what iMessage, WhatsApp
 * and Telegram links open in) are permitted by Google and present
 * browser-identical UAs — they must NOT be flagged.
 *
 * Two-pronged detection:
 *  - explicit markers the big apps append to their WebView UA
 *  - structural giveaways: Android's `; wv)` build flag, and iOS
 *    WKWebView's missing `Safari/` token (every real iOS browser —
 *    Safari, CriOS, FxiOS — carries one)
 *
 * The stakes are asymmetric — a false positive shows a harmless hint, a
 * false negative strands the user on Google's error page — so lean
 * toward flagging.
 */

const WEBVIEW_MARKERS =
  /FBAN|FBAV|FB_IAB|FB4A|FBIOS|Instagram|LinkedInApp|musical_ly|TikTok|BytedanceWebview|\bLine\/|MicroMessenger|Snapchat/i;

export function isEmbeddedWebView(ua: string): boolean {
  if (WEBVIEW_MARKERS.test(ua)) return true;
  // Android WebView advertises itself with a `; wv)` build flag — and
  // keeps the `Safari/` token, so the iOS heuristic below would miss it.
  if (/Android/i.test(ua) && /;\s*wv\)/.test(ua)) return true;
  // iOS WKWebView: `Mobile/` token without the trailing `Safari/` one.
  if (
    /iPhone|iPad|iPod/.test(ua) &&
    /Mobile\/\S+/.test(ua) &&
    !/Safari\//.test(ua)
  ) {
    return true;
  }
  return false;
}
