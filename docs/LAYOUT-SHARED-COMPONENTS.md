# Shared UI Components

All shared components live in `packages/ui/src/components/layout/`. This document provides a quick reference.

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

## Sidebar

| Component              | File                                 | Description                                                                                                |
|------------------------|--------------------------------------|------------------------------------------------------------------------------------------------------------|
| `SidebarContainer`     | `sidebar/sidebar-container.tsx`      | Responsive sidebar wrapper: full (desktop), condensed (tablet), overlay (mobile)                           |
| `SidebarItem`          | `sidebar/sidebar-item.tsx`           | Navigation item: icon + label + optional colorDot. Renders as `Link` or `Button`. Supports condensed mode. |
| `SidebarSection`       | `sidebar/sidebar-section.tsx`        | Grouped section with optional title, supports condensed mode                                               |
| `DroppableSidebarItem` | `sidebar/droppable-sidebar-item.tsx` | `SidebarItem` wrapped with `useListDropTarget` for drag-and-drop onto sidebar items                        |

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

## User Components

| Component          | File                     | Description                                                                             |
|--------------------|--------------------------|-----------------------------------------------------------------------------------------|
| `UserAvatar`       | `user-avatar.tsx`        | Avatar with auto-fetch from API when no imageUrl. DigiDoodle fallback. sm/md/lg sizes, with optional tooltip |
| `UserItem`         | `user-item.tsx`          | Avatar + name + email row. Optional `mailLink`, `label`, and `autoFetch`                |

## Labels

| Component            | File                               | Description                                                                            |
|----------------------|------------------------------------|----------------------------------------------------------------------------------------|
| `LabelDialog`        | `labels/label-dialog.tsx`          | Create/edit/delete label dialog with color picker and form validation                  |
| `LabelFilterHeader`  | `labels/label-filter-header.tsx`   | Header bar showing active label name + color dot + edit button                         |
| `LabelManager`       | `labels/label-manager.tsx`         | Sidebar label list with add/edit buttons. Uses `SidebarItem` or `DroppableSidebarItem` |
| `LabelAssignSubMenu` | `labels/label-assign-sub-menu.tsx` | Dropdown sub-menu for toggling labels on items                                         |

## Contacts

| Component               | File                                  | Description                                                                          |
|-------------------------|---------------------------------------|--------------------------------------------------------------------------------------|
| `ContactAutosuggest`    | `contacts/contact-autosuggest.tsx`    | Input with dropdown suggestions from contacts. Supports append mode for email fields |
| `useContactSuggestions` | `contacts/use-contact-suggestions.ts` | Hook that filters contacts by query. Returns matching name/email suggestions         |

## Context Menu

| Component | File | Description |
|-----------|------|-------------|
| `useContextMenu` | `context-menu/use-context-menu.ts` | Hook for right-click context menus: tracks item, position ({x, y}), isOpen, handleContextMenu, close |
| `ContextMenuAnchor` | `context-menu/context-menu-anchor.tsx` | Wrapper that renders hidden DropdownMenuTrigger and positions DropdownMenuContent at cursor |

## Hooks

| Hook                        | File                                    | Description                                                  |
|-----------------------------|-----------------------------------------|--------------------------------------------------------------|
| `useKeyboardListNavigation` | `hooks/use-keyboard-list-navigation.ts` | Keyboard navigation for lists (Arrow keys, Home/End, Enter). |
| `useListSelection`          | `hooks/use-list-selection.ts`           | Multi-select state (Shift/Ctrl+click).                       |
| `useListDrag`               | `hooks/use-list-drag.ts`                | Selection-aware drag source.                                 |
| `useListDropTarget`         | `hooks/use-list-drop-target.ts`         | Generic drop target.                                         |
| `useMobile`                 | `hooks/use-mobile.ts`                   | Mobile detection hook.                                       |

## Common UI

| Component            | File                                | Description                                                                              |
|----------------------|-------------------------------------|------------------------------------------------------------------------------------------|
| `SearchBar`          | `search-bar/search-bar.tsx`         | Search input with icon, configurable max-width and placeholder                           |
| `TooltipButton`      | `toolbar/tooltip-button.tsx`        | Icon button wrapped in tooltip                                                           |
| `TooltipToggle`      | `toolbar/tooltip-toggle.tsx`        | Toggle button wrapped in tooltip                                                           |
| `DeleteDialog`       | `delete/delete-dialog.tsx`          | Confirmation dialog for destructive actions with cancel/delete buttons                   |
| `ShadowContent`      | `shadow-content.tsx`                | Renders HTML/text inside a closed Shadow DOM for style isolation (used for email bodies) |
| `DocumentModeButton` | `toolbar/document-mode-button.tsx`  | Read-only/editing mode indicator using `TooltipButton` with Eye/Pencil icon              |

## Branding & Auth

| Component                 | File                 | Description                                                  |
|---------------------------|----------------------|--------------------------------------------------------------|
| `AppLogo`                 | `app/app-logo.tsx`       | `eigen\|appname>` logo with expandable app switcher on click |
| `EigenLoader`             | `braket/eigen-loader.tsx`   | Animated chevron loading indicator with delayed start        |
| `LoadingScreen`           | `pages/loading-screen.tsx` | Full-screen centered `EigenLoader`                           |
| `Bra`                     | `braket/bra.tsx`           | SVG `〈` bracket for branding                                 |
| `Ket`                     | `braket/ket.tsx`           | SVG `〉` bracket for branding                                 |
| `Bar`                     | `braket/bar.tsx`           | SVG `\|` bar for branding                                    |
| `LoginPage`               | `pages/loginpage.tsx`      | Login form with email/password, uses `useAuth`               |
| `createLoginRouteOptions` | `pages/login-route.tsx`    | Factory for TanStack Router login route config with redirect |

