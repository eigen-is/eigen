# Layout

> **TLDR:** Every app is `EigenApp` (the provider stack) around `AppShell` (topbar, sidebar, content), and every page is a `ColumnLayout` of `Column`s with the toolbar passed as a prop. The shell lives in `packages/ui/src/components/layout/`, Drive's file UI in `packages/ui/src/components/drive/`. Four things are not obvious from the code: on a phone only the `mobileColumn` renders and the sidebar is a column, not an overlay; z-index is one project-wide scale and app code sets none; buttons navigate in the same tab while links inside content open a new tab; and every document-level keymap stands down while a dialog is open.

## Every app is `EigenApp` around `AppShell`

`EigenApp` (`layout/app/eigen-app.tsx`) holds the providers every app shares: hotkeys, query client, auth, theme, SSE, uploads, the quick-look overlay and the command palette. `AppShell` (`layout/app/app-shell.tsx`) draws the topbar, the sidebar and `<main>`. A new app wraps its `__root.tsx` in `AppShell` and makes `_auth.tsx` a `createAuthRouteOptions` route.

The marketing routes in `apps/index` use `AppShell` without `EigenApp`. So `PaletteRunner` renders nothing when the palette provider is missing, and nothing for an anonymous visitor either, so Mod+K never binds for them.

## Every page is a `ColumnLayout` of `Column`s with the toolbar as a prop

The toolbar is the `toolbar` prop of a `Column`, never part of the page content. `Column` draws it in a fixed `h-12` bar, so every page has the same toolbar height and the mobile back arrow has one home.

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
    <Column id="list" width="350px" onBack="sidebar" toolbar={<ListToolbar />}>…</Column>
    <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar />}>…</Column>
