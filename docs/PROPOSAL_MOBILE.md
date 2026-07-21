# Proposal: Mobile Pass

> **Status (2026-07-21): Phase 1 MERGED to main** (`b939efba`) — sidebar-as-column, per-app back
> arrows, topbar switcher-left, hamburger/overlay/backdrop/SidebarHeader deleted, sidebar items
> close the mobile column on tap; cold-reviewed, /simplify'd, browser-verified 13/13 at
> 390/360/tablet/desktop; audit findings 12 + 14 fixed en route. **Follow-up round MERGED**
> (`65f8aa70`): calendar sidebar gained View Month / View Week nav links (fixes the no-exit wart;
> today-anchored, desktop too) and the mail composer back arrow is un-suppressed (safe: EmailDraft
> saves on unmount; an explicit Discard button stays parked). **Next: Phase 2 — the editor toolbar
> kebab (Design 2).** Phases 3–5 not started.
>
> A codebase research
> pass and a full headless-browser audit (12 apps, ~90 views, ~60 dialogs, 296 reviewed screenshots at
> 390×844 / 360×800) were run on 2026-07-20. Raw evidence — screenshots, driver scripts, the full
> per-app audit tables, and the research report — lives in `docs/superpowers/mobile-audit/`
> (local-only, gitignored). The three core UX decisions below are settled; per-phase design decisions
> are marked open.

> **TLDR**: Eigen's column/shell architecture is fundamentally mobile-sound — `ColumnLayout` already
> switches to a single column with a back arrow, dialogs are responsive by default, and the worst app
> (mail) is nearly clean. What breaks is concentrated in five classes: (1) the mobile sidebar is an
> overlay instead of a navigation level, (2) editor toolbar icon clusters overflow 390px, (3) a
> handful of dialogs and every nested Radix submenu clip at phone widths, (4) hover-only and
> right-click-only affordances are dead on touch, and (5) two editors (slides, partially sheets) are
> structurally desktop-gated. This doc fixes (1) and (2) by design decision, and phases the rest.

## Settled decisions (Reinder, 2026-07-20)

1. **Editor toolbar icon row collapses to a kebab on mobile.** The right-side icon cluster in the
   eigendoc editors (find / activity / watch / comments / share) becomes a single ⋮ button opening a
   menu with the same actions.
2. **The mobile hamburger + sidebar overlay are removed.** Instead, the FIRST column of every
   `ColumnLayout` gets a mobile back arrow (the same affordance detail columns already have) that
   shows the sidebar as a full column in the layout. Mobile navigation becomes 2–3 nested levels:
   sidebar → list → detail. No more sidebar-over-content.
3. **The mobile topbar becomes identical to the desktop topbar.** App switcher (Grip) at the LEFT,
   before the AppLogo — exactly as on desktop today. It leaves the mobile right-side cluster (which
   keeps palette trigger, notification bell, user menu). The hamburger's left slot is what the
   switcher takes over.
4. **Editor routes get NO back arrow.** An open doc/sheet/slides/stickies editor is a "separate
   app": it has no sidebar, and its toolbar stays as it is. The back arrow only ever appears in the
   main column when a sidebar exists — which is exactly what the sentinel's
   `sidebarMode === 'collapsible'` gate implements. Escape hatches from an editor remain the topbar
   logo links, the app switcher, and browser back.

## Current mechanics (the seams everything hangs on)

- Breakpoints are a **JS hook, not CSS**: `useIsMobile()` = `max-width: 768px`, `useIsTablet()`
  769–1024 (`packages/lib/src/core/media/hooks/use-media-query.ts`). `AppShell` publishes both via
  `LayoutContext`; everything reads `useLayout().isMobile`. Watch out: docs' `EditorToolbar` has a
  local 1200px query *named* `isMobile` — that is the formatting-collapse breakpoint, not the real one.
