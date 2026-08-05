# Portfolio page redesign — design

**Date:** 2026-08-05
**Status:** Approved (layout decisions made via interactive mockup review)
**Mockups:** claude.ai artifact "Portfolio Page — Layout Proposal" (Option A/B frames, mobile frames, both app themes)

## Problem

The portfolio detail page (`src/app/(app)/p/[id]/page.tsx`) is a single centered column: a full-width 340px benchmark chart at the top, three benchmark stat cards above it, then a 4-way tab bar (Positions / Logbook / Allocation / Insights) showing one panel at a time. On desktop this wastes horizontal space, forces long scrolls, and hides three of the four content surfaces behind tabs. Day-to-day questions — "what's it worth, what moved today, what happened recently" — require scrolling and tab-hunting.

## Decisions

Made by the owner after reviewing rendered mockups of both candidates:

1. **Desktop hero = split hero.** Stats left, benchmark chart right (~55% width, ~218px tall). Chart always visible.
2. **Mobile hero = sparkline.** Sparkline sits *beside* the value/P&L/today group (not below it); tapping expands the full chart in place.
3. **Insights tab dissolves.** Top movers + upcoming dates become one full-width **rotating band** under the hero; analyst ratings become a **pill in each holdings row**. Full analyst detail stays on the ticker page.
4. **Allocation tab dissolves.** The treemap becomes a **List | Map** toggle inside the Holdings card.
5. **Logbook = preview column + expand in place.** Right column shows the most recent 8 trades with "View all"; activating it swaps the columns area for the existing full logbook table with a Back control. No new route.
6. **One rotating band** (not two stacked): ~52px, auto-cycles every ~6s, pauses on hover/focus, manual dots, static with manual switching under `prefers-reduced-motion`.
7. **Rejected:** the "holdings + logbook share one fixed scrollable region" variant — nested scroll areas fight the page scroll; capping the preview by count achieves the same containment with a single scrollbar.

## Layout

### Desktop (`lg` ≥ 1024px)

Top to bottom inside the existing `max-w-6xl` main column:

1. **Header** — breadcrumb; title + "by you / by {owner}" + follower stack; actions right (`Share` primary, `Sync`, `Add holding`) with a small `synced Xh ago` caption beneath (from the existing `lastSyncAt` subscription + `relativeTime`).
2. **Hero** — two-column grid (`1fr / 1.25fr`, bordered bottom):
   - Left: total market value (USD, 40px+), performance pill "▲ +X% vs cost", **new "today +$Δ · +Δ%" pill**, verdict chips **"vs SPY +X% ahead/behind"** and **"vs QQQ …"**, meta row (P/L $, positions count, since date).
   - Right: the benchmark `AreaChart` at ~218px height with the legend above it. Same `series` data and tooltip as today.
3. **Rotating band** — full width, cycles *Today's movers* ↔ *Upcoming* (next earnings / ex-dividend / pay dates, soonest first). Movers view lists day-% chips, gainers first then losers (from the existing `topMovers`), overflow fading at the right edge. Chips click through to ticker pages.
4. **Columns** (`1.45fr / 1fr` grid):
   - **Holdings card** (left): header row with count + **List | Map** segmented toggle. List rows: symbol + **analyst rating pill** with sub-line "{shares} sh · avg ${avg}" | current price + day % | market value + allocation bar/% | gain $ + %. Row click → ticker page. Map view renders the existing `AllocationTreemap`.
   - **Logbook card** (right): last ~8 `buildTradeLog` entries (date, side pill, symbol, value, realized % on sells) + "View all N →". The collapsed **Sync history** disclosure moves under this card.
5. **"View all" state** — the columns section is replaced by the current full logbook table (all columns, owner and viewer variants unchanged) with a "← Back to overview" control. Local component state only; no route change.

The three benchmark stat cards ("Portfolio / Hypothetical SPY / Hypothetical QQQ") are **removed**; their content survives as the hero verdict chips and the chart tooltip. The desktop tab bar is **removed**.

### Tablet (`md`–`lg`, 768–1024px)

Same cards, stacked full width: hero (chart below stats), band, Holdings card, Logbook card. No tab bar.

### Mobile (< 768px)

1. Header (compact breadcrumb "‹ Mine"; owner action buttons wrap under the title as today).
2. **Hero row**: left — value + pills (vs cost, today); right — **sparkline button** (~110×40, portfolio curve only, "⌄ chart" hint). Tap expands a ~200px chart card in place beneath the row — **with the same Portfolio/SPY/QQQ legend as desktop** (the sparkline itself is unlabeled, so the expanded view must name the lines); tap again collapses.
3. **Band** — compact variant, right-edge fade mask, dots; swipe/manual switching.
4. **Two-tab bar: Holdings | Logbook** (existing `TabBar`, reduced from four tabs). Holdings rows: symbol + rating pill, sub-line "{shares} sh · avg ${avg} · {day %}", right side market value + gain (two-line). Logbook tab = existing mobile logbook rows.
5. Bottom app nav unchanged.