</ColumnLayout>
```

`width="flex"` takes the rest of the row. The bar's bottom border fades in once the content scrolls (`toolbarBorder="auto"`); columns with a canvas below set `"always"`. A plain page title is `ToolbarTitle`, which renders at the same regular weight as the `BreadcrumbPage` richer toolbars compose, so the two read alike.

## On a phone only the `mobileColumn` renders

Below 769px (`useIsMobile`, [MOBILE.md](MOBILE.md)) a `ColumnLayout` with a `mobileColumn` renders only the `Column` whose `id` matches, at full width. Without a `mobileColumn`, or outside a `ColumnLayout`, every `Column` renders. That is how an editor mounts a full-width pane as a sibling. It is also why `PanelColumn`, the comments and activity pane on every viewport, must mount outside any `ColumnLayout` that sets one: a wrapped pane silently never shows ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)).

`onBack` gives a column the mobile back arrow. A function steps up a level (detail to list). **The first column of a page passes `onBack="sidebar"`,** or a phone user has no way back to navigation. The sentinel opens the sidebar as a full column and checks `sidebarMode` itself, so a surface without a sidebar (an editor, `RequestAccessView`) never shows a dead arrow.

## The sidebar is a rail on a tablet and a column on a phone

`AppShell`'s `sidebar` prop is a node or a function of `SidebarProps`, whose only field is `condensed`. It is true on a tablet, where the sidebar is a `w-16` rail ([MOBILE.md § Width picks the layout](MOBILE.md#width-picks-the-layout-the-pointer-picks-the-affordances)). On a phone the sidebar replaces `<main>` as the one visible column, and `<main>` is hidden with CSS rather than unmounted, so an editor keeps its collab state and a list keeps its scroll.

`useLayout()` exposes the layout state (`sidebarColumnShown`, `isMobile`, `isTablet` and the setters) and `setDocumentTitle` for the browser tab. A fullscreen view with only the topbar (`RequestAccessView`, the admin access-denied screen) calls `setSidebarHidden(true)` and restores it on unmount.

## A dialog never grows to fit what a user typed

`DialogContent` caps its own width and height and scrolls inside, and its grid track is `minmax(0, 1fr)`, so a long word can't widen the box. Text a user owns (a title, a location, a description) still needs `min-w-0 break-words` where it sits in a flex row, or that row overflows the dialog.

## The command palette is the one shell surface with its own engine

The engine, parsers, providers and commands live in `packages/lib/src/core/command-palette/`, the dialog and rows in `packages/ui/src/components/layout/app/command-palette/`. Its New commands come from the shared `apps` registry and the EigenDocType registries (`EIGEN_DOC_TYPE_INFO`, `EIGEN_DOC_ICONS`), so a new EigenDocType appears in the palette with no palette change. A route publishes what is selected and what can be done with it through `usePaletteSelection` and `usePaletteSelectionActions`. Design and open work: [the proposal](proposals/PROPOSAL_COMMAND_PALETTE.md).

## One `DriveCapabilities` value gates every Drive action

`DriveLayout` is the file-management UI: `DriveList` (grid or table), `DriveDetail` and the dialogs in `drive-layout-dialogs.tsx`. Each render site declares its whole surface as one `DriveCapabilities` value (`drive-capabilities.ts`), and a capability that is off hands `undefined` handlers to the list, the detail column, the toolbar and the palette, so every surface hides the action the same way.

- The fs browser follows the viewer's own access: `browseCapabilities(canWrite)`, with `canWrite` from `useCheckPermissions` (the same `SharedDrive.canWrite` the mutations enforce). A folder shared read-only still browses, previews, downloads and copies out, but never offers Rename, Duplicate, Move to trash or a convert.
- The watched feed is `DRIVE_CAPABILITIES.readOnly`.
- Flat views (mime filters, per-app doc lists, shared by and with me) spread `.listing`, which has no move, because a flat view has no folder context. Mime filters read only the caller's own and team mounts, so they stay writable.
- Shared with me turns `canWrite` and `canRename` off: its rows are other owners' files and the feed carries no per-row permission. Delete stays on, because there it means leaving the share.

`canWrite` also rides into every file subject the view builds (`subjectFromPath(item, capabilities.canWrite)`). A convert writes its new document beside the source, so in a read-only feed it has nowhere to write ([PREVIEWS.md](PREVIEWS.md#a-file-subject-stores-identity-everything-else-is-derived)).

## One item menu serves the row and the detail column

`DriveItemMenuItems` (`drive-item-menu.tsx`) is the menu both the row's context menu and the detail column's kebab draw. Between its Open rows and its own item actions it draws the shared file actions through `FileActionMenuItems`, minus `save-to-drive`, because Drive's own Copy to… already says that. Each host passes the sorted listing as siblings, so Quick preview pages through the folder the way the Space key does ([PREVIEWS.md](PREVIEWS.md#the-host-mounts-the-runners-dialogs)).

`DriveBrowser` (`drive-browser.tsx`) is a lighter layer over the same table, with a breadcrumb and a mount list but no dialogs and no detail column. The file picker and the location field use it.

## The document apps reach Drive through one config

Only `apps/drive` mounts `DriveLayout` directly. Docs, Stickies, Slides and Sheets go through `EigenDocListView` and `EigenDocSharedView`, which filter by the app's MIME type. Their configs come from `buildConfig` in `eigendoc-config.ts`, which reads the EigenDocType registry, so an app gets its sidebar, list and shared views without its own Drive code.

## A file's icon comes from its name as well as its MIME type

`getFilePresentation` and `getFileIconComponent` live in `packages/lib/src/core/file-presentation.ts`, DOM-free so lib callers like the palette can use them; `getFileIcon` in `drive/file-presentation.tsx` is the JSX wrapper. Both take the file name, because a `.vcf`, a `.eml` or an `.ics` is often stored as `application/octet-stream`, and each still carries its app's icon and color, the way an Eigen document carries its own app's. `APP_FORMATS` in `packages/lib/src/core/file-presentation.ts` is the one list the icon, the tile tint and the format badge all read.

## Lists compose hooks, not a shared list component

Each list owns its rendering and composes the hooks in `packages/ui/src/hooks/`:

- `useListSelection`: click, modifier click, select all
- `useKeyboardListNavigation`
- `useListDrag`: the multi-drag badge
- `useListDropTarget`: a drop on a sidebar item, through `DroppableSidebarItem`
- `useContextMenu`, from `components/context-menu/`

`email-list.tsx` in Mail, `PersonList` (contacts and admin) and `use-drive-item-controller.ts` are the working examples.

A row's state is a class in `packages/ui/src/styles/globals.css`, painted in the current app's color (`--app-current-color` for the 2px stripe, `--app-current-color-soft` for the wash):

| Class | State | Paint |
|---|---|---|
| `eigen-list-item-active` | the open row | stripe and wash |
| `eigen-list-item-cursor` | the keyboard cursor (Mail) | stripe only, so it reads apart from the open row |
| `eigen-list-item-selected` | multi-selected | wash |
| `eigen-tile` (`-active`, `-selected`) | grid tiles | a full border, because a stripe and wash on a tile's label strip read as stray chrome |

`ContextMenuAnchor` portals its zero-size trigger into `document.body`. The trigger sits at viewport coordinates, and a transformed ancestor (a dialog's centering translate) would otherwise become its containing block and open the menu somewhere else.

## Reordering uses dnd-kit, moving between lists uses native drag

Reordering in place (a stickies column, the slides rail) uses `@dnd-kit`. Dragging between lists, onto a sidebar drop target, or to and from the OS uses native HTML5 drag: `useListDrag` and `useListDropTarget`, plus `useFileDropTarget` and `useFilePasteTarget` for OS files. dnd-kit never sees an OS file drop, and only the native path carries the drag type across lists.

## Hover-revealed affordances rest visible on touch

An action icon shown on row hover uses `group` with `invisible group-hover:visible`, and always adds the matching `pointer-coarse:` variant, set to what the mouse user sees on hover. A touch device has no hover, so without it the action is unreachable. `pointer-fine:group-hover:` is the opt-out for a hover that really is desktop-only. `scripts/check-standards.ts` gates it.

```tsx
<div className="invisible group-hover:visible pointer-coarse:visible ml-auto">
    <TooltipButton icon={Edit} tooltipText="Edit" onClick={…} />
