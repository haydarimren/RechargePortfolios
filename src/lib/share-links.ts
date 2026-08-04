"use client";

/**
 * Share-link data layer: token lifecycle, snapshot publish/read, the
 * follow redeem sequence, and the small browser-storage helpers the
 * funnel uses. Pure math lives in share-links-math.ts; this module owns
 * crypto wiring + Firestore I/O.
 *
 * Capability model: the raw token exists only in the share URL's
 * fragment and in the owner's ownerTokenWrap ciphertext. Firestore only
 * ever sees sha256(token) (doc ID) and ciphertext. The server cannot
 * decrypt a snapshot, and a snapshot cannot decrypt holdings.
 */

import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  bytesToHex,
  decryptJson,
  deriveAesKeyFromSecret,
  encryptJson,
  type Ciphertext,
} from "./crypto-client";
import { buildSnapshotV1, type SnapshotV1 } from "./share-links-math";
import { buildComparisonSeries, normalizeSeries, poolPositions } from "./portfolio";
import {
  getCachedHistoricalCloses,
  getCachedHistoricalSeries,
} from "./historical-cache";
import {
  convertHoldingsToUsd,
  convertPointsToUsd,
  currenciesInHoldings,
  fxSymbol,
} from "./currency";
import type { HistoricalPoint } from "./yahoo";
import type { Holding } from "./types";

const SNAPSHOT_INFO = "share-link-snapshot";
const OWNER_WRAP_INFO = "share-link-token";
const BENCHMARKS = ["SPY", "QQQ"] as const;

// ---------- token + URL ----------------------------------------------------

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlToBytes = (s: string): Uint8Array => {
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** 16 random bytes, base64url (22 chars, no padding). */
export function generateShareToken(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return b64url(buf);
}

export function shareLinkUrl(
  origin: string,
  portfolioId: string,
  token: string,
): string {
  return `${origin}/s/${portfolioId}#t=${token}`;
}

/** Parse `#t=<token>` from a location.hash string. Null when absent/malformed. */
export function parseShareTokenFromHash(hash: string): string | null {
  const m = /^#t=([A-Za-z0-9_-]{22})$/.exec(hash);
  return m ? m[1] : null;
}

/** sha256 of the token string (UTF-8), hex — the shareLinks doc ID. */
export async function tokenHashHex(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token) as BufferSource,
  );
  return bytesToHex(new Uint8Array(digest));
}

// ---------- crypto ----------------------------------------------------------

export async function encryptSnapshot(
  snap: SnapshotV1,
  token: string,
): Promise<Ciphertext> {
  const key = await deriveAesKeyFromSecret(b64urlToBytes(token), SNAPSHOT_INFO);
  return encryptJson(snap, key);
}

export async function decryptSnapshot(
  ct: Ciphertext,
  token: string,
): Promise<SnapshotV1> {
  const key = await deriveAesKeyFromSecret(b64urlToBytes(token), SNAPSHOT_INFO);
  return decryptJson<SnapshotV1>(ct, key);
}

export async function wrapTokenForOwner(
  token: string,
  masterSecret: Uint8Array,
): Promise<Ciphertext> {
  const key = await deriveAesKeyFromSecret(masterSecret, OWNER_WRAP_INFO);
  return encryptJson(token, key);
}

export async function unwrapTokenForOwner(
  wrapped: Ciphertext,
  masterSecret: Uint8Array,
): Promise<string> {
  const key = await deriveAesKeyFromSecret(masterSecret, OWNER_WRAP_INFO);
  return decryptJson<string>(wrapped, key);
}

// ---------- snapshot building (owner side, async fetches) ------------------

/**
 * Build the full SnapshotV1 for a portfolio: baselines from the decoded
 * holdings + the normalized benchmark curve (same pipeline the detail
 * page chart uses: buildComparisonSeries → normalizeSeries).
 */
/**
 * Daily {currency}→USD closes for every non-USD currency these holdings
 * touch. Mirrors the `useFxSeries` hook the pages use — same cached
 * fetch path, just callable outside React.
 */
