# Shared UI Components

All shared components live in `packages/ui/src/components/layout/`. This document provides a quick reference.

---

## Core Layout

| Component | File | Description |
|-----------|------|-------------|
| `EigenApp` | `eigen-app.tsx` | Root provider wrapper: QueryClient, AuthProvider, SSEProvider, UploadProvider, TooltipProvider, Toaster |
| `AppShell` | `app-shell.tsx` | App shell with Topbar, SecondaryToolbar, sidebar, and main content area |
| `LayoutContext` | `layout-context.tsx` | Context for layout state: sidebar, columns, mobile detection, toolbar slots |
| `useLayout` | `layout-context.tsx` | Hook to access layout context (isMobile, isTablet, activeColumn, etc.) |
| `useApp` | `layout-context.tsx` | Hook to access/set appName |
| `useSidebar` | `layout-context.tsx` | Hook to access/set sidebarOpen state |
| `ColumnLayout` | `column-layout.tsx` | Flex row container for columns with mobile column switching |
| `Column` | `column-layout.tsx` | Single column with width, toolbar, onBack support |
| `Topbar` | `topbar.tsx` | Blue header bar: app logo, toolbar slots (desktop), user dropdown |
| `SecondaryToolbar` | `secondary-toolbar.tsx` | Mobile-only bar below topbar: back button + active column toolbar |

See `docs/LAYOUT.md` for detailed architecture documentation.

---

## Sidebar

| Component | File | Description |
|-----------|------|-------------|
| `SidebarContainer` | `sidebar/sidebar-container.tsx` | Responsive sidebar wrapper: full/condensed on desktop, sheet overlay on mobile |
| `SidebarItem` | `sidebar/sidebar-item.tsx` | Navigation item: icon + label, renders as `Link` (if `to`) or `Button` |
| `SidebarSection` | `sidebar/sidebar-section.tsx` | Grouped section with optional title, supports condensed mode |

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
| `UserAvatar` | `user-avatar.tsx` | Avatar with auto-fetch from API, DigiDoodle fallback, size variants |
| `UserPublicAvatar` | `user-public-avatar.tsx` | `UserAvatar` wrapped in tooltip showing user name, fetches user data by email |
| `UserItem` | `user-item.tsx` | Avatar + name + email row, optional mail link and label |
| `UserPublicItem` | `user-item.tsx` | Like `UserItem` but fetches user data from API by email |

---

## Labels

| Component | File | Description |
|-----------|------|-------------|
| `LabelDialog` | `labels/label-dialog.tsx` | Create/edit/delete label dialog with color picker |
| `LabelFilterHeader` | `labels/label-filter-header.tsx` | Header bar showing active label name + color dot + edit button |
| `LabelManager` | `labels/label-manager.tsx` | Sidebar label list with add/edit, uses `SidebarItem` for each label |
| `LabelAssignSubMenu` | `labels/label-assign-sub-menu.tsx` | Dropdown sub-menu for toggling labels on an item, shows checkmarks for assigned labels |

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
| `useContextMenu` | `context-menu/use-context-menu.ts` | Hook for right-click context menus with position tracking and open/close state |
| `ContextMenuAnchor` | `context-menu/context-menu-anchor.tsx` | Wrapper that renders hidden DropdownMenuTrigger and positions DropdownMenuContent |

---

## Hooks

| Hook | File | Description |
|------|------|-------------|
| `useKeyboardListNavigation` | `hooks/use-keyboard-list-navigation.ts` | Hook for keyboard navigation in selectable lists (ArrowUp/Down, Enter, Home/End) with scroll-into-view |

---

## Common UI

| Component | File | Description |
|-----------|------|-------------|
| `SearchBar` | `search-bar/search-bar.tsx` | Search input with icon, configurable max-width and placeholder |
| `TooltipButton` | `tooltip-button/tooltip-button.tsx` | Icon button (`h-8 w-8`, ghost variant) wrapped in tooltip |
| `DeleteDialog` | `delete/delete-dialog.tsx` | Confirmation dialog for destructive actions with cancel/delete buttons |
| `ShadowContent` | `shadow-content.tsx` | Renders HTML/text inside a Shadow DOM for style isolation (used for email bodies) |
| `DocumentModeButton` | `toolbar/DocumentModeButton.tsx` | Read-only/editing mode indicator button with tooltip |

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
| `EigenLoader` | `eigen-loader.tsx` | Animated chevron loading indicator |
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

The `drive/` subdirectory contains shared Drive components used by both the Drive and Docs apps:

| Component | File | Description |
|-----------|------|-------------|
| `DriveLayout` | `drive/drive-layout.tsx` | Two-column drive layout with file browser and detail panel |
| `DriveTable` | `drive/drive-table.tsx` | File/folder table with selection, sorting, drag-drop; uses shared `useKeyboardListNavigation` and `useContextMenu` |
| `DriveList` | `drive/drive-list.tsx` | Grid/list view for drive items |
| `DriveDetail` | `drive/drive-detail.tsx` | File detail panel with metadata, sharing, actions |
| `DriveAccessDialog` | `drive/drive-access-dialog.tsx` | Share dialog for managing file/folder access |
| `DriveAccessList` | `drive/drive-access-list.tsx` | List of users with access to a file |
| `DriveAccessListEdit` | `drive/drive-access-list-edit.tsx` | Editable access list with role dropdowns |
| `DriveCreateDoc` | `drive/drive-create-doc.tsx` | Create new document dialog |
| `DriveCreateFolder` | `drive/drive-create-folder.tsx` | Create folder dialog |
| `DriveCreateFolderItem` | `drive/drive-create-folder-item.tsx` | Inline folder creation input |
| `DriveCreateStickies` | `drive/drive-create-stickies.tsx` | Create new stickies board dialog |
| `DriveDeleteItem` | `drive/drive-delete-item.tsx` | Delete confirmation for drive items |
| `DriveRenameItem` | `drive/drive-rename-item.tsx` | Rename dialog for drive items |
| `DriveShareSummary` | `drive/drive-share-summary.tsx` | Sharing status badge/summary |
| `DriveUploadFiles` | `drive/drive-upload-files.tsx` | File upload with drag-and-drop |
| `FileUpload` | `drive/file-upload.tsx` | Low-level file upload component |
| `fileIconHelper` | `drive/file-icon-helper.tsx` | Maps file types to icons |
| `useDriveDialogs` | `drive/use-drive-dialogs.ts` | Hook managing open/close state for all drive dialogs |
| `useTableDragDrop` | `drive/use-table-drag-drop.ts` | Hook for drag-and-drop in file tables |
| `FilePreview` | `drive/file-preview.tsx` | Lightbox overlay for images, videos, and PDFs with Escape-to-close |

---

## Redundancy Notes

1. **SearchBar now used by apps** - `SearchBar` is now used by both Mail and Contacts apps, replacing hand-rolled search inputs.

2. **DocumentModeButton uses inline Tooltip** — `DocumentModeButton` manually wraps `Button` in `Tooltip` instead of using `TooltipButton`. It also has an empty `onClick` handler.

3. **UserPublicItem duplicates UserItem** — `UserPublicItem` in `user-item.tsx` is essentially `UserItem` with a `useAvatar` fetch. Consider merging into `UserItem` with an optional `autoFetch` prop.

4. **MailLink in email-detail** — `MailLink` is exported from `email-detail.tsx` (mail app) but creates hardcoded mail compose URLs. If other apps need this pattern, it should be shared.

5. **Dutch comments** — Cleaned up in contacts app. Check `eigen-loader.tsx` if any remain.