</div>
```

Icon buttons with a tooltip are `TooltipButton`. When hover icons would change the row height, position them `absolute` over the row.

## Document keymaps stand down while a dialog is open

Global shortcuts use `@tanstack/react-hotkeys` (`useHotkey`), with `formatForDisplay()` for tooltip labels. Manual listeners stay for stateful navigation (`use-keyboard-list-navigation.ts`) and for editors that own their keys (Tiptap, the canvas keymap in [CANVAS.md](CANVAS.md)). Mod+K is a raw window listener rather than a `useHotkey`, so the palette opens from inside a text field too.

**A document-level keymap folds `useDialogOpen()` into its `enabled`.** The library's own guard covers text fields only, so a key pressed on a dialog button otherwise acts on the document behind it: Delete on a confirm button deleting the canvas selection, `#` in Mail's location picker trashing the message. The hook watches the DOM for an open `role="dialog"` or `role="alertdialog"`, so it keeps no registry. An overlay that is a dialog itself (the file preview, Mail's cheat sheet) registers its keys ungated.

## One z-index scale, and app code sets none

| Layer | z-index | Examples |
|---|---|---|
| Document content | auto | everything that flows |
| In-content floating UI | 10 | inline autocompletes, suggestion lists |
| Sheet canvas overlays | 8 to 30 | selection, freeze handles, scrollbars, all under `cellArea` |
| Portaled UI | 50 | shadcn and Radix dropdowns, popovers, dialogs |
| Full-screen overlay | 100 | `FilePreview`, slides `PresentMode` |
| Above the overlay | 200 | `DialogContent` with `abovePreview`; `MessageView`'s details popover in the `.eml` quick look |
| Toaster | library | Sonner stacks itself |

- **App components set no z-index.** They use layout instead: a flex sibling (slides) or `absolute` inside a parent that makes a stacking context (docs, `relative overflow-hidden`). Side panels belong here.
- `position: relative` alone makes no stacking context. It takes a z-index other than `auto`, or `transform`, `opacity` below 1, `filter`, `isolation: isolate` or `will-change`. To contain children's z-indices, add `isolation: isolate`.
- Don't raise a menu above shadcn's z-50. If a portaled menu is covered, lower whatever covers it.
- **Anything above 50 carries a comment** saying why. A layer at 200 is a `role="dialog"` after the overlay in `<body>`, which is how the overlay under it knows to stand its own keys down ([PREVIEWS.md](PREVIEWS.md#the-overlays-keys-stand-down-for-a-layer-above-it)).
- Overlays inside the sheet's `cellArea` stay at 30 or below, so the sheet's portaled menus land above them at 50.

## Buttons navigate here, links in content open a new tab

The rule is who started the navigation, not where it points, so a user can predict it by looking. A rule that depended on the destination's host would be invisible: two links that look the same would behave differently.

**A navigation affordance opens in the same tab.** A notification row and its toast's View, activity and file-history rows, Drive rows, the quick-look overlay's Open and creating a document all mean "take me there". `openDocument()` (`packages/lib/src/core/api.ts`) has no new-tab branch, so the path that opens an Eigen document can't drift; other affordances follow the rule by convention.

A link isn't checked for access before it is shown. The fs listing needs read access to the item's parent folder; when it answers 403 and the URL carries `?pid=`, the drive route redirects to `getDriveShareUrl()` for that item. The destination knows the answer, and a link builder could only guess. Request access still shows for a viewer who can't read the item either ([ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)).

**A link or chip inside content opens a new tab, whatever it points at.** A URL in a chat message, a comment, a sticky card or an email is an aside, and so is the drive-reference chip beside it: following it must not abandon what the user is reading. The sanitizer (`core/html-dom.ts`), chat's linkifier (`rich-content.tsx`), sheet cell hyperlinks, the docs and `LightEditor` Tiptap links and `reference-attachment-chip.tsx` all enforce it unconditionally.

Two cases leave the same-tab side:

- The user asked for a new tab: Drive's Open in new tab row and the `drive.open-in-new-tab` command. Prefer a real `<a href>` for a navigation affordance where the markup allows it (`DriveItemNameLink`, the quick-look overlay's Open, Drive's recent-activity rows through `ActivityRow`'s `href`), because Cmd-click and middle-click then open a new tab and the user keeps the choice. Two things block an anchor: a URL that needs an async resolve (the notification bell), and a button in the row's `trailing` slot, since a `<button>` inside an `<a>` is invalid HTML.
- The destination is outside the app: downloads, the marketing site, exported HTML, and mail. Mail is deliberate twice over. A share email is read in other clients as often as in Eigen Mail, and deciding "open in this tab" from a stranger's URL is exactly where an Eigen-looking phishing host would replace the reader's inbox.

## See also

- [MOBILE.md](MOBILE.md): the breakpoints and how the shell behaves on phones and touch
- [COMMENTS.md](COMMENTS.md): the comments and activity pane
- [PREVIEWS.md](PREVIEWS.md): the quick-look overlay, file subjects and file actions
- [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md): every shared component, hook and type, generated
- [TYPOGRAPHY.md](TYPOGRAPHY.md): type scale and fonts
