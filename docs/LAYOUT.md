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

| Column Prop | Type                        | Description                                       |
|-------------|-----------------------------|---------------------------------------------------|
| `id`        | `string`                    | Must match `mobileColumn` to be visible on mobile |
| `width`     | `string`                    | CSS width or `"flex"`                             |
| `toolbar`   | `ReactNode`                 | h-12 bar above content                            |
| `onBack`    | `(() => void) \| 'sidebar'` | Shows ← button on mobile                          |

**Desktop**: All columns visible side-by-side.
**Mobile**: Only `mobileColumn` visible. `onBack` provides back navigation. A function navigates
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

Lookup reference for all shared components in `packages/ui/src/components/layout/`. Use this to find existing
components before building new ones.

**Known issues**: Find-and-Replace dialog z-index in sheets; formula "learn more" dialog broken; tab color via context
menu needs submenu.

### Core Layout

| Component       | File                       | Description                                                                        |
|-----------------|----------------------------|------------------------------------------------------------------------------------|
| `EigenApp`      | `app/eigen-app.tsx`        | Root provider stack (QueryClient, Auth, Theme, SSE, Upload, Tooltip, Toaster)      |
| `AppShell`      | `app/app-shell.tsx`        | App shell: Topbar + sidebar + content                                              |
| `LayoutContext` | `app/layout-context.tsx`   | Layout state context. Hooks: `useLayout`, `useApp`                                 |
| `ColumnLayout`  | `app/column-layout.tsx`    | Multi-column layout with mobile switching                                          |
| `Column`        | `app/column-layout.tsx`    | Single column with toolbar slot                                                    |
| `Topbar`        | `app/topbar.tsx`           | Themed header (`bg-app`): app logo, notification bell, user dropdown               |
| `ThemeProvider` | `app/theme-provider.tsx`   | Applies light/dark/system theme from space settings                                |
| `NotificationBell` | `app/notification-bell.tsx` | Unread notification count + popover                                            |
| `NotFound`      | `app/not-found.tsx`        | Empty state for missing resources                                                  |
| `AccessDenied`  | `app/access-denied.tsx`    | Role-based access denied (admin app only). For resource access, use `RequestAccessView` |
| `RequestAccessView` | `app/request-access-view.tsx` | Fullscreen "request access" screen with owner info, message field, request button. Hides sidebar via `setSidebarHidden` |
| `EmptyState`    | `app/empty-state.tsx`      | Centered message with optional icon + action                                       |
| `ErrorState`    | `app/error-state.tsx`      | Error message with optional detail                                                 |
| `LoadingState`  | `app/loading-state.tsx`    | Centered EigenLoader spinner                                                       |

### Sidebar

| Component              | File                                 | Description                                       |
|------------------------|--------------------------------------|---------------------------------------------------|
| `SidebarContainer`     | `sidebar/sidebar-container.tsx`      | Responsive wrapper: full (desktop) / condensed rail (tablet) / in-flow full-width column when open (mobile) |
| `SidebarItem`          | `sidebar/sidebar-item.tsx`           | Nav item: icon + label + colorDot. Link or Button |
| `SidebarSection`       | `sidebar/sidebar-section.tsx`        | Grouped section with optional title               |
| `DroppableSidebarItem` | `sidebar/droppable-sidebar-item.tsx` | SidebarItem + drop target                         |

### Providers

| Provider              | File                                            | Description                                |
|-----------------------|-------------------------------------------------|--------------------------------------------|
| `SSEProvider`         | `sse-provider/sse-provider.tsx`                 | SSE events → toast notifications           |
| `UploadProvider`      | `upload-provider/upload-provider.tsx`            | File upload state + progress UI            |
| `useUpload`           | `upload-provider/upload-provider.tsx`            | Hook for creating/tracking uploads         |
| `UploadContainer`     | `upload-provider/upload-container.tsx`           | Floating upload progress cards             |
| `uploadWithProgress`  | `upload-provider/upload-with-progress.tsx`       | XHR upload helper with progress callback   |
| `PreviewProvider`     | `preview-provider/preview-provider.tsx`          | File preview (images, videos, PDFs)        |
| `usePreview`          | `preview-provider/preview-provider.tsx`          | Hook: openPreview, closePreview            |
| `useOptionalPreview`  | `preview-provider/preview-provider.tsx`          | Returns null when no provider in the tree  |
| `CommandPaletteProvider` | `app/command-palette/command-palette-provider.tsx` | Holds palette open/input/scope + published selection/selectionActions |