- `Column` hides on mobile unless `id === mobileColumn`
  (`packages/ui/src/components/layout/app/column-layout.tsx:45`); `onBack` renders an ArrowLeft
  **only on mobile** (`:62-66`). Shown-column state is derived per route from URL params;
  `ColumnLayout` is stateless.
- The mobile sidebar is a `fixed inset-0 z-50` overlay + `z-40` backdrop that auto-closes on pathname
  change (`packages/ui/src/components/layout/sidebar/sidebar-container.tsx:19-44`). The hamburger
  lives in `topbar.tsx` (`showBurger = isMobile && sidebarMode !== 'none'`). `sidebarOpen` state
  lives in `AppShell`, travels via `LayoutContext`.
- `setSidebarHidden` (RequestAccessView, admin AccessDenied) collapses `effectiveSidebarMode` to
  `'none'` — the seam that must gate any new sidebar affordance.
- The editor icon row is already ONE shared primitive: `DocumentShareCluster`
  (`packages/ui/src/components/layout/toolbar/document-share-cluster.tsx`) — Find, Activity toggle,
  **Watch bell** (watch/unwatch — NOT the notification center; that bell is in the topbar and is
  untouched), Comments + `CountBadge`, Share-or-read-only-Eye. Consumers: docs, sheets, slides,
  stickies. Chat hand-rolls its own pair (Pencil + UserRoundPlus) instead.

## Design 1 — sidebar-as-column navigation (settled decisions 2 + 3)

Smallest surface found; desktop pixels untouched (every change is behind `isMobile`).

1. **`SidebarContainer` mobile branch** becomes in-flow: `sidebarOpen ? 'block w-full' : 'hidden'`
   instead of the fixed overlay. **Delete the backdrop div** — the z-40 layer disappears
   (update CODE-STANDARDS § Z-Index in the same cycle).
2. **`AppShell` `<main>`** is hidden via CSS while `isMobile && sidebarOpen` — hidden, NOT unmounted,
   so editors keep Yjs/WS state and lists keep scroll position.
3. **The existing pathname auto-close effect stays** — it already implements "navigate down a level".
   Extend it to also fire on search-param navigation: today mail's Compose (a `?mode=compose` nav)
   leaves the drawer covering the composer (audit finding 14).
4. **Back arrow**: widen `ColumnProps.onBack` to `(() => void) | 'sidebar'`. The `'sidebar'` sentinel
   renders the same ArrowLeft calling `setSidebarOpen(true)`, and **self-gates on
   `sidebarMode === 'collapsible'`** so RequestAccessView / AccessDenied / sidebar-less apps never
   show a dead arrow. (Per-app closures were considered and rejected: every app repeats them and
   none can cheaply know the sidebar is hidden — a dead-arrow bug class.)
5. **Topbar**: delete the hamburger block; render `AppSwitcher` on the left before `AppLogo` on
   mobile (as desktop); remove the Grip from the mobile right cluster.
6. **Deletions**: hamburger + `showBurger`, backdrop, overlay classes, `SidebarHeader` (the mobile
   X-close header at the top of every sidebar — 8 call sites in 7 files) and the
   `isMobile`/`onClose` members of `SidebarProps` (`condensed` stays for tablet).

### Migration list (add `onBack="sidebar"` to first columns)

| App | Where | Effort |
|---|---|---|
| drive + all 4 eigendoc list views | ONE edit in shared `DriveLayout` (covers fs/mime/shared/watched + list/shared views) | trivial, high leverage |
| drive trash | `_auth.trash.tsx` | trivial |
| mail | list column | trivial |
| contacts | 2 list columns (editor routes keep their function `onBack`) | trivial |
| calendar | single `calendar-main` column | trivial |
| chat | `messages` column; **plus** `_auth.index.tsx` empty state needs a Column/toolbar — without the hamburger a chat-less user has no path to the sidebar | small |
| space | 7 single columns | mechanical |
| admin | 4 list + 4 single columns | mechanical |
| index | nothing (no sidebars) | — |

### Editor routes (docs / sheets / slides / stickies)

