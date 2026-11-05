# Mobile

> **TLDR:** Eigen has no separate mobile app: the same components adapt to two independent signals. The viewport width picks the layout, and the pointer type picks the touch affordances. The media hooks live in `packages/lib/src/core/media/`.

A phone shows one column at a time, built from the same `ColumnLayout` and sidebar as the desktop ([LAYOUT.md](LAYOUT.md)), so a page that follows the layout rules gets most of its phone behavior for free. What steps aside on a phone is hidden with CSS, never unmounted, so an editor keeps its state. A phone views the canvas documents (slides, vector) but never edits them. Long-press opens the same context menu as right-click, and a submenu opens as a page of its menu.

## Width picks the layout, the pointer picks the affordances

| Width | Hook | Layout |
|---|---|---|
| up to 768px | `useIsMobile` | one column at a time; the sidebar is a full column |
| 769 to 1024px | `useIsTablet` | the sidebar is a `w-16` rail (`SidebarProps.condensed`) |
| from 1025px | `useIsDesktop` | the full sidebar and every column side by side |

Touch affordances never key on width: an iPad in landscape gets the desktop layout but has no hover, and a narrow desktop window has a mouse. So they key on a coarse pointer (`pointer-coarse:`, `useIsCoarsePointer`) or a `touch` pointer event. A hover-revealed action rests visible ([LAYOUT.md](LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch)), a menu hides its key hints, and Drive's Move to trash confirms first, since a mis-tap is easy with no hover cue.

An editor toolbar folds its icon row into its menus by its own width gate (`useIsCompactToolbar`, or the bar's own width in Sheets, [LAYOUT.md](LAYOUT.md#the-app-bars-menus-are-one-radix-menubar)). That is density, not touch. On a phone Docs also folds its Tools menu into the share cluster's kebab (`mobileMenuItems`), because five menus overflow a 360px screen.

The media hooks answer `false` during a prerender, so a build-time render and the first client render agree on the desktop layout.

## A phone shows one column, and the rest stays mounted

`ColumnLayout`'s `mobileColumn` picks the one `Column` a phone renders, and the first column's `onBack="sidebar"` arrow opens the sidebar as a column ([LAYOUT.md](LAYOUT.md#on-a-phone-only-the-mobilecolumn-renders)). The sidebar column closes on every navigation, including one that changes only the search params, such as Mail's `?mode=compose`.

What steps aside is hidden, not unmounted: `<main>` under the sidebar column, and docs, sheets and the canvas under the comments pane ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)). An editor keeps its collab socket, scroll position, selection and undo history across the visit.

## A hidden surface can't be scrolled or focused

A scroll or a focus call on a `display: none` subtree does nothing. So a phone opens a comment card with plain `setOpenCardId` instead of revealing its anchor first, and opening find (⌘F, an in-document palette hit) closes the comments pane through `useDocumentPanels`' `onSearchOpenChange`, because the find bar floats inside the hidden editor. The sheet re-measures its canvas when its container shows again ([SHEETS.md](SHEETS.md#comments-are-eigen-comment-cards)).

## Docs panels need 769px

The docs comment, activity and properties panels render whenever the viewport is not a phone. With a panel open, the page first slides left and scales down only when the slack runs out; the shift keeps the text column clear, so a wide table may tuck under the panel. A phone has no form of these panels. Format › Table and Format › Image hold what a table and an image need there, but a chart's Edit data, caption and layout have no way in on a phone ([DOCS.md](DOCS.md#the-properties-panels-follow-the-selection-on-desktop-only)).

## A phone views canvas documents, never edits them

Slides and vector set `canEdit = canWrite && !isMobile`. The file menu, the share cluster and comments keep `canWrite`, so a phone user can still share, comment and download. The canvas keymap is gated on `canEdit` too, so a hardware keyboard can't act on the deck.

A phone gets the frame-fit canvas, read-only, and pages a deck with a horizontal swipe. The slides rail would take half a phone, so the phone shows its thumbnails as a row under the slide instead, as Google Slides does in portrait: a tap jumps, and there is no drag or menu ([SLIDES.md](SLIDES.md)).

Present mode works without the fullscreen API, which iOS Safari lacks: the overlay is `fixed inset-0` with its own exit X, and it leaves present when fullscreen ends outside its control, such as Android's back gesture.

## Long-press opens the same context menu as right-click

WebKit on iOS never turns a long touch into a `contextmenu` event, so `useLongPress` (`packages/ui/src/hooks/use-long-press.ts`) opens the surface's own menu after a still press on a touch pointer. Lists, tiles, cards, the sheet's cells and headers, chat messages and attachment chips all use it. A chat message's floating action bar is `pointer-fine:` only, because a long press opens the same actions. `.eigen-list-item` and `.eigen-tile` set `-webkit-touch-callout: none`, so iOS's link-preview callout doesn't compete with the menu.

Three menus stay right-click only, because touch has another path:

- Canvas objects: a phone can't edit the canvas.
- Drive's create menu on empty list space: the `+` and New folder buttons are the touch path.
- A sheet tab: its always-visible chevron is the touch path.

## A submenu drills in on a phone

On a phone a `DropdownMenu`, and every app-bar menu, shows a `DropdownMenuSub` as a page of the same menu with a back row, since a flyout has no room beside the menu. Three limits are accepted:

- Keyboard roving is weaker inside a page, which is built for touch.
- A `DropdownMenuSub` directly inside a `DropdownMenuGroup` does not drill. No consumer nests it that way.
- Non-item JSX on an ancestor page stays visible while a deeper page is open. All such JSX sits on leaf pages.

## Two small differences are decided, not bugs

- The read-only Eye marker is dropped on a phone: its tooltip can't show on touch.
- On desktop, tapping a card in the docs activity panel switches to the comments panel to reveal its anchor. Every phone pane stays put.

Open mobile work, a check on real devices included, is the Mobile row in [ROADMAP.md](ROADMAP.md). The [verify-in-browser skill](../.claude/skills/verify-in-browser/SKILL.md) covers checking at phone sizes.

## See also

- [LAYOUT.md](LAYOUT.md): the shell, `ColumnLayout` and the hover rule
- [COMMENTS.md](COMMENTS.md): the comments and activity pane
- [SLIDES.md](SLIDES.md) and [CANVAS.md](CANVAS.md): the view-only canvas
