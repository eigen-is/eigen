# Layout

> **TLDR:** The shared frame every Eigen app draws its pages in, and the conventions that make the apps feel like one product: menus, lists, focus, keys, layering and where a click opens. Every app is `EigenApp` (the providers) around `AppShell` (topbar, sidebar, content), and every page is a `ColumnLayout` of `Column`s. The shell lives in `packages/ui/src/components/layout/`, Drive's file UI in `packages/ui/src/components/drive/`.

An app composes the shared pieces in `packages/ui`, with their logic in `packages/lib`, instead of laying out its own, so a fix to the shell reaches every app at once and a user finds things in the same place everywhere. Read the sections before you add a page, a list, a menu or a shortcut. Phones and touch screens add their own rules on top ([MOBILE.md](MOBILE.md)).

The things that surprise people: on a phone only one column renders and the sidebar is a column, not an overlay ([§ On a phone](#on-a-phone-only-the-mobilecolumn-renders)); every context and ⋮ menu draws its rows in one order, a destructive row last and red ([§ Menus](#menus-draw-their-rows-in-one-order)); app code sets no z-index ([§ z-index](#one-z-index-scale-and-app-code-sets-none)); buttons navigate in the same tab while links inside content open a new one ([§ Buttons](#buttons-navigate-here-links-in-content-open-a-new-tab)); and every document-level keymap stands down while a dialog is open ([§ Keymaps](#document-keymaps-stand-down-while-a-dialog-is-open)).

## Every app is `EigenApp` around `AppShell`

`EigenApp` (`layout/app/eigen-app.tsx`) holds the providers every app shares: hotkeys, query client, auth, theme, SSE, uploads, the quick-look overlay and the command palette. `AppShell` (`layout/app/app-shell.tsx`) draws the topbar, the sidebar and `<main>`. A new app wraps its `__root.tsx` in `AppShell` and makes `_auth.tsx` a `createAuthRouteOptions` route. That guard hands the signed-in user to every child route's context, so an `_auth` page reads `Route.useRouteContext().user`, never `useAuth().user!`, and a shared view it renders takes the user's id as a prop.

The marketing routes in `apps/index` use `AppShell` without `EigenApp`, so `PaletteRunner` renders nothing when the palette provider is missing, and nothing for a signed-out visitor. The palette itself is [COMMAND-PALETTE.md](COMMAND-PALETTE.md).

## Every page is a `ColumnLayout` of `Column`s with the toolbar as a prop

The toolbar is the `toolbar` prop of a `Column`, never part of the page content. `Column` draws it in a fixed `h-12` bar, so every page has the same toolbar height and the mobile back arrow has one home.

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
    <Column id="list" width="350px" onBack="sidebar" toolbar={<ListToolbar />}>…</Column>
    <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar />}>…</Column>
</ColumnLayout>
```

A list whose items open a detail is `ListDetailLayout`, as on the contacts and admin users and teams pages. The page passes `detail` only while its URL names a selection, so with nothing selected the list fills the page.

## Every horizontal inset is the one gutter

**Every list, toolbar, header and pane takes its horizontal inset from `--app-gutter-x`**, through the `app-gutter-x` or `app-gutter` class (`packages/ui/src/styles/globals.css`). So a row, its header and the toolbar above it share one left edge. The gutter widens from the `sm` breakpoint. The navigation sidebar beside the content narrows it with `app-gutter-sidebar`, because its items are padded pills, and the topbar's left block takes the same class so it shares the sidebar's edge. A dialog pads with its own `p-6` instead.

The wide gutter is 20px because that clears a macOS overlay scrollbar, which takes no layout width and paints its hover track over a scroller's last 16px or so. A scroller inside a padded parent takes `app-gutter-bleed`: it reaches out by one gutter and pads its content back in. Whatever cancels the gutter, such as a hover fill to the pane's edge, uses the variable (`-mx-(--app-gutter-x)`), never a literal, so it follows the breakpoint.

## On a phone only the `mobileColumn` renders

On a phone ([MOBILE.md](MOBILE.md)) a `ColumnLayout` with a `mobileColumn` renders only the `Column` whose `id` matches, at full width. Without a `mobileColumn`, or outside a `ColumnLayout`, every `Column` renders, which is how an editor mounts a full-width pane as a sibling. So `PanelColumn`, the comments and activity pane, must mount outside any `ColumnLayout` that sets one: a wrapped pane silently never shows ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)).

`onBack` gives a column the mobile back arrow. **The first column of a page passes `onBack="sidebar"`,** or a phone user has no way back to navigation. The sentinel opens the sidebar as a column and checks `sidebarMode` itself, so a surface without a sidebar never shows a dead arrow.

## The sidebar is a rail on a tablet and a column on a phone

`AppShell`'s `sidebar` prop is a node or a function of `SidebarProps`, whose `condensed` is true on a tablet's rail. On a phone the sidebar replaces `<main>` as the one visible column, and `<main>` is hidden with CSS rather than unmounted, so an editor keeps its collab state and a list its scroll.

A sidebar row is selected by its path alone (`includeSearch: false` in `SidebarItem`), because opening an item in a list adds it to the URL's search, and a match on the search would unselect a filter such as **All stickies** the moment a board is picked. A fullscreen view with only the topbar, such as `RequestAccessView`, calls `setSidebarHidden(true)` from `useLayout()` and restores it on unmount.

## A dialog never grows to fit what a user typed

`DialogContent` caps its own size and scrolls inside, and its grid track is `minmax(0, 1fr)`, so a long word can't widen the box. Text a user owns still needs `min-w-0 break-words` where it sits in a flex row, or that row overflows the dialog.

## A closing dialog gives the focus back

Radix gives the focus back only to a `DialogTrigger`. A dialog opened from a menu or a key would drop the focus on `<body>` as it closes, and a list's keys would do nothing until a click. `useFocusReturn` (`packages/ui/src/hooks/use-focus-return.ts`) fixes that: `DialogContent` and `FilePreview` call it, and so does any Radix dialog built outside `DialogContent`. It reads what had the focus as the dialog opens, before a field's `autoFocus` moves it.

A menu row that opens a dialog is gone a moment later, so the menu names the target instead. A context menu hands the dialog its list through `returnFocusTo`, which leaves the focus inside the dialog; focusing the list would make the dialog's focus trap pull the focus back and select its field's text. A bar menu such as File hands over its trigger with `handFocusReturnTo`, because Radix's Menubar focuses no trigger once the focus moved into a dialog. A test of that needs a real `Menubar`, since a `DropdownMenu` does focus its trigger.

A target still on the page is never replaced, and an element inside an open dialog never becomes one, so a dialog opened over another can't steal its target. A caller's `onCloseAutoFocus` that calls `preventDefault`, such as the sheet's grid refocus, decides for itself. Something that took the focus as the dialog closed, such as a Rename dialog a palette row opened, keeps it.

The returned focus shows a ring only when its target had one as it left (`:focus-visible`). A dropdown menu a pointer opened focuses its trigger with `focusVisible: false`, because Radix's plain `focus()` after Escape draws a ring in Chrome, and a hover-revealed ⋮ with a ring stays shown after the pointer leaves.

## A dialog opened by a value keeps it while it closes

A dialog that shows a value, such as the items to delete, still draws its text while it fades out, so its owner never clears that value on close. `useDialogValue<T>()` (`packages/ui/src/hooks/use-dialog-value.ts`) holds the open flag and the last value: `openDialog(value)` sets both, `setOpen` is the dialog's `onOpenChange`, and the owner mounts the dialog once `value` is set. An `open` derived from `value !== null` is the bug, because the close then blanks the text or counts "0 items", and unmounting the dialog on close skips its fade-out.

A test reads a closing dialog with `holdClosingDialogs` (`packages/ui/src/test/closing-dialog.ts`). It goes in before the dialog mounts, because Radix reads the content's animation as it mounts.

## One `DriveCapabilities` value gates every Drive action

`DriveLayout` is the file-management UI: `DriveList`, `DriveDetail` and the Drive action runner (`useDriveActionRunner`), which runs each action and owns its dialogs. Each render site declares its whole surface as one `DriveCapabilities` value (presets in `drive-capabilities.ts`). `DRIVE_ACTIONS` (`packages/lib/src/core/drive/drive-actions.ts`) is the one list of Drive actions with each row's label, group and gate. `driveActionsFor` answers which rows apply, and `useDriveActionsFor` drops the guest-denied and mail-only rows, so the row menu, the detail column, the Delete key and the command palette offer the same set. Watch is no row: it shows live state, so the menu and the palette draw it from `useWatchToggle`.

- The fs browser follows the viewer's own access, `browseCapabilities(canWrite)`, with `canWrite` the same `SharedDrive.canWrite` the mutations enforce. A read-only folder still previews, downloads, copies out and shares a link, but never renames, duplicates, trashes or converts.
- An open document's File menu gates its Drive rows the same way with the editor's `canWrite`: the document stands where the browser's folder stands.
- Duplicate follows `canWrite`, not `canMove`, because the copy lands beside its source. A root item and an item shared with the viewer are never duplicated, since the server refuses a copy into the owner's folder.
- Flat views (mime filters, per-app lists, shared by and with me) spread `.listing`, which has no move, because a flat view has no folder context.
- Shared with me turns `canWrite` and `canRename` off, because its feed carries no per-row permission. Delete stays on and means leaving the share.

`canWrite` also rides into every file subject the view builds, because a convert writes beside its source and a read-only view has nowhere to write ([PREVIEWS.md](PREVIEWS.md#a-file-subject-stores-identity-everything-else-is-derived)).

The detail column's Location row reads the parent's `useBreadcrumb`, the query the folder view reads, and names the drive as the sidebar does, or the owner or team where the server cut the chain short, then the folders down to the parent, as a link only when the viewer can read that parent.

## One item menu serves the row and the detail column

`DriveItemMenuItems` (`drive-item-menu.tsx`) is the menu both the row's context menu and the detail column's ⋮ draw, for one item or a multi-selection, which gets only the rows with a `pluralLabel`. Each row is a `DriveActionMenuItem`, which the File menu and Trash's menu draw too. A row's `shortcut` is the hotkey constant the listing's key handler compares against, so the menu shows the key that acts; only the row's context menu names keys, because they act on the listing. The shared file actions come in through `FileActionMenuItems`, minus Save to Drive, which Drive's own Copy to… already says. Space, the detail preview and the menu row all go through the file-action registry, so none of them previews a folder ([PREVIEWS.md](PREVIEWS.md#the-host-mounts-the-runners-dialogs)).

`DriveBrowser` is a lighter layer over the same table, with no dialogs and no detail column, for the file picker and the location field. It keeps no location of its own: its host holds one `DriveLocationValue` (owner, mount, folder), the browser draws that and asks for another through `onChange`, so a folder click, a mount click and a host that moves all go one way. A mount click asks for the mount with an empty folder id, which means its root. `useResolvedDriveLocation` is the one place that fills the root in, from the loaded root during render, and it stays empty while the root loads. The browser and the location field call it to draw, and a host that confirms a destination, such as `DriveLocationPicker` or the new chat dialog, calls it for what it hands on and keeps its confirm button disabled until the folder is there. Such a host is mounted while its dialog is closed, often for a drive the viewer cannot read, so it passes `enabled` false then and a closed picker reads no root.

## Menus draw their rows in one order

Every right-click and ⋮ menu composes `MenuSections` (`packages/ui/src/components/context-menu/menu-sections.tsx`). A host hands each row to a named group, and the component draws the groups in a fixed order with a separator between two that are there. So a user finds Copy, Download or Delete in the same place in every app, and a new menu cannot drift.

| Group | Rows |
|---|---|
| `open` | Open, Open in new tab, Quick preview, View comment, Reply, Forward |
| `clipboard` | Cut, Copy, Paste, from `ClipboardMenuItems` |
| `create` | New slide, Insert, Duplicate, Edit, Rename |
| `organize` | Move to, Copy to, Archive, labels, color, assign, resolve, hide, sort, filter, Clear contents |
| `arrange` | An object's `OrderMenuSub`, a sheet tab's Move left and right |
| `convert` | Convert to shapes, Convert to Sheet, Document or Slides |
| `output` | Download, Export, Print, Save to Drive, Import to… |
| `collaborate` | Add comment, Share ▸, Watch |
| `destructive` | Delete, Move to trash, Remove…, Delete row or column |

Shared rows know their group: a `FileAction` names one, and `FileActionMenuItems` draws each in its place, or one group when the host passes `group`. On a menu about something else, such as a cell, the comment rows split with `part="rows"` and `part="delete"`, so the comment's Delete sits with the cell's.

`DropdownMenuSeparator` hides itself when nothing visible stands on one side of it, so a row that renders nothing takes its separator along and no host writes separator logic. happy-dom draws no CSS, so tests read a menu as a user sees it through `menuRows` (`packages/ui/src/test/menu-rows.ts`).

Bar menus (File, Edit, Format) keep Google's order, which users know from Docs, except that their delete rows go last and red.

## The app bar's menus are one Radix Menubar

**The menus at the left of a document app's bar are one shadcn `Menubar`, each menu an `AppBarMenu`.** They are non-modal, as Google's are: a press outside closes the menu and also reaches what is under it, so it focuses an input or selects a cell. Where that press would change something, it only closes the menu: the canvas and a formula being composed ask `pressClosesMenu` (`menubar.tsx`) on their pointerdown, which runs before Radix closes the menu. The icon row's dropdowns and the share kebab are `modal={false}` for the same reason.

The rows are the same `DropdownMenu*` rows every menu uses. Radix gives each kind of menu its own contexts, so `MenubarContent` wraps its rows in `MenuRows`, which hands them the Menubar's parts. One row such as `ChoiceMenuSub` then serves a bar menu and a context menu alike.

Three things keep the bar from closing under the user:

- A bar menu has no exit animation. A menu that fades while the focus moves into the next one closes the whole bar.
- Once one menu is open, Radix opens the next as the pointer reaches its trigger, before the press aimed at it. `AppBarMenu` keeps a menu open through that press.
- An editor that takes the focus back as a menu closes takes it only from the body or a menu trigger (`focusLeftToEditor`), so the next menu, a dialog a pick opened or an input the user pressed keeps it.

A bar trigger is a `role="menuitem"` inside `role="menubar"`, so a test looks for a menu's rows inside `[role="menu"]`.

The bar of every document app is a `CenteredToolbar`: menus left, the icon row at the true center, the share cluster right. The icon row folds into the menus as the bar narrows, so every icon it folds away is a menu row. Sheets reads the bar's own width through a container query, because a panel beside the workbook narrows the bar; the other editors read the viewport.

## The bar's menus come in Google's order

**An editor's bar menus read File, Edit, View, Insert, Format, the app's own menus, Tools and Help, as Google's do, and each app shows the ones it has.** Docs has File, Edit, Insert, Format and Tools; Sheets File, Edit, View, Insert, Format and Data; Slides and Vector File, Edit and Insert; Stickies File, Edit, Insert and Filter. A user who knows Google Docs or Sheets looks for a menu in that place, so an app that adds a menu puts it in its Google place.

Every editor's Edit is `EditMenu` (`packages/ui/src/components/layout/toolbar/edit-menu.tsx`): Undo and Redo, the host's rows, then Find. A host that cuts and copies hands it `ClipboardMenuItems`, the rows its right-click menus draw, so Cut, Copy, Paste, Select all, Duplicate and Delete have one label, icon and order in Docs, Sheets, Slides and Vector. Stickies has no clipboard rows.

## A row greys while it waits, and hides when it can never act

A row that depends on the selection or the document's state is disabled, such as Copy with nothing selected or the canvas's Insert › Comment unless one object is selected. A row the app or the user's role can never use is not drawn: a viewer's Edit in Docs and Sheets has no Cut, Paste or Delete, and on a canvas only Find. Google greys both. Eigen hides the second, so a viewer's menu is not a wall of dead rows, and a grey row means something the user can change. `ClipboardMenuItems` draws a row only when its host passes the handler, so a host gates a row by leaving it out. File › Make a copy greys for a reader as well, where Drive's Duplicate does not apply.

## A shown shortcut is the binding's own constant

A menu row shows `formatForDisplay` of the constant its key handler binds, such as `PRINT_HOTKEY`, `ADD_COMMENT_HOTKEY` or `SHEET_HOTKEYS`, so the menu cannot name a key that does something else. The shared clipboard rows show the lib constants (`CUT_HOTKEY`, `SELECT_ALL_HOTKEY`, …) that the sheet's table and the canvas's keys bind too; Cut, Copy and Paste themselves are the browser's clipboard events, which every editor handles. ⌘K is the command palette in every app ([COMMAND-PALETTE.md](COMMAND-PALETTE.md)), so Insert › Link shows no shortcut, where Google's shows ⌘K.

## A row that deletes is red and last

**A row that deletes, trashes or removes is `variant="destructive"`**, red with its icon, alone in the last group. Google draws none of these red and puts Delete mid-menu; Eigen follows iOS and Material, so the one row that loses work is the one a user finds last and sees coloured. Move to trash is red too, even though Trash restores it. Log out is last but plain, since it loses nothing. A share dialog's role Remove is a `SelectItem` with the same variant.

A properties panel has no Delete button. An object's Delete is its menu's last row, the Delete key and Edit › Delete, so a misclick in the panel loses nothing.

`scripts/check-standards.ts` gates it: a `DropdownMenuItem` or `SelectItem` that draws `Trash2` or says Delete, Remove or to trash fails without the variant, and so does one tinted by `text-destructive`, which leaves the icon grey.

## An icon-only button is flat, a button with text has an edge

**An icon-only button is `TooltipButton` as it comes: `ghost`, in the text color, a soft background on hover and its tooltip as its name.** It is 32px in toolbars, dialog footers and panel rows, and 28px in dense rows and properties panels. A row of bordered boxes competes with the one action that has a label, and the icon already says what it does.

A button with text keeps an edge, `outline`, or is filled when it is the main action, so Cancel, Save and Share with team still read as buttons beside flat icons.

An icon that deletes is flat too, and not red. The red is on the Delete of the confirmation it opens (`DeleteDialog`), and on a delete button that has words, which is `variant="destructive"`. A real primary action stays filled, such as chat's Send, and the list and grid switch keeps its edge because it is one control with two options.

`TooltipButton` and `KebabTrigger` take no `outline`, so a bordered icon fails typecheck. A plain `Button` with an icon size can still take one, which review catches.

## Pink is Eigen's accent color

Pink `#f6339a` (`packages/lib/src/constants/colors.ts`) comes first in `EIGEN_ACCENT_COLORS_SHUFFLED`, the order calendars, labels, chart series and presence hand the accents out in, so what Eigen picks for a user starts in its own color. Rose and fuchsia sit close to it, so they come late ([CHARTS.md](CHARTS.md) has the reasoning).

A fixed color mapped onto the palette (`eigenColor(name, step)`) takes the nearest palette color by OKLab distance, and in doubt the lighter, less saturated step, because the originals are muted.

## A choice is a submenu with a check

**A row that shows a current option or an on state draws a check on its left, and nothing else does.** Google's menus work this way, so a user reads every Eigen menu alike, and a screen reader hears each row as checked or not.

- A choice goes through `ChoiceMenuItems` in `dropdown-menu.tsx`: one row per option, the current one checked, each a `menuitemradio`. In a menu of actions it is `ChoiceMenuSub`, a submenu named for the property (Theme ▸, Assign to ▸). A menu whose trigger already names the choice lists the options directly.
- An on/off setting is one `DropdownMenuCheckboxItem`. A label only some of the selection has is `checked="indeterminate"`.
- An action that flips its item's state keeps Google's label swap instead: Watch or Stop watching, Create or Remove filter.

`DropdownMenuRadioGroup` is not exported, so a choice cannot draw Radix's dot. `scripts/check-standards.ts` fails a `DropdownMenuItem` that draws a `Check` when a condition holds. The color picker's swatches and the searchable `MemberCommandList`, a combobox, keep their own marks.

## The document apps reach Drive through one config

Only `apps/drive` mounts `DriveLayout` directly. Docs, Stickies, Slides and Sheets go through `EigenDocListView` and `EigenDocSharedView`, configured by `buildConfig` in `eigendoc-config.ts` from the EigenDocType registry, so an app gets its sidebar, list and shared views without Drive code of its own. Each list route is its `createFileRoute` line, `validateDriveSearch` and `<EigenDocListView config={…} route={Route} />`: the view reads the params, the selection and the viewer from the route it is handed, typed by shape (`EigenDocListRoute`) since every app has its own route tree, and that type fails to compile for a route whose search skips `validateDriveSearch`.

## Every Drive list has one empty text and one error text

`DriveList` draws both, so no page passes copy of its own. An empty list shows `EmptyState`'s default sentence in place of the table or grid, so it centers in the whole list area, with a hint only where you can drop or create (the button's own label when the list creates one kind). Drawn below the table, the two `flex-1` children split the column and the sentence sat in its lower half. A failed load shows `ErrorState`'s default sentence alone, with no error detail; the error boundary shows the same one. A page that needs other words is a different screen, such as `RequestAccessView` for a folder you can't read.

