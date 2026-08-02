# Proposal: Mobile Pass — remaining work

> **Status (2026-08-02): Phases 1–4 shipped.** Phases 1–3 (navigation shell, toolbar kebabs,
> dialog + submenu overflow) merged and pushed through `46eb4f61`. Phase 4 (touch affordances —
> findings 6, 7, 8, 15, 16, 19, 20 + menu-system consolidation) complete on branch
> `mobile-touch-affordances`: the raw ContextMenu primitive is deleted (all menus now on the
> singleton), drive row actions and Move/Copy are touch-reachable, long-press opens the context
> menus on all five audited surfaces via the shared `useLongPress` hook, hover-only affordances
> rest visible on coarse pointers (policy: match the hover value; pattern documented in
> AGENTS.md), docs gained Insert → Comment (sheets already had it), drive trash confirms on
> coarse pointers only, and the mail cheat-sheet has a toolbar entry point. Browser-verified
> 21/21 at 390/360/768/1280 (Chromium). This doc now tracks ONLY what remains. Raw audit
> evidence stays in gitignored `docs/superpowers/mobile-audit/`.

## Phase 5 — structural

- **Mobile presentation for comment/activity panels** (finding 5's remaining half): full-width
  overlay instead of the `w-64` side panel — unlocks docs comments/activity below 1200px for the
  first time. Then also: restore the docs mobile kebab's Comments item + CountBadge (deliberately
  omitted while the panel can't render), give kebab menu items an open-state cue (desktop buttons
  had `active`), and let the palette comment-reveal open the card dialog on mobile (today it only
  scrolls to the mark below 1200px).
- **Calendar week view** (finding 13): ~55px columns, one-letter titles, no time grid. *Open
  decision:* redesign as an agenda/day list on mobile vs accept degraded.
- **Slides on mobile** (finding 11): editor is structurally view-only < 768px (no canvas, no
  add-slide, no per-slide menu). *Open decision:* bless view-only and remove the dead affordances
  so it doesn't lie, vs invest in mobile editing. Present-mode already works well. New inputs
  from phase 4: thumbnail long-press now offers Duplicate/Delete to writers on mobile (the two
  operations that don't need a canvas — decide whether that lone edit affordance stays), and
  read-only viewers see those items as inert no-ops (pre-existing on desktop right-click,
  mirrored on mobile) — fix the gating with whatever this decision lands on.
- **Sheet tabs below 640px** (finding 17): tab strip hidden — only "+" and the all-sheets
  dropdown; no rename/reorder/recolor.
- **Tap-target pass** (finding 21): recurring 24–36px icon buttons vs the ~44px guideline
  (stickies column-header 24px, chat message actions 28px, toolbar/topbar 32–36px).
- Observation for this phase (from phase-4 verification): drive multi-select has no pure-touch
  affordance (modifier-click only), so the multi-item menus are effectively
  keyboard-assisted-only on touch.

## Accepted drifts (decided — don't re-flag, don't fix)

- Drill-in submenu pages (the shared dropdown primitive): keyboard roving degrades inside pages
  (touch-first by design); a `DropdownMenuSub` nested directly inside a `DropdownMenuGroup` would
  not drill (no consumer does this); raw non-item JSX on an *ancestor* page stays visible while a
  deeper page is open (all such JSX sits on leaf pages today).
- Read-only member of a *team* chat has no access-dialog entry point on any viewport (personal
  chats keep the left-slot `DriveShareSummary`).
- Read-only Eye marker is dropped on mobile (its tooltip can't show on touch, so the explanation
  is lost either way; desktop unchanged).
- Sheet-tab menu (phase 4): right-click opens the tab's chevron dropdown (anchored at the
  chevron, not the pointer); long-press on a tab opens nothing — the always-visible chevron IS
  the touch path. ≥640px surface only (strip hidden below, finding 17).
- Drive background create menus (list + picker) are contextmenu-event-only — no long-press timer.
  Long-press on empty space works where the engine synthesizes contextmenu (Android-class), not
  on iOS; the `+` / "New folder" buttons are the primary touch create paths.
- Chat message actions stay JS tap-to-reveal (tap emulates hover and shows the floating bar —
  verified working on touch). Not converted to always-visible; the 28px targets are finding 21.
- Beyond the audit's five long-press surfaces, some context menus remain right-click-only by
  scope: contacts list rows, slides canvas objects, sheet row/column headers.

## Verification (every phase)

- Screenshot round at 390×844 + 360×800 with the seeded `mobile-audit@eigen.is` account
  (reproducer set, still on the dev server), pixel verdicts + behavioral probes (tap, long-press,
  scroll, reload-persistence). `hOverflow`-style page probes report 0 on the worst bugs
  (portalled layers / `overflow:hidden` clip without widening the page) — pixel review is
  mandatory. Full recipe: [VERIFICATION.md](VERIFICATION.md). Long-press needs real CDP touch
  synthesis; account passwords + fresh-cookie recipe live in the phase1-verify helper header.
- Real-device spot check before calling the program done (all Chromium-only so far): sheets
  touch-scroll; native date inputs in iOS Safari; and from phase 4 — long-press on the five
  surfaces under real iOS (timer path + link-callout suppression on drive rows/tiles + no
  first-menu-item activation on finger lift).
- Same-cycle doc updates: LAYOUT.md / AGENTS.md tables when APIs change, and this file per phase.
