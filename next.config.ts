import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ['192.168.0.176'],

  // Same-origin Firebase auth handler (Option 3 of
  // https://firebase.google.com/docs/auth/web/redirect-best-practices).
  //
  // The Google OAuth round-trip runs through `authDomain`. With the
  // default `<project>.firebaseapp.com` that whole dance is cross-origin
  // to the app, and WebKit's storage partitioning (all iOS browsers,
  // Safari 16.1+, Orion) severs it — the handler loses its sessionStorage
  // state mid-flow ("missing initial state" error page) or the result
  // never reaches the SDK's relay iframe (silent sign-in loop).
  //
  // These rewrites serve Firebase's handler through OUR origin, so
  // firebase.ts can point `authDomain` at the app's own host and the
  // popup/redirect flow never leaves it. Rewrites are transparent
  // proxies (not 302s), which is exactly what the Firebase doc requires.
  //
  // Coupled console config — see the authDomain comment in
  // src/lib/firebase.ts before adding hosts.
  async rewrites() {
    return [
      {
        source: "/__/auth/:path*",
        destination:
          "https://shared-portfolio-manager.firebaseapp.com/__/auth/:path*",
      },
      // Belt-and-braces: some handler versions fetch project config from
      // this reserved path relative to their own origin.
      {
        source: "/__/firebase/init.json",
        destination:
          "https://shared-portfolio-manager.firebaseapp.com/__/firebase/init.json",
      },
    ];
  },
};

export default nextConfig;