async function loadFxSeries(
  holdings: Holding[],
): Promise<Record<string, HistoricalPoint[]>> {
  const currencies = currenciesInHoldings(holdings);
  if (currencies.length === 0) return {};
  let firstDate: string | null = null;
  for (const h of holdings) {
    if (!firstDate || h.purchaseDate < firstDate) firstDate = h.purchaseDate;
  }
  if (!firstDate) return {};
  const fromMs = new Date(firstDate).getTime() - 14 * 24 * 60 * 60 * 1000;
  const toMs = Date.now();
  const entries = await Promise.all(
    currencies.map((ccy) =>
      getCachedHistoricalCloses(fxSymbol(ccy), fromMs, toMs).then(
        (pts) => [ccy, pts] as const,
      ),
    ),
  );
  return Object.fromEntries(entries.filter(([, pts]) => pts.length > 0));
}

export async function buildSnapshotForPortfolio(input: {
  holdings: Holding[];
  name: string;
  ownerName: string;
}): Promise<SnapshotV1> {
  // Restate everything in USD first. The snapshot is percent-only, but
  // percentages of a sum that mixed GBP and EUR are just as wrong as the
  // sum was — and the benchmark it's normalized against is a USD
  // instrument. Fetched here rather than passed in so every caller of
  // this builder inherits it.
  const fxByCurrency = await loadFxSeries(input.holdings);
  const holdings = convertHoldingsToUsd(input.holdings, fxByCurrency);

  const pooled = poolPositions(holdings);
  let normalizedSeries: SnapshotV1["series"] = [];
  if (pooled.length > 0) {
    const firstDate = pooled
      .map((p) => p.firstPurchaseDate)
      .reduce((a, b) => (a < b ? a : b));
    const fromMs = new Date(firstDate).getTime() - 14 * 24 * 60 * 60 * 1000;
    const toMs = Date.now();
    const symbols = Array.from(new Set(pooled.map((p) => p.symbol)));
    const yahooBySymbol = new Map<string, string>();
    for (const h of holdings) {
      if (h.yahooSymbol && !yahooBySymbol.has(h.symbol)) {
        yahooBySymbol.set(h.symbol, h.yahooSymbol);
      }
    }
    const results = await Promise.all([
      ...symbols.map((s) =>
        getCachedHistoricalSeries(yahooBySymbol.get(s) ?? s, fromMs, toMs).then(
          (ser) =>
            [
              s,
              convertPointsToUsd(ser.points, ser.currency, fxByCurrency),
            ] as const,
        ),
      ),
      ...BENCHMARKS.map((b) =>
        getCachedHistoricalCloses(b, fromMs, toMs).then(
          (pts) => [`__bench__${b}`, pts] as const,
        ),
      ),
    ]);
    const priceMap: Record<string, HistoricalPoint[]> = {};
    const benchMap: Record<string, HistoricalPoint[]> = {};
    for (const [key, pts] of results) {
      if (key.startsWith("__bench__")) benchMap[key.slice("__bench__".length)] = pts;
      else priceMap[key] = pts;
    }
    normalizedSeries = normalizeSeries(
      buildComparisonSeries(holdings, priceMap, benchMap),
    );
  }
  return buildSnapshotV1({
    name: input.name,
    ownerName: input.ownerName,
    holdings,
    nativeHoldings: input.holdings,
    normalizedSeries,
    asOf: Date.now(),
  });
}

// ---------- Firestore I/O ---------------------------------------------------

export interface ShareLinkDoc {
  tokenHash: string; // doc id
  payload: string;
  iv: string;
  ownerTokenWrap: Ciphertext;
  createdAt: number;
  updatedAt: number;
}

function shareLinksCol(portfolioId: string) {
  return collection(db, "portfolios", portfolioId, "shareLinks");
}

/** Owner-only (rules): fetch the portfolio's single link doc, or null. */
export async function getShareLinkDocForOwner(
  portfolioId: string,
): Promise<ShareLinkDoc | null> {
  const snap = await getDocs(shareLinksCol(portfolioId));
  const d = snap.docs[0];
  if (!d) return null;
  const data = d.data();
  return {
    tokenHash: d.id,
    payload: data.payload as string,
    iv: data.iv as string,
    ownerTokenWrap: data.ownerTokenWrap as Ciphertext,
    createdAt: data.createdAt as number,
    updatedAt: data.updatedAt as number,
  };
}

/** Create a fresh link: new token, full doc write. Returns the token. */
export async function createShareLink(
  portfolioId: string,
  snapshot: SnapshotV1,
  masterSecret: Uint8Array,
): Promise<string> {
  const token = generateShareToken();
  const hash = await tokenHashHex(token);
  const ct = await encryptSnapshot(snapshot, token);
  const ownerTokenWrap = await wrapTokenForOwner(token, masterSecret);
  await setDoc(doc(shareLinksCol(portfolioId), hash), {
    payload: ct.payload,
    iv: ct.iv,
    ownerTokenWrap,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
  });
  return token;
}