## A file's icon comes from its name as well as its MIME type

`getFilePresentation` (`packages/lib/src/core/file-presentation.ts`) takes the file name, because a `.vcf`, `.eml` or `.ics` is often stored as `application/octet-stream` and still carries its app's icon and color. It is DOM-free so lib callers such as the palette can use it. `APP_FORMATS` there is the one list the icon, the tile tint and the format badge read.

## Lists compose hooks, not a shared list component

Each list owns its rendering and composes the hooks in `packages/ui/src/hooks/`: `useListSelection`, `useKeyboardListNavigation`, `useListDrag`, `useListDropTarget` and `useContextMenu`. `email-list.tsx`, `PersonList` and `use-drive-item-controller.ts` are the working examples.

A row's state is a class in `globals.css`, painted in the current app's color:

| Class | State | Paint |
|---|---|---|
| `eigen-list-item-active` | the open row | stripe and wash |
| `eigen-list-item-cursor` | the keyboard cursor on another row | stripe only, so it reads apart from the open row |
| `eigen-list-item-selected` | multi-selected | wash |
| `eigen-tile` (`-active`, `-selected`) | grid tiles | a full border, because a stripe on a tile's label strip reads as stray chrome |

A row takes every class that holds. A right-click or ⋮ selects its row without opening it, so the open row keeps its look.

