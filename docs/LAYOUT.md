# Layout System

> **TLDR**: `AppShell` wraps every app with Topbar + sidebar + content. `ColumnLayout` + `Column` provide responsive
> multi-column layouts — desktop shows all columns, mobile shows only `mobileColumn`. Toolbars are h-12 bars above each
> column. Back navigation via `onBack` prop on `Column`.

## Structure

```
AppShell
├── Topbar              (themed header, app logo, notification bell, user dropdown)
└── Content Area
    ├── SidebarContainer (collapsible)
    └── ColumnLayout
        ├── Column "list"    (fixed width)
        └── Column "detail"  (flex width)
```

## AppShell

Every app wraps its root route in `AppShell`:

```tsx
<AppShell
    appName="contacts"
    rootRoute={Route}
    sidebar={({ condensed }) => <ContactsSidebar condensed={condensed} />}
>
    <Outlet />
</AppShell>
```

| Prop          | Type                                | Description                           |
|---------------|-------------------------------------|---------------------------------------|
| `appName`     | `string`                            | Shown in Topbar and `document.title`  |
| `rootRoute`   | `{ useNavigate }`                   | TanStack Router root route            |
| `sidebar`     | `ReactNode \| (props) => ReactNode` | Sidebar content (omit for no sidebar) |
| `sidebarMode` | `'collapsible' \| 'none'`           | Default: `'collapsible'`              |

`SidebarProps` carries only `condensed` (true on tablet, where the sidebar renders as a `w-16`
rail). On mobile the sidebar is a full navigation column, not an overlay: the first `Column` of a
`ColumnLayout` opts in with `onBack="sidebar"`, which renders the ← arrow that shows it.

## EigenApp Provider Stack

`EigenApp` (`packages/ui/src/components/layout/app/eigen-app.tsx`) wraps every app with providers:

HotkeysProvider → TooltipProvider → QueryClientProvider → AuthProvider(loadingFallback) → ThemeProvider →
SSEProvider → UploadProvider → PreviewProvider → CommandPaletteProvider → GlobalHotkeys → ErrorBoundary →
Toaster + ReactQueryDevtools

`AuthProvider` accepts a `loadingFallback` prop (defaults to `<LoadingScreen />`) shown while auth state loads.
`ThemeProvider` applies light/dark/system theme from user space settings.
`CommandPaletteProvider` holds the palette's open state + the current selection/selectionActions
published by routes; `AppShell` mounts `PaletteRunner` (which renders `<CommandPalette>` + the shared
create dialogs) inside it. Apps that don't wrap with `EigenApp` (the marketing routes in `apps/index`)
omit the palette stack — `PaletteRunner` exits early via `useOptionalCommandPalette` so they don't crash.

## ColumnLayout & Column

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
    <Column id="list" width="350px" onBack="sidebar" toolbar={<ListToolbar />}>
        <ContactsList />
    </Column>
    <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar />}>
        <ContactDetail />
    </Column>
</ColumnLayout>
```

| Column Prop     | Type                        | Description                                                         |
|-----------------|-----------------------------|---------------------------------------------------------------------|
| `id`            | `string`                    | Must match `mobileColumn`, when one is set                          |
| `width`         | `string`                    | CSS width or `"flex"`                                               |
| `toolbar`       | `ReactNode`                 | h-12 bar above content                                              |
| `toolbarBorder` | `'auto' \| 'always'`        | `'auto'` fades the border in on scroll; canvas apps set `'always'`  |
| `onBack`        | `(() => void) \| 'sidebar'` | Shows ← button on mobile                                            |
| `className`     | `string`                    | Extra classes on the column wrapper                                 |

**Desktop**: All columns visible side-by-side.
**Mobile**: Only `mobileColumn` visible — the id gate only applies when a `ColumnLayout` sets
`mobileColumn`; without it (or outside a `ColumnLayout`) every `Column` renders, which is how the
editors mount a full-width pane as a sibling. `onBack` provides back navigation. A function navigates
up a level (detail → list); the `'sidebar'` sentinel goes on FIRST columns and shows the sidebar
as a full column — it self-gates on `sidebarMode === 'collapsible'`, so sidebar-less surfaces
(editors, RequestAccessView) never render a dead arrow.

## Page Layout Pattern

Every page uses `ColumnLayout` + `Column`. The toolbar is a **separate prop**, not part of the page content. The `Column` renders the toolbar in a fixed `h-12` bar with `px-4 border-b`. This ensures consistent toolbar height across all pages.

```tsx
<ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
    <Column id="list" width="flex" onBack="sidebar" toolbar={<MyToolbar />}>
        <MyContent />
    </Column>
    <Column id="detail" width="400px" onBack={handleBack} toolbar={<DetailToolbar />}>
        <DetailContent />
    </Column>
