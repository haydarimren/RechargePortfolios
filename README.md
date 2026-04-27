# Shared Portfolio Tracker

A stock portfolio tracker built for sharing trades with friends. Record your
buys and sells, see how each position has performed since purchase, compare
your portfolio against a hypothetical SPY or QQQ investment over the same
period, and share read-only views with friends so you can see what each other
are actually trading.

Built with Next.js 16, React 19, Tailwind v4, and Firebase (Auth + Firestore).

> **Live demo:** https://recharge-portfolios.vercel.app/

## Why this exists

Most portfolio trackers are either (a) brokerage walled gardens you can't
share, or (b) generic tools that show you a number without context. I wanted
something that:

- Shows each lot's performance against its own purchase date, not a blended
  time-weighted return.
- Lets friends see each other's trades without exchanging screenshots or
  revealing total net worth.
- Answers the question "would I have been better off just buying the index?"
  with an honest per-lot comparison, not a TWRR fudge.

## Features

- **Firebase Auth** — email/password + Google sign-in.
- **Portfolios with lot-level holdings.** Each buy is its own lot; same-ticker
  lots get aggregated into one row with a weighted-average cost basis.
- **Benchmark comparison.** For every lot, the app computes what the same
  dollars would be worth today had they gone into SPY or QQQ on the same day.
  Plots the portfolio-vs-benchmark curve on a daily timeline.
- **Trade Logbook.** Chronological buy/sell feed with UK Section 104 pooling
  (no FIFO lot matching). Shared viewers see weight % and realized % only —
  no dollar amounts.
- **Shared portfolios.** Invite a friend by UID; they get read-only access.
  Unread-trade indicators on the home card and Logbook tab clear on view.