One context menu serves the whole list, so a list never draws a `DropdownMenu` per row. A row's button opens it from the button's own rect, because a click made with Enter reports 0,0. `ContextMenuAnchor` portals its trigger to `document.body`, because a transformed ancestor, such as a dialog's centering translate, would otherwise move the menu.

The menu key (Shift+F10 or ContextMenu) opens the same menu from the row's rect, through the list's `onMenu`; a virtualized list finds the row by its `data-index` and opens a frame after scrolling it in. On Windows and Linux the browser follows the key with a native `contextmenu` event that a keydown `preventDefault` can't stop, which would open the browser's menu over ours. `isKeyboardContextMenu` (`use-context-menu.ts`) tells a key's event from a pointer's, and the list's native listener opens the cursor row's menu for it before React's handlers run.

A menu row's icon gap lives in the item primitives (`gap-4`); never add `mr-*` or a `gap-*` override to a menu icon.

## Reordering uses dnd-kit, moving between lists uses native drag

Reordering in place (a stickies column, the slides rail) uses `@dnd-kit`. Dragging between lists, onto a sidebar target, or to and from the OS uses native HTML5 drag (`useListDrag`, `useListDropTarget`, `useFileDropTarget`), because dnd-kit never sees an OS file drop and only the native path carries the drag type across lists.