</ColumnLayout>
```

The first column passes `onBack="sidebar"` — the sentinel renders the mobile back arrow that steps up to the sidebar column, and self-gates away when the app has no sidebar. Without it a mobile user has no path back to navigation. Use `width="flex"` for a single full-width column. For a plain page title in the toolbar, use the shared `ToolbarTitle` component (`@workspace/ui/components/layout/toolbar`), which applies the `.eigen-toolbar-title` class (`text-sm font-normal text-foreground truncate` — thin, matching the breadcrumb) rather than hand-rolling a styled span. Richer toolbars (drive's path) compose a `BreadcrumbPage` (`font-normal`), so the two read at the same weight.

## LayoutContext

`useLayout()` provides: `appName`, `setAppName`, `documentTitle`, `setDocumentTitle`, `sidebarOpen`,
`setSidebarOpen`, `sidebarColumnShown` (mobile: the sidebar currently renders as the visible column
and `<main>` is CSS-hidden), `sidebarMode`, `sidebarHidden`, `setSidebarHidden`, `isMobile`, `isTablet`.

Convenience hook: `useApp()` → `{appName, setAppName}`. Use
`setDocumentTitle()` to update the browser tab title dynamically (e.g., showing the current document name).

`setSidebarHidden(true)` removes the sidebar entirely from the layout. Used by `RequestAccessView` and the admin
access denied screen to show a fullscreen view with only the topbar. Always restore on unmount:

```tsx
useEffect(() => {
    setSidebarHidden(true);
    return () => setSidebarHidden(false);
}, [setSidebarHidden]);
```

## Adding a New App

1. Create `__root.tsx` with `AppShell` wrapper
2. Create `_auth.tsx` route guard with `beforeLoad` redirect
3. Define routes with `ColumnLayout` + `Column`
4. Set `mobileColumn` based on URL params
5. Co-locate toolbar components with their views

## Shared Components

The component inventory lives in [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) — a generated, CI-gated
registry of every export of `packages/lib` and `packages/ui`. Search there before building any shared
component, hook or type. Layout components sit under `packages/ui/src/components/layout/`.

`DialogContent` caps its own width and height and scrolls inside, and its single grid track is `minmax(0, 1fr)`, so the box never grows to the min-content width of what a user typed. Text a user owns — a title, a location, a description — still needs `min-w-0 break-words` where it sits in a flex row, or the row itself overflows the dialog it is drawn in.

The comments/activity pane is `PanelColumn` (`components/comments/panel-column.tsx`) on every viewport: a
`Column` whose toolbar holds the title, the filter and the close affordance (back arrow on mobile, X on
desktop) around `CommentPanel` or `ActivityPanel`. See [COMMENTS.md](COMMENTS.md).

The **command palette** (`Mod+K`) is the one shared surface with its own architecture: engine, parsers,
providers and commands in `packages/lib/src/core/command-palette/`, dialog and rows in
`packages/ui/src/components/layout/app/command-palette/`. Its catalog is built from the shared `apps`
registry plus the `EIGEN_DOC_TYPE_INFO` / `EIGEN_DOC_ICONS` registries, so a new EigenDocType shows up in
the New menu for free. Routes publish selection-aware actions with `usePaletteSelection` +
`usePaletteSelectionActions`.

## Drive Components

`DriveLayout` orchestrates the file-management UI. Everything lives in
`packages/ui/src/components/drive/`.

### Architecture

```
DriveLayout (list/detail columns; every action gated by one required `capabilities` value)
├── useDriveLayoutDialogs + DriveLayoutDialogs (drive-layout-dialogs.tsx: dialog state,
│     mutations, palette publication — a capability that's off exposes `undefined` handlers)
├── DriveList (toolbar + breadcrumb + external drop zone + view-mode toggle)
│   ├── DriveGrid  → DriveTile   (grid view)
│   └── DriveTable → DriveRow    (list view: sorting, keyboard nav, drag-drop, context menu)
└── DriveDetail (preview, metadata, access list — 400px column, hidden on mobile until opened)
```

`DriveItemMenuItems` (`drive-item-menu.tsx`) is the item menu both the row context menu (`DriveItemContextMenu`, on the singleton `useContextMenu`) and the detail column's kebab draw. Open and Open in new tab are its own rows, and so are the download-formats submenu, Rename, Move to…, Copy to…, Duplicate, the watch toggle, Share and Move to trash; between the Open group and the download-formats submenu sit the file actions, drawn from the shared registry through `FileActionMenuItems`, minus `save-to-drive` — Drive's "Copy to…" already is that. Each host builds the runner from `subjectFromPath(item)` plus the sorted listing as siblings, so Quick preview pages through the folder the way the Space key does ([PREVIEWS.md](PREVIEWS.md)).

Render sites declare their whole surface as one `DriveCapabilities` value (`drive-capabilities.ts`): watched passes `DRIVE_CAPABILITIES.readOnly`, and the flat views (mime filters, per-app doc lists, shared-by/with-me) spread `.listing` with their own overrides. The fs browser derives its value from the viewer's own access instead — `browseCapabilities(canWrite)` returns `.browse` for a writer and `.readOnly` with the breadcrumb kept for everyone else, so a folder shared read-only still browses, previews, downloads and copies out but is never offered Rename, Duplicate, Move to trash or a convert that writes beside the source. `canWrite` comes from `useCheckPermissions` (`GET …/path/:pathId/permissions`, the same `SharedDrive.canWrite` the mutations enforce); owners and team members short-circuit it. Mime filters read only the caller's own and team mounts, so they stay writable; shared-with-me rows are other owners' files at mixed access and the feed carries no per-row permission, so that side turns `canWrite` off with `canRename` — delete stays on, because there it means leaving the share. `canWrite` rides down into the subjects the view's menus, detail column and quick look act on (`subjectFromPath(item, capabilities.canWrite)`), because a file action that writes beside its source — Convert to Sheet, Convert to Document — has nowhere to write in a read-only feed ([PREVIEWS.md](PREVIEWS.md)).

`DriveBrowser` (`drive-browser.tsx`) is a separate, lighter layer over `DriveTable`: breadcrumb + mount
list, no dialogs and no detail column. The file picker (`drive-file-picker.tsx`) and the location field
(`drive-location-field.tsx`) use it.

Only `apps/drive` mounts `DriveLayout` directly. Docs, Stickies, Slides and Sheets reach it through
`EigenDocListView` / `EigenDocSharedView`, which filter by the app's MIME type. Each app passes a config
(`DOCS_CONFIG`, `STICKIES_CONFIG`, `SLIDES_CONFIG`, `SHEETS_CONFIG`) built by `buildConfig` in
`eigendoc-config.ts` from the shared EigenDocType registry, and gets sidebar, list view and
shared-with-me view for free.

MIME → icon is not a Drive concern: `getFileIconComponent` / `getFilePresentation` live in
`packages/lib/src/core/file-presentation.ts` (DOM-free, so lib callers like the palette can use them),
with the JSX wrapper `getFileIcon` re-exported from `drive/file-presentation.tsx`.
Both take the file name beside the mime: a `.vcf`, a `.eml` and a `.ics` are often stored as `application/octet-stream`, and each carries its app's icon and color — Contacts, Mail and Calendar — the way an eigendoc carries its own app's. `APP_FORMATS` in that file is the one list; the icon, the tint behind a Drive tile and hero, and the format badge all read it.

## List Patterns

> Interactive lists use composable hooks: `useListSelection` → `useKeyboardListNavigation` → `useListDrag` →
> `useContextMenu`. No shared list component — each list owns its rendering. CSS classes in
> `packages/ui/src/styles/globals.css`.

### Hooks

| Hook                           | File                                                                 | Purpose                                                  |
|--------------------------------|----------------------------------------------------------------------|----------------------------------------------------------|
| `useListSelection<T>`          | `packages/ui/src/hooks/use-list-selection.ts`                        | Multi-select: click, Ctrl+click, Shift+click, select-all |
| `useKeyboardListNavigation<T>` | `packages/ui/src/hooks/use-keyboard-list-navigation.ts`              | Arrow keys, Home/End, Shift+Arrow, Ctrl+A, Escape        |
| `useListDrag<T>`               | `packages/ui/src/hooks/use-list-drag.ts`                             | Drag from list (multi-drag badge)                        |
| `useListDropTarget`            | `packages/ui/src/hooks/use-list-drop-target.ts`                      | Drop on sidebar items                                    |
| `useContextMenu<T>`            | `packages/ui/src/components/context-menu/use-context-menu.ts` | Right-click context menu                                 |

### CSS Classes

Defined in `packages/ui/src/styles/globals.css`:

| Class                      | Purpose                                                                |
|----------------------------|------------------------------------------------------------------------|
| `eigen-list-item`          | Base row: background, pointer, no user-select, transparent 2px stripe  |
| `eigen-list-item-active`   | Open / URL-active row: app-color wash + 2px stripe                     |
| `eigen-list-item-cursor`   | Keyboard cursor: the 2px stripe WITHOUT the wash (mail list)           |
| `eigen-list-item-selected` | Multi-selected: app-color wash                                         |
| `eigen-tile` (+ `-active`, `-selected`) | Grid-view tile: full app-color border instead of stripe + wash |
| `eigen-ket-tile`           | Launcher tile (`KetTile`): straight left edge with the 2px stripe, right edge is the logo's ket; hover = the row wash |
| `drag-badge`               | Off-screen badge for multi-drag image                                  |

The wash is `--app-current-color-soft` and the stripe `--app-current-color`, so every list picks up
its own app color.

### Setup Pattern

#### 1. Selection + Keyboard

```tsx
const selection = useListSelection({ items, getId: (item) => item.id });
const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
    items, activeId, getId: (item) => item.id,
    onSelect: (id) => navigate(id),
    containerRef: listRef, selection,
});
```

#### 2. Row Rendering

```tsx
<div ref={listRef} tabIndex={0} onKeyDown={handleKeyDown} className="outline-none">
    {items.map((item, index) => (
        <div
            key={item.id}
            className={cn(
                "eigen-list-item",
                (activeId === item.id || selectedIndex === index) && "eigen-list-item-active",
                selection.isSelected(item.id) && "eigen-list-item-selected",
            )}
            onClick={(e) => {
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onRowClick(item.id);
            }}
        >
            {/* content */}
        </div>
    ))}
