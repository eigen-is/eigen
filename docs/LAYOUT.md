# Layout

> **TLDR:** The shared frame every Eigen app draws its pages in, and the conventions that make the apps feel like one product: menus, lists, focus, keys, layering and where a click opens. Every app is `EigenApp` (the providers) around `AppShell` (topbar, sidebar, content), and every page is a `ColumnLayout` of `Column`s. The shell lives in `packages/ui/src/components/layout/`, Drive's file UI in `packages/ui/src/components/drive/`.

An app composes the shared pieces in `packages/ui`, with their logic in `packages/lib`, instead of laying out its own, so a fix to the shell reaches every app at once and a user finds things in the same place everywhere. Read the sections before you add a page, a list, a menu or a shortcut. Phones and touch screens add their own rules on top ([MOBILE.md](MOBILE.md)).

The things that surprise people: on a phone only one column renders and the sidebar is a column, not an overlay ([§ On a phone](#on-a-phone-only-the-mobilecolumn-renders)); every context and ⋮ menu draws its rows in one order, a destructive row last and red ([§ Menus](#menus-draw-their-rows-in-one-order)); app code sets no z-index ([§ z-index](#one-z-index-scale-and-app-code-sets-none)); buttons navigate in the same tab while links inside content open a new one ([§ Buttons](#buttons-navigate-here-links-in-content-open-a-new-tab)); and every document-level keymap stands down while a dialog is open ([§ Keymaps](#document-keymaps-stand-down-while-a-dialog-is-open)).

## Every app is `EigenApp` around `AppShell`

`EigenApp` (`layout/app/eigen-app.tsx`) holds the providers every app shares: hotkeys, query client, auth, theme, SSE, uploads, the quick-look overlay and the command palette. `AppShell` (`layout/app/app-shell.tsx`) draws the topbar, the sidebar and `<main>`. A new app wraps its `__root.tsx` in `AppShell` and makes `_auth.tsx` a `createAuthRouteOptions` route. That guard hands the signed-in user to every child route's context, so an `_auth` page reads `Route.useRouteContext().user`, never `useAuth().user!`, and a shared view it renders takes the user's id as a prop.

The marketing routes in `apps/index` use `AppShell` without `EigenApp`, so `PaletteRunner` renders nothing when the palette provider is missing, and nothing for a signed-out visitor. The palette itself is [COMMAND-PALETTE.md](COMMAND-PALETTE.md).

## Every page is a `ColumnLayout` of `Column`s with the toolbar as a prop

The toolbar is the `toolbar` prop of a `Column`, never part of the page content. `Column` draws it in a fixed `h-12` bar, so every page has the same toolbar height and the phone's back has one home.

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
    <Column id="list" width="large" onBack="sidebar" toolbar={<ListToolbar />}>…</Column>
    <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar />}>…</Column>
</ColumnLayout>
```

A list whose items open a detail is `ListDetailLayout`, as on the contacts and admin users and teams pages. The page passes `detail` only while its URL names a selection, so with nothing selected the list fills the page.

## A side column is small, medium or large

**A `Column`'s `width` is a name, never a pixel value: `flex` for the main, or `small` (256), `medium` (320) or `large` (400).** `small` is for navigation and tools, such as the sidebar, the properties panels and the Docs outline, and for the comments and activity list, which takes turns with properties in the right slot and so keeps its width; `medium` for a detail beside a work surface, such as the calendar's event; `large` for a list or a detail beside one, such as Mail's list or Drive's detail. On a tablet `large` steps down to 320, so there every column that isn't `small` is 320 and a 1024 tablet keeps a 640 main beside the sidebar's rail. The numbers and that step live once, in `column-widths.ts` beside `Column`, which reads `isTablet` itself, so no page writes its own tablet branch. A host that lays out around a column or draws one as a plain element, such as `PropertiesPanel` or `SidebarContainer`, reads the number from `columnWidthPx`, and in React from `useColumnWidthPx`, which knows the tablet step, as the Docs overlay's maths and the find bar's inset beside a column do. The sidebar's 64px tablet rail is a mode of the sidebar, not a width a column picks.

Slides' slide rail is the one side column with its own width: 208 (`w-52`), and 256 from 1920 wide, where it matches the properties panel across from it. Its thumbnails read no better wider, so the slide keeps the room.

## A detail column opens at the right, under the bar that spans the screen

**A detail column shows one thing the user opened, such as a calendar event or a document's comments, at the right of the page, under the bar that spans the screen.** `DetailColumn` (`layout/app/detail-column.tsx`) draws it. Its bar names a list, never an item: a title over a list, "‹" with the list's name once it drilled into one item, the item's actions, then X. It is `medium` beside a work surface, such as the calendar grid, and `large` beside a list. The comments list is `small`, the properties panel's width, and a comment thread is the one detail that grows to `large` beside a surface ([COMMENTS.md](COMMENTS.md#in-docs-slides-and-vector-comments-open-in-a-column-the-url-names)).

The URL names what is open, so a link and a reload show it. `useDetailHistory` (`packages/ui/src/hooks/use-detail-history.ts`) gives every detail one history rule: an open from closed pushes an entry flagged as its own, a switch to another item replaces, and close goes back over that entry and replaces anywhere else, such as on a link. So X and back do the same, and back after X never reopens the item. X, Esc and back close it. The column hears Esc on `window`, after every `document` listener, so a handler that uses an Esc, such as a canvas deselecting, calls `preventDefault` and the column closes on the next one.

In an editor the bar that spans the screen is the editor bar. The detail takes the right slot under it and a right tool, such as the properties panel, yields while it is open; a left tool, such as Slides' rail, stays, with one top edge across. Under the bar no bar refolds as a detail opens, and the editor never remounts as the column opens, grows or closes, since it holds the document's collab session and undo. On a phone `PhoneDetail` gives the detail the whole screen and hides the main with a class, never a wrapper swap, so an editor or a grid stays mounted, and the bar's lone "‹" at the left closes it in place of X. Docs keeps its own `hidden` wrapper instead, which its outline pane shares. Docs is the one editor whose right slot is an overlay rather than a sibling: the column lies over the page's right margin, never its text, and the page moves only as far as it must ([DOCS.md](DOCS.md#the-page-keeps-its-width-and-slides-then-scales-clear-of-a-panel)).

## A properties panel's sections come in one order

Every properties panel, in Vector, Slides, Docs and Sheets, writes its sections in one order: geometry (Transform, Layout), content (Text, Spacing, Image), paint (Fill, Color, Background, Stroke, Border, Shape, Arrowheads, Sketch), appearance, actions (Arrange, Align), then Delete. It is a convention, not a sort: a panel's titles are literals and its guards only filter, so the written order is the drawn order, and the tab order follows what the eye sees. A new section slots into its group, and a group a panel lacks is absent.

## Every horizontal inset is the one gutter

**Every list, toolbar, header and pane takes its horizontal inset from `--app-gutter-x`**, through the `app-gutter-x` or `app-gutter` class (`packages/ui/src/styles/globals.css`). So a row, its header and the toolbar above it share one left edge. The gutter widens from the `sm` breakpoint. The navigation sidebar beside the content narrows it with `app-gutter-sidebar`, because its items are padded pills, and the topbar's left block takes the same class so it shares the sidebar's edge. A dialog pads with its own `p-6` instead.

The wide gutter is 20px because that clears a macOS overlay scrollbar, which takes no layout width and paints its hover track over a scroller's last 16px or so. A scroller inside a padded parent takes `app-gutter-bleed`: it reaches out by one gutter and pads its content back in. Whatever cancels the gutter, such as a hover fill to the pane's edge, uses the variable (`-mx-(--app-gutter-x)`), never a literal, so it follows the breakpoint.

## On a phone only the `mobileColumn` renders

On a phone ([MOBILE.md](MOBILE.md)) a `ColumnLayout` with a `mobileColumn` renders only the `Column` whose `id` matches, at full width. Without a `mobileColumn`, or outside a `ColumnLayout`, every `Column` renders, which is how an editor mounts a full-width pane as a sibling. So `PanelColumn`, the comments and activity pane, must mount outside any `ColumnLayout` that sets one: a wrapped pane silently never shows ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)).

`onBack` gives a column the phone's back, a lone "‹" from `BackButton`. **The first column of a page passes `onBack="sidebar"`,** or a phone user has no way back to navigation. The sentinel opens the sidebar as a column and checks `sidebarMode` itself, so a surface without a sidebar never shows a dead back.

**`BackButton` is the one back in a bar: a lone "‹" with the tooltip Back, or "‹" beside the name of where it goes, such as Drive's text editor's "‹ Files".** One glyph for every back, on a phone and a desktop, so the same move never looks two ways.

## The sidebar is a rail on a tablet and a column on a phone

`AppShell`'s `sidebar` prop is a node or a function of `SidebarProps`, whose `condensed` is true on a tablet's rail. On a phone the sidebar replaces `<main>` as the one visible column, and `<main>` is hidden with CSS rather than unmounted, so an editor keeps its collab state and a list its scroll.

The **Recent files** row belongs in the sidebars of Drive and the file apps (Docs, Sheets, Slides, Stickies, Vector) only, because it lists files; Mail, Chat, Calendar and Contacts have none.

A sidebar row is selected by its path alone (`includeSearch: false` in `SidebarItem`), because opening an item in a list adds it to the URL's search, and a match on the search would unselect a filter such as **All stickies** the moment a board is picked. A fullscreen view with only the topbar, such as `RequestAccessView`, calls `setSidebarHidden(true)` from `useLayout()` and restores it on unmount.

## A dialog is wide unless it is small and has nothing to type in

**`DialogContent` takes `size="lg"` (672px, the default) or `size="sm"` (448px), and nothing in between.** Every dialog with a box you type in is `lg`: a text, number or email input, a chip or search box, or a rich-text field, such as Rename, Add label or Data validation. So is every dialog with a lot to read or pick from, whatever it holds: a list (Manage rules, Keyboard shortcuts), a picker (file, location, import, the palette, New chat) or a card with its thread. Only a small dialog with nothing to type in is `sm`: a confirm, Custom sort, Slides' Page setup or the calendar's "This event / following / all" choice. The Sheets range picker is `sm` because it floats over the grid it picks from, and About and the upload progress box are `sm` status boxes. `ConfirmDialog` passes `sm` itself, and `FormDialog` is `lg` unless its caller passes `size="sm"`. A middle width makes every new dialog a judgment call, so a form that feels cramped gets a two-column layout inside, not a third size.

**A wide dialog's footer has a line above it and stays in view.** `DialogFooter` in an `lg` dialog runs edge to edge under a top border and sticks to the bottom of the box while the body scrolls; the header has no line under it. A narrow dialog has no lines. The content box says its width as `data-size`, and the footer reads it through the `group/dialog` variant, so no caller passes a class for it. A wide box that holds a footer drops its bottom padding, and the footer's own padding takes its place. The footer has no negative bottom margin: a sticky box is kept inside its parent, so one that hangs 24px below a form's bottom is pushed 24px back up, over the last field. Content that should run edge to edge too, such as a picker's browser, takes `-mx-6` against the box's padding. On a phone the file picker's browser keeps the padding, as the location field's does, so the drive select above its folders doesn't touch the sides.

**There is one footer.** Its right side holds Cancel and the main button, as `DialogFooter`'s children. Its left side holds a tool about the item, such as attach, Upload from device, Back or delete, as its `start`, which `FormDialogForm` fills from `footerStart`. The footer is that one row at every width, its buttons at their normal size, phones included. A footer tool with a text label, such as the Share dialog's Share with team, shows only its icon below the `sm` breakpoint (`max-sm:sr-only` on the label), so the row fits a phone and the label still names the button for a screen reader. A row that is still too wide wraps: the tools stay at the left and the right buttons move to the next line together, at the right, because the footer keeps them in one group. The title sits on the left at every width. How a form in a dialog behaves, its keys, its close with changes and its errors, is [FORMS.md](FORMS.md).

## A dialog never grows to fit what a user typed

`DialogContent` caps its own size and scrolls inside, and its grid track is `minmax(0, 1fr)`, so a long word can't widen the box. Text a user owns still needs `min-w-0 break-words` where it sits in a flex row, or that row overflows the dialog.

## Every yes or no is one `ConfirmDialog`

A question with only a yes and a no, such as Delete calendar, Move to trash or Discard changes, is `ConfirmDialog`, with no wrapper per kind. Its caller writes the whole description as sentences, the item's name in bold where it reads naturally (`<>Delete <strong>{name}</strong>? All events in it will be lost.</>`), and names its own button. The dialog adds nothing to the text, so a sentence never ends in a stray name or a doubled question mark. `destructive` makes the yes red where it loses work or access: delete, trash, empty trash, remove, delete history, leave a share, and a restore that replaces an account's live data. A restore of a document version saves the current state as a version first, so it stays plain.

## A closing dialog gives the focus back

Radix gives the focus back only to a `DialogTrigger`. A dialog opened from a menu or a key would drop the focus on `<body>` as it closes, and a list's keys would do nothing until a click. `useFocusReturn` (`packages/ui/src/hooks/use-focus-return.ts`) fixes that: `DialogContent` and `FilePreview` call it, and so does any Radix dialog built outside `DialogContent`. It reads what had the focus as the dialog opens, before a field's `autoFocus` moves it.

A menu row that opens a dialog is gone a moment later, so the menu names the target instead and leaves the focus in the dialog. Nothing may take the focus out of an open dialog: its focus trap takes it straight back and selects its field's text, which undoes a selection the dialog set as it opened, such as Rename's name without its extension. A context menu hands the dialog its list through `returnFocusTo`. A dropdown menu such as the detail column's ⋮ and a bar menu such as File hand over their trigger with `handFocusReturnTo`, which tells the dropdown whether a dialog holds the focus; Radix's Menubar focuses no trigger once the focus moved into a dialog. A row of a closed menu, still on the page while it animates out under the dialog, doesn't let Radix focus the menu as the pointer leaves the row. A test of the bar menu needs a real `Menubar`, whose close differs from a `DropdownMenu`'s.

A dropdown menu that closes with no dialog over it focuses its trigger itself, whatever holds the focus by then. `returnFocusTo` is the wrong call there: it leaves the focus with whatever took it meanwhile, and Drive's list takes it the moment a closing menu leaves the page (`useKeyboardListNavigation`), so New, the avatar and the detail ⋮ would never get it back. A context menu and a closing dialog do go through `returnFocusTo`, so in Drive they end on the list.

A target still on the page is never replaced, and an element inside an open dialog never becomes one, so a dialog opened over another can't steal its target. A caller's `onCloseAutoFocus` that calls `preventDefault`, such as the sheet's grid refocus, decides for itself. Something that took the focus as the dialog closed, such as a Rename dialog a palette row opened, keeps it.

A target a save drew anew, such as an event chip that moved to another day, is found again by its `data-focus-key`: the calendar's event buttons carry their occurrence (`occurrenceKey`), so Edit event gives the focus to the chip on its new day. With no element of that key left, such as an event moved out of the shown week, the focus stays on `<body>`, where the calendar's keys still work.

"Discard changes?" gives the focus back itself on Keep editing (`useDiscardChanges`). The press that asked focused the X, or nothing for a click outside, so Radix's return would land there; the form dialog's content reports every focus in its form through the hook's `onFocus`, and Keep editing goes back to the last of those fields, or to the first field once it is gone. While a dialog is open, `useKeyboardListNavigation` takes no focus from `<body>`: Chrome fires `focusout` when the question's focused button leaves the page, and Drive's list would otherwise grab the focus before the dialog returns it.

The returned focus shows a ring only when its target had one as it left (`:focus-visible`). A dropdown menu a pointer opened gives its trigger the focus with `focusVisible: false`, because Radix's plain `focus()` after Escape draws a ring in Chrome, and a hover-revealed ⋮ with a ring stays shown after the pointer leaves.

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

`DriveBrowser` is a lighter layer over the same table, with no dialogs and no detail column, for the file picker and the location field. It keeps no location of its own: its host holds one `DriveLocationValue` (owner, mount, folder), the browser draws that and asks for another through `onChange`, so a folder click, a mount click and a host that moves all go one way. A mount click asks for the mount with an empty folder id, which means its root. A phone has no room for the mount column, so it picks the drive from `DriveMountSelect` above the folders, which draws the same list of drives and asks the same way. `useResolvedDriveLocation` is the one place that fills the root in, from the loaded root during render, and it stays empty while the root loads. The browser and the location field call it to draw, and a host that confirms a destination, such as `DriveLocationPicker` or the new chat dialog, calls it for what it hands on and keeps its confirm button disabled until the folder is there. `DriveLocationPicker` and `DriveFilePicker` mount their body inside `DialogContent`, so a closed picker reads no root, and the new chat dialog reads the viewer's own root.

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

## The app switcher is a NavigationMenu that opens on hover

**The grip at the top left of every app is a shadcn `NavigationMenu`, not a `DropdownMenu`, because it is a list of links that opens as the mouse rests on it.** Radix's NavigationMenu waits 200 ms before it opens, so a pointer passing on its way to the browser's tabs opens nothing, and closes 150 ms after the mouse leaves the grip and the panel. It leaves the focus where it was while the mouse opens it, so an editor keeps the keys; a DropdownMenu would take the focus as it opens. A click, a tap or Enter opens it too.

- Radix toggles on every click, so the press aimed at a grip the resting mouse just opened would close it. `NavigationMenuTrigger` keeps an open menu open on a mouse click; a tap or a key still toggles.
- The panel is not portaled: it sits `absolute` under its trigger, so it needs `w-max` to size to its content instead of to the grip's width.
- Its panel has no `role="menu"`, so `OPEN_MENU` names its `data-slot` too: a press on the canvas only closes it, and Vector's keys stand down while it is open, as for any menu.

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

An icon that deletes is flat too, and not red. The red is on the Delete of the confirmation it opens (a `ConfirmDialog` with `destructive`), and on a delete button that has words, which is `variant="destructive"`. A real primary action stays filled, such as chat's Send, and the list and grid switch keeps its edge because it is one control with two options.

`TooltipButton` and `KebabTrigger` take no `outline`, so a bordered icon fails typecheck. A plain `Button` with an icon size can still take one, which review catches.

## Pink is Eigen's accent color

Pink `#f6339a` (`packages/lib/src/constants/colors.ts`) comes first in `EIGEN_ACCENT_COLORS_SHUFFLED`, the order calendars, labels, chart series and presence hand the accents out in, so what Eigen picks for a user starts in its own color. Rose and fuchsia sit close to it, so they come late ([CHARTS.md](CHARTS.md) has the reasoning).

A fixed color mapped onto the palette (`eigenColor(name, step)`) takes the nearest palette color by OKLab distance, and in doubt the lighter, less saturated step, because the originals are muted.

**The theme token `--accent` (`bg-accent`) is not this pink.** It is shadcn's name for the grey hover fill of ghost and outline buttons and menu rows, so a pink element takes its color from `colors.ts`. Each app has its own color too, `--app-current-color` (`packages/ui/src/styles/globals.css`), which tints its selected list rows, the topbar's brackets and the sidebar's New button. The meaning of every theme token is a comment beside it in that file.

## A document stays white in dark mode

Dark mode themes the app around a document, never the document. The page in Docs, the grid in Sheets, the slide in Slides and the canvas in Vector stay white in either theme, while the bars, panels and menus around them follow it. This is intended (the owner, 14 Nov 2026). `.eigen-paper` pins the light palette on such a surface ([CANVAS.md](CANVAS.md)).

## An item is one square block, and an opened item reads block, meta, sections

Cards in Stickies, comments in the document apps and events in Calendar are drawn alike, so the apps read as one. Every item drawn as a block of its own reads one class, `.eigen-block` (`packages/ui/src/styles/globals.css`): square like a list row, with one flat shadow set through Tailwind's shadow variable, so a ring on the block adds to it, and in dark mode `colorSurface`'s 2px stripe in its place. `CardTile` (a board card, a comment card in a list or the hover card, the drag overlay), the calendar's blocks, bars, drafts and lane ghosts, and `DetailItemBlock` read it, and none keeps a corner or shadow of its own. It comes after the search ring in the stylesheet, since the ring rounds what it rings. A floating surface around a tile, such as the hover card's popover, keeps its own `shadow-md`.

The color is `colorSurface(color, tone)` in one of two tones, which the caller always names: `'tile'` for a small item you scan by color, such as a card on the board or an event on the grid, and the paler `'panel'` for the reading block of an opened item ([STICKIES.md](STICKIES.md)).

An opened item's body is built from the parts in `packages/ui/src/components/layout/app/detail-item.tsx`, in this order: `DetailItemBlock`, the item's block with its title inside, in its color's panel tone or `bg-muted` without one; `DetailMeta`, one muted line, such as who created it; then `DetailSection`s, each an `eigen-section-label` caption over its rows. An opened card or comment takes all three. An opened event, in its dialog or an `.ics` quick look, skips the block and shows its title as a plain heading, as its color only names its calendar ([CALENDAR.md](CALENDAR.md#an-event-on-the-grid-is-drawn-as-a-card-is-and-opened-it-has-no-block)).

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
| `eigen-tile-active`, `eigen-tile-selected` | the open or a multi-selected grid tile | a full border, because the wash would cover only a tile's label strip |
| `eigen-tile-cursor` | the keyboard cursor on a grid tile | the row cursor's stripe on the tile's left edge, drawn over the thumbnail |

A row or tile takes every class that holds, so a selected tile under the cursor shows the border and the stripe. A right-click or ⋮ selects its row without opening it, so the open row keeps its look.

One context menu serves the whole list, so a list never draws a `DropdownMenu` per row. A row's button opens it from the button's own rect, because a click made with Enter reports 0,0. `ContextMenuAnchor` portals its trigger to `document.body`, because a transformed ancestor, such as a dialog's centering translate, would otherwise move the menu.

The menu key (Shift+F10 or ContextMenu) opens the same menu from the row's rect, through the list's `onMenu`; a virtualized list finds the row by its `data-index` and opens a frame after scrolling it in. On Windows and Linux the browser follows the key with a native `contextmenu` event that a keydown `preventDefault` can't stop, which would open the browser's menu over ours. `isKeyboardContextMenu` (`use-context-menu.ts`) tells a key's event from a pointer's, and the list's native listener opens the cursor row's menu for it before React's handlers run. Inside an open menu the event lands on the focused row, and `DropdownMenuContent` cancels it, so the browser's menu never opens over a dropdown or a context menu.

A menu row's icon gap lives in the item primitives (`gap-4`); never add `mr-*` or a `gap-*` override to a menu icon.

## Reordering uses dnd-kit, moving between lists uses native drag, placing uses a pointer drag

Reordering in place (a stickies column, the slides rail) uses `@dnd-kit`. Dragging between lists, onto a sidebar target, or to and from the OS uses native HTML5 drag (`useListDrag`, `useListDropTarget`, `useFileDropTarget`), because dnd-kit never sees an OS file drop and only the native path carries the drag type across lists.

Placing and resizing a handle or block that follows one pointer uses `usePointerDrag` from `packages/ui/src/hooks/`: it follows the pointer under pointer capture, and Escape or a cancelled pointer cancels. dnd-kit has no resize. `ObjectTransform` keeps its own lifecycle, since Alt and Shift reshape a resize mid-drag. dnd-kit's sensors, `useDragScroll` and `usePointerDrag`'s default read one `DRAG_THRESHOLD_PX` from `@workspace/lib/constants/drag`, the travel before a press becomes a drag. Vector's handles pass a smaller threshold of their own, since a handle drag goes live almost at once.

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

**A document-level keymap folds `useDialogOpen()` into its `enabled`.** The library's own guard covers text fields only, so a key on a dialog button would act on the document behind it: Delete on a confirm button deleting the canvas selection. The hook watches the DOM for an open `role="dialog"` or `alertdialog`, so it keeps no registry. A bar menu leaves the page live, so the canvas also folds in `useMenuOpen()`, or ArrowRight in File would nudge the selected shape. A detail column has no focus trap, so the canvas folds in `useFocusInDetail()` too, in its keymap, its own Esc and its drawing tools' keys: Delete on a comment thread's Resolve or ⌘Z in its reply box would otherwise act on the drawing, and an Esc there would deselect before the column heard it.

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

- [FORMS.md](FORMS.md): how a form in a dialog, a card or a page behaves
- [MOBILE.md](MOBILE.md): the breakpoints and how the shell behaves on phones and touch
- [COMMAND-PALETTE.md](COMMAND-PALETTE.md): the ⌘K palette the shell mounts
- [COMMENTS.md](COMMENTS.md): the comments column and the comments and activity pane
- [PREVIEWS.md](PREVIEWS.md): the quick-look overlay, file subjects and file actions
- [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md): every shared component, hook and type, generated
- [TYPOGRAPHY.md](TYPOGRAPHY.md): type scale and fonts
