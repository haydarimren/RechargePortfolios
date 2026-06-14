"use client";

/**
 * React-free broker-sync engine. Lifted verbatim from the portfolio
 * detail page's `runHandleSync` so the auto-sync coordinator can run a
 * sync for portfolios whose page isn't mounted. The ONLY differences
 * from the original are the substitutions required to leave React:
 *
 *   - State that used to be read off the component (`holdings`,
 *     `portfolioKey`, `user`, `unlocked`) is resolved up-front here:
 *     the portfolio key via `loadPortfolioKeyWithRetry`, holdings via
 *     `loadHoldingsOnce`. Both are passed/derived from `SyncContext`.
 *   - Every React setter (`setSyncError`, `setSyncResults`,
 *     `setConnectFields`, `setShowImport`, `setSyncLoading`) is gone.
 *     Early bails return a `{ ran:false, reason }` outcome instead of
 *     `setSyncError(msg); return;`; the success path returns the import
 *     counters. The page wrapper maps the outcome back onto React
 *     state (and keeps the UI-only form-clearing).
 *
 * The credential resolution, both lock guards, both SnapTrade
 * account-superset checks, the fetch, the holdings write, the
 * positions-authoritative reconciler, the rollback, and the encrypted
 * syncLog write are all preserved branch-for-branch. Reviewers diff
 * this against the original `runHandleSync`.
 */

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Holding } from "@/lib/types";
import type { UnlockedState } from "@/lib/key-store";
import {
  loadHoldingsOnce,
  loadPortfolioKeyWithRetry,
  updateHoldingFields,
} from "@/lib/holdings-repo";
import { reconcileToPositionUnits } from "@/lib/portfolio";
import {
  decryptBrokerCredential,
  encryptBrokerCredential,
  encryptHolding,
  encryptJson,
} from "@/lib/crypto-client";
import { BROKERS } from "./registry";
import type { BrokerId } from "./ids";
import type { ImportResult, SnapTradeDiagnostics, SyncTiming } from "./types";
import {
  deriveLockedBroker,
  snaptradeAccountIdsFromHoldings,
} from "./sync-lock";
import { parseSnaptradeAccountIds } from "./snaptrade/sync";
import { cleanT212Symbol } from "./trading212/symbols";

export interface SyncContext {
  portfolioId: string;
  uid: string;
  unlocked: UnlockedState; // from "@/lib/key-store"
  credentialOverride?: string; // manual fresh-paste; else decrypt stored credential
  brokerIdHint?: BrokerId; // manual picker's chosen broker
}

export type SyncReason =
  | "ok"
  | "no-credentials"
  | "corrupt-credentials"
  | "broker-mismatch"
  | "lock-mismatch"
  | "account-set-mismatch"
  | "no-key";

export interface SyncOutcome {
  ran: boolean; // true iff the adapter fetch + writes executed without a thrown error
  reason: SyncReason;
  buys: number;
  sells: number;
  skipped: number;
  partialFillsSkipped: number;
  errors: string[];
  diagnostics: SnapTradeDiagnostics | null;
  timing: SyncTiming | null;
}

/** Zero-counter outcome helper for the early bails that never reach the
 *  adapter. `ran` is always false for these. */
function bail(reason: SyncReason): SyncOutcome {
  return {
    ran: false,
    reason,
    buys: 0,
    sells: 0,
    skipped: 0,
    partialFillsSkipped: 0,
    errors: [],
    diagnostics: null,
    timing: null,
  };
}