### User Components

| Component    | File              | Description                                           |
|--------------|-------------------|-------------------------------------------------------|
| `UserAvatar`          | `user-avatar.tsx`           | Avatar with auto-fetch. DigiDoodle fallback. sm/md/lg         |
| `UserItem`            | `user-item.tsx`             | Avatar + name + email row                                     |
| `CollapsibleUserList` | `collapsible-user-list.tsx` | Collapsible summary header + user list (Drive ACL, attendees) |

### Labels

| Component            | File                               | Description                                |
|----------------------|------------------------------------|--------------------------------------------|
| `LabelDialog`        | `labels/label-dialog.tsx`          | Create/edit/delete label with color picker |
| `LabelFilterHeader`  | `labels/label-filter-header.tsx`   | Active label header bar                    |
| `LabelManager`       | `labels/label-manager.tsx`         | Sidebar label list with add/edit           |
| `LabelAssignSubMenu` | `labels/label-assign-sub-menu.tsx` | Dropdown sub-menu for toggling labels      |

### Contacts

| Component               | File                                                                | Description                                                                                |
|-------------------------|---------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `ContactAutosuggest`    | `packages/ui/src/components/layout/contacts/contact-autosuggest.tsx` | Input with contact suggestions dropdown                                                    |
| `ContactSuggestList`    | `packages/ui/src/components/layout/contacts/contact-suggest-list.tsx` | Presentational `<ul>` of suggestions (used by autosuggest + chat @-mention)               |
| `ContactAddRow`         | `packages/ui/src/components/layout/contacts/contact-add-row.tsx`     | ContactAutosuggest + plus button (drive/calendar share dialogs)                            |
| `useContactSuggestions` | `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts`    | Hook: merge personal contacts + team members, filter by query. `kind: 'personal' \| 'team'` + `teamId` lets consumers branch. Lives in lib so the command palette and the autosuggest UIs share one implementation |
| `ContactSuggestion`     | `packages/lib/src/types/contact.ts`                                  | Canonical projection: `{ kind, id, displayName, email, teamId? }`                          |

### Command Palette

`Mod+K` opens a global palette that searches and acts across every app. Architecture in
`packages/lib/src/core/command-palette/` (engine, parsers, rank, providers, commands, hooks) +
`packages/ui/src/components/layout/app/command-palette/` (dialog, rows, footer, trigger).
The catalog draws from the shared `apps` registry (`@workspace/lib/apps`) and the
`EIGEN_DOC_TYPE_INFO` + `EIGEN_DOC_ICONS` registries — adding a new EigenDocType updates the
palette's New menu automatically. Selection-aware actions arrive via `usePaletteSelection` +
`usePaletteSelectionActions` published by routes (DriveList multi-select, eigendoc viewers
publish 1-item selections).

