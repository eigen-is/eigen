# Drive Picker Components Design

Two shared picker components for selecting files from Drive and choosing a destination location on Drive.

## Overview

| Component | Purpose | Use Cases |
|-----------|---------|-----------|
| `DriveFilePicker` | Select a file from drive (attach) | Mail compose attach, chat attach, docs insert image |
| `DriveLocationPicker` | Choose a folder destination | Create new doc, save attachment to drive, move files |

Both share a common `DriveBrowser` primitive that handles mount selection and folder navigation.

## Architecture

```
packages/ui/src/components/layout/drive/
├── drive-browser.tsx          # Shared core: mount list + folder browser + breadcrumb
├── drive-file-picker.tsx      # Dialog wrapping DriveBrowser in "file" mode
├── drive-location-picker.tsx  # Dialog wrapping DriveBrowser in "folder" mode
└── drive-mount-list.tsx       # Standalone selectable mount list (left column)
```

### Composition

```
DriveFilePicker (Dialog)
├── DriveBrowser (mode="file", mimeFilter?)
│   ├── DriveMountList (left column)
│   └── Folder content list (center — uses DriveTable with reduced features)
└── Footer: [Upload from device]  [Cancel] [Select]

DriveLocationPicker (Dialog)
├── Name field (top, when mode is "create" or "save-as")
├── DriveBrowser (mode="folder") — collapsible in "create" mode
│   ├── DriveMountList (left column)
│   └── Folder list (center — folders only, with "New folder" button)
└── Footer: [Download instead?]  [Cancel] [Confirm]
```

## Component APIs

### DriveBrowser

The shared browsing primitive. Manages mount selection, folder navigation, and breadcrumbs.

```tsx
type DriveBrowserProps = {
  ownerId: string
  mode: 'file' | 'folder'
  mimeFilter?: string[]
  selectedId?: string | null
  onSelect: (path: DrivePath) => void
  onConfirm?: (path: DrivePath) => void
  onFolderChange?: (folder: DrivePath, mountId: string) => void
  defaultMountId?: string
  defaultFolderId?: string
  showNewFolder?: boolean
  className?: string
}
```

### DriveFilePicker

Dialog for attaching files from drive.

```tsx
type DriveFilePickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (paths: DrivePath[]) => void
  onUploadFromDevice?: () => void
  mimeFilter?: string[]
  title?: string              // default: "Attach file"
  multiple?: boolean          // default: false
}
```

### DriveLocationPicker

Dialog for choosing a save/create/move destination.

```tsx
type DriveLocationPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'save-as' | 'folder'
  onConfirm: (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => void
  onDownloadInstead?: () => void
  title?: string
  defaultName?: string
  defaultMountId?: string
  defaultFolderId?: string
  nameLabel?: string          // "Save as:" / "Name"
  confirmLabel?: string       // "Create" / "Save here" / "Move here"
}
```

### DriveMountList

Standalone selectable mount list for the left column.

```tsx
type DriveMountListProps = {
  ownerId: string
  activeMountId: string
  activeOwnerId: string
  onMountSelect: (ownerId: string, mountId: string) => void
}
```

Uses `useRootFolder` (personal mount) and `useMyTeams` (team mounts).

## Location Picker Modes

| Mode | Folder browser | Name field | Use cases |
|------|---------------|------------|-----------|
| `create` | Collapsed breadcrumb, expandable | Primary, auto-focused | New doc, new stickies, new slides |
| `save-as` | Always expanded | Top, pre-filled | Save single attachment to drive |
| `folder` | Always expanded | Hidden | Save multiple attachments, move files |

### Layout (top → bottom, consistent across modes)

1. Dialog title
2. Name field (when applicable)
3. Folder browser (collapsible in create mode)
4. Footer actions

## Behavior

### Navigation

- Single click folder → navigate into it
- Single click file → select it (file mode) / no-op (folder mode)
- Double click file → select + confirm (file mode)
- Breadcrumb segments clickable to navigate up
- Mount click → navigate to mount root

### File Picker: Mime Filtering

- Non-matching files shown at 0.35 opacity, not clickable
- Folders always navigable regardless of filter
- Filter shown as a chip in the breadcrumb bar (set by caller, non-removable)

### Location Picker: Folder-Only View

- Only folders shown (files hidden entirely)
- Current folder = selected destination
- "New folder" button in breadcrumb bar + right-click context menu
- After creating folder, auto-navigate into it (becomes selection)

### Create Mode: Collapse/Expand

- Default: collapsed — shows name input + clickable breadcrumb with "Change" affordance
- Click "Change" → expands full DriveBrowser below name field
- Selecting a folder updates the breadcrumb display
- Smooth height transition between states

### Footer Pattern (Option C)

The "local" alternative lives in the footer as a secondary button:
- File picker: `[Upload from device]` (left) — triggers native file input via callback
- Location picker: `[Download instead]` (left) — triggers download via callback

This avoids tabs: the drive browser gets the full dialog space, local action is one click.

### Keyboard

- Arrow keys: navigate list
- Enter: confirm selection (file picker) / open folder (both)
- Escape: close dialog

## Reused Components

| Existing | Used For |
|----------|----------|
| `DriveTable` | File list in file picker (props: `onItemClick`, `onItemOpen`, `getFileIcon`, `sortFn` only — no share/delete/rename/move/export context menu) |
| `getFileIcon` | Icons for all file types |
| `useFolderContent` | Loading folder contents |
| `useRootFolder` | Getting mount root path |
| `useBreadcrumb` | Path display |
| `useMyTeams` | Team mounts in mount list |
| `useCreateFolder` | New folder in location picker |
| `DriveCreateItemDialog` | Pattern for new-folder dialog |
| `Dialog` / `DialogContent` | Dialog shell |
| `Breadcrumb*` components | Breadcrumb rendering |
| `defaultDriveSort` | Folders first, alphabetical |

## New Components Needed

| Component | Why |
|-----------|-----|
| `DriveMountList` | Sidebar uses `SidebarItem` (router-linked). Pickers need standalone selectable list |
| `DriveBrowser` | Composition of mount list + folder browser + state management |
| Folder-only table variant | DriveTable shows all files; location picker needs folders only |

## Dialog Sizing

- File picker: ~700×480px (`sm:max-w-2xl`)
- Location picker (expanded): ~600×450px (`sm:max-w-xl`)
- Location picker (create, collapsed): ~400px height, auto-expands

## Future Extensions

- "Recent files" as a virtual mount in the left column
- Multi-select in file picker
- Search within picker
- Drag-and-drop from drive app into picker
