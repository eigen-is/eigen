# Shared UI Components

All shared components live in `packages/ui/src/components/layout/`. This document provides a quick reference.

---

## Core Layout

| Component | File | Description |
|-----------|------|-------------|
| `EigenApp` | `eigen-app.tsx` | Root provider wrapper: QueryClient, AuthProvider, SSEProvider, UploadProvider, TooltipProvider, Toaster |
| `AppShell` | `app-shell.tsx` | App shell with Topbar, sidebar, and main content area via `<Outlet/>` |
| `LayoutContext` | `layout-context.tsx` | Context for layout state: appName, sidebar open/close, sidebarMode, mobile/tablet detection |
| `useLayout` | `layout-context.tsx` | Hook to access layout context (isMobile, isTablet, sidebarOpen, sidebarMode, etc.) |
| `useApp` | `layout-context.tsx` | Hook to access/set appName |
| `useSidebar` | `layout-context.tsx` | Hook to access/set sidebarOpen state |
| `ColumnLayout` | `column-layout.tsx` | Flex row container for columns with mobile column switching |
| `Column` | `column-layout.tsx` | Single column with width, toolbar slot, onBack support |
| `Topbar` | `topbar.tsx` | Blue header bar: app logo, user dropdown, app navigation |

See `docs/LAYOUT.md` for detailed architecture documentation.

---

## Sidebar

| Component | File | Description |
|-----------|------|-------------|
| `SidebarContainer` | `sidebar/sidebar-container.tsx` | Responsive sidebar wrapper: full (desktop), condensed (tablet), overlay (mobile) |
| `SidebarItem` | `sidebar/sidebar-item.tsx` | Navigation item: icon + label + optional colorDot, renders as `Link` (if `to`) or `Button`, supports condensed mode |
| `SidebarSection` | `sidebar/sidebar-section.tsx` | Grouped section with optional title, supports condensed mode |
| `DroppableSidebarItem` | `sidebar/droppable-sidebar-item.tsx` | `SidebarItem` wrapped with `useListDropTarget` for drag-and-drop onto sidebar items |

---

## Providers

| Provider | File | Description |
|----------|------|-------------|
| `SSEProvider` | `sse-provider/sse-provider.tsx` | Listens to SSE events and shows toast notifications |
| `UploadProvider` | `upload-provider/upload-provider.tsx` | Manages file upload state with progress tracking UI |
| `useUpload` | `upload-provider/upload-provider.tsx` | Hook to create/track uploads with progress callbacks |
| `uploadWithProgress` | `upload-provider/upload-with-progress.tsx` | XHR helper for file uploads with progress events |
| `UploadContainer` | `upload-provider/upload-container.tsx` | Floating upload progress cards (bottom-right) |
| `LabelProvider` | `labels/label-provider.tsx` | Context provider for label CRUD operations with toast feedback |
| `useLabels` | `labels/label-provider.tsx` | Hook to access addLabel, updateLabel, deleteLabel |

---

## User Components

| Component | File | Description |
|-----------|------|-------------|
| `UserAvatar` | `user-avatar.tsx` | Avatar with auto-fetch from API when no imageUrl, DigiDoodle fallback, sm/md/lg sizes |
| `UserPublicAvatar` | `user-public-avatar.tsx` | `UserAvatar` wrapped in tooltip showing user name, fetches user data by email |
| `UserItem` | `user-item.tsx` | Avatar + name + email row, optional `mailLink`, `label`, and `autoFetch` (fetches name/email/avatar from API by email) |
| `UserPublicItem` | `user-item.tsx` | Thin wrapper around `UserItem` with `autoFetch` enabled — resolves user data from email |

---

## Labels

| Component | File | Description |
|-----------|------|-------------|
| `LabelDialog` | `labels/label-dialog.tsx` | Create/edit/delete label dialog with color picker and form validation |
| `LabelFilterHeader` | `labels/label-filter-header.tsx` | Header bar showing active label name + color dot + edit button |
| `LabelManager` | `labels/label-manager.tsx` | Sidebar label list with add/edit buttons, uses `SidebarItem` or `DroppableSidebarItem` per label |
| `LabelAssignSubMenu` | `labels/label-assign-sub-menu.tsx` | Dropdown sub-menu for toggling labels: checkmark if all selected items have the label, dot if only some (`partialLabelIds`) |

---

## Contacts

| Component | File | Description |
|-----------|------|-------------|
| `ContactAutosuggest` | `contacts/contact-autosuggest.tsx` | Input with dropdown suggestions from contacts, supports append mode for email fields |
| `useContactSuggestions` | `contacts/use-contact-suggestions.ts` | Hook that filters contacts by query, returns matching name/email suggestions |

---

## Context Menu

| Component | File | Description |
|-----------|------|-------------|
| `useContextMenu` | `context-menu/use-context-menu.ts` | Hook for right-click context menus: tracks item, position ({x, y}), isOpen, handleContextMenu, close |
| `ContextMenuAnchor` | `context-menu/context-menu-anchor.tsx` | Wrapper that renders hidden DropdownMenuTrigger and positions DropdownMenuContent at cursor |

---

## Hooks

