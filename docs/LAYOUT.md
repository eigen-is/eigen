# Layout

> **TLDR:** Every app is `EigenApp` (the provider stack) around `AppShell` (topbar, sidebar, content), and every page is a `ColumnLayout` of `Column`s with the toolbar passed as a prop. The shell lives in `packages/ui/src/components/layout/`, Drive's file UI in `packages/ui/src/components/drive/`. Five things are not obvious from the code: on a phone only the `mobileColumn` renders and the sidebar is a column, not an overlay; every context and ⋮ menu draws its rows in one order, with a destructive row last and red; z-index is one project-wide scale and app code sets none; buttons navigate in the same tab while links inside content open a new tab; and every document-level keymap stands down while a dialog is open.

This doc governs the frame every app draws its pages in and the conventions that make the apps feel like one product: the shell, the columns, the gutter, Drive's file UI, lists, drag, the keyboard, layering, where a click opens, and the Radix traps. Read it before you add a page, a list, a menu or a shortcut. The pieces live in `packages/ui`, with their logic in `packages/lib`, so an app composes the shared pieces instead of laying out its own, and a fix to the shell reaches every app at once. Phones and touch screens add their own rules on top ([MOBILE.md](MOBILE.md)).

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

A list whose items open a detail is `ListDetailLayout` (`list-detail-layout.tsx`), as on the contacts, admin users and admin teams pages. With nothing selected the list fills the page and there is no detail column. The page passes `detail` only while its URL names a selection, such as `?contactId=`, `?userId=` or `?teamId=`: the list then narrows to 350px beside the detail, and on a phone the detail replaces the list. Mail draws the same layout by hand, with a list of 400px (320px on a tablet).

## Every horizontal inset is the one gutter

**Every list, toolbar, header and pane takes its horizontal inset from `--app-gutter-x`**, through the `app-gutter-x` class, or `app-gutter` where it pads both axes (`packages/ui/src/styles/globals.css`). The gutter is 16px below the `sm` breakpoint (640px), wide enough for Mail's unread dot to sit centered in it clear of the sender, and 20px from `sm` up. Beside the content (desktop and the tablet rail), the navigation sidebar narrows it to 12px, because its items are padded pills; the mobile sidebar keeps 16px: `SidebarContainer` overrides `--app-gutter-x` with the `app-gutter-sidebar` class, so its primary button, items and scrollers follow. Each block of the topbar takes the inset of the column below it: its left block (app switcher and logo) takes `app-gutter-sidebar` too when a sidebar is beside the content, so it shares the sidebar's left edge, and its right block (search, bell, avatar) keeps the content gutter. No list, toolbar, header or pane hand-rolls its own inset, so a row, its header and the toolbar above it share one left edge, and a Drive tile lines up with the toolbar's first item. A dialog pads with its own `p-6` instead, and a full-pane dialog (the chat create wizard, the Drive file and location pickers) drops it and gives its header, footer and sections `px-6`.

20px is what clears a macOS overlay scrollbar. It takes no layout width, so `scrollbar-gutter` can't reserve room for it, and its hover track paints over a scroller's last 16px or so. A scroller inside a padded parent (a dialog, a sidebar body) takes `app-gutter-bleed`: it reaches out by one gutter and pads its content back in, so the content keeps its edge and still clears the track. Whatever cancels the gutter (a hover fill that bleeds to the pane's edge) cancels it with the variable, `-mx-(--app-gutter-x)`, never a literal, so it follows the breakpoint. A literal negative margin only cancels an item's own padding, as the command palette's groups reach out by their items' `px-2` so item text lines up with the search icon.

## On a phone only the `mobileColumn` renders

Below 769px (`useIsMobile`, [MOBILE.md](MOBILE.md)) a `ColumnLayout` with a `mobileColumn` renders only the `Column` whose `id` matches, at full width. Without a `mobileColumn`, or outside a `ColumnLayout`, every `Column` renders. That is how an editor mounts a full-width pane as a sibling. It is also why `PanelColumn`, the comments and activity pane on every viewport, must mount outside any `ColumnLayout` that sets one: a wrapped pane silently never shows ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)).

`onBack` gives a column the mobile back arrow. A function steps up a level (detail to list). **The first column of a page passes `onBack="sidebar"`,** or a phone user has no way back to navigation. The sentinel opens the sidebar as a full column and checks `sidebarMode` itself, so a surface without a sidebar (an editor, `RequestAccessView`) never shows a dead arrow.

## The sidebar is a rail on a tablet and a column on a phone

