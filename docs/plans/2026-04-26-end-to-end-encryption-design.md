# End-to-End Encryption for Shared Portfolios

## Context

The app currently stores all portfolio holdings as plaintext in Firestore. To broaden adoption beyond the current 5–6 users, the "the app owner can see everyone's holdings" property is a legitimate trust blocker. This design adds end-to-end encryption (E2E) so that holdings, prices, quantities, dates, and Trading 212 credentials are never readable by the server — only by the user who owns them and the friends they explicitly share with.

**Promise to users:** *"Your holdings are encrypted on your device before they reach our servers. Even if our database is breached or our staff turn malicious, only you and the friends you've granted access to can read your portfolio."*

## Threat model

**Encrypted (private):**
- Holding rows: `symbol`, `shares`, `purchasePrice`, `purchaseDate`
- Trading 212 API credentials at rest

**Plaintext (acceptable metadata):**
- User identity (email, UID, public key)
- Portfolio existence, name, `sharedWith` array, `createdAt`
- The set of stock symbols currently being queried for live quotes
- Holding `createdAt` (kept plaintext so the existing trade-notification feature can flag unread trades)

Server is a TLS-terminating relay. It may briefly see plaintext during T212 sync proxying but never persists it. Modeled after Bitwarden / ProtonMail.

## Cryptographic primitives

All via the Web Crypto API; no external crypto libraries.

- **Identity keypair per user:** ECDH P-256.
- **Master secret:** 16 random bytes, encoded as a 12-word BIP39 recovery phrase.
- **Daily-login wrapping:** master secret wrapped under an Argon2id-derived key (~250ms target on a phone) from the user's encryption password. Stored in IndexedDB.
- **Cross-device recovery:** identity private key wrapped under master secret, stored at `users/{uid}.wrappedPrivateKey`. Server holds ciphertext only.
- **Per-portfolio symmetric key (`K_portfolio`):** AES-GCM-256.
- **Per-friend wrapping of `K_portfolio`:** ECDH(owner_priv, friend_pub) → AES-KW.

## Onboarding & key custody

**First-time signup:**
1. Sign up with email/password or Google (Firebase Auth, unchanged).
2. Browser generates identity keypair + master secret.
3. Recovery-phrase modal: 12 words shown, three-word confirmation gate, no skip.
4. Email/password users: encryption password transparently reuses Firebase password (one prompt total).
5. Google users: explicit "set encryption password" field on the same modal.
6. Server gets `users/{uid}.publicKey` (plaintext) + `users/{uid}.wrappedPrivateKey` (ciphertext).
7. IndexedDB gets the wrapped master secret.

**Daily login (same device):**
1. Sign in.
2. Prompt for encryption password → unwrap master secret → unwrap identity private key.

**New device / cleared browser:**
1. Sign in.
2. No IndexedDB state → prompt for recovery phrase.
3. Derive master secret → fetch `wrappedPrivateKey` from server → unwrap → seed IndexedDB.

**Forgot password (still has phrase):**
1. Enter phrase + new password → re-wrap master secret in IndexedDB. Data preserved.

**Lost phrase + lost password:** unrecoverable. Mirrors WhatsApp.

## Sharing model

Per-portfolio symmetric key, re-wrapped per friend (Signal group / sender-key model).

**Create portfolio (Alice):**
1. Generate `K_portfolio`.
2. Wrap under Alice's public key → `portfolios/{id}/wrappedKeys/alice`.
3. Write `portfolios/{id}` with `encrypted: true` flag.

**Add holding:**
1. Decrypt `K_portfolio` (cached in session memory).
2. Encrypt fields → write `{ payload, iv, createdAt, schemaVersion }`.

**Share with Bob:**
1. Fetch `users/{bob}.publicKey`. If missing → fail with *"Bob hasn't enabled encryption — ask them to log in once."*
2. ECDH-derive wrapping key → wrap `K_portfolio` → write `portfolios/{id}/wrappedKeys/bob`.
3. Add `bob` to `sharedWith`.

**Revoke Bob:**
1. Generate fresh `K_portfolio_v2`.
2. Re-encrypt every holding doc under v2.
3. Wrap v2 under remaining sharers' keys.
4. Delete Bob's wrappedKey doc, remove from `sharedWith`.
5. Single Firestore batch.
6. UI honesty: *"Bob loses access to future updates. Anything already viewed may have been kept."*

## Trading 212 sync

