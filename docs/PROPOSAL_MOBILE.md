# Proposal: Mobile Pass — remaining work

> **Status (2026-08-03): Phases 1–5 shipped.** Phases 1–3 (navigation shell, toolbar kebabs,
> dialog + submenu overflow) merged and pushed through `46eb4f61`. Phase 4 (touch affordances —
> findings 6, 7, 8, 15, 16, 19, 20 + menu-system consolidation) merged through `d9124a2a`: the raw
> ContextMenu primitive is deleted (all menus now on the singleton), drive row actions and
> Move/Copy are touch-reachable, long-press opens the context menus on all five audited surfaces
> via the shared `useLongPress` hook, hover-only affordances rest visible on coarse pointers
> (policy: match the hover value; pattern documented in AGENTS.md), docs gained Insert → Comment,
> drive trash confirms on coarse pointers only, and the mail cheat-sheet has a toolbar entry
> point. Phase 5 (structural — findings 5 and 11) is complete on branch `mobile-structural`; what
> it shipped is listed below. Browser-verified per phase at 390/360/768/1280 (Chromium). This doc
> now tracks ONLY what remains. Raw audit evidence stays in gitignored
> `docs/superpowers/mobile-audit/`.

## Phase 5 — shipped (structural)

- One shared mobile pane on docs, slides and sheets. `MobilePanelColumn` draws the back arrow, the
  title and the comment filter toolbar, and the panel body runs full width. The editors hide under
  the pane, they never unmount, so scroll position, selection and node views survive a visit.
  Panel open state lives in one `useDocumentPanels()` hook. Comment rows and activity rows share
  one `onOpenCard` prop, and the pane stays on Activity when a card opens.
- The sheet engine re-measures on container resize, not just on window resize. That also fixes the
  desktop panel-clip bug: the grid now resizes to the panel edge and the scrollbar stays
  reachable.
- Docs comment and activity panels render from 768px. The old 1200px `isWide` gate is gone. The
  page shifts left before it scales, so the text column always clears the panel.
- Slides on mobile is view-only for everyone. Thumbnail long-press and the thumbnail context menu
  are desktop and iPad-desktop-layout only. The kebab open-state cue was dropped again: it is
  unreachable under the takeover pane.
- Present mode has a transient exit X, a `fullscreenchange` sync and a `.catch` on
  `requestFullscreen`. Esc now exits fullscreen too, and editing is inert while presenting (object
  nudge and delete, Cmd+Z, copy and paste are all gated).
- The docs mobile kebab has Comments (with count) and Activity back, and the palette
  comment-reveal opens the card dialog on every viewport.
- Opening a find session while the pane is up (⌘F, a palette in-document hit) closes the pane in
  all three editors. The bar rides with the editor, so it used to open inside the hidden one.

Findings 5 (panels) and 11 (slides view-only) are closed, with their knock-ons. Finding 13
(calendar week view) was reviewed on 2026-08-03: it is fine on mobile for now, no work planned.

Contracts for the shipped pane live in [COMMENTS.md](COMMENTS.md) (panel hosting, `onOpenCard`,
`useDocumentPanels`), [SHEETS.md](SHEETS.md) (container-resize contract) and
[LAYOUT.md](LAYOUT.md) (component table).

## Next round

- **Sheet tabs below 640px** (finding 17): the tab strip is hidden, so there is only "+" and the
  all-sheets dropdown. No rename, reorder or recolor.
- **Tap-target pass** (finding 21): recurring 24–36px icon buttons against the ~44px guideline
  (stickies column header 24px, chat message actions 28px, toolbar and topbar 32–36px).
- **Session-open actions run while the surface is hidden**: opening a find session closes the pane,
  but everything that session does on open — the reveal scroll and the bar's own input focus — fires
  in the same tick, before the editor is back. Neither works on a `display: none` subtree, so a match
  outside the current scroll window stays off-screen and the bar can open unfocused (verified at
  390×420 — bar reads "1 of 1", the document does not move). Highlights and the count are correct.
  Fix seam: a `surfaceHidden` prop on `DocSearchProvider` that parks the pending reveal and replays it
  from a layout effect once the surface is visible again.
- **Stickies Activity toggle below 768px**: stickies is the fourth editor and still gates its
  toggle on `!isMobile` — the abandoned "only offer it where the panel renders" idiom. Its mobile
  Activity is unreachable. Either give stickies the shared `MobilePanelColumn` or drop the gate.
- **Drive touch multi-select**: picking more than one item needs a modifier click today, so the
  multi-item menus are keyboard-assisted only on touch. Leading candidate: a "Select mode" entry
  in the long-press menu and the kebab that turns on checkboxes and reuses the existing
  multi-select actions.

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
- Slides keeps document-level keydown hooks (Delete, arrows), so a hardware keyboard can act on
  the hidden canvas while the pane is open. Pre-existing body-level listeners — the same
  hidden-surface family as the session-open residual under Next round.
- Flipping a desktop viewport to mobile with the thumbnail menu open leaves a menu on screen once.
  It dismisses on tap. Strictly better than the stranded reopen it replaced.
- Pane rows show the anchor text while the card dialog shows the title. A glance mismatch, product
  polish for later.
- Docs desktop `ActivityPanel` still switches to the comments panel when a card is tapped. It is
  the only surface that does; all three mobile panes stay put.

## Verification (every phase)

- Screenshot round at 390×844 + 360×800 with the seeded `mobile-audit@eigen.is` account
  (reproducer set, still on the dev server), pixel verdicts + behavioral probes (tap, long-press,
  scroll, reload-persistence). `hOverflow`-style page probes report 0 on the worst bugs
  (portalled layers / `overflow:hidden` clip without widening the page) — pixel review is
  mandatory. Full recipe: [VERIFICATION.md](VERIFICATION.md). Long-press needs real CDP touch
  synthesis; account passwords + fresh-cookie recipe live in the phase1-verify helper header.
- Same-cycle doc updates: LAYOUT.md / AGENTS.md tables when APIs change, and this file per phase.

### Real-device spot check (before the program is called done)

Everything so far is Chromium-only. Open on a real phone and tablet:

- Sheets touch-scroll, and native date inputs in iOS Safari.
- Long-press on the five phase-4 surfaces under real iOS: the timer path, link-callout
  suppression on drive rows and tiles, and no first-menu-item activation on finger lift.
- The sheets pane while the iOS URL bar collapses, and the sheets pane with cards in it.
- Present mode: the exit X on real iOS (no fullscreen API there) and the Android back-gesture
  exit. Check the 2s fade window when the fullscreen transition is slow.
- Slides thumbnail callout suppression. `[-webkit-touch-callout:none]` as a TSX arbitrary property
  is the first of its kind here, so confirm it on a fresh build (stale-JIT gotcha).
- Docs between 768 and 830px: page legibility at scale ~0.6 with a panel open. Wide tables and
  full-bleed figures may tuck under the panel in the shift band. That is by design, so eyeball it.
- Docs figure click at 900px (the properties panel opens through the shift; code-verified only)
  and the mobile mark-tap path (the card dialog closes back into the pane).