export async function runBrokerSync(ctx: SyncContext): Promise<SyncOutcome> {
  // Resolve K_portfolio up front. The page read this off a non-null
  // React state (`portfolioKey`) that was populated when the portfolio
  // unlocked; here we resolve it ourselves. loadPortfolioKeyWithRetry
  // THROWS if it can't resolve — treat that as the "no-key" early bail.
  let portfolioKey: CryptoKey;
  try {
    portfolioKey = await loadPortfolioKeyWithRetry(
      ctx.portfolioId,
      ctx.uid,
      ctx.unlocked.privateKey,
    );
  } catch {
    return bail("no-key");
  }

  // One-shot decoded holdings — replaces `holdings`, `holdingsRef.current`,
  // and `decodedCurrent` from the page (all the same live-subscription
  // array there). portfolioKey is non-null on success above, so encrypted
  // docs decode.
  const holdings = await loadHoldingsOnce(ctx.portfolioId, portfolioKey);

  // Resolve the broker. The picker's choice (`brokerIdHint`) wins; absent
  // that (auto-sync has no picker), derive the lock from holdings. Null
  // means a manual-only portfolio with nothing to sync.
  const provider = ctx.brokerIdHint ?? deriveLockedBroker(holdings);
  if (!provider) return bail("no-credentials");
  const adapter = BROKERS[provider];

  // Lock enforcement (UX rail; server can't see broker identity to
  // enforce). Re-derive from the freshly-loaded `holdings` so we catch
  // any holdings added by a concurrent sync. Mirrors the page's
  // `liveLocked` check.
  const locked = deriveLockedBroker(holdings);
  if (locked && locked !== provider) {
    return bail("lock-mismatch");
  }

  // SnapTrade gets a second-tier lock: the credential's account set C
  // must be a SUPERSET of the live lock set L (every account that
  // contributed lots must be synced — that's what keeps the fully-sold
  // sweep safe). Re-derive L from the freshly-loaded holdings. The
  // picker UI already enforces this for the happy path; this is
  // defense-in-depth so any caller (retry, scripted, auto-sync) can't
  // slip past the lock.
  const liveLockedSnaptradeSet =
    provider === "snaptrade"
      ? snaptradeAccountIdsFromHoldings(holdings)
      : new Set<string>();
  if (
    provider === "snaptrade" &&
    ctx.credentialOverride &&
    liveLockedSnaptradeSet.size > 0
  ) {
    const incoming = new Set(parseSnaptradeAccountIds(ctx.credentialOverride));
    const missing = [...liveLockedSnaptradeSet].filter(
      (id) => !incoming.has(id),
    );
    if (missing.length > 0) {
      return bail("account-set-mismatch");
    }
  }
  // Single generic secrets doc per portfolio. The provider name (e.g.
  // "trading212") is stamped inside the encrypted payload, never on
  // the doc path.
  const secretRef = doc(
    db,
    "portfolios",
    ctx.portfolioId,
    "secrets",
    "credentials",
  );

  // Resolve a plaintext API key for this sync.
  //   - Fresh paste (`credentialOverride`): plaintext in hand, write ciphertext.
  //   - Stored `secrets/credentials` doc: `{ payload, iv }` envelope —
  //     decrypt under master secret. The eager migration on home-page
  //     load already renamed any legacy `secrets/trading212` to this
  //     path, so by the time sync runs we shouldn't see the old name.
  let plaintextKey: string;
  let needsWriteBack = false;
  if (ctx.credentialOverride) {
    plaintextKey = ctx.credentialOverride;
    needsWriteBack = true;
  } else {
    const secretSnap = await getDoc(secretRef);
    const data = secretSnap.exists() ? secretSnap.data() : null;
    if (
      data &&
      typeof data.payload === "string" &&
      typeof data.iv === "string"
    ) {
      try {
        // decryptBrokerCredential returns `{brokerId, credential}`.
        // For T212/Alpaca the credential is the bare `key:secret`
        // string. For SnapTrade it's the JSON-encoded 5-field BYO
        // blob. The adapter knows how to parse its own shape.
        const decoded = await decryptBrokerCredential(
          { payload: data.payload, iv: data.iv },
          ctx.unlocked.masterSecret,
        );
        // Sanity: doc says it's broker X, picker says Y → refuse.
        if (decoded.brokerId !== provider) {
          return bail("broker-mismatch");
        }
        plaintextKey = decoded.credential;
      } catch {
        return bail("corrupt-credentials");
      }
    } else {
      return bail("no-credentials");
    }
  }

  const errors: string[] = [];
  let buys = 0;
  let sells = 0;
  let skipped = 0;
  // Captured from the adapter result so the `finally` syncLog write
  // can persist the redacted SnapTrade decision trace (encrypted
  // under the portfolio key). Null for non-SnapTrade brokers.
  let syncDiagnostics: SnapTradeDiagnostics | null = null;
  let syncTiming: SyncTiming | null = null;
  let partialFillsSkipped = 0;
  // Belt-and-braces re-sync check: if we read a stored credential
  // (no credentialOverride) and its account set doesn't cover the live
  // lock set derived from holdings, refuse rather than silently sync a
  // subset (which would let the fully-sold sweep zero positions held
  // in the uncovered accounts). The per-holding account tag now comes
  // from each ImportedOrder (the adapter stamps the source account
  // per leg), not from a single credential-level id.
  if (
    provider === "snaptrade" &&
    !ctx.credentialOverride &&
    liveLockedSnaptradeSet.size > 0
  ) {
    const stored = new Set(parseSnaptradeAccountIds(plaintextKey));
    const missing = [...liveLockedSnaptradeSet].filter((id) => !stored.has(id));
    if (missing.length > 0) {
      return bail("account-set-mismatch");
    }
  }
  try {
    if (needsWriteBack) {
      // Client-side encrypt under master secret. The brokerId stamped
      // INSIDE the encrypted payload tells future readers (us, on
      // re-sync) which broker the credential is for; the doc top
      // level stays generic so the server can't infer broker
      // identity from at-rest data.
      const env = await encryptBrokerCredential(
        { brokerId: provider, credential: plaintextKey },
        ctx.unlocked.masterSecret,
      );
      await setDoc(secretRef, {
        payload: env.payload,
        iv: env.iv,
        updatedAt: Date.now(),
      });
    }
    // The `isOrderKnown` predicate stops pagination as soon as a full
    // page of orders is already imported — adapters return orders
    // newest-first, so once we hit a fully-known page everything older
    // is also already imported. Repeat syncs drop from N pages to 1-2.
    //
    // Match BOTH on `brokerOrderId` (preferred — exact identity) AND
    // on shape (symbol + purchaseDate + shares) for legacy holdings
    // that predate broker-id tracking. The shape match uses a per-
    // broker symbol normalizer for `rawTicker` so that broker-specific
    // suffixes (T212's `_EQ`, etc.) are stripped before comparing
    // against the holding's normalized `symbol`.
    const normalizeRawTicker = (raw: string) =>
      provider === "trading212" ? cleanT212Symbol(raw) : raw;
    const isOrderKnown = (args: {
      orderId: string;
      rawTicker: string;
      purchaseDate: string;
      shares: number;
    }) => {
      for (const h of holdings) {
        if (h.brokerOrderId === args.orderId) return true;
      }
      const cleaned = normalizeRawTicker(args.rawTicker);
      for (const h of holdings) {
        if (h.brokerOrderId) continue; // covered by id check above
        if (h.symbol !== cleaned) continue;
        if (h.purchaseDate !== args.purchaseDate) continue;
        if (Math.abs(h.shares - args.shares) > 0.0001) continue;
        return true;
      }
      return false;
    };
    const result: ImportResult = await adapter.fetchOrders({
      credential: plaintextKey,
      isOrderKnown,
    });
    syncDiagnostics = result.diagnostics ?? null;
    syncTiming = result.timing ?? null;
    partialFillsSkipped = result.partialFillsSkipped;

    // Use the already-decoded `holdings` from the one-shot load. It's
    // the DECODED shape: for v2 docs, the dedup-by-brokerOrderId check
    // below would always fail against the raw `getDocs` shape
    // (brokerOrderId lives inside the encrypted payload there, not at
    // the doc top level). That bug caused every sync after the first to
    // double-import every order.
    const decodedCurrent = holdings;
    // Decisions are sequential (encrypt-then-write) but we can still
    // batch the Firestore round-trip for the new-doc writes. Backfill
    // updates of encrypted docs need a read-decrypt-merge-encrypt-write
    // cycle each, so they're not batchable — issue them serially.
    const newDocsBuffer: Array<{
      encryptedShape: Record<string, unknown>;
      plaintextShape: Record<string, unknown>;
    }> = [];

    for (const order of result.orders) {
      const existing = decodedCurrent.find(
        (h) => h.importSource === provider && h.brokerOrderId === order.id,
      );
      const byShape = existing
        ? undefined
        : decodedCurrent.find(
            (h) =>
              !h.brokerOrderId &&
              h.symbol === order.symbol &&
              h.purchaseDate === order.purchaseDate &&
              Math.abs(h.shares - order.shares) < 0.0001,
          );
      const target = existing ?? byShape;
      if (target) {
        // Backfill yahooSymbol/isin/symbol corrections — same logic as
        // before, but routed through updateHoldingFields so encrypted
        // docs go through decrypt-merge-encrypt rather than naively
        // updating top-level fields that don't exist on ciphertext docs.
        //
        // Also backfill brokerOrderId on holdings that were matched by
        // shape rather than by id — without this, the dedup-and-stop
        // optimization stays expensive forever on these holdings
        // (each shape lookup is O(holdings) instead of O(1)). After
        // one sync post-this-fix, future syncs are fully on the
        // cheap id path.
        const patch: Record<string, string | undefined> = {};
        if (order.yahooSymbol && target.yahooSymbol !== order.yahooSymbol) {
          patch.yahooSymbol = order.yahooSymbol;
        }
        if (!target.isin && order.isin) patch.isin = order.isin;
        if (order.symbol && target.symbol !== order.symbol) {
          patch.symbol = order.symbol;
        }
        if (!target.brokerOrderId) patch.brokerOrderId = order.id;
        if (Object.keys(patch).length > 0) {
          await updateHoldingFields(
            ctx.portfolioId,
            target.id,
            portfolioKey,
            patch,
          );
        }
        skipped++;
        continue;
      }
      // New holding. Pre-encrypt now so the write batch can be a single
      // round-trip at the end.
      const plaintextShape: Record<string, unknown> = {
        symbol: order.symbol,
        shares: order.shares,
        purchasePrice: order.purchasePrice,
        purchaseDate: order.purchaseDate,
        createdAt: Date.now(),
        importSource: provider,
        brokerOrderId: order.id,
        side: order.side,
      };
      if (order.currency) plaintextShape.currency = order.currency;
      if (order.isin) plaintextShape.isin = order.isin;
      if (order.yahooSymbol) plaintextShape.yahooSymbol = order.yahooSymbol;
      // SnapTrade holdings carry the account id of the leg's SOURCE
      // account (adapter-stamped, per leg) so the lock set and
      // account-removal cleanup can be derived from holdings.
      if (order.snaptradeAccountId) {
        plaintextShape.snaptradeAccountId = order.snaptradeAccountId;
      }

      // v2 shape: importSource and brokerOrderId go INSIDE the
      // encrypted payload along with every other field. The
      // Firestore doc top level only carries the envelope plus
      // createdAt and schemaVersion — nothing identifying the
      // broker.
      const ct = await encryptHolding(
        {
          symbol: order.symbol,
          shares: order.shares,
          purchasePrice: order.purchasePrice,
          purchaseDate: order.purchaseDate,
          side: order.side,
          currency: order.currency,
          isin: order.isin,
          yahooSymbol: order.yahooSymbol,
          importSource: provider,
          brokerOrderId: order.id,
          ...(order.snaptradeAccountId
            ? { snaptradeAccountId: order.snaptradeAccountId }
            : {}),
        },
        portfolioKey,
      );
      newDocsBuffer.push({
        plaintextShape,
        encryptedShape: {
          payload: ct.payload,
          iv: ct.iv,
          createdAt: plaintextShape.createdAt,
          schemaVersion: 2,
        },
      });
      if (order.side === "SELL") sells++;
      else buys++;
    }
    const batch = writeBatch(db);
    const holdingsCol = collection(
      db,
      "portfolios",
      ctx.portfolioId,
      "holdings",
    );
    for (const item of newDocsBuffer) {
      batch.set(doc(holdingsCol), item.encryptedShape);
    }
    await batch.commit();

    // --- Positions-authoritative reconciliation -------------------
    // The broker's position snapshot is the truth for CURRENT shares
    // (it already reflects every sale). SnapTrade's order window is
    // partial/mis-dated, so the Section-104 pool over stored lots can
    // disagree (a real sale dropped during import, mis-sided, or a
    // sync-dated synthetic sorting after — and erasing — an earlier
    // real sell). For each broker position, pool the actually-stored
    // holdings (with the UI's own function) and write/maintain ONE
    // canonical `pos-recon-` adjustment lot so the displayed net lands
    // exactly on the broker's units. Best-effort: a hiccup here must
    // not fail an otherwise-successful order import (onSnapshot
    // reconciles; same optimistic contract as the rest of sync).
    try {
      const recPositions = result.positions ?? [];
      if (recPositions.length > 0 && provider === "snaptrade") {
        const today = new Date().toISOString().split("T")[0];
        // Lots written THIS sync aren't in `decodedCurrent` yet (the
        // snapshot is async) — project them in memory so the pool is
        // accurate now.
        const projectedNew: Holding[] = newDocsBuffer.map((b, i) => {
          const p = b.plaintextShape;
          return {
            id: `__new_${i}`,
            symbol: String(p.symbol),
            shares: Number(p.shares),
            purchasePrice: Number(p.purchasePrice),
            purchaseDate: String(p.purchaseDate),
            createdAt: Number(p.createdAt ?? 0),
            side: p.side === "SELL" ? "SELL" : "BUY",
          };
        });
        const positionSymbols = new Set(recPositions.map((p) => p.symbol));

        // Legacy migration: per-account reconcilers
        // (pos-recon-{accountId}-{symbol}) predate the merged scheme.
        // Delete them outright (synthetic lots; deletion avoids
        // permanent 0-share artifacts) and exclude them from the
        // pooling below so fresh merged adjustments are computed
        // against real lots only. Targets are now cross-account sums,
        // so per-account reconcilers would fight each other when the
        // same ticker is held in two accounts.
        const isLegacyRecon = (h: Holding) =>
          h.importSource === provider &&
          !!h.brokerOrderId &&
          h.brokerOrderId.startsWith("pos-recon-") &&
          !h.brokerOrderId.startsWith("pos-recon-merged-");
        const legacyRecons = decodedCurrent.filter(isLegacyRecon);
        for (const legacy of legacyRecons) {
          await deleteDoc(
            doc(db, "portfolios", ctx.portfolioId, "holdings", legacy.id),
          ).catch(() => {});
        }
        const current = decodedCurrent.filter((h) => !isLegacyRecon(h));

        for (const pos of recPositions) {
          const reconId = `pos-recon-merged-${pos.symbol}`;
          const existingRecon = current.find(
            (h) =>
              h.importSource === provider && h.brokerOrderId === reconId,
          );
          // Pool everything for this symbol EXCEPT a prior reconciler
          // (recompute fresh) plus this sync's new legs.
          const lots: Holding[] = [
            ...current.filter(
              (h) => h.symbol === pos.symbol && h.id !== existingRecon?.id,
            ),
            ...projectedNew.filter((h) => h.symbol === pos.symbol),
          ];
          const adj = reconcileToPositionUnits(lots, pos.symbol, pos.units, {
            price: pos.price,
            date: today,
            id: reconId,
          });
          if (adj && existingRecon) {
            await updateHoldingFields(
              ctx.portfolioId,
              existingRecon.id,
              portfolioKey,
              {
                shares: adj.shares,
                purchasePrice: adj.purchasePrice,
                side: adj.side,
              },
            );
          } else if (adj && !existingRecon) {
            const plain = {
              symbol: adj.symbol,
              shares: adj.shares,
              purchasePrice: adj.purchasePrice,
              purchaseDate: today,
              side: adj.side,
              importSource: provider,
              brokerOrderId: reconId,
              ...(pos.currency ? { currency: pos.currency } : {}),
              ...(pos.yahooSymbol ? { yahooSymbol: pos.yahooSymbol } : {}),
              // Deliberately NO snaptradeAccountId: the merged
              // reconciler spans accounts, so the lock-set derivation
              // and account-removal cleanup must ignore it.
            };
            const ct = await encryptHolding(plain, portfolioKey);
            await addDoc(holdingsCol, {
              payload: ct.payload,
              iv: ct.iv,
              createdAt: Date.now(),
              schemaVersion: 2,
            });
          } else if (!adj && existingRecon && existingRecon.shares !== 0) {
            // Lots now reconcile on their own — neutralize the stale
            // reconciler (0 shares is inert in the pool).
            await updateHoldingFields(
              ctx.portfolioId,
              existingRecon.id,
              portfolioKey,
              {
                shares: 0,
              },
            );
          }
        }

        // A symbol the broker no longer reports (fully sold) won't be
        // in recPositions — neutralize any leftover reconciler so it
        // can't keep a closed position visible. Safe under
        // multi-account because sync requires C ⊇ L: every held
        // symbol's source account was part of this sync.
        for (const h of current) {
          if (
            h.importSource === provider &&
            h.brokerOrderId?.startsWith("pos-recon-") &&
            !positionSymbols.has(h.symbol) &&
            h.shares !== 0
          ) {
            await updateHoldingFields(ctx.portfolioId, h.id, portfolioKey, {
              shares: 0,
            });
          }
        }
      }
    } catch (reconErr) {
      console.warn("snaptrade reconciliation (best-effort) failed", reconErr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    errors.push(msg);
    // Wrong creds are the most common reason a fresh-paste sync
    // fails. (The page also clears the connect form here — that's UI,
    // it stays in the page wrapper.) Only do the credential rollback
    // when the user just typed credentials in this attempt
    // (`credentialOverride`) — a re-sync of an already-connected
    // broker has nothing fresh to roll back.
    // Rollback: delete the just-written credential ONLY if the portfolio
    // has no broker-locked holdings even after this sync — i.e. the
    // credential would be orphaned (its broker identity can't be derived
    // from holdings). Mirrors the original page check: a pre-existing lock
    // OR any holding written this sync means "locked", so we keep it.
    if (ctx.credentialOverride) {
      const lockedAfterSync =
        deriveLockedBroker(holdings) !== null || buys + sells > 0;
      if (!lockedAfterSync) {
        await deleteDoc(secretRef).catch(() => {});
      }
    }
  } finally {
    try {
      // syncLog body is encrypted under K_portfolio because `errors`
      // strings can carry broker-named messages (e.g. "Trading212
      // API error 429: ..."). Server stores ciphertext only; only
      // the user with portfolio access can decrypt. Schema mirrors
      // holdings: `{ payload, iv, createdAt, schemaVersion: 1 }`.
      // `portfolioKey` is always present here — the engine returns
      // `bail("no-key")` long before this finally if the key can't be
      // resolved — so the write is unconditional.
      const createdAt = Date.now();
      const payload = {
        timestamp: createdAt,
        imported: buys + sells,
        buys,
        sells,
        skipped,
        errors,
        // Redacted SnapTrade decision trace (no symbols/amounts/ids).
        // Encrypted under K_portfolio along with the rest of the log.
        diagnostics: syncDiagnostics,
        timing: syncTiming,
      };
      const ct = await encryptJson(payload, portfolioKey);
      await addDoc(
        collection(db, "portfolios", ctx.portfolioId, "syncLogs"),
        {
          payload: ct.payload,
          iv: ct.iv,
          createdAt,
          schemaVersion: 1,
        },
      );
    } catch {
      // best-effort audit log
    }
  }

  return {
    ran: errors.length === 0,
    reason: "ok",
    buys,
    sells,
    skipped,
    partialFillsSkipped,
    errors,
    diagnostics: syncDiagnostics,
    timing: syncTiming,
  };
}