**Storage:** T212 secret encrypted under user's master secret, written client-side. Server cannot decrypt at rest. `T212_ENCRYPTION_KEY` env var removed; server-side `src/lib/crypto.ts` deleted.

**Sync click:**
1. Browser decrypts T212 secret.
2. Browser unwraps `K_portfolio`.
3. Browser runs the entire orchestration (pagination, ISIN map, exchange-letter normalization, retry-on-429) — logic ported from `src/lib/trading212.ts`.
4. Each T212 HTTP call goes through `POST /api/t212-proxy` — auth-gated dumb relay that forwards the request and returns the response unread, unwritten.
5. Browser encrypts holdings under `K_portfolio`, writes ciphertext docs.

**Server exposure during sync:** T212 auth header + response bodies in memory ~50ms per request, never persisted, never logged.

## Quote fetching & client-side computation

Server-side Yahoo quote fetching stays (`src/lib/finnhub.ts`, `src/lib/yahoo.ts`). Browser decrypts holdings → extracts symbols → calls server quote action by symbol.

**Acceptable leak:** server learns "user X queried symbols [AAPL, MSFT, ASTS]." Quantities, prices, dates remain encrypted.

**Moves client-side:** `aggregateHoldings`, `closeOnOrBefore`, `buildComparisonSeries` from `src/lib/portfolio.ts` — same pure functions, called after decryption.

**Performance:** 30-symbol portfolio → ~2s first paint, ~50ms cached. Friend's view identical.

## Migration

Per-user, atomic, no plaintext fallback retained.

1. User signs in. App reads `users/{uid}.publicKey`. Missing → migration mode.
2. Onboarding modal (recovery phrase + encryption password if Google).
3. Background, for each portfolio the user owns:
   - Generate `K_portfolio`.
   - For each plaintext holding: encrypt fields, write ciphertext, delete plaintext fields. Single Firestore batch per portfolio.
   - Wrap `K_portfolio` under owner's public key.
   - For each `sharedWith` UID that already has a `publicKey`: wrap `K_portfolio` for them too. Skip those without.
   - Set `portfolios/{id}.encrypted = true`.
4. Re-share reconnection: when an owner loads a portfolio, browser walks `sharedWith`, finds any UID with `publicKey` but no wrappedKey doc, silently writes the wrap.

**Coexistence during rollout:** a portfolio's encryption state is owned by its owner's migration state. Pre-migration portfolios stay plaintext (legacy code path active until owner signs in). No forced timeline; users migrate at their own pace.

## Firestore schema additions

```
users/{uid}
  publicKey: <hex>                  // ECDH P-256, plaintext
  wrappedPrivateKey: <hex>          // ciphertext, server cannot decrypt

portfolios/{id}
  encrypted: true                   // present once migrated
  // existing: ownerId, name, sharedWith, createdAt — unchanged

portfolios/{id}/wrappedKeys/{uid}
  wrappedKey: <hex>                 // K_portfolio wrapped under {uid}'s public key
  schemaVersion: 1

portfolios/{id}/holdings/{holdingId}
  payload: <hex>                    // ciphertext: { symbol, shares, purchasePrice, purchaseDate }
  iv: <hex>
  createdAt: <plaintext ms>         // kept plaintext for trade-notification feature
  schemaVersion: 1

portfolios/{id}/secrets/trading212
  apiKey: <hex>                     // ciphertext under user's master secret
```

## Firestore rules additions

```
match /users/{userId} {
  // existing read-by-anyone rule covers publicKey access
  // wrappedPrivateKey already protected by `request.auth.uid == userId`
}

match /portfolios/{portfolioId}/wrappedKeys/{uid} {
  allow read: if request.auth.uid == uid
              || request.auth.uid == get(/databases/$(database)/documents/portfolios/$(portfolioId)).data.ownerId;
  allow write: if request.auth.uid == get(/databases/$(database)/documents/portfolios/$(portfolioId)).data.ownerId;
}
```

## Files to touch

**New:**
- `src/lib/crypto-client.ts` — Web Crypto wrappers: `generateIdentityKey`, `wrap/unwrap`, `encryptHolding`, `decryptHolding`, `deriveFromPassword`, `seedToPhrase`, `phraseToSeed`.
- `src/lib/recovery-phrase.ts` — BIP39 word-list + encode/decode 16-byte seeds.
- `src/lib/key-store.ts` — IndexedDB session-state management (wrapped master secret, in-memory unwrapped key cache).
- `src/lib/trading212-client.ts` — port of `src/lib/trading212.ts` to browser, all HTTP via `/api/t212-proxy`.
- `src/app/api/t212-proxy/route.ts` — auth-gated dumb relay (~50 lines).
- `src/app/onboarding/encryption/page.tsx` — recovery-phrase modal + password setup.
- `src/lib/migration.ts` — one-shot per-user portfolio migration.

