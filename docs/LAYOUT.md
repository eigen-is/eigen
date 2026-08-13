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

The comments/activity pane is `PanelColumn` (`layout/comments/panel-column.tsx`) on every viewport: a
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

Render sites declare their whole surface as one `DriveCapabilities` value (`drive-capabilities.ts`):
the fs browser passes `DRIVE_CAPABILITIES.browse`, watched passes `.readOnly`, and the flat views
(mime filters, per-app doc lists, shared-by/with-me) spread `.listing` with their own overrides.

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
| `drag-badge`               | Off-screen badge for multi-drag image                                  |

The wash is `--app-current-color-soft` and the stripe `--app-current-color`, so every list picks up
its own app colour.

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

#### 4. Drag-and-Drop

```tsx
const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'my-type' });
// On rows: {...drag.getDragProps(item)}
// Sidebar: <DroppableSidebarItem acceptTypes={['my-type']} onDrop={...} />
```

### Existing Lists

| List                     | File                                                                    | Drag type    |
|--------------------------|-------------------------------------------------------------------------|--------------|
| `DriveGrid`/`DriveTable` | `packages/ui/src/components/drive/use-drive-item-controller.ts`  | `drive-item` |
| `EmailList`              | `apps/mail/src/components/mail/email-list.tsx`                          | `email`      |
| `ContactsList`           | `apps/contacts/src/components/contacts/contacts-list.tsx`               | `contact`    |

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
| `Mod+Z`              | Undo (Stickies, Slides)   | `board.tsx`, `slides/editor.tsx` |
| `Mod+Y` / `Mod+Shift+Z` | Redo (Stickies, Slides) | `board.tsx`, `slides/editor.tsx` |
| `Delete`/`Backspace` | Delete selected (Slides)  | `slides/editor.tsx`              |
| `Escape`             | Deselect (Slides)         | `slides/editor.tsx`              |
| `Arrow keys`         | Nudge selected (Slides)   | `slides/editor.tsx`              |

Use `@tanstack/react-hotkeys` for global shortcuts and `formatForDisplay()` for tooltip labels. Keep manual
listeners for stateful navigation (`use-keyboard-list-navigation.ts`) and framework-specific contexts (Tiptap).

```tsx
import { useHotkey, formatForDisplay } from '@tanstack/react-hotkeys';

useHotkey('Mod+S', () => save(), { enabled: canSave });
const label = formatForDisplay('Mod+S'); // "⌘S" on Mac, "Ctrl+S" on Windows
```

## File Locations

The shell itself lives in `packages/ui/src/components/layout/app/` (`app-shell.tsx`, `eigen-app.tsx`,
`column-layout.tsx`, `layout-context.tsx`, `topbar.tsx`), the sidebar in
`packages/ui/src/components/layout/sidebar/`, and Drive in `packages/ui/src/components/drive/`.
Anything else: [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md).
