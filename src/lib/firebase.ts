import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";

// Hosts where /__/auth/* is reverse-proxied to the Firebase auth handler
// (see rewrites in next.config.ts). On these origins the whole OAuth
// popup/redirect dance is same-origin with the app, which is what stops
// WebKit's storage partitioning from severing the round-trip — the
// "Google sign-in broken on every iPhone" bug.
//
// A host may ONLY be added here after BOTH console steps are done:
//   1. Google Cloud console → APIs & Services → Credentials → the
//      auto-created OAuth "Web client" → Authorized redirect URIs →
//      add https://<host>/__/auth/handler
//   2. Firebase console → Authentication → Settings → Authorized
//      domains → <host> is listed
// Listing a host without step 1 breaks Google sign-in there for
// EVERYONE (redirect_uri_mismatch), desktop included.
//
// Unlisted hosts (Vercel previews, localhost — whose redirect URIs
// can't/needn't be registered; the SDK also forces https on authDomain,
// which rules localhost out anyway) fall back to the cross-origin
// default: sign-in there works on desktop browsers but not on iOS.
const AUTH_PROXY_HOSTS = new Set(["recharge-portfolios.vercel.app"]);

const authDomain =
  typeof window !== "undefined" && AUTH_PROXY_HOSTS.has(window.location.host)
    ? window.location.host
    : "shared-portfolio-manager.firebaseapp.com";

const firebaseConfig = {
  apiKey: "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o",
  authDomain,
  projectId: "shared-portfolio-manager",
  storageBucket: "shared-portfolio-manager.firebasestorage.app",
  messagingSenderId: "61362598574",
  appId: "1:61362598574:web:0eed28a14c99f42bde733f",
  measurementId: "G-QNXGSZMZD9"
};

// Initialize Firebase securely to avoid re-initialization
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Tell Firestore to *auto-detect* whether to use BiDi streaming or long-polling
// rather than its default of always trying streaming first. On some networks /
// proxies / browsers the streaming handshake fails on cold opens and the SDK
// waits 30-60s before retrying — during which onSnapshot delivers no first
// snapshot and the home page sits in a misleading "empty" state.
//
// Important: this is NOT a revert of 30904dd. That revert pulled out
// `experimentalForceLongPolling`, which forced long-polling unconditionally and
// produced a 20-req/s retry storm with no backoff on Orion/WebKit. Auto-detect
// keeps streaming as the happy path and only falls back when the SDK detects
// streaming is failing — which is the actual fix for the cold-open stall
// without bringing back the retry-storm pathology.
//
// `experimentalLongPollingOptions.timeoutSeconds: 5` keeps individual long-poll
// requests short once the SDK has fallen back, so a stuck poll can't add
// another 30s on top.
//
// Must run before any getFirestore() call. The global flag prevents HMR
// re-imports from double-initializing Firestore (which throws).
if (
  typeof window !== "undefined" &&
  !(globalThis as { __recharge_firestore?: true }).__recharge_firestore
) {
  try {
    initializeFirestore(app, {
      // Persist Firestore's cache to IndexedDB so a REOPENED tab serves data
      // from local disk instantly, instead of re-running the cold-open
      // WebChannel handshake (which stalls ~30s on some networks/browsers)
      // before the first read lands. The cache holds the same CIPHERTEXT the
      // server does — holdings stay encrypted on disk, decryptable only with
      // the in-memory keys — so this adds no plaintext-holdings exposure;
      // only already-public portfolio names land in IndexedDB. Multi-tab
      // manager so several open tabs share one cache without conflicting.
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
      experimentalAutoDetectLongPolling: true,
      experimentalLongPollingOptions: { timeoutSeconds: 5 },
    });
    (globalThis as { __recharge_firestore?: true }).__recharge_firestore = true;
  } catch {
    // Already initialized (HMR, double-mount). getFirestore() below will
    // return the existing instance.
  }
}

// App Check — attaches a reCAPTCHA v3 attestation token to every Firebase
// request so someone who copies our web config can't hit our quota from
// their own site. Browser-only; no-op during SSR/build. The reCAPTCHA site
// key is public by design (it's served to every client anyway).
if (typeof window !== "undefined") {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(
        "6Ld0iMQsAAAAACteZku6YXv0H6_pZMXJlCGL6odh",
      ),
      isTokenAutoRefreshEnabled: true,
    });
  } catch {
    // App Check may throw if already initialized (HMR, double-mount).
    // Safe to ignore — the initial call succeeded.
  }
}

export const auth = getAuth(app);
export const db = getFirestore(app);