**Modified:**
- `src/app/login/page.tsx` — post-auth, route to encryption setup if `users/{uid}.publicKey` missing; otherwise unlock prompt.
- `src/app/page.tsx` — gated on key unlock; surface "friend hasn't enabled encryption" hints in share UI.
- `src/app/portfolios/[id]/page.tsx` — decrypt holdings client-side; sync via `trading212-client.ts`; share modal checks recipient's `publicKey`.
- `src/app/portfolios/[id]/[symbol]/page.tsx` — same decryption path on drilldown.
- `src/lib/types.ts` — `Holding` gains `payload`/`iv`/`schemaVersion` fields; legacy plaintext fields kept optional during migration window only.

**Deleted:**
- `src/lib/crypto.ts` (server-side AES-GCM helper) — T212 secret encryption moves client-side.
- `fetchTrading212Orders` server action in `src/lib/trading212.ts` — replaced by browser + proxy. File deleted entirely.

**Env vars removed:**
- `T212_ENCRYPTION_KEY`.

## Suggested phasing

The full design is large enough that one PR is risky. Suggested phases:

1. **Phase 1 — Crypto foundations + onboarding (no behavior change yet).** Add `crypto-client.ts`, `recovery-phrase.ts`, `key-store.ts`. Login detects "no publicKey" and walks new signups through onboarding. Existing users still see plaintext path.
2. **Phase 2 — Encrypted holdings + per-user migration on next login.** Wire encryption into create-holding / read-holding paths. Migration runs on login if unmigrated.
3. **Phase 3 — Sharing rewrite.** Per-portfolio key, wrappedKeys subcollection, revoke flow.
4. **Phase 4 — T212 proxy + client-side sync.** Replace server-side `trading212.ts` with browser logic + proxy route.
5. **Phase 5 — Cleanup.** Delete `src/lib/crypto.ts`, `T212_ENCRYPTION_KEY`, plaintext-fallback code paths once telemetry confirms all users migrated.

Each phase ships independently. Phases 1–2 already deliver "own holdings encrypted." Phase 3 unlocks the "share with friends" promise. Phase 4 closes the T212-secret-at-rest gap. Phase 5 is housekeeping.

## Verification

1. `npm run build` passes TS + lint.
2. **Fresh signup (email/password):** recovery-phrase modal appears, three-word confirm gate works, lands on empty home with IndexedDB populated.
3. **Add manual holding:** holding appears, page reload still shows it. Firestore inspection: doc has `payload` + `iv`, no plaintext `symbol`/`shares`/etc.
4. **T212 sync:** connect API key (Firestore secret doc is ciphertext), click Sync, server logs show only proxy metadata (status/latency), no bodies. Holdings appear, all docs ciphertext.
5. **Share with account B:** B has logged in and has a `publicKey`. Add B's UID. B sees the portfolio after refresh.
6. **Revoke B:** remove B from share. B sees "no access" on refresh. A's view still works.
7. **New device (incognito):** sign in, recovery-phrase prompt, paste 12 words, portfolio loads.
8. **Forgot password:** enter phrase + new password, portfolio still loads.
9. **Pre-migration sharer hits a migrated portfolio:** A migrated, B not. B sees a "this portfolio uses encryption you haven't enabled yet" message. After B onboards and A reloads (which silently writes B's wrappedKey), B sees the portfolio.
10. **Yahoo quotes:** confirm prices render for symbols decrypted from ciphertext holdings.
11. **Owner viewing own pre-migration portfolio:** plaintext path still works for users who haven't completed onboarding.
12. **Cross-tab sanity:** open two tabs as the same user, edit in one, the other receives the live update and decrypts correctly.

## Out of scope (deliberately)

- Forward secrecy on portfolio access (overkill — not a messenger).
- Encryption of portfolio name (low signal, complicates UX).
- Hiding the symbol-list metadata leak from quotes path.
- Account deletion cleanup of dangling wrappedKey docs (manual script when needed).
- Browser environments without IndexedDB (modern browsers all support it).
- Screenshot prevention on shared views.