export async function revokeShareLink(
  portfolioId: string,
  tokenHash: string,
): Promise<void> {
  await deleteDoc(doc(shareLinksCol(portfolioId), tokenHash));
}

/**
 * Re-encrypt + write the snapshot for an EXISTING link, skipping the
 * write when content (minus asOf) is unchanged. Returns what happened.
 */
export async function republishSnapshotIfChanged(
  portfolioId: string,
  link: ShareLinkDoc,
  masterSecret: Uint8Array,
  fresh: SnapshotV1,
): Promise<"unchanged" | "published"> {
  const token = await unwrapTokenForOwner(link.ownerTokenWrap, masterSecret);
  let current: SnapshotV1 | null = null;
  try {
    current = await decryptSnapshot({ payload: link.payload, iv: link.iv }, token);
  } catch {
    // Corrupt/illegible current payload — overwrite unconditionally.
  }
  const comparable = (s: SnapshotV1) => JSON.stringify({ ...s, asOf: 0 });
  if (current && comparable(current) === comparable(fresh)) return "unchanged";
  const ct = await encryptSnapshot(fresh, token);
  await setDoc(
    doc(shareLinksCol(portfolioId), link.tokenHash),
    { payload: ct.payload, iv: ct.iv, updatedAt: Date.now() },
    { merge: true },
  );
  return "published";
}

/** Anyone-with-the-link read path (anonymous included). Throws on miss. */
export async function readSnapshotByToken(
  portfolioId: string,
  token: string,
): Promise<SnapshotV1> {
  const hash = await tokenHashHex(token);
  const snap = await getDoc(doc(shareLinksCol(portfolioId), hash));
  if (!snap.exists()) throw new Error("share link not found");
  const data = snap.data();
  return decryptSnapshot(
    { payload: data.payload as string, iv: data.iv as string },
    token,
  );
}

// ---------- follow redeem ---------------------------------------------------

/**
 * The signed-in redeem: (1) create followRequests/{uid} carrying the
 * tokenHash (rules verify the link exists), then (2) self-append to
 * sharedWith (rules verify the followRequest exists). arrayUnion is
 * exactly the old-set ∪ {uid} the rule demands. Idempotent per uid.
 */
export async function redeemFollow(
  portfolioId: string,
  token: string,
  uid: string,
): Promise<void> {
  const hash = await tokenHashHex(token);
  await setDoc(doc(db, "portfolios", portfolioId, "followRequests", uid), {
    tokenHash: hash,
    createdAt: Date.now(),
  });
  await updateDoc(doc(db, "portfolios", portfolioId), {
    sharedWith: arrayUnion(uid),
  });
}

/** Owner-side cleanup at delete time: best-effort sweep of both subcollections. */
export async function deleteShareArtifacts(portfolioId: string): Promise<void> {
  for (const colName of ["shareLinks", "followRequests"] as const) {
    try {
      const snap = await getDocs(collection(db, "portfolios", portfolioId, colName));
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    } catch {
      // best-effort
    }
  }
}

// ---------- browser storage helpers (funnel state) -------------------------

const INTENT_KEY = "followIntent";
const pendingKey = (pid: string) => `pendingLinkToken:${pid}`;

export interface FollowIntent {
  pid: string;
  token: string;
}

export function stashFollowIntent(intent: FollowIntent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {}
}

export function readFollowIntent(): FollowIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FollowIntent;
    if (typeof parsed.pid !== "string" || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearFollowIntent(): void {
  try {
    sessionStorage.removeItem(INTENT_KEY);
  } catch {}
}

/** Pending-full-access viewer hint: lets /p/{pid} render the snapshot
 *  tier until the owner's next session wraps K_portfolio. */
export function setPendingLinkToken(pid: string, token: string): void {
  try {
    localStorage.setItem(pendingKey(pid), token);
  } catch {}
}

export function getPendingLinkToken(pid: string): string | null {
  try {
    return localStorage.getItem(pendingKey(pid));
  } catch {
    return null;
  }
}

export function clearPendingLinkToken(pid: string): void {
  try {
    localStorage.removeItem(pendingKey(pid));
  } catch {}
}