| Hook | File | Description |
|------|------|-------------|
| `useKeyboardListNavigation` | `hooks/use-keyboard-list-navigation.ts` | Keyboard navigation for lists: ArrowUp/Down moves highlight, Enter/Space activates, Home/End jumps, optional `selection` for Shift+Arrow range select / Ctrl+A / Escape. Uses `shouldNotify` to control when `onSelect` fires on arrow keys. Auto-focuses container on mount. |
| `useListSelection` | `hooks/use-list-selection.ts` | Multi-select state: `select` (single), `toggle` (Ctrl+click), `selectRange` (Shift+click with anchor ref), `selectAll`, `clearSelection`, `handleItemClick` (dispatches based on modifier keys). Returns `selectedIds`, `selectedItems`, `isSelected`, `hasSelection`. |
| `useListDrag` | `hooks/use-list-drag.ts` | Selection-aware drag source: auto-selects dragged item if not already selected, sets `application/eigen-drag` MIME data with type + ids, shows count badge for multi-drag |
| `useListDropTarget` | `hooks/use-list-drop-target.ts` | Generic drop target: accepts `application/eigen-drag` data filtered by `acceptTypes`, provides `isOver` state + `getDropProps()` |

---

## Common UI

| Component | File | Description |
|-----------|------|-------------|
| `SearchBar` | `search-bar/search-bar.tsx` | Search input with icon, configurable max-width (xs/sm/md/lg/xl/full) and placeholder |
| `TooltipButton` | `tooltip-button/tooltip-button.tsx` | Icon button wrapped in tooltip, configurable size/variant/className, optional `label` text |
| `DeleteDialog` | `delete/delete-dialog.tsx` | Confirmation dialog for destructive actions with cancel/delete buttons |
| `ShadowContent` | `shadow-content.tsx` | Renders HTML/text inside a closed Shadow DOM for style isolation (used for email bodies) |
| `DocumentModeButton` | `toolbar/DocumentModeButton.tsx` | Read-only/editing mode indicator using `TooltipButton` with Eye/Pencil icon |

---

## Media

| Component | File | Description |
|-----------|------|-------------|
| `ResizableMedia` | `media/resizable-media.tsx` | Image with drag-to-resize handles, alignment controls, and style picker |
| `MediaStylePicker` | `media/media-style-picker.tsx` | Popover picker for border-radius, shadow, and border options |

---

## Branding & Auth

| Component | File | Description |
|-----------|------|-------------|
| `AppLogo` | `app-logo.tsx` | `eigen|appname>` logo with expandable app switcher on click |
| `EigenLoader` | `eigen-loader.tsx` | Animated chevron loading indicator with delayed start |
| `LoadingScreen` | `loading-screen.tsx` | Full-screen centered `EigenLoader` |
| `LoginPage` | `loginpage.tsx` | Login form with email/password, uses `useAuth` |
| `createLoginRouteOptions` | `login-route.tsx` | Factory for TanStack Router login route config with redirect |

---

## Storage

| Component | File | Description |
|-----------|------|-------------|
| `StorageUsage` | `home/usage.tsx` | Storage progress bar with expandable per-domain breakdown |

---

## Drive (domain-specific shared)

The `drive/` subdirectory contains shared Drive components used by the Drive, Docs, and Stickies apps:

| Component | File | Description |
|-----------|------|-------------|
| `DriveLayout` | `drive/drive-layout.tsx` | Two-column drive layout: file list + detail panel; manages dialogs, toolbar, and detail visibility based on `pid` |
| `DriveTable` | `drive/drive-table.tsx` | File/folder table with keyboard navigation (`useKeyboardListNavigation`), multi-selection (`useListSelection`), drag-and-drop (`useListDrag`), context menu, and parent `..` row |
| `DriveList` | `drive/drive-list.tsx` | List wrapper around `DriveTable`: adds toolbar, breadcrumb, drag-to-upload zone, empty state, and row click logic (select on first click, activate on second) |
| `DriveDetail` | `drive/drive-detail.tsx` | File detail panel with metadata, sharing summary, access list, and file preview |
| `DriveAccessDialog` | `drive/drive-access-dialog.tsx` | Share dialog for managing file/folder access |
| `DriveAccessList` | `drive/drive-access-list.tsx` | Read-only list of users with access to a file |
| `DriveAccessListEdit` | `drive/drive-access-list-edit.tsx` | Editable access list with role dropdowns, contact autosuggest, and public access toggle |
| `DriveCreateDoc` | `drive/drive-create-doc.tsx` | Create new document dialog |
| `DriveCreateFolder` | `drive/drive-create-folder.tsx` | Create folder dialog |
| `DriveCreateFolderItem` | `drive/drive-create-folder-item.tsx` | Inline folder creation input |
| `DriveCreateStickies` | `drive/drive-create-stickies.tsx` | Create new stickies board dialog |
| `DriveDeleteItem` | `drive/drive-delete-item.tsx` | Delete confirmation for drive items with post-action callback |
| `DriveRenameItem` | `drive/drive-rename-item.tsx` | Rename dialog for drive items |
| `DriveShareSummary` | `drive/drive-share-summary.tsx` | Sharing status badge/summary |
| `DriveUploadFiles` | `drive/drive-upload-files.tsx` | File upload with drag-and-drop |
| `FileUpload` | `drive/file-upload.tsx` | Low-level file upload component |
| `fileIconHelper` | `drive/file-icon-helper.tsx` | Maps MIME types and file types to Lucide icons |
| `useDriveDialogs` | `drive/use-drive-dialogs.ts` | Hook managing open/close state for all drive dialogs |
| `FilePreview` | `drive/file-preview.tsx` | Lightbox overlay for images, videos, and PDFs with Escape-to-close |