| Component                    | File                                                                                | Description                                                                                                            |
|------------------------------|-------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `CommandPalette`             | `packages/ui/src/components/layout/app/command-palette/command-palette.tsx`         | The `Mod+K` dialog: cmdk `<Command>` with controlled value (first-item-selected on each result-set change), fixed `h-[420px]` list, scope chip header, kind-aware rows |
| `CommandPaletteTrigger`      | `packages/ui/src/components/layout/app/command-palette/command-palette-trigger.tsx` | Topbar pill (desktop) + icon button (mobile), styled to match the existing `bg-app` topbar buttons                     |
| `usePaletteShortcuts`        | `packages/ui/src/components/layout/app/command-palette/use-palette-shortcuts.ts`    | Global `Mod+K` capture                                                                                                 |
| `CommandRow*` components     | `packages/ui/src/components/layout/app/command-palette/command-row-*.tsx`           | One row component per kind (action, smart, contact, mail) — palette density (h-4 icons / h-5 avatar)                   |
| `useCommandPalette`          | `@workspace/lib/command-palette`                                                    | Read palette context (open/input/scope/selection/selectionActions). Throws if no provider                              |
| `useOptionalCommandPalette`  | `@workspace/lib/command-palette`                                                    | Returns `null` when no provider — used by `PaletteRunner` to skip rendering in apps without `EigenApp`                 |
| `useCommandResults`          | `@workspace/lib/command-palette`                                                    | Composes the 4 providers + the engine; holds the last settled merge during `mail.isPending` so the palette doesn't flicker on keystrokes |
| `usePaletteSelection`        | `@workspace/lib/command-palette`                                                    | Publish a `{items: DrivePath[]}` selection from a route (DriveList, each eigendoc viewer). Stable on `idsKey`           |
| `usePaletteSelectionActions` | `@workspace/lib/command-palette`                                                    | Publish dialog-opening handlers (rename/share/delete/etc.) from `DriveLayout`. Stable on a shape-key so callers don't need to memoise perfectly |
| `Command` / `PaletteResult`  | `packages/lib/src/types/command-palette.ts`                                         | Catalog entry + discriminated-union result types. Result kinds: `action`, `smart`, `contact`, `mail`. `Command.group: 'actions' \| 'selection'` + `dynamicTitle(ctx) => string` for item-aware labels |
| `buildSections`              | `packages/lib/src/core/command-palette/engine.ts`                                   | Pure merge: groups → Top Hit → Suggestions → Selection → Mail → Contacts → Actions. Sections cap at 6                  |

### Context Menu

| Component           | File                                   | Description                                         |
|---------------------|----------------------------------------|-----------------------------------------------------|
| `useContextMenu`    | `context-menu/use-context-menu.ts`     | Right-click menu state (item, position, open/close) |
| `ContextMenuAnchor` | `context-menu/context-menu-anchor.tsx` | Positions DropdownMenu at cursor                    |

### Common UI

| Component            | File                               | Description                                    |
|----------------------|------------------------------------|------------------------------------------------|
| `SearchBar`          | `search-bar/search-bar.tsx`        | Search input with icon                         |
| `TooltipButton`      | `toolbar/tooltip-button.tsx`       | Icon button + tooltip                          |
| `TooltipToggle`      | `toolbar/tooltip-toggle.tsx`       | Toggle button + tooltip                        |
| `Toolbar`            | `toolbar/toolbar.tsx`              | Base toolbar component                         |
| `KebabTrigger`       | `toolbar/kebab-trigger.tsx`        | ⋮ overflow-menu trigger (inside a DropdownMenu) |
| `DocumentModeButton` | `toolbar/document-mode-button.tsx` | Read-only/editing mode toggle                  |
| `FileMenu`           | `toolbar/file-menu.tsx`            | File dropdown: rename, delete, revision history |
| `DeleteDialog`       | `delete/delete-dialog.tsx`         | Confirmation dialog for destructive actions    |
| `ConfirmDialog`      | `confirm-dialog.tsx`               | Generic confirmation dialog (title + action)   |
| `ShadowContent`      | `shadow-content.tsx`               | Shadow DOM for style isolation (email bodies)  |
| `ColorPicker`        | `media/color-picker.tsx`           | Color picker popover                           |
| `FontPicker`         | `media/font-picker.tsx`            | Font family picker dropdown                    |
| `ImageResizeHandles` | `media/image-resize-handles.tsx`   | Resize handles (docs + slides)                 |
| `MountForm`          | `mount/mount-form.tsx`             | Storage mount configuration form               |

### Side Panels