</div>
```

#### 3. Context Menu

```tsx
const contextMenu = useContextMenu<MyItem>();
const contextItems = contextMenu.item
    ? (selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item])
    : [];
```

`ContextMenuAnchor` portals its zero-size trigger into `document.body`: the trigger is positioned in viewport coordinates, and a transformed ancestor (a dialog's centering translate) would otherwise become its containing block and open the menu somewhere else.

#### 4. Drag-and-Drop

```tsx
const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'my-type' });
// On rows: {...drag.getDragProps(item)}
// Sidebar: <DroppableSidebarItem acceptTypes={['my-type']} onDrop={...} />
```

**Which DnD system**: reordering items in place (a kanban column, a sortable list) uses `@dnd-kit` (see the stickies board). Dragging BETWEEN lists, onto sidebar drop targets, or interoperating with OS files uses the native HTML5 `useListDrag` / `useListDropTarget` (and `useFileDropTarget` / `useFilePasteTarget` for OS files) — dnd-kit does not see OS-file drops, and the native path carries the drag type across lists.

### Existing Lists

| List                     | File                                                                    | Drag type    |
|--------------------------|-------------------------------------------------------------------------|--------------|
| `DriveGrid`/`DriveTable` | `packages/ui/src/components/drive/use-drive-item-controller.ts`  | `drive-item` |
| `EmailList`              | `apps/mail/src/components/mail/email-list.tsx`                          | `email`      |
| `ContactsList`           | `apps/contacts/src/components/contacts/contacts-list.tsx`               | `contact`    |

## Hover-Only Icons

To show action icons only on row hover (like the share icon in Drive), use the Tailwind `group` + `invisible group-hover:visible` pattern. Always add the matching `pointer-coarse:` variant so the affordance rests visible on touch devices, which have no hover — mirror the value the mouse user sees on hover. `pointer-fine:group-hover:` is the opt-out when hover really is desktop-only. Gated:

```tsx
<TableRow className="eigen-list-item group">
    <TableCell>
        <span>Item name</span>
        <div className="invisible group-hover:visible pointer-coarse:visible ml-auto">
            <TooltipButton icon={Edit} tooltipText="Edit" className="h-7 w-7" onClick={...} />
        </div>
    </TableCell>