Mobile keeps the same section order as desktop (hero → band → holdings/logbook), so the two form factors read as one app.

## Non-owner (shared viewer) variant

Layout identical; content follows the existing privacy split — **no dollar amounts anywhere**:

- Hero: performance pill vs cost + "vs SPY" pill (both exist today), *no* value, *no* today-$ (today-% only), normalized % chart (`normalizedSeries`).
- Holdings rows: symbol + rating pill | allocation % | gain %.
- Logbook preview/full: viewer columns (date, side, symbol, weight %, realized %).
- Band is already %-only and identical for both audiences.

## Data & plumbing

No new upstream sources; no schema changes; nothing new server-side.

- **Today's move:** derived from the existing 120s quote poll. Per position: `shares × (quote day change)` converted to USD the same way market value is (`quoteValueUsd` family). Unpriced positions are excluded (consistent with the existing `unpricedSymbols` handling). Hero % = today $ / (market − today $).
- **Analyst pills + upcoming dates:** the exact fetch pair `InsightsTab` uses today — `getStockInsights` (Yahoo quoteSummary, daily TTL cache) + `getAnalystSpreads` (Finnhub, daily TTL cache) — moved into a small hook (e.g. `useInsightsData(symbolKey)`) shared by the band and the holdings rows so the page issues **one** fetch per symbol set. Pill = consensus label (via existing `deriveRatingKey` / `ratingTone` / `RatingPill` tone classes) + analyst count; no coverage → no pill. Cost note: this fetch now runs on page view rather than on tab open; the server-side daily caches make upstream volume equivalent.
- **Movers:** pure derivation from quotes (`topMovers` exists).
- **Sparkline:** inline SVG path from the already-fetched `series` (portfolio values only). No Recharts instance for it; the expanded mobile chart reuses the real `AreaChart`.
- **Benchmark verdict chips:** from the existing `benchGain` memo (`diffPct` per benchmark).

## Component changes

- `p/[id]/page.tsx` (2,178 lines) is decomposed as part of this work. The page keeps data orchestration (auth, snapshots, keys, quotes, series, sync); rendering moves to new components: `PortfolioHero`, `InsightsBand`, `HoldingsCard`, `LogbookCard` (names indicative).
- `InsightsTab.tsx` is **deleted**; `insights-ui.tsx` (RatingPill, spread bar) is reused by the pills and remains shared with `TickerInsightsCard` (unchanged).
- `TabBar.tsx` remains, used only on mobile with 2 items.
- `AllocationTreemap.tsx` unchanged, rendered inside the Holdings card's Map view.
- Chart tweak: SPY keeps dash `5 4`; QQQ becomes dotted `1.5 3.5` with round linecap — the two benchmarks are currently distinguishable only by color, which fails under red-green color-blindness (validated with a palette checker against both themes).

**Dropped from the visible desktop table** (still available on the ticker drilldown): cost basis column, lots count, separate shares / avg-cost columns (merged into the row sub-line). The full logbook table keeps all its current columns.

## Not changing

Share/Add/Sync modals and flows, `SnapshotPortfolioView` and the `/s/[id]` page, encryption/key handling, Firestore reads/writes, quote/history cadence, Section 104 math, ticker drilldown page, USD display-currency policy.

## Accessibility & motion

- Band: manual dot buttons (labelled), pause on hover *and* focus-within, no auto-rotation under `prefers-reduced-motion`; content isn't `aria-live` (rotation is decorative; all items are reachable via dots).
- Sparkline button: `aria-label="Show benchmark chart"`, ≥44px touch target.
- Expand/collapse animates `max-height`/opacity ≤300ms, ease-out; instant under reduced motion.
- Day-% and gain values keep sign characters, not color alone.

## Verification

- `npm run build && npm test` must pass (use `tsc --noEmit` + `npm test` while the dev server runs).
- New pure logic (today-change aggregation, pill label/count derivation) gets unit tests beside the existing `insights.test.ts` / portfolio math tests.
- Manual pass: owner and shared-viewer views, both themes, 390 / 768 / 1440 widths, reduced-motion on, portfolio with unpriced symbols and with zero holdings.

## Out of scope

TWRR/MWRR, new insight data sources, list virtualization, share-link snapshot format changes, options/pies support, any server-side data reading.