## Hover-revealed affordances rest visible on touch

An action shown on row hover sits in a `group` row and takes `HOVER_REVEAL_CLASS` from `@workspace/ui/lib/utils`. With a mouse it shows only while the pointer is over the row, with `pointer-events-none` until then so a click passes through. It stays in the accessibility tree, and `group-has-focus-visible:` shows it when Tab reaches its row. Never hide it with `invisible` or `hidden`, which take it from the keyboard and screen readers, and never reveal it on `focus-within:`, which keeps it shown after a mouse click. In a list with keyboard navigation a row's buttons take `tabIndex={-1}`, because the menu key reaches the same actions.

A touch device has no hover, so a hover reveal adds the matching `pointer-coarse:` variant, which the constant carries. `pointer-fine:group-hover:` opts out for a hover that is desktop-only, such as chat's message actions, which a long press opens as a menu. `scripts/check-standards.ts` gates the touch variant.

```tsx
<div className={cn(HOVER_REVEAL_CLASS, 'ml-auto')}>
    <TooltipButton icon={Edit} tooltipText="Edit" onClick={…} />
</div>
```

## Document keymaps stand down while a dialog is open

Global shortcuts use `@tanstack/react-hotkeys` (`useHotkey`), with `formatForDisplay()` for labels. Manual listeners stay for list navigation and for editors that own their keys. Mod+K is a raw window listener, so the palette opens from inside a text field too. A `'*'` chord needs a capture-phase listener, and `'Shift+8'` never matches.