`AppShell`'s `sidebar` prop is a node or a function of `SidebarProps`, whose only field is `condensed`. It is true on a tablet, where the sidebar is a `w-16` rail, its 40px icons inside the sidebar's 12px gutter on each side ([MOBILE.md § Width picks the layout](MOBILE.md#width-picks-the-layout-the-pointer-picks-the-affordances)). On a phone the sidebar replaces `<main>` as the one visible column, and `<main>` is hidden with CSS rather than unmounted, so an editor keeps its collab state and a list keeps its scroll.

A sidebar row is selected by its path alone: `SidebarItem` matches with `includeSearch: false`, because a click on an item in a list adds the item to the URL's search (`?pid=…`), and an exact match that compared the search unselected a filter such as **All stickies** the moment a board was picked.

`useLayout()` exposes the layout state (`sidebarColumnShown`, `isMobile`, `isTablet` and the setters) and `setDocumentTitle` for the browser tab. A fullscreen view with only the topbar (`RequestAccessView`, the admin access-denied screen) calls `setSidebarHidden(true)` and restores it on unmount.

## A dialog never grows to fit what a user typed

`DialogContent` caps its own width and height and scrolls inside, and its grid track is `minmax(0, 1fr)`, so a long word can't widen the box. Text a user owns (a title, a location, a description) still needs `min-w-0 break-words` where it sits in a flex row, or that row overflows the dialog.

## A closing dialog gives the focus back

Radix's modal content gives the focus back to a `DialogTrigger` alone. Without help the focus falls to `<body>` as a dialog opened from a menu or a key closes, and a list's keys do nothing until a click. `useFocusReturn` gives it back. `DialogContent` and `FilePreview` call it, and a Radix dialog built outside `DialogContent` calls it too. It reads what had the focus as the dialog renders open, before a field's `autoFocus` moves it. A dialog opened from a menu row reads a row that is gone a moment later. A context menu (`useContextMenu`) hands the dialog the list it opened from as the menu closes: its `restoreFocus` calls `returnFocusTo`, which finds the focus inside the dialog, leaves it there and makes the list that dialog's target. Focusing the list instead would make the dialog's focus trap take the focus back and select all of its field's text. A dropdown menu with its own Radix trigger, such as a toolbar's ⋮ menu, focuses that trigger as it closes. Then the first element outside every open dialog that takes the focus becomes the target. A bar menu (`AppBarMenu`), such as File, gets no such focus: Radix's Menubar focuses no trigger once the focus moved into the dialog, and an editor's handler keeps the focus where it is. So the bar menu hands its trigger to the dialog with `handFocusReturnTo` as it closes, and File › Rename › Escape lands on File. A test of this needs a real `Menubar`, since a `DropdownMenu` does focus its trigger. A target still on the page is never replaced, and an element inside any open dialog never becomes one, so the fields of a dialog opened over this one, such as Save to Drive over a preview, can't take its place.

On close, a caller's `onCloseAutoFocus` runs first, and one that calls `preventDefault`, such as the sheet's grid refocus or the Docs editor's, decides where the focus goes. Otherwise the dialog calls the same `returnFocusTo` with its target, if that is still on the page. Something that took the focus as the dialog or the menu closed keeps it, such as the Rename dialog a palette row opened, or the edit box a chat message's Edit row focuses. A dialog that holds the focus and whose own target is gone takes over the closing one's target, so its own close returns to the list.

The focus comes back with a focus ring only when its target had one as it left (`:focus-visible`, which a browser sets for a Tab and not for a mouse click). `returnFocusTo` and `handFocusReturnTo` take that as `ring`; a caller that passes none, such as the menu bar's File menu, keeps the ring the dialog recorded from the menu row it came from. And a dropdown menu that a pointer opened focuses its own trigger with `focusVisible: false` instead of leaving it to Radix, whose plain `focus()` after Escape draws a ring in Chrome. Without this a hover-revealed ⋮ that a mouse clicked, such as a calendar's or a Drive tile's, shows while it has a ring and stays shown after the pointer leaves. The dropdown menu tells a pointer from a key by the trigger's `pointerdown` or `keydown` that Radix opens it on, and focuses no trigger where Radix wouldn't, after a right-click outside or any outside press on a non-modal menu. Chrome 145, Firefox 104 and Safari 18.4 honor `focusVisible`, and an older browser draws the ring.

## The command palette is the one shell surface with its own engine

The engine, parsers, providers and commands live in `packages/lib/src/core/command-palette/`, the dialog and rows in `packages/ui/src/components/layout/app/command-palette/`. Its New commands come from the shared `apps` registry and the EigenDocType registries (`EIGEN_DOC_TYPE_INFO`, `EIGEN_DOC_ICONS`), so a new EigenDocType appears in the palette with no palette change. A page publishes what is selected and the menu rows bound to it through `usePaletteSelection`. How it merges, scopes, ranks and takes a published selection: [COMMAND-PALETTE.md](COMMAND-PALETTE.md).

## One `DriveCapabilities` value gates every Drive action

`DriveLayout` is the file-management UI: `DriveList` (grid or table), `DriveDetail` and the Drive action runner (`useDriveActionRunner` in `drive-action-runner.tsx`), which runs each action and owns its dialogs. Each render site declares its whole surface as one `DriveCapabilities` value (the type in `types/drive.ts`, the presets in `drive-capabilities.ts`). `DRIVE_ACTIONS` (`packages/lib/src/core/drive/drive-actions.ts`) is the one list of Drive actions, with each row's label, icon, menu group and gate, in `FILE_ACTIONS`' shape. Watch is not a row: it shows the item's live watch state, so the menu and the palette draw it from `useWatchToggle`. `driveActionsFor({ items, capabilities, isSharedWithMe })` answers which rows apply, and `useDriveActionsFor(capabilities)` drops the guest-denied and mail-only rows for the viewer, so the row menu, the detail column's buttons, the Delete key and the command palette offer the same set. The runner's `actionsFor(items)` is that hook, and `run(id, items)` refuses a row the items don't offer.

- The fs browser follows the viewer's own access: `browseCapabilities(canWrite)`, with `canWrite` from `useCheckPermissions` (the same `SharedDrive.canWrite` the mutations enforce). A folder shared read-only still browses, previews, downloads, copies out, copies a link and mails, but never offers Rename, Duplicate, Move to trash or a convert. Copy link and Mail to need only read access, so a read-only view keeps a Share submenu with those two.
- Duplicate follows `canWrite`, not `canMove`: the copy lands beside its source, so a flat listing offers it. A root item is never duplicated, and neither is an item shared with the viewer, whose source folder is its owner's, where the server refuses the copy.
- The watched feed is `DRIVE_CAPABILITIES.readOnly`.
- An open document's File menu has no view, so it gates its Drive rows (Rename, Share, Email collaborators, Move to trash or Remove shared item) on `browseCapabilities(canWrite)` with the editor's own `canWrite`: the document stands where the fs browser's folder stands. A reader gets no Share, Rename or delete row there.
- Flat views (mime filters, per-app doc lists, shared by and with me) spread `.listing`, which has no move, because a flat view has no folder context. A mime filter and a document app's index list the viewer's own and team items, which stay writable, and the items shared with the viewer too (`Drive.getMimeTypeContents`), which keep their owner's folder.
- Shared with me turns `canWrite` and `canRename` off: its rows are other owners' files and the feed carries no per-row permission. Delete stays on, because there it means leaving the share.

`canWrite` also rides into every file subject the view builds (`subjectFromPath(item, capabilities.canWrite)`). A convert writes its new document beside the source, so in a read-only feed it has nowhere to write ([PREVIEWS.md](PREVIEWS.md#a-file-subject-stores-identity-everything-else-is-derived)).

## One item menu serves the row and the detail column

`DriveItemMenuItems` (`drive-item-menu.tsx`) is the menu both the row's context menu and the detail column's kebab draw, for one item or a multi-selection. A multi-selection gets only the rows with a `pluralLabel`, whose `{n}` `labelFor` fills with the count ("Move 3 items to…"). Each row is a `DriveActionMenuItem`, the one drawing of a Drive action as a menu row (its label, its red when it destroys, its key), which the File menu and Trash's row menu draw too. Three rows draw more than a label: Download as opens its formats, Watch reads its live state through `WatchMenuItem`, and one item's sharing rows sit in a Share submenu. A row's `shortcut` holds its hotkey constant from `constants/hotkeys.ts`, the one the listing's key handler compares against too, and the menu draws it through `formatForDisplay` as every Eigen menu does: Quick preview shows ␣ and the delete row ⌫, on every platform. Only the row's context menu names them, through its `shortcuts` flag, because those keys act on the listing; the detail column's ⋮ names none. It draws the shared file actions through `FileActionMenuItems` one group at a time, each beside its own rows in the menu order ([Menus draw their rows in one order](#menus-draw-their-rows-in-one-order)), minus `save-to-drive`, because Drive's own Copy to… already says that. Each host passes the sorted listing as siblings, so Quick preview pages through the folder the way the Space key does ([PREVIEWS.md](PREVIEWS.md#the-host-mounts-the-runners-dialogs)). Space, a click on the detail column's preview and the menu row all go through the file-action registry, so none of them previews a folder and a read-only view's preview offers no convert.

`DriveBrowser` (`drive-browser.tsx`) is a lighter layer over the same table, with a breadcrumb and a mount list but no dialogs and no detail column. The file picker and the location field use it.

## Menus draw their rows in one order

Every right-click menu and every ⋮ menu composes `MenuSections` (`packages/ui/src/components/context-menu/menu-sections.tsx`). A host hands each row to a named group, and the component draws the groups in a fixed order with a separator between two that are there. The order is the one source, so a user finds Copy, Download or Delete in the same place in every app, and a new menu cannot drift from it.

| Group | Rows |
|---|---|
| `open` | Open, Open in new tab, Quick preview, View comment, Reply, Forward |
| `clipboard` | Cut, Copy, Paste, in that order, from `ClipboardMenuItems` with their shortcuts |
| `create` | New slide, Insert, Duplicate, Edit, Rename |
| `organize` | Move to, Copy to, Archive, labels, color, assign, resolve, hide, sort, filter, Clear contents |
| `arrange` | A canvas object's or a sheet image's or chart's `OrderMenuSub` (Google Slides' Order ▸), a sheet tab's Move left and right |
| `convert` | Convert to shapes, Convert to Sheet, Document or Slides |
| `output` | Download, Export, Print, Save to Drive, Import to…; an object's Download original image and Download image |
| `collaborate` | Add comment, Share ▸, Watch |
| `destructive` | Delete, Move to trash, Remove…, Delete row or column |

Shared rows know their group. A `FileAction` in `packages/lib/src/core/file-actions.ts` names one (`open`, `convert` or `output`), and `FileActionMenuItems` draws all three in their places, or one when the host passes `group`, as Drive does to put Quick preview by Open. The comment rows take the groups themselves on a card's own menu; in a menu about something else (a cell, an image) the host draws `part="rows"` in its collaborate group and `part="delete"` in its destructive group, so the comment's Delete sits with the cell's.

`DropdownMenuSeparator` hides itself when it opens the menu, follows another separator or has no row after it. A row component may render nothing (`DownloadOriginalImageMenuItem` with no path, `DownloadImageMenuItem` with nothing to draw, the comment rows for a viewer), and the separator before it then goes too, so no host writes separator logic of its own. Tests read a menu as a user sees it through `menuRows` and `collapseSeparators` in `packages/ui/src/test/menu-rows.ts`, since happy-dom draws no CSS.

Bar menus (File, Edit, Format) keep Google's order, which a user knows from Docs, except that their delete rows go last and red, as Format › Table's Delete row, column and table do.

## The app bar's menus are one Radix Menubar

**The menus at the left of a document app's bar are one shadcn `Menubar`, each menu an `AppBarMenu`**: Docs, Sheets, Slides, Vector, Stickies, and Drive's markdown editor when its bar is compact. The menus are non-modal, as Google's are. A press outside an open menu closes it and also reaches what is under it: it focuses an input, places the caret in a document and selects a cell. Where it would change something, it only closes the menu: the canvas ignores it, so the eraser deletes nothing and the text tool places no box, and a formula being composed takes no reference from it. Both ask `pressClosesMenu` in `menubar.tsx` on their pointerdown, which runs before Radix closes the menu on the same press; the grid acts on the mousedown, so `SheetOverlay` keeps the answer in `globalCache.pressClosedMenu` for it. A hover moves to another menu once one is open, and ArrowLeft and ArrowRight walk across the bar. The icon row's dropdowns (Align, the style and font pickers) and the share kebab are `modal={false}` for the same reason: one press on File moves on from them.

The rows are the `DropdownMenu*` rows every other menu uses. Radix gives each kind of menu its own React contexts, so a `DropdownMenu` row inside a Menubar menu would find no menu around it. `MenubarContent` wraps its rows in `MenuRows`, which hands each row the Menubar's Radix parts, so one row such as `ChoiceMenuSub` or `ColorPickerMenuItem` serves a bar menu and a context menu alike, the phone's drill-in included. A whole `DropdownMenu` nested inside a bar menu's rows, such as a picker, gets its own parts back from `DropdownMenuContent`, which provides the DropdownMenu's parts and its root page to its rows, so a pick closes it and leaves the bar menu open.

Three things keep the bar from closing under the user:

- A bar menu has no exit animation, as shadcn's has none. A closing menu kept on screen while it fades sees the focus move into the next menu, and closes the whole bar.
- A press on an open menu's trigger closes it. Once a menu is open, though, Radix opens the next one as the pointer moves onto its trigger, before the press the user aimed at it. `AppBarMenu` keeps a menu the pointer opened through that press, with the focus in the menu.
- An editor that takes the focus back as a menu closes takes it only from the page's body, where a pick or Esc leaves it, or from a menu's trigger (`focusLeftToEditor` in `menubar.tsx`). `keepEditorFocus` in Docs and `useCellEditorRefocus` in Sheets ask it. Whatever else took the focus keeps it: the next menu, which would close on focus-outside, a dialog a pick opened, and an input a press outside landed on, such as the size box, the find bar or a comment's reply box.

A bar trigger is a `role="menuitem"` inside the `role="menubar"`, so a test that looks for a menu's rows looks inside `[role="menu"]`.

The bar of Docs, Sheets, Slides, Vector and Stickies is a `CenteredToolbar`: the menus on the left, the icon row at the bar's true center and the share cluster on the right. The menu row never scrolls. The icon row folds into the menus as the bar narrows, so every icon it folds away is a row of a menu; Docs' and Sheets' fold from the right end, so their order is their priority order. Each breakpoint is where a part of the row fits beside the menus, with the widest font name in the font picker. The other editors read the viewport's width. Sheets reads the bar's own width, through a container query on `WorkbookMenuBar`, as a panel beside the workbook narrows the bar.

## A row that deletes is red and last

**A row that deletes, trashes or removes is `variant="destructive"`**, red with its icon, and sits alone in the last group. Move to trash is red even though Trash restores it, and a Sheets row's or a table's Delete row goes there too, apart from its Insert. Google draws none of these red and puts Delete in the middle of a menu; Eigen follows iOS and Material instead, so the one row that loses work is the one a user finds last and sees coloured. Log out is last but plain, since it loses nothing, and Clear contents is an object action.

A share dialog's role Remove is a `SelectItem` with the same `variant`, behind a `SelectSeparator`.

A properties panel has no Delete button. An object's Delete is its menu's last row, the Delete key and Edit › Delete, in Vector, Slides and Sheets alike, so the panel holds only what edits the object and a misclick there loses nothing.

`scripts/check-standards.ts` gates it as a hard zero: a `DropdownMenuItem` or `SelectItem` that draws a `Trash2` icon, or whose label says Delete, Remove or to trash, fails without the variant, and so does one tinted by `text-destructive`, which leaves the icon grey. A toggle's label (`'Remove' : 'Add'` space before) is an undo and passes.

## Pink is Eigen's accent color

Pink `#f6339a`, the accent row of the pink column in `packages/lib/src/constants/colors.ts`, is Eigen's accent color. It comes first in `EIGEN_ACCENT_COLORS_SHUFFLED`, the order calendars, labels, chart series and presence hand the accents out in, so what Eigen picks for a user starts in its own color: a new account's first calendar and a chart's first series. A new deck's title slide opens on it too. Rose and fuchsia sit close to it, so they come late in that order ([CHARTS.md](CHARTS.md) has the reasoning).

A fixed color mapped onto the palette (`eigenColor(name, step)`, as the sheet's color scales and data bars do in `CF_PRESETS`) takes the nearest palette color by OKLab distance, and where the choice is in doubt the lighter, less saturated step, because the originals are muted.

## A choice is a submenu with a check

**A row that shows a current option or an on state draws a check on its left, and nothing else does.** Google's menus work this way (View › Mode, Format › Line & paragraph spacing, View › Show ruler), so a user reads every Eigen menu the same way, and a screen reader hears each row as checked or not.

- A choice, one of several, goes through `ChoiceMenuItems` in `dropdown-menu.tsx`: one row per option, the current one checked, each a `menuitemradio`. A mixed selection passes no value and checks no row.
- In a menu of actions the choice is `ChoiceMenuSub`, a submenu named for the property: an equation's Style ▸, the avatar's Theme ▸, a comment's Assign to ▸. A menu whose trigger already names the choice (the Align dropdown, All sheets, Drive's sort, a phone's View options) lists the options directly.
- An on/off setting is one `DropdownMenuCheckboxItem`, a `menuitemcheckbox` checked when on. A set of them with several on (the comment filter's Color, Assign label) keeps the menu open with `onSelect` preventing the default, and a label only some of the selection has is `checked="indeterminate"`, drawn as a dash.
- An action that flips its item's state keeps Google's label swap instead of a check: Add or Remove space before paragraph, Create or Remove filter, Watch or Stop watching. Commands that set a value without showing it, such as Format › Text › Bold, stay plain rows, as in Google.

`DropdownMenuRadioGroup` and `DropdownMenuRadioItem` are not exported, so a choice cannot draw Radix's dot. `scripts/check-standards.ts` gates the rest as a hard zero: a `DropdownMenuItem` that draws a `Check` when a condition holds fails. The color picker's swatch grid is exempt, since it marks its color inside the swatch, as Google's palette does. A searchable member list (`MemberCommandList`) is a combobox, not menu rows, and keeps its trailing check.

## The document apps reach Drive through one config

Only `apps/drive` mounts `DriveLayout` directly. Docs, Stickies, Slides and Sheets go through `EigenDocListView` and `EigenDocSharedView`, which filter by the app's MIME type. Their configs come from `buildConfig` in `eigendoc-config.ts`, which reads the EigenDocType registry, so an app gets its sidebar, list and shared views without its own Drive code.

## A file's icon comes from its name as well as its MIME type

`getFilePresentation` and `getFileIconComponent` live in `packages/lib/src/core/file-presentation.ts`, DOM-free so lib callers like the palette can use them; `getFileIcon` in `drive/file-presentation.tsx` is the JSX wrapper. Both take the file name, because a `.vcf`, a `.eml` or an `.ics` is often stored as `application/octet-stream`, and each still carries its app's icon and color, the way an Eigen document carries its own app's. `APP_FORMATS` in `packages/lib/src/core/file-presentation.ts` is the one list the icon, the tile tint and the format badge all read.

## Lists compose hooks, not a shared list component

Each list owns its rendering and composes the hooks in `packages/ui/src/hooks/`:

- `useListSelection`: click, modifier click, select all
- `useKeyboardListNavigation`: Space, Enter, Delete and the menu key (Shift+F10 or the ContextMenu key) act on the cursor row, or on the topmost selected row when a select-all left no cursor
- `useListDrag`: the multi-drag badge
- `useListDropTarget`: a drop on a sidebar item, through `DroppableSidebarItem`
- `useContextMenu`, from `components/context-menu/`

`email-list.tsx` in Mail, `PersonList` (contacts and admin) and `use-drive-item-controller.ts` are the working examples.

A row's state is a class in `packages/ui/src/styles/globals.css`, painted in the current app's color (`--app-current-color` for the 2px stripe, `--app-current-color-soft` for the wash):

| Class | State | Paint |
|---|---|---|
| `eigen-list-item-active` | the open row | stripe and wash |
| `eigen-list-item-cursor` | the keyboard cursor on a row that isn't open | stripe only, so it reads apart from the open row |
| `eigen-list-item-selected` | multi-selected | wash |
| `eigen-tile` (`-active`, `-selected`) | grid tiles | a full border, because a stripe and wash on a tile's label strip read as stray chrome |

A row takes every class that holds, the way `email-list.tsx`, `DriveRow` and `PersonList` set them: the open row `-active`, the cursor on any other row `-cursor`, and each selected row `-selected` on top. A plain click opens, selects and moves the cursor to one row, which then has the stripe and the wash. A right-click or ⋮ selects its row without opening it, so the open row keeps its look and the other row gets the wash. A grid tile has no cursor look of its own: `DriveGrid` draws the cursor's tile `-active`.

`ContextMenuAnchor` portals its zero-size trigger into `document.body`. The trigger sits at viewport coordinates, and a transformed ancestor (a dialog's centering translate) would otherwise become its containing block and open the menu somewhere else.

One context menu serves the whole list, so a list never draws a `DropdownMenu` per row. A row's button opens it with `openAt(item, rect.right, rect.bottom)` from the button's own bounding rect, because a click made with the keyboard's Enter has clientX and clientY 0,0.

The menu key opens the same menu from the row's own rect: the list passes `onMenu`. A list that draws every row, such as `PersonList`, gets the row's element from the hook, and a virtualized list finds it by the `data-index` its virtualizer already puts on each virtual row (a grid tile by that row and its column). In a virtualized list the hook scrolls the row in and calls `onMenu` a frame later, once the row is drawn, so the menu never opens at the list's corner. On Windows and Linux the browser follows the key with a native `contextmenu` event at whatever has the focus, on Windows at keyup, when the row's menu already holds the focus. A keydown `preventDefault` doesn't stop it, and left alone it opens the browser's menu over ours, or Drive's New menu behind the list. `isKeyboardContextMenu` (`use-context-menu.ts`) tells that event from a pointer's: a key's reports button 0 and a right-click 2, and a Mac's Ctrl+click and a long press, which report 0 too, carry the Ctrl key or a touch `pointerType`. A key's event also targets the focused element, while a press targets the row under the pointer, so an older browser's long press, a plain mouse event with button 0, doesn't pass. `pointerType` alone can't tell, because Chrome gives a key's event the mouse's. `ContextMenuAnchor` cancels a key's event inside the menu. The hook binds a native `contextmenu` listener on the list, which opens the cursor row's menu for a key's event, a screen reader's included, and stops it before React's handlers on the rows and around the list. A pointer's event passes on, so a right-click below the rows still reaches the background menu. Safari sends a key's event as a right-click on the focused element, which reads as a pointer's. macOS sends no `contextmenu` for either key.

A menu row's 16 px between icon and label lives in the item primitives in `dropdown-menu.tsx` (`gap-4`), which the Sheets right-click menu uses too. Put the bare icon in the row; never add `mr-*` or a `gap-*` override to a menu icon.

## Reordering uses dnd-kit, moving between lists uses native drag

Reordering in place (a stickies column, the slides rail) uses `@dnd-kit`. Dragging between lists, onto a sidebar drop target, or to and from the OS uses native HTML5 drag: `useListDrag` and `useListDropTarget`, plus `useFileDropTarget` and `useFilePasteTarget` for OS files. dnd-kit never sees an OS file drop, and only the native path carries the drag type across lists.

## Hover-revealed affordances rest visible on touch

An action shown on row hover, such as a row's remove button, sits in a `group` row and takes `HOVER_REVEAL_CLASS` from `@workspace/ui/lib/utils`, on the button or its wrapper. With a mouse it shows only while the pointer is over the row, and until then `pointer-events-none` lets a click through to what lies under it, as a hidden element would. It stays in the accessibility tree, and `group-has-focus-visible:` shows it when Tab reaches it or another control in its row. It stays in the tab order too, except in a list with keyboard navigation: there a row's buttons, such as `ContextMenuButton` and a Drive row's `DriveShareSummary`, take `tabIndex={-1}`, because the menu key reaches the same actions and Tab would otherwise stop on every row. Never hide it with `invisible` or `hidden`, which take it away from the keyboard and screen readers. Never reveal it on `focus-within:` or `group-focus-within:` either: a mouse click leaves the focus in the row, and the button would stay shown after the pointer left.

A touch device has no hover, so a hover reveal always adds the matching `pointer-coarse:` variant, set to what the mouse user sees on hover, and the constant carries it. `pointer-fine:group-hover:` is the opt-out for a hover that really is desktop-only, such as the message actions in `ChatMessageList`, which a long press opens as a menu. `scripts/check-standards.ts` gates the touch variant.

```tsx
<div className={cn(HOVER_REVEAL_CLASS, 'ml-auto')}>
    <TooltipButton icon={Edit} tooltipText="Edit" onClick={…} />
</div>
```

Icon buttons with a tooltip are `TooltipButton`. When hover icons would change the row height, position them `absolute` over the row.

## Document keymaps stand down while a dialog is open

Global shortcuts use `@tanstack/react-hotkeys` (`useHotkey`), with `formatForDisplay()` for tooltip labels. Manual listeners stay for stateful navigation (`use-keyboard-list-navigation.ts`) and for editors that own their keys (Tiptap, the canvas keymap in [CANVAS.md](CANVAS.md)). Mod+K is a raw window listener rather than a `useHotkey`, so the palette opens from inside a text field too. A `'*'` chord needs a capture-phase listener, and `'Shift+8'` never matches.

**A document-level keymap folds `useDialogOpen()` into its `enabled`.** The library's own guard covers text fields only, so a key pressed on a dialog button otherwise acts on the document behind it: Delete on a confirm button deleting the canvas selection, `#` in Mail's location picker trashing the message. The hook watches the DOM for an open `role="dialog"` or `role="alertdialog"`, so it keeps no registry. An overlay that is a dialog itself, such as Mail's cheat sheet, registers its keys ungated. The file preview is a Radix dialog itself, so its keys act only on a key pressed inside it ([PREVIEWS.md](PREVIEWS.md#the-overlays-own-keys-act-only-on-a-key-pressed-inside-it)). A bar menu leaves the page live, so its keys reach the document too: the canvas also folds in `useMenuOpen()`, or ArrowRight in File nudges the selected shape and Delete deletes it. The grid needs neither, since it reads only the keys pressed inside the workbook and an open menu holds the focus in its portal.

**Two keymaps may register the same key, and their gates keep them apart.** The canvas's nudges and the file preview's paging both register the arrow keys on the document, and the canvas's are off while a dialog, the preview included, is open. The `@tanstack/hotkeys` core under `@tanstack/react-hotkeys` 0.1.3 counts every second registration of a key as a conflict, a disabled one included, and warns each time one registers, which `useHotkey` does on every `enabled` flip. So `EigenApp`'s `HotkeysProvider` passes `conflictBehavior: 'allow'` to every `useHotkey`. A new keymap that shares a key needs a gate of its own: the library no longer warns about the overlap.

**A suggestion input inside a dialog is a combobox that says when its list is open.** Radix dismisses a dialog from a document capture listener, which runs before any React handler. So `DialogContent` leaves Escape alone when it comes from a `role="combobox"` with `aria-expanded="true"`, and the input's own keydown closes the list. `ChatMessageInput` and `ContactAutosuggest` set both; a new suggestion input sets them too. cmdk's input is skipped: it says expanded always, and its list is the dialog.

## One z-index scale, and app code sets none

| Layer | z-index | Examples |
|---|---|---|
| Document content | auto | everything that flows |
| Docs figure layers | -1 to 2 | a figure behind the text (-1) or in front of it (1), and its grips above both (2), in the page's stacking context |
| In-content floating UI | 10 | inline autocompletes, suggestion lists |
| Sheet canvas overlays | 8 to 30 | selection, freeze handles, scrollbars, all under `cellArea` |
| Portaled UI | 50 | shadcn and Radix dropdowns, popovers, dialogs, tooltips; `FilePreview` |
| Inline full-screen overlay | 100 | slides `PresentMode` |
| Toaster | library | Sonner stacks itself |

- **App components set no z-index.** They use layout instead: a flex sibling (slides) or `absolute` inside a parent that makes a stacking context (docs, `relative overflow-hidden`). Side panels belong here.
- `position: relative` alone makes no stacking context. It takes a z-index other than `auto`, or `transform`, `opacity` below 1, `filter`, `isolation: isolate` or `will-change`. To contain children's z-indices, add `isolation: isolate`.
- Don't raise a menu above shadcn's z-50. If a portaled menu is covered, lower whatever covers it.
- **Portaled layers stack by document order.** Each portals to `<body>` as it opens, so at the same z-50 the later one paints above. The file preview is a Radix dialog too, so a dialog, a select list or a tooltip opened over it lands above it ([PREVIEWS.md](PREVIEWS.md#the-overlay-is-a-radix-dialog-so-radix-decides-which-layer-a-key-or-a-click-is-for)).
- **Anything above 50 carries a comment** saying why. Present mode is at 100 because it renders inside the app shell, not on `<body>`, and must cover the shell's own portals.
- Overlays inside the sheet's `cellArea` stay at 30 or below, so the sheet's portaled menus land above them at 50.

## Buttons navigate here, links in content open a new tab

The rule is who started the navigation, not where it points, so a user can predict it by looking. A rule that depended on the destination's host would be invisible: two links that look the same would behave differently.

**A navigation affordance opens in the same tab.** A notification row and its toast's View, activity and file-history rows, Drive rows, the quick-look overlay's Open and creating a document all mean "take me there". `openDocument()` (`packages/lib/src/core/api.ts`) has no new-tab branch, so the path that opens an Eigen document can't drift; other affordances follow the rule by convention.

A link isn't checked for access before it is shown. The fs listing needs read access to the item's parent folder; when it answers 403 and the URL carries `?pid=`, the drive route redirects to `getDriveShareUrl()` for that item. The destination knows the answer, and a link builder could only guess. Request access still shows for a viewer who can't read the item either ([ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)).

**A link or chip inside content opens a new tab, whatever it points at.** A URL in a chat message, a comment, a sticky card or an email is an aside, and so is the drive-reference chip beside it: following it must not abandon what the user is reading. The sanitizer (`core/html-dom.ts`), chat's linkifier (`rich-content.tsx`), sheet cell hyperlinks, the docs and `LightEditor` Tiptap links and `reference-attachment-chip.tsx` all enforce it unconditionally.

Two cases leave the same-tab side:

- The user asked for a new tab: Drive's Open in new tab row and the `drive.open-in-new-tab` command. Prefer a real `<a href>` for a navigation affordance where the markup allows it (`DriveItemNameLink`, the quick-look overlay's Open, Drive's recent-activity rows through `ActivityRow`'s `href`), because Cmd-click and middle-click then open a new tab and the user keeps the choice. Two things block an anchor: a URL that needs an async resolve (the notification bell), and a button in the row's `trailing` slot, since a `<button>` inside an `<a>` is invalid HTML.
- The destination is outside the app: downloads, the marketing site, exported HTML, and mail. Mail is deliberate twice over. A share email is read in other clients as often as in Eigen Mail, and deciding "open in this tab" from a stranger's URL is exactly where an Eigen-looking phishing host would replace the reader's inbox.

## Radix and the DOM have defaults that break a component silently

Each of these looks like a bug in our own code, so the cause and the fix are written down:

- `TooltipTrigger asChild` overwrites its child's `data-state`, so a Toggle's `data-[state=on]:*` never matches inside a tooltip. Style the pressed state with `aria-pressed:*`, as the find bar's option toggles do (`find-replace-bar.tsx`).
- A non-modal Popover inside a Radix Dialog can't scroll: the dialog's scroll lock eats the wheel while hover still works. Pass `modal`.
- A Popover inside a Radix menu closes on focus-outside. Use `DropdownMenuSub`.
- A Radix menu takes focus back to its trigger on close. To focus something else, `preventDefault` in `onCloseAutoFocus`, then give the target to `returnFocusTo`, which leaves the focus where a menu row put it, such as in a dialog or a field (§ A closing dialog gives the focus back).
- A modal Radix menu turns off pointer events on the page while it is open, so a press on another menu's trigger only closes it. Toolbar menus are non-modal for that reason (§ The app bar's menus are one Radix Menubar).
- Radix `onOpenChange` never fires on unmount, so state it set stays behind.
- A flex item that loses `overflow-hidden` loses its escape from its minimum size too: add `min-h-0`.
- An input focused in `pointerdown` is blurred again by the mousedown that follows. `preventDefault` the pointerdown.

## See also

- [MOBILE.md](MOBILE.md): the breakpoints and how the shell behaves on phones and touch
- [COMMENTS.md](COMMENTS.md): the comments and activity pane
- [PREVIEWS.md](PREVIEWS.md): the quick-look overlay, file subjects and file actions
- [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md): every shared component, hook and type, generated
- [TYPOGRAPHY.md](TYPOGRAPHY.md): type scale and fonts
