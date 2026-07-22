# Proposal: Mobile Pass — remaining work

> **Status (2026-07-22): Phases 1–3 shipped** (navigation shell, editor + list/calendar toolbar
> kebabs, dialog + submenu overflow — merged and pushed through `46eb4f61`). Audit findings
> 1, 2, 3, 4, 9, 10, 12, 14, 18, 22 and the toggle-lie half of 5 are cleared; the as-built record
> lives in git history, [LAYOUT.md](LAYOUT.md), and AGENTS.md. This doc now tracks ONLY what
> remains. Raw audit evidence (per-app tables, 296 screenshots, finding numbers referenced below)
> stays in gitignored `docs/superpowers/mobile-audit/`.

## Phase 4 — touch affordances

Mobile is navigable now; these are the actions a touch user still cannot reach.

- **Hover-only affordance policy + sweep** (finding 15). *Open decision:* always-visible icons on
  touch (e.g. a `pointer-coarse` variant on the shared `invisible group-hover:visible` pattern) vs
  long-press/swipe alternatives per surface. Known instances: calendar sidebar edit/share pencils
  (`calendar-sidebar.tsx`, opacity-0 idle), chat wizard picked-person remove-X, contacts sidebar
  label pencil, chat message actions (28px, hover-gated), drive row icons.
- **Drive per-file actions reachable by touch** (finding 6): row ⋮ hidden below 800px *container*
  width; long-press/right-click surface DriveList's folder-create context menu instead of the
  file's menu.
- **Move to… / Copy to… on mobile** (finding 7): absent from the DriveDetail More menu; only in
  the masked/hidden row menu.
- **Long-press context menus** (finding 8): long-press is dead in sheets (cut/copy/paste/sort/
  filter/comment), stickies (delete/resolve), slides (thumbnail menu gated `!mobile`), mail rows;
  drive long-press opens the wrong menu. Extend the existing singleton `useContextMenu` (`openAt`)
  — no per-row menus. Include the sheet-tab menu here: `SheetItem` uses the separate Radix
  ContextMenu primitive, the one submenu surface that still side-cascades on phones (the drill-in
  fix covers dropdown menus only).
- **Touch path to CREATE a doc comment** (finding 16): keyboard shortcut or right-click only today
  (replying to an existing thread works by tapping the highlight).
- **Drive "Move to trash" confirm** (finding 19). *Open decision:* mobile-only mis-tap guard, or
  desktop too, or rely on restorability.
- **Mail shortcuts cheat-sheet on touch** (finding 20): `?`-key only AND gated behind a
  default-off setting — no touch entry point.

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
  so it doesn't lie, vs invest in mobile editing. Present-mode already works well.
- **Sheet tabs below 640px** (finding 17): tab strip hidden — only "+" and the all-sheets
  dropdown; no rename/reorder/recolor.
- **Tap-target pass** (finding 21): recurring 24–36px icon buttons vs the ~44px guideline
  (stickies column-header 24px, chat message actions 28px, toolbar/topbar 32–36px).

Phases 4 and 5 are independently shippable, FE-only, own branch each, in any order.

## Accepted drifts (decided — don't re-flag, don't fix)

- Drill-in submenu pages (the shared dropdown primitive): keyboard roving degrades inside pages
  (touch-first by design); a `DropdownMenuSub` nested directly inside a `DropdownMenuGroup` would
  not drill (no consumer does this); raw non-item JSX on an *ancestor* page stays visible while a
  deeper page is open (all such JSX sits on leaf pages today).
- Read-only member of a *team* chat has no access-dialog entry point on any viewport (personal
  chats keep the left-slot `DriveShareSummary`).
- Read-only Eye marker is dropped on mobile (its tooltip can't show on touch, so the explanation
  is lost either way; desktop unchanged).

## Verification (every phase)

- Screenshot round at 390×844 + 360×800 with the seeded `mobile-audit@eigen.is` account
  (reproducer set, still on the dev server), pixel verdicts + behavioral probes (tap, long-press,
  scroll, reload-persistence). `hOverflow`-style page probes report 0 on the worst bugs
  (portalled layers / `overflow:hidden` clip without widening the page) — pixel review is
  mandatory. Full recipe: [VERIFICATION.md](VERIFICATION.md).
- Real-device spot check before calling the program done: sheets touch-scroll, and native date
  inputs in iOS Safari (phase 3 verified them in Chromium only).
- Same-cycle doc updates: LAYOUT.md / AGENTS.md tables when APIs change, and this file per phase.