**A document-level keymap folds `useDialogOpen()` into its `enabled`.** The library's own guard covers text fields only, so a key on a dialog button would act on the document behind it: Delete on a confirm button deleting the canvas selection. The hook watches the DOM for an open `role="dialog"` or `alertdialog`, so it keeps no registry. A bar menu leaves the page live, so the canvas also folds in `useMenuOpen()`, or ArrowRight in File would nudge the selected shape.

Two keymaps may register one key, such as the canvas's nudges and the file preview's paging, and their gates keep them apart. The hotkeys library warns on every second registration of a key, a disabled one included, so `EigenApp` passes `conflictBehavior: 'allow'`. A new keymap that shares a key needs a gate of its own: nothing warns about the overlap.

A suggestion input inside a dialog is a `role="combobox"` with `aria-expanded`, because Radix dismisses a dialog on Escape from a capture listener that runs before React. `DialogContent` leaves Escape alone while such a combobox says its list is open.

## One z-index scale, and app code sets none

| Layer | z-index | Examples |
|---|---|---|
| Document content | auto | everything that flows |
| Docs figure layers | -1 to 2 | a figure behind or in front of the text, and its grips, in the page's stacking context |
| In-content floating UI | 10 | inline autocompletes, suggestion lists |
| Sheet canvas overlays | 8 to 30 | selection, freeze handles, scrollbars, under `cellArea` |
| Portaled UI | 50 | shadcn and Radix menus, popovers, dialogs, tooltips; `FilePreview` |
| Inline full-screen overlay | 100 | slides `PresentMode` |
| Toaster | library | Sonner stacks itself |