**No back arrow (settled decision 4).** Editor routes mount with `sidebarMode: 'none'` on all
viewports, so the sentinel no-ops there by construction — no per-editor work, and the bespoke
sheets toolbar is untouched. Escape hatches from an editor remain the topbar logo links, the app
switcher, and browser back. Drive's native-file-editor keeps its existing own back button —
unchanged (it's an in-drive surface, not a separate app).

### Edge cases (all verified in research)

- Single-column apps (calendar/chat/space/admin-settings): 2-level nav, sidebar → page. Works.
- Deep links to detail: unchanged — each level's back affordance is independent.
- Default mobile view stays the content column (`sidebarOpen` starts `false`).
- Cross-app sidebar links are full-page loads → land with the sidebar closed. Correct.
- Tablet (769–1024) untouched: condensed `w-16` rail keeps rendering.
- Known warts to verify while implementing: `Mod+B` now toggles the mobile column (harmless?);
  a sidebar link to the *current* pathname doesn't auto-close (fix in `SidebarItem` if it annoys).

## Design 2 — editor toolbar kebab (settled decision 1)

Collapse **internally** in `DocumentShareCluster` — zero API change for docs/sheets/slides/stickies:

- At `useIsMobile()` (the 768px seam, NOT docs' local 1200px), render a single ⋮ `MoreVertical`
  ghost button with a shadcn `DropdownMenu align="end"` (the established toolbar-overflow pattern —
  see `person-detail-toolbar.tsx`, `drive-detail.tsx`; the singleton `useContextMenu` is for
  list-row right-click and does not apply here). Desktop renders the current row unchanged.
- Menu items: Find in document (present only when `useOptionalDocSearchBar()` is non-null, carrying
  over `FindInDocumentButton`'s null-safety) · Activity · Watch/Stop watching (new small
  `WatchMenuItem` next to `WatchToggleButton`, same hooks; `BellRing` icon when watching) ·
  Comments with unresolved count in the label · Share (when `canWrite`).
- The unresolved-comments `CountBadge` moves onto the kebab trigger (same `relative` wrapper pattern
  as the comments button today).
- **A kebab item must not open a panel that can't render.** Today docs' Comments toggle is already
  an enabled no-op < 1200px (button activates, panel is gated on `isWide`) — audit confirmed
  (finding 5). Scope for this change: collapse what actually works per app, gate the docs comments
  item on the same condition as the panel, and fix panel *presentation* on mobile as its own
  follow-up (phase 5). The kebab API doesn't depend on it.
- Side effect worth verifying: shrinking the right cluster to one 32px button should also fix docs'
  untappable Insert menu (audit finding 4 — the right cluster paints over the left menu slot in
  `CenteredToolbar`'s `1fr auto 1fr` grid) and sheets' fully off-screen cluster (finding 3). If the
  grid can still collide at 360px, fix `CenteredToolbar` min-widths in the same change.

## Audit findings — ranked (2026-07-20, 390×844 + 360×800 re-shoots)

Screenshot refs are in `docs/superpowers/mobile-audit/AUDIT.md` (local-only) with per-app tables.
Verdicts came from reading pixels; note that page-level horizontal-overflow probes report 0 for most
of the worst items — they clip inside `overflow:hidden` containers or portalled layers.

1. **Calendar event create/edit dialog overflows right** — end-time picker, add-guest "+", Save/
   Cancel partly off-screen; the core calendar flow (`create-event-dialog.tsx` + edit twin: date
   input + two TimeSelects + attendee row don't shrink). Verified from pixels.
2. **Stickies card dialog actions off-screen** — Edit/Resolve/Copy-link render past the viewport
   (meta row missing `min-w-0` in `note-card-dialog.tsx`); stickies can't be edited or resolved by
   touch at all. Verified from pixels.
3. **Sheets action cluster off-screen** under `overflow:hidden` — Comments/Activity have NO mobile
   entry point (Share/Find have File-menu fallbacks). Fixed by Design 2. Verified from pixels.
4. **Docs Insert menu untappable** — right cluster paints over it; Link/Image/Table/HR/Code-block
   unreachable by touch. Largely fixed by Design 2 (verify the grid at 360px).
5. **Docs comments + activity panels gated to >1200px** — comments button activates but renders
   nothing; activity has no button at all on mobile. Kebab gating (Design 2) removes the lie;
   phase 5 makes the panels actually usable.
6. **Drive per-file actions unreachable by touch** — row ⋮ hidden below 800px *container* width;
   long-press/right-click surface DriveList's folder-create context menu instead of the file menu.
7. **Drive Move to… / Copy to… impossible on mobile** — absent from the detail More menu; only in
   the masked/hidden row menu.
8. **No touch context menus anywhere** — long-press is dead in sheets (cut/copy/paste/sort/filter/
   comment), stickies (delete/resolve), slides (thumbnail menu gated `!mobile`), mail rows; drive
   long-press opens the wrong menu.
9. **Sheets Format submenus cascade off-screen-left** — Number/Borders/Fill/Conditional clipped;
   conditional-formatting rule dialogs (3 levels deep) fully unreachable.
10. **Version-history Restore clipped in the shared FileMenu submenu** — docs, slides, stickies
    ("Restore" reads "Re…" at 390, fully off-screen at 360). One shared-FileMenu fix serves all
    three; drive shows history inline in the detail panel and is fine.
11. **Slides editor is structurally view-only < 768px** — no canvas, no add-slide, no text editing,
    no per-slide menu; plus a dead comments toggle. Needs a product decision (open decision 4).
12. **Shared topbar overflows ~30px at 360w in long-wordmark apps** — every contacts screen and the
    calendar grids clip the avatar; short wordmarks (space) fit.
13. **Calendar week view unusable** — ~55px columns, one-letter titles, top-anchored list rather
    than a time grid, no scroll.
14. **Mail compose from the sidebar leaves the drawer covering the composer** — auto-close keys on
    pathname; compose is a search-param nav. Fixed by Design 1 step 3.
15. **Hover-only affordances dead on touch** (a class, 5+ instances): calendar sidebar edit/share
    pencils, chat wizard picked-person remove-X, contacts sidebar label pencil, chat message
    actions, drive row icons. The `invisible group-hover:visible` pattern AGENTS.md documents is a
    desktop-only pattern by construction — needs a policy (open decision 5).
16. **No touch path to CREATE a doc comment** — keyboard shortcut or right-click only (replying to
    an existing thread works by tapping the highlight).
17. **Sheet tabs hidden < 640px** — only "+" and the all-sheets dropdown; no rename/reorder/recolor.
18. **Stickies Add/Edit Sticky dialog** — 8-swatch color row + Assignee picker clip at the right edge.
19. **Drive "Move to trash" fires with no confirm** from the detail More menu (restorable, but no
    mis-tap guard; desktop has the same behavior — decide whether this is mobile-only).
20. **Mail shortcuts cheat-sheet unreachable on touch** — `?`-key only AND gated behind a
    default-off setting.
21. **Small tap targets throughout** — recurring 24–36px icon buttons vs the ~44px guideline
    (stickies column-header 24px, chat message actions 28px, toolbar/topbar 32–36px).
22. **Minor clipping** — docs comment-create Assignee control; docs format submenus flip left and
    clip icon padding.

Clean surfaces worth naming: mail (best app of the audit), index landing/support, space + auth
pages, admin (as far as reachable), drive's dialogs, chat's core messaging, present-mode in slides,
stickies board pan/drag (92vw scroll-snap columns work well).

### Cross-cutting classes

- **Radix nested submenus are systematically broken at phone widths** (findings 9, 10, 22):
  second-level menus open toward a viewport edge and clip. One mobile submenu strategy (e.g.
  flatten to a second-level `DropdownMenu` page or a full-width sheet) fixes several findings at once.
- **`overflow:hidden` + portals hide breakage from DOM-level probes** — mobile verification must
  stay pixel-based (per VERIFICATION.md discipline).
- **Hover-only affordance class** — always means "invisible on touch"; needs one policy, not
  per-spot fixes.

## Phased plan

Each phase is independently shippable, FE-only (eigen.is formats untouched), own branch,
browser-verified at 390×844 + 360×800 per VERIFICATION.md before merge.

- **Phase 1 — Navigation shell** (Design 1): sidebar-as-column, `onBack: 'sidebar'` sentinel +
  per-app migration, topbar switcher-left, hamburger/overlay/backdrop/SidebarHeader deletions,
  chat empty-state route, auto-close on search-param nav (fixes finding 14). Also the 360px topbar
  overflow (finding 12) — it's topbar work.
- **Phase 2 — Editor toolbar kebab** (Design 2): cluster collapse, docs comments-item gating
  (finding 5's "lying button"), verify it clears findings 3 + 4; chat adopts the same pattern
  (open decision 2).
- **Phase 3 — Dialog + submenu overflow**: calendar create/edit dialog (finding 1), stickies card
  dialog + add/edit form (2, 18), shared-FileMenu version-history submenu (10), sheets format
  submenus + the mobile submenu strategy (9, 22).
- **Phase 4 — Touch affordances**: hover-only policy + sweep (15), drive row actions + Move/Copy on
  mobile (6, 7), long-press context menus (8) — extend the existing singleton `useContextMenu`
  (`openAt`), don't add per-row menus —, doc comment creation via touch (16), delete confirm (19),
  mail row actions + cheat-sheet entry point (20).
- **Phase 5 — Structural**: mobile presentation for comment/activity panels (full-width overlay
  instead of `w-64` side panel — unlocks docs/sheets panels for the first time), calendar week view
  (13), slides mobile decision (11), sheet tabs (17), tap-target pass (21).

Phases 1+2 are the settled decisions and should land first; 3–5 in any order after.

## Open decisions

1. **Read-only Eye marker** (`DocumentModeButton`) on mobile: keep outside the kebab (costs 32px),
   drop it, or move the info into the menu. A passive tooltip-only marker inside a menu is useless.
2. **Chat toolbar**: adopt `DocumentShareCluster` wholesale (gets Find/Watch — needs a
   DocSearchProvider decision) or just reuse the kebab pattern for its Edit/Share pair.
3. **Kebab breakpoint**: 768px (recommended — at 769–1200 the 3–5 icon row still fits) vs docs'
   1200px formatting breakpoint.
4. **Slides on mobile**: bless view-only (then remove the dead affordances so it doesn't lie) vs
   invest in mobile editing. Present-mode already works well.
5. **Hover-only policy**: always-visible icons on touch devices (e.g. a `pointer-coarse` variant on
   the shared pattern) vs long-press/swipe alternatives per surface.
6. **Calendar week view**: redesign as an agenda/day list on mobile vs accept degraded.
7. **Sidebar look without `SidebarHeader`**: the mobile X-header (app logo row) disappears; the
   topbar sits above the sidebar-column instead. Confirm the presentation once Phase 1 screenshots
   exist.
8. **Drive trash confirm** (finding 19): mobile-only guard, or desktop too, or rely on restorability.

## Verification + docs to update

- Every phase: screenshot round at 390×844 + 360×800 with a throwaway user (the audit's
  `mobile-audit@eigen.is` account + seeded content is still on the dev server as a reproducer set),
  pixel verdicts, plus behavioral probes (tap, long-press, scroll, reload-persistence). Real-device
  spot check before calling the program done (sheets touch-scroll was not verifiable headless).
- Same-cycle doc updates: CODE-STANDARDS § Z-Index (z-40 backdrop row), LAYOUT.md (sidebar overlay,
  SidebarHeader, hamburger; its "AppLogo has app switcher" note is already stale), AGENTS.md
  pattern tables where `Column`/`SidebarProps` APIs change, and this file's status line per phase.
