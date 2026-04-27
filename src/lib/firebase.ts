import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";

const firebaseConfig = {
  apiKey: "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o",
  authDomain: "shared-portfolio-manager.firebaseapp.com",
  projectId: "shared-portfolio-manager",
  storageBucket: "shared-portfolio-manager.firebasestorage.app",
  messagingSenderId: "61362598574",
  appId: "1:61362598574:web:0eed28a14c99f42bde733f",
  measurementId: "G-QNXGSZMZD9"
};

// Initialize Firebase securely to avoid re-initialization
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

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