- **App components set no z-index.** They use layout instead: a flex sibling, or `absolute` inside a parent that makes a stacking context. `position: relative` alone makes none; add `isolation: isolate` to contain children's z-indices.
- Don't raise a menu above z-50. If a portaled menu is covered, lower whatever covers it.
- **Portaled layers stack by document order**: each portals to `<body>` as it opens, so at the same z-50 the later one paints above ([PREVIEWS.md](PREVIEWS.md#the-overlay-is-a-radix-dialog-so-radix-decides-which-layer-a-key-or-a-click-is-for)).
- **Anything above 50 carries a comment** saying why. Present mode is at 100 because it renders inside the shell and must cover the shell's own portals.

## Buttons navigate here, links in content open a new tab

The rule is who started the navigation, not where it points, so a user can predict it by looking. A rule keyed on the destination would make two links that look the same behave differently.

**A navigation affordance opens in the same tab**: a notification row, a Drive row, the quick-look's Open, creating a document. `openDocument()` (`packages/lib/src/core/api.ts`) has no new-tab branch. Prefer a real `<a href>` where the markup allows, so Cmd-click and middle-click still open a new tab. A link isn't checked for access before it is shown: the destination knows the answer, and the drive route redirects a 403 with `?pid=` to the item's share URL ([ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)).

**A link or chip inside content opens a new tab, whatever it points at.** A URL in a chat message, a comment, a card or an email is an aside, and following it must not abandon what the user is reading. The sanitizer (`core/html-dom.ts`), chat's linkifier, sheet hyperlinks, the Tiptap links and the drive-reference chip all enforce it.

Two cases leave the same-tab side: the user asked for a new tab (Open in new tab), or the destination is outside the app (downloads, the marketing site, exported HTML, mail). Mail is deliberate: a share email is read in other clients as often as in Eigen, and opening a stranger's URL in place is where a phishing host would replace the reader's inbox.

## Radix and the DOM have defaults that break a component silently

Each looks like a bug in our own code:

- `TooltipTrigger asChild` overwrites its child's `data-state`, so style a Toggle's pressed state with `aria-pressed:*`.
- A non-modal Popover inside a Radix Dialog can't scroll, because the dialog's scroll lock eats the wheel. Pass `modal`.
- A Popover inside a Radix menu closes on focus-outside. Use `DropdownMenuSub`.
- A modal Radix menu turns off pointer events on the page, so a press on another menu's trigger only closes it. Toolbar menus are non-modal for that reason.
- Radix `onOpenChange` never fires on unmount, so state it set stays behind.
- A flex item that loses `overflow-hidden` loses its escape from its minimum size too: add `min-h-0`.
- An input focused in `pointerdown` is blurred again by the mousedown that follows. `preventDefault` the pointerdown.

## See also

- [MOBILE.md](MOBILE.md): the breakpoints and how the shell behaves on phones and touch
- [COMMAND-PALETTE.md](COMMAND-PALETTE.md): the ⌘K palette the shell mounts
- [COMMENTS.md](COMMENTS.md): the comments and activity pane
- [PREVIEWS.md](PREVIEWS.md): the quick-look overlay, file subjects and file actions
- [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md): every shared component, hook and type, generated
- [TYPOGRAPHY.md](TYPOGRAPHY.md): type scale and fonts
