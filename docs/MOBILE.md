# Mobile

> **TLDR:** Eigen has no separate mobile app: the same components adapt, keyed on two independent signals. The viewport width picks the layout (`useIsMobile`, `useIsTablet` in `packages/lib/src/core/media/`), and the pointer type picks the touch affordances (`pointer-coarse:`, `useIsCoarsePointer`, a `touch` pointer event). On a phone one column shows at a time, and a surface that steps aside is hidden with CSS, never unmounted. A phone views the canvas documents (slides, vector) but never edits them. Long-press opens the same context menu as right-click, and a submenu drills in as a page of its menu.

## Width picks the layout, the pointer picks the affordances

| Width | Hook | Layout |
|---|---|---|
| up to 768px | `useIsMobile` | one column at a time; the sidebar is a full column |
| 769 to 1024px | `useIsTablet` | the sidebar is a `w-16` rail (`SidebarProps.condensed`) |
| from 1025px | `useIsDesktop` | the full `w-64` sidebar and every column side by side |

An editor toolbar folds its format rows into a kebab on its own, wider gate, `useIsCompactToolbar` (1200px, docs 1400px). It is density only and says nothing about touch.

Touch affordances never key on width. An iPad in landscape gets the desktop layout but has no hover, and a narrow desktop window has a mouse. So a hover-revealed action rests visible under `pointer-coarse:` ([LAYOUT.md](LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch)), long-press arms only for a `touch` pointer, and Drive's Move to trash confirms first on a coarse pointer, where there is no hover cue and a mis-tap is easy.

The media hooks answer `false` during a prerender, so a build-time render and the first client render agree on the desktop layout.

## A phone shows one column, and the rest stays mounted

`ColumnLayout`'s `mobileColumn` picks the one `Column` a phone renders, and the first column's `onBack="sidebar"` arrow opens the sidebar as a column ([LAYOUT.md](LAYOUT.md#on-a-phone-only-the-mobilecolumn-renders)). The sidebar column closes on every navigation, including one that changes only the search params, such as Mail's `?mode=compose`.

What steps aside is hidden, not unmounted. `<main>` hides under the sidebar column, and docs, sheets and the canvas hide under the comments pane ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)). An editor keeps its collab socket, scroll position, selection, node views and undo history across the visit.

## A hidden surface can't be scrolled or focused

Anything that acts on a `display: none` subtree does nothing: a reveal scroll doesn't move it, and a focus call doesn't land. So a phone opens a comment card with plain `setOpenCardId` instead of revealing its anchor first, and a find session that opens (⌘F, an in-document palette hit) closes the pane through `useDocumentPanels`' `onSearchOpenChange`, because the find bar floats inside the hidden editor. The sheet re-measures its canvas when its container shows again ([SHEETS.md](SHEETS.md#comments-are-eigen-comment-cards)).

## Docs panels need 769px and shift the page before they shrink it

The docs comment, activity and properties panels render whenever the viewport is not a phone. With a panel open, the page first slides left by its overlap with the panel and scales down only when the slack runs out. The shift keeps the text column clear, not the page, so a wide table or a full-bleed figure may tuck under the panel in that band. That is by design. From 769px a writer who selects a figure or a table gets its properties panel opened for them.

## A phone views canvas documents, never edits them

Slides and vector set `canEdit = canWrite && !isMobile`. The file menu, the share cluster and comments keep `canWrite`, so a phone user can still share, comment and download. A phone gets the frame-fit canvas, read-only, and pages the deck with a one-finger horizontal swipe. The slides rail and the properties panel are desktop surfaces: the rail's fixed width would take half a phone ([SLIDES.md](SLIDES.md)).

The canvas keymap is gated on `canEdit`, so a hardware keyboard on a phone can't act on the deck. The layered-Escape listener stays document-level.

Present mode works without the fullscreen API (iOS Safari has none): the overlay is `fixed inset-0` and draws its own exit X, and it leaves present when fullscreen ends outside its control, such as Android's back gesture.

## Long-press opens the same context menu as right-click

WebKit on iOS never turns a long touch into a `contextmenu` event, so `useLongPress` (`packages/ui/src/hooks/use-long-press.ts`) fires the surface's own menu after a still press on a touch pointer. It serves Drive rows and tiles, the Mail list, `PersonList` (contacts and admin), the slides rail, stickies cards, the sheet's cells and row and column headers, chat messages, and attachment chips in Mail and the card dialog. A chat message's floating action bar is `pointer-fine:` only, because on touch a long press opens the same actions as a menu. `.eigen-list-item` and `.eigen-tile` set `-webkit-touch-callout: none`, so iOS's link-preview callout doesn't compete with the menu.

Some menus stay right-click only, by scope:

- Canvas objects. A phone can't edit the canvas anyway.
- Drive's create menu on empty list space. Android synthesizes `contextmenu` from a long press there, iOS doesn't; the `+` and New folder buttons are the touch path.
- A sheet tab. Right-click opens the tab's chevron dropdown at the chevron, and a long press opens nothing, because the always-visible chevron is the touch path.

## A submenu drills in on a phone

On a phone `DropdownMenu` shows a `DropdownMenuSub` as a page of the same menu, with a back row, instead of a flyout that has no room beside the menu. Three limits are accepted:

- Keyboard roving is weaker inside a page. The pages are built for touch first.
- A `DropdownMenuSub` directly inside a `DropdownMenuGroup` does not drill. No consumer nests it that way.
- Non-item JSX on an ancestor page stays visible while a deeper page is open. All such JSX sits on leaf pages.

## Four small differences are decided, not bugs

- The read-only Eye marker is dropped on a phone. Its tooltip can't show on touch, so the explanation is lost either way.
- A read-only member of a team chat has no entry to the access dialog on any viewport. A personal chat keeps `DriveShareSummary` in the toolbar.
- A pane row shows the comment's anchor text, the card dialog its title.
- On desktop, tapping a card in the docs activity panel switches to the comments panel to reveal its anchor. Every phone pane stays put.

Open mobile work, and the real-device check still owed, is the Mobile row in [ROADMAP.md](ROADMAP.md). How to verify at phone sizes: the [verify-in-browser skill](../.claude/skills/verify-in-browser/SKILL.md).

## See also

- [LAYOUT.md](LAYOUT.md): the shell, `ColumnLayout` and the hover rule
- [COMMENTS.md](COMMENTS.md): the comments and activity pane
- [SLIDES.md](SLIDES.md) and [CANVAS.md](CANVAS.md): the view-only canvas
