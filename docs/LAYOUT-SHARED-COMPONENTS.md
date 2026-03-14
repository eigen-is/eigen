# Shared UI Components

> **TLDR**: Lookup reference for all shared components in `packages/ui/src/components/layout/`. Use this to find
> existing components before building new ones.

**Known issues**: Find-and-Replace dialog z-index in sheets; formula "learn more" dialog broken; tab color via context
menu needs submenu.

## Core Layout

| Component       | File                 | Description                                                            |
|-----------------|----------------------|------------------------------------------------------------------------|
| `EigenApp`      | `app/eigen-app.tsx`  | Root provider stack (QueryClient, Auth, SSE, Upload, Tooltip, Toaster) |
| `AppShell`      | `app/app-shell.tsx`  | App shell: Topbar + sidebar + content. See [LAYOUT.md](LAYOUT.md)      |
| `LayoutContext` | `layout-context.tsx` | Layout state context. Hooks: `useLayout`, `useApp`, `useSidebar`       |
| `ColumnLayout`  | `column-layout.tsx`  | Multi-column layout with mobile switching                              |
| `Column`        | `column-layout.tsx`  | Single column with toolbar slot                                        |
| `Topbar`        | `topbar.tsx`         | Blue header: app logo, user dropdown, navigation                       |

## Sidebar

| Component              | File                                 | Description                                       |
|------------------------|--------------------------------------|---------------------------------------------------|
| `SidebarContainer`     | `sidebar/sidebar-container.tsx`      | Responsive wrapper: full/condensed/overlay        |
| `SidebarItem`          | `sidebar/sidebar-item.tsx`           | Nav item: icon + label + colorDot. Link or Button |
| `SidebarSection`       | `sidebar/sidebar-section.tsx`        | Grouped section with optional title               |
| `DroppableSidebarItem` | `sidebar/droppable-sidebar-item.tsx` | SidebarItem + drop target                         |

## Providers

| Provider          | File                                    | Description                              |
|-------------------|-----------------------------------------|------------------------------------------|
| `SSEProvider`     | `sse-provider/sse-provider.tsx`         | SSE events → toast notifications         |
| `UploadProvider`  | `upload-provider/upload-provider.tsx`   | File upload state + progress UI          |
| `useUpload`       | `upload-provider/upload-provider.tsx`   | Hook for creating/tracking uploads       |
| `UploadContainer` | `upload-provider/upload-container.tsx`  | Floating upload progress cards           |
| `LabelProvider`   | `labels/label-provider.tsx`             | Label CRUD context                       |
| `useLabels`       | `labels/label-provider.tsx`             | Hook: addLabel, updateLabel, deleteLabel |
| `PreviewProvider` | `preview-provider/preview-provider.tsx` | File preview (images, videos, PDFs)      |
| `usePreview`      | `preview-provider/preview-provider.tsx` | Hook: openPreview, closePreview          |

## User Components

| Component    | File              | Description                                           |
|--------------|-------------------|-------------------------------------------------------|
| `UserAvatar` | `user-avatar.tsx` | Avatar with auto-fetch. DigiDoodle fallback. sm/md/lg |
| `UserItem`   | `user-item.tsx`   | Avatar + name + email row                             |

## Labels

| Component            | File                               | Description                                |
|----------------------|------------------------------------|--------------------------------------------|
| `LabelDialog`        | `labels/label-dialog.tsx`          | Create/edit/delete label with color picker |
| `LabelFilterHeader`  | `labels/label-filter-header.tsx`   | Active label header bar                    |
| `LabelManager`       | `labels/label-manager.tsx`         | Sidebar label list with add/edit           |
| `LabelAssignSubMenu` | `labels/label-assign-sub-menu.tsx` | Dropdown sub-menu for toggling labels      |

## Contacts

| Component               | File                                  | Description                             |
|-------------------------|---------------------------------------|-----------------------------------------|
| `ContactAutosuggest`    | `contacts/contact-autosuggest.tsx`    | Input with contact suggestions dropdown |
| `useContactSuggestions` | `contacts/use-contact-suggestions.ts` | Hook: filter contacts by query          |

## Context Menu