| Component           | File                                    | Description                                                                                                 |
|---------------------|-----------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `PropertiesPanel`   | `properties-panel/properties-panel.tsx` | Right-side panel container                                                                                  |
| `PropertySection`   | `properties-panel/properties-panel.tsx` | Section with title                                                                                          |
| `PropertyRow`       | `properties-panel/properties-panel.tsx` | Row with label + content                                                                                    |
| `CommentPanel`      | `comments/comment-panel.tsx`            | Document comments list body — no chrome of its own                                                          |
| `ActivityPanel`     | `comments/activity-panel.tsx`           | File activity list body — no chrome of its own                                                              |
| `PanelColumn`       | `comments/panel-column.tsx`             | The comments/activity pane on every viewport: a `Column` whose toolbar holds the title, the filter and the close affordance (back arrow on mobile, X on desktop) around one of the two bodies. See [COMMENTS.md](COMMENTS.md) |

### Branding & Auth

| Component                 | File                       | Description                         |
|---------------------------|----------------------------|-------------------------------------|
| `AppLogo`                 | `app/app-logo.tsx`         | `eigen\|appname>` wordmark links (the app switcher is the separate `AppSwitcher` in the Topbar) |
| `EigenLoader`             | `braket/eigen-loader.tsx`  | Animated loading indicator          |
| `LoadingScreen`           | `pages/loading-screen.tsx` | Full-screen loader                  |
| `LoginPage`               | `pages/loginpage.tsx`      | Login form                          |
| `createLoginRouteOptions` | `pages/login-route.tsx`    | TanStack Router login route factory |

### Storage

| Component      | File             | Description                           |
|----------------|------------------|---------------------------------------|
| `StorageUsage` | `home/usage.tsx` | Storage bar with per-domain breakdown |

### Chat

| Component           | File                           | Description                             |
|---------------------|--------------------------------|-----------------------------------------|
| `ChatMessageInput`  | `chat/chat-message-input.tsx`  | Input with slash commands + suggestions |
| `ChatMessageList`   | `chat/chat-message-list.tsx`   | Message list with auto-scroll           |
| `ChatPlayerSuggest` | `chat/chat-player-suggest.tsx` | @mention autosuggest                    |
| `ChatSlashSuggest`  | `chat/chat-slash-suggest.tsx`  | Slash command autosuggest               |

## Drive Components

> `DriveLayout` orchestrates file management UI (list + detail + dialogs). Used by Drive, Docs, Stickies apps.
> All components in `packages/ui/src/components/layout/drive/`.

### Architecture

```
DriveLayout (orchestrator)
├── DriveList (toolbar + breadcrumb + external drop zone)
│   └── DriveTable (rows, keyboard nav, internal drag-drop, context menu)
├── DriveDetail (file preview, metadata, access list)
└── Dialogs (create, delete, rename, share, upload)
```

### Components

| Component             | File                         | Description                                           |
|-----------------------|------------------------------|-------------------------------------------------------|
| `DriveLayout`         | `drive-layout.tsx`           | Main entry point with dialogs + actions               |
| `DriveList`           | `drive-list.tsx`             | File browser with toolbar + breadcrumb                |
| `DriveTable`          | `drive-table.tsx`            | Table with sorting, keyboard, drag-drop, context menu |
| `DriveDetail`         | `drive-detail.tsx`           | Metadata, preview (image/video/audio), access list    |
| `DriveCreateFolder`   | `drive-create-folder.tsx`    | Create folder dialog                                  |
| `DriveCreateEigenDoc` | `drive-create-eigendoc.tsx`  | Unified create dialog (doc/stickies/chat/slides/sheets) |
| `DriveDeleteItem`     | `drive-delete-item.tsx`      | Delete confirmation                                   |
| `DriveRenameItem`     | `drive-rename-item.tsx`      | Rename dialog                                         |
| `DriveAccessDialog`   | `drive-access-dialog.tsx`    | Share/ACL management                                  |
| `DriveAccessListEdit` | `drive-access-list-edit.tsx` | Editable access list                                  |
| `DriveAccessList`     | `drive-access-list.tsx`      | Read-only access list                                 |
| `DriveShareSummary`   | `drive-share-summary.tsx`    | Sharing status badge                                  |
| `DriveUploadFiles`        | `drive-upload-files.tsx`        | Upload with drag-drop                               |
| `DriveCreateFolderItem`   | `drive-create-folder-item.tsx`  | Shared create-item dialog (name input + breadcrumb) |
| `DriveEmailCollaborators` | `drive-email-collaborators.tsx` | Email collaborators about a shared file             |
| `FilePreview`             | `file-preview.tsx`              | Lightbox for images/videos/PDFs                     |
| `fileIconHelper`          | `file-icon-helper.tsx`          | MIME type → Lucide icon                             |
| `useDriveDialogs`         | `use-drive-dialogs.ts`          | Dialog state for all 7+ dialogs                     |