</TableRow>
```

Use `TooltipButton` from `packages/ui/src/components/layout/toolbar/tooltip-button.tsx` for icon buttons with tooltips. Don't rebuild Tooltip+Button manually.

If hover icons would affect row height, use `absolute` positioning so they float over the row.

## Keyboard Shortcuts

`@tanstack/react-hotkeys` for global shortcuts. `Mod` = Cmd (Mac) / Ctrl (Windows).

| Shortcut             | Action                    | Location                         |
|----------------------|---------------------------|----------------------------------|
| `Mod+K`              | Command palette           | `use-palette-shortcuts.ts` (raw window capture, so it fires inside inputs too) |
| `Mod+F`              | In-document search        | `doc-search-provider.tsx`        |
| `Mod+P`              | Print                     | `eigen-app.tsx`                  |
| `Mod+S`              | Save (Inline Editor)      | `use-editor-save.ts`            |
| `Escape`             | Close preview             | `file-preview.tsx`               |
| `ArrowLeft/Right`    | Navigate preview          | `file-preview.tsx`               |
| `Mod+Z`              | Undo (Stickies)           | `board.tsx`                      |
| `Mod+Y` / `Mod+Shift+Z` | Redo (Stickies)        | `board.tsx`                      |
| Canvas keymap (slides + vector) | tools, nudge, delete, duplicate, z-order, layered Escape | `vector/hooks/use-canvas-keyboard.ts` — see [CANVAS.md](CANVAS.md) |

Use `@tanstack/react-hotkeys` for global shortcuts and `formatForDisplay()` for tooltip labels. Keep manual
listeners for stateful navigation (`use-keyboard-list-navigation.ts`) and framework-specific contexts (Tiptap).

**A document-level keymap folds `useDialogOpen()` (`packages/ui/src/hooks/use-dialog-open.ts`) into its `enabled`.** The library's own guard covers text fields only; a key pressed on a dialog button otherwise acts on the document behind it (Delete on a confirm button deleting the canvas selection, `#` in the mail location picker trashing the message). The hook watches the DOM for an open `role="dialog"` / `role="alertdialog"` element — Radix dialogs, alert dialogs and popovers, and the `useFocusTrap` overlays all carry it — so no registry is kept. Overlays that are dialogs themselves (`file-preview.tsx`, the mail cheat sheet) register their keys ungated. Current consumers: the mail shortcut set, the canvas keymap and its layered Escape, the find bar, the stickies undo keys.