- **End-to-end encryption.** Holdings, lot prices, and broker credentials
  are encrypted in the browser before they reach Firestore. The server
  stores ciphertext only and cannot decrypt anything at rest — not even
  the operator with full database access. On enrollment the browser
  generates a 12-word BIP39 recovery phrase (the user's master secret);
  for daily use that phrase is unwrapped from an Argon2id-derived key
  cached in IndexedDB, so login is silent. Sharing a portfolio re-wraps
  its per-portfolio AES-GCM key for the recipient using ECDH P-256 — the
  server only ferries already-wrapped key blobs.
- **Trading 212 sync.** Paste an API key, pull your actual positions and
  order history in one click. The key is encrypted client-side under
  your master secret before it ever hits Firestore; sync runs in the
  browser and the server is a dumb auth-gated relay that forwards the
  HTTP request and returns the response without reading the body.
  (Note: Trading 212 **Pies** — including Social Pies — aren't supported;
  the public API doesn't expose pie holdings. Only regular Invest / ISA
  positions sync.)
- **Dual theme.** A dark "terminal" mode (Geist + blue accent) and a light
  "paper" mode (IBM Plex + ink-blue accent). Persisted to localStorage,
  zero-flash via a blocking inline script.

## Architecture highlights

- **Client-rendered with live Firestore subscriptions** (`onSnapshot`). Every
  page gates on `onAuthStateChanged`; writes are optimistic and the snapshot
  reconciles.
- **End-to-end crypto stack** in [`src/lib/crypto-client.ts`](src/lib/crypto-client.ts).
  Master secret (16 random bytes, encoded as a 12-word BIP39 phrase) wraps
  an ECDH P-256 identity keypair stored at `users/{uid}.wrappedPrivateKey`.
  Each portfolio has its own AES-GCM data key; that key is wrapped per
  recipient and stored at `portfolios/{id}/wrappedKeys/{uid}`. Sharing
  fetches the recipient's `publicKey`, derives a shared secret via ECDH,
  re-wraps the portfolio key, and writes it — the server never sees an
  unwrapped key. Revocation deletes the recipient's wrappedKey doc.
- **Auth-gated dumb broker relay** at
  [`src/app/api/broker-proxy/route.ts`](src/app/api/broker-proxy/route.ts).
  Brokers don't set permissive CORS, so the browser can't call them
  directly. The proxy verifies a Firebase ID token, forwards the call
  with the user-supplied auth header, and returns the response untouched
  — no body logging, no persistence. Outbound destination and path
  prefix are hardcoded server-side as the SSRF guard.
- **Section 104 pooling** in [`src/lib/portfolio.ts`](src/lib/portfolio.ts).
  Single-pool weighted-average cost, no lot matching — matches how HMRC
  actually treats UK retail trades.
- **Benchmark math.** Per-lot hypothetical: `cost × benchmark_close(today) /
  benchmark_close(purchaseDate)`. At each timeline day, only include lots
  with `purchaseDate ≤ that day`. No cash-flow neutralization required.
- **Semantic color tokens backed by CSS variables.** Tailwind v4 `@theme`
  tokens point at CSS vars scoped by `[data-theme="..."]`, so every
  `bg-bg` / `text-accent` class resolves at runtime from the active theme.
- **App Check with reCAPTCHA v3** attests every Firestore request so the
  public web config can't be used to burn quota from a different origin.
- **Server actions** for external APIs. All market data flows through Yahoo
  Finance — one batch endpoint for live quotes (30s server cache) and one
  chart endpoint for historical closes (1h cache). Both are unofficial
  endpoints; Twelve Data is the documented fallback if they break.

## Data model

```
users/{uid}
  { displayName, publicKey, wrappedPrivateKey, encryptionEnrolledAt }
  // publicKey = ECDH P-256 SPKI hex; wrappedPrivateKey = AES-GCM under
  // master secret. No plaintext identity material ever reaches the server.

users/{uid}/portfolioViews/{portfolioId}
  { lastPortfolioViewAt, lastLogbookViewAt }  // drives unread badges

portfolios/{id}
  { ownerId, ownerEmail, name, sharedWith: string[], createdAt, encrypted: true }

portfolios/{id}/holdings/{hid}
  { payload, iv, createdAt, schemaVersion: 2 }
  // payload = AES-GCM ciphertext containing { symbol, shares,
  // purchasePrice, purchaseDate, side, importSource?, t212OrderId? }

portfolios/{id}/secrets/credentials
  { payload, iv, updatedAt }
  // Generic doc name (no broker name leak). Ciphertext holds the broker
  // identifier + credential under the user's master secret.

portfolios/{id}/wrappedKeys/{uid}
  { wrappedKey, wrappedBy, schemaVersion }
  // Per-recipient wrap of the portfolio AES-GCM key. One doc per user
  // with read access. Owner writes; recipients read their own.

portfolios/{id}/syncLogs/{lid}
  { timestamp, ordersImported, sellsImported, errors }
```

Firestore security rules restrict reads to the owner plus anyone in
`sharedWith`; writes to the owner only. `wrappedKeys/{uid}` is readable
by that uid (so they can fetch their own wrap) and the portfolio owner;
only the owner can write any wrappedKey doc.

## Running locally

```bash
npm install
npm run dev         # http://localhost:3000
npm run build       # typecheck + lint
npm run test        # vitest
```

Environment variables: **none required.** Trading 212 credentials are
encrypted client-side under each user's master secret before reaching
Firestore — the previous `T212_ENCRYPTION_KEY` env var is obsolete.
Market data comes from Yahoo Finance's public endpoints. Firebase client config is embedded in
[`src/lib/firebase.ts`](src/lib/firebase.ts); it's a public web config,
which is why App Check + Firestore rules exist.

To run end-to-end you'll need your own Firebase project with Auth
(Email/Password + Google) and Firestore enabled.

## Tech stack

- Next.js 16 (App Router, Turbopack) / React 19
- Firebase Auth, Firestore, App Check
- Tailwind CSS v4
- Recharts
- TypeScript, ESLint, Vitest

## License

MIT — see [LICENSE](LICENSE).