## Storage

| Component | File | Description |
|-----------|------|-------------|
| `StorageUsage` | `home/usage.tsx` | Storage progress bar with expandable per-domain breakdown |

## Chat

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `ChatMessageInput`      | `chat/chat-message-input.tsx`        | Chat message input component with slash commands and player suggestions                   |
| `ChatMessageList`       | `chat/chat-message-list.tsx`         | List of chat messages with auto-scroll and keyboard navigation                            |
| `ChatPlayerSuggest`     | `chat/chat-player-suggest.tsx`       | Autosuggest for player mentions in chat                                                  |
| `ChatSlashSuggest`      | `chat/chat-slash-suggest.tsx`        | Autosuggest for slash commands in chat                                                   |
| `chat-utils`            | `chat/chat-utils.ts`                 | Utility functions for chat processing and formatting                                      |

## Toolbar

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `Toolbar`               | `toolbar/toolbar.tsx`                | Base toolbar component                                                                   |
| `TooltipButton`         | `toolbar/tooltip-button.tsx`         | Icon button wrapped in tooltip                                                           |
| `TooltipToggle`         | `toolbar/tooltip-toggle.tsx`         | Toggle button wrapped in tooltip                                                           |
| `DocumentModeButton`    | `toolbar/document-mode-button.tsx`   | Read-only/editing mode indicator using `TooltipButton` with Eye/Pencil icon              |

## Media

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `ColorPicker`           | `media/color-picker.tsx`             | Color picker popover with preset colors and hex input                                    |
| `ImageResizeHandles`    | `media/image-resize-handles.tsx`     | Shared resize handle overlay for draggable/resizable images (used in docs and slides)    |

## Collab

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `RevisionHistory`       | `collab/revision-history.tsx`        | History panel showing Yjs document revisions                                             |

## Properties Panel

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `PropertiesPanel`       | `properties-panel/properties-panel.tsx` | Right-side panel container with scroll area for property controls                        |
| `PropertySection`       | `properties-panel/properties-panel.tsx` | Section within properties panel with title and spacing for grouped controls              |
| `PropertyRow`           | `properties-panel/properties-panel.tsx` | Row within property section with label and content area for form controls                 |

## Preview Provider

| Component/Hook          | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `PreviewProvider`       | `preview-provider/preview-provider.tsx` | Context provider for file preview functionality (images, videos, PDFs)                  |
| `usePreview`            | `preview-provider/preview-provider.tsx` | Hook to access preview functions: openPreview, updatePreview, closePreview, isPreviewOpen |

## Drive (domain-specific shared)

The `drive/` subdirectory contains shared Drive components used by the Drive, Docs, and Stickies apps:

| Component               | File                                 | Description                                                                              |
|-------------------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `DriveLayout`           | `drive/drive-layout.tsx`             | Two-column drive layout: file list + detail panel                                        |
| `DriveTable`            | `drive/drive-table.tsx`              | File/folder table with keyboard navigation, multi-selection, drag-and-drop, context menu |
| `DriveList`             | `drive/drive-list.tsx`               | List wrapper around `DriveTable`                                                         |
| `DriveDetail`           | `drive/drive-detail.tsx`             | File detail panel with metadata, sharing summary, access list, and file preview          |
| `DriveAccessDialog`     | `drive/drive-access-dialog.tsx`      | Share dialog for managing file/folder access                                             |
| `DriveAccessList`       | `drive/drive-access-list.tsx`        | Read-only list of users with access to a file                                            |
| `DriveAccessListEdit`   | `drive/drive-access-list-edit.tsx`   | Editable access list with role dropdowns, contact autosuggest, and public access toggle  |
| `DriveCreateChat`      | `drive/drive-create-chat.tsx`        | Create new chat dialog                                                               |
| `DriveCreateDoc`        | `drive/drive-create-doc.tsx`         | Create new document dialog                                                               |
| `DriveCreateFolder`     | `drive/drive-create-folder.tsx`      | Create folder dialog                                                                     |
| `DriveCreateFolderItem` | `drive/drive-create-folder-item.tsx` | Inline folder creation input                                                             |
| `DriveCreateSheets`   | `drive/drive-create-sheets.tsx`    | Create new sheets dialog                                                         |
| `DriveCreateSlides`   | `drive/drive-create-slides.tsx`    | Create new slides dialog                                                         |
| `DriveCreateStickies` | `drive/drive-create-stickies.tsx`    | Create new stickies board dialog                                                         |
| `DriveDeleteItem`       | `drive/drive-delete-item.tsx`        | Delete confirmation for drive items with post-action callback                            |
| `DriveRenameItem`       | `drive/drive-rename-item.tsx`        | Rename dialog for drive items                                                            |
| `DriveShareSummary`     | `drive/drive-share-summary.tsx`      | Sharing status badge/summary                                                             |
| `DriveUploadFiles`      | `drive/drive-upload-files.tsx`       | File upload with drag-and-drop                                                           |
| `FileUpload`            | `drive/file-upload.tsx`              | Low-level file upload component                                                          |
| `fileIconHelper`        | `drive/file-icon-helper.tsx`         | Maps MIME types and file types to Lucide icons                                           |
| `useDriveDialogs`       | `drive/use-drive-dialogs.ts`         | Hook managing open/close state for all drive dialogs                                     |
| `FilePreview`           | `drive/file-preview.tsx`             | Lightbox overlay for images, videos, and PDFs with Escape-to-close                       |