| Component           | File                                   | Description                                         |
|---------------------|----------------------------------------|-----------------------------------------------------|
| `useContextMenu`    | `context-menu/use-context-menu.ts`     | Right-click menu state (item, position, open/close) |
| `ContextMenuAnchor` | `context-menu/context-menu-anchor.tsx` | Positions DropdownMenu at cursor                    |

## List Hooks

| Hook                        | File                                    | Description                     |
|-----------------------------|-----------------------------------------|---------------------------------|
| `useKeyboardListNavigation` | `hooks/use-keyboard-list-navigation.ts` | Arrow keys, Home/End, Enter     |
| `useListSelection`          | `hooks/use-list-selection.ts`           | Multi-select (Shift/Ctrl+click) |
| `useListDrag`               | `hooks/use-list-drag.ts`                | Selection-aware drag source     |
| `useListDropTarget`         | `hooks/use-list-drop-target.ts`         | Generic drop target             |
| `useMobile`                 | `hooks/use-mobile.ts`                   | Mobile detection                |

See [LAYOUT-UI-LIST.md](LAYOUT-UI-LIST.md) for full list integration patterns.

## Common UI

| Component            | File                               | Description                                   |
|----------------------|------------------------------------|-----------------------------------------------|
| `SearchBar`          | `search-bar/search-bar.tsx`        | Search input with icon                        |
| `TooltipButton`      | `toolbar/tooltip-button.tsx`       | Icon button + tooltip                         |
| `TooltipToggle`      | `toolbar/tooltip-toggle.tsx`       | Toggle button + tooltip                       |
| `Toolbar`            | `toolbar/toolbar.tsx`              | Base toolbar component                        |
| `DocumentModeButton` | `toolbar/document-mode-button.tsx` | Read-only/editing mode toggle                 |
| `DeleteDialog`       | `delete/delete-dialog.tsx`         | Confirmation dialog for destructive actions   |
| `ShadowContent`      | `shadow-content.tsx`               | Shadow DOM for style isolation (email bodies) |
| `ColorPicker`        | `media/color-picker.tsx`           | Color picker popover                          |
| `ImageResizeHandles` | `media/image-resize-handles.tsx`   | Resize handles (docs + slides)                |
| `RevisionHistory`    | `collab/revision-history.tsx`      | Yjs document revision panel                   |

## Properties Panel

| Component         | File                                    | Description                |
|-------------------|-----------------------------------------|----------------------------|
| `PropertiesPanel` | `properties-panel/properties-panel.tsx` | Right-side panel container |
| `PropertySection` | `properties-panel/properties-panel.tsx` | Section with title         |
| `PropertyRow`     | `properties-panel/properties-panel.tsx` | Row with label + content   |

## Branding & Auth

| Component                 | File                       | Description                         |
|---------------------------|----------------------------|-------------------------------------|
| `AppLogo`                 | `app/app-logo.tsx`         | `eigen\|appname>` with app switcher |
| `EigenLoader`             | `braket/eigen-loader.tsx`  | Animated loading indicator          |
| `LoadingScreen`           | `pages/loading-screen.tsx` | Full-screen loader                  |
| `LoginPage`               | `pages/loginpage.tsx`      | Login form                          |
| `createLoginRouteOptions` | `pages/login-route.tsx`    | TanStack Router login route factory |

## Storage

| Component      | File             | Description                           |
|----------------|------------------|---------------------------------------|
| `StorageUsage` | `home/usage.tsx` | Storage bar with per-domain breakdown |

## Chat

| Component           | File                           | Description                             |
|---------------------|--------------------------------|-----------------------------------------|
| `ChatMessageInput`  | `chat/chat-message-input.tsx`  | Input with slash commands + suggestions |
| `ChatMessageList`   | `chat/chat-message-list.tsx`   | Message list with auto-scroll           |
| `ChatPlayerSuggest` | `chat/chat-player-suggest.tsx` | @mention autosuggest                    |
| `ChatSlashSuggest`  | `chat/chat-slash-suggest.tsx`  | Slash command autosuggest               |

## Drive

See [LAYOUT-UI-DRIVE.md](LAYOUT-UI-DRIVE.md) for the full Drive component reference.