### EigenDoc Components

Document-like apps (Docs, Stickies, Slides, Sheets) share a common UI shell via `eigendoc-*` components. Each app
provides an `EigenDocAppConfig` and gets a sidebar, list view, and shared-with-me view for free.

| Component             | File                      | Description                                             |
|-----------------------|---------------------------|---------------------------------------------------------|
| `EigenDocAppConfig`   | `eigendoc-config.ts`      | Config type: appName, mimeType, icon, createDialog      |
| `eigenDocConfigs`     | `eigendoc-configs.ts`     | Pre-built configs: `DOCS_CONFIG`, `STICKIES_CONFIG`, etc |
| `EigenDocRoot`        | `eigendoc-root.tsx`       | Root route wrapper: AppShell + sidebar + DriveContext    |
| `EigenDocSidebar`     | `eigendoc-sidebar.tsx`    | Sidebar: new button, all items, shared-with-me          |
| `EigenDocListView`    | `eigendoc-list-view.tsx`  | MIME-filtered DriveLayout for the app's file type        |
| `EigenDocSharedView`  | `eigendoc-shared-view.tsx`| Shared-with-me view for the app's file type              |

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
| `useContextMenu<T>`            | `packages/ui/src/components/layout/context-menu/use-context-menu.ts` | Right-click context menu                                 |

### CSS Classes

Defined in `packages/ui/src/styles/globals.css`:

| Class                      | Purpose                                      |
|----------------------------|----------------------------------------------|
| `eigen-list-item`          | Base row (white bg, pointer, no user-select) |
| `eigen-list-item-active`   | Keyboard-focused / URL-active row            |
| `eigen-list-item-selected` | Multi-selected (blue highlight)              |
| `eigen-list-item-unread`   | Unread indicator (red left border)           |
| `drag-badge`               | Off-screen badge for multi-drag image        |

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

| List           | File                                                      | Drag type    |
|----------------|-----------------------------------------------------------|--------------|
| `DriveTable`   | `packages/ui/src/components/layout/drive/drive-table.tsx` | `drive-item` |
| `EmailList`    | `apps/mail/src/components/mail/email-list.tsx`            | `email`      |
| `ContactsList` | `apps/contacts/src/components/contacts/contacts-list.tsx` | `contact`    |

## Keyboard Shortcuts

`@tanstack/react-hotkeys` for global shortcuts. `Mod` = Cmd (Mac) / Ctrl (Windows).

| Shortcut             | Action                    | Location                         |
|----------------------|---------------------------|----------------------------------|
| `Mod+B`              | Toggle sidebar            | `packages/ui/.../sidebar.tsx`    |
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

| Component                 | File                                                              |
|---------------------------|-------------------------------------------------------------------|
| AppShell                  | `packages/ui/src/components/layout/app/app-shell.tsx`             |
| EigenApp (provider stack) | `packages/ui/src/components/layout/app/eigen-app.tsx`             |
| ColumnLayout / Column     | `packages/ui/src/components/layout/app/column-layout.tsx`         |
| LayoutContext             | `packages/ui/src/components/layout/app/layout-context.tsx`        |
| Topbar                    | `packages/ui/src/components/layout/app/topbar.tsx`                |
| SidebarContainer          | `packages/ui/src/components/layout/sidebar/sidebar-container.tsx` |
| DriveLayout               | `packages/ui/src/components/layout/drive/drive-layout.tsx`        |