```tsx
import { useHotkey, formatForDisplay } from '@tanstack/react-hotkeys';

useHotkey('Mod+S', () => save(), { enabled: canSave });
const label = formatForDisplay('Mod+S'); // "⌘S" on Mac, "Ctrl+S" on Windows
```

## Z-Index / Layering

One scale, project-wide. Higher values are progressively rarer — if you reach for one, justify it with a comment.

| Layer                                        | z-index | Examples                                                |
|----------------------------------------------|---------|---------------------------------------------------------|
| Document content                             | auto    | Default; everything flows                               |
| In-content floating UI                       | 10      | Inline autocompletes, chat/contact suggestion lists     |
| Sheet canvas-internal overlays               | 8–30    | Selection, freeze handles, scrollbars, hint boxes — scoped under `cellArea` |
| Portaled UI (dropdowns, popovers, dialogs)   | 50      | shadcn / Radix default — leave it alone                 |
| Full-screen overlay                          | 100     | `FilePreview`, slides `PresentMode`                     |
| Above the full-screen overlay                | 200     | `DialogContent` with `abovePreview` prop; `MessageView`'s header details popover, on the same prop, for the `.eml` quick look |
| Toaster                                      | library | Sonner manages its own stack                            |

Rules:

- **App-level components don't set z-index.** Use layout instead — flex sibling (slides pattern) or absolute inside a parent that establishes a stacking context (docs pattern with `position: relative overflow-hidden`). Side panels (comments, properties) belong here.
- **`position: relative` alone does *not* establish a stacking context** — the element needs a `z-index` other than `auto` (or one of: `transform`, `opacity < 1`, `filter`, `isolation: isolate`, `will-change`). If you want to contain children's z-indices, add `isolation: isolate`.
- **Don't override shadcn primitives' z-50.** If a portaled menu is being covered, fix the offending high z-index, don't escalate the menu.
- **Anything > 50 needs a comment** explaining why (current exceptions are `FilePreview`, the slides `PresentMode` overlay and the `abovePreview` Dialog prop, which `MessageView`'s details popover reads off the preview context). A layer at 200 is a `role="dialog"` of its own, which is what `useDialogOpen(overlayRef)` reads so the overlay under it stands its own keys down — and for the keydown in hand, the overlay reads where the key was pressed instead, because a layer dismisses on that event's capture phase ([PREVIEWS.md](PREVIEWS.md)).
- **The sheet engine's `cellArea` is its own world** — overlays under it stay ≤ 30; portaled menus rely on shadcn's z-50 to land above.

## Opening Items and Links

The rule is **who started the navigation**, not where the link points. It is written this way so a user can predict it by looking: buttons in the UI navigate here, links in text open a new tab. A rule that depended on the destination's host would be invisible — two links that look identical would behave differently.

**Navigation affordances navigate in the same tab.** A notification row and its SSE toast's **View**, activity and file-history rows, drive rows, Quick Look's **Open**, and creating a new document all mean "take me there". `openDocument()` (`packages/lib/src/core/api.ts`) has no new-tab branch, so the eigen-document open path can't drift; it covers the six eigen document types, and every other navigation affordance follows the rule by convention (`navigate()` for inline-editables, `window.location.href` in the drive and mail write hooks). Links aren't gated on access up front: the fs listing route needs read access to the item's **parent** folder, so when it 403s and the URL carries `?pid=`, it redirects to `getDriveShareUrl()` for that item — the destination knows the answer, the link builders would only be guessing. *Request access* still shows for a viewer who can't read the item either.

**Links and chips inside content open a new tab, whatever they point at.** A URL typed into a chat message, a comment, a sticky card or an email is an aside while the user is mid-task, and so is the drive-reference chip rendered beside it — clicking either must not abandon the conversation they are reading. Enforced unconditionally in the sanitizer (`core/html-dom.ts`), chat's linkifier (`rich-content.tsx`), sheet cell hyperlinks, the docs and LightEditor Tiptap `Link` extensions, and `reference-attachment-chip.tsx`.

Two further carve-outs on the same-tab side:

- **The user asked for a new tab** — Drive's **Open in new tab** row and the `drive.open-in-new-tab` command. Prefer a real `<a href>` for a navigation affordance wherever the markup allows it — `DriveItemNameLink`, Quick Look's **Open**, and Drive's *Recent activity* rows (`ActivityRow` takes `href`, which wins over `onOpen`): an anchor lets cmd/middle-click open a new tab, so the user keeps the choice and the default matters less. A `div` driven by `window.location.assign` takes that choice away. Two things block it: a URL that needs an async resolve (the notification bell), and an interactive control in `trailing` — a `<button>` inside an `<a>` is invalid HTML.
- **Genuinely external destinations** — downloads, the marketing site, exported HTML read outside the instance, and mail. Mail is deliberate twice over: our own share email is read in other clients as often as in Eigen Mail, and deriving "open in this tab" from a *stranger's* URL is exactly where an Eigen-looking phishing host would replace the reader's inbox.

Open question, not yet decided: on touch, a new tab is harder to escape than on desktop, so the content rule may deserve a `pointer-coarse` exception ([MOBILE.md](MOBILE.md)).

## File Locations

The shell itself lives in `packages/ui/src/components/layout/app/` (`app-shell.tsx`, `eigen-app.tsx`,
`column-layout.tsx`, `layout-context.tsx`, `topbar.tsx`), the sidebar in
`packages/ui/src/components/layout/sidebar/`, and Drive in `packages/ui/src/components/drive/`.
Anything else: [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md).
