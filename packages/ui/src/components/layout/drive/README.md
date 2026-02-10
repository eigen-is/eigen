# Drive UI Components

Google Drive-like file management components for Eigen apps. Built with TypeScript, Tailwind CSS, and shadcn/ui.

## Architecture

```
DriveLayout (orchestrator)
├── DriveList (toolbar + breadcrumb + drag-drop overlay)
│   └── DriveTable (table rows, keyboard nav, context menu)
├── DriveDetail (file preview panel)
└── Dialogs (create, delete, rename, share, upload)
```

## Hooks

### `useDriveDialogs`

Manages state for all 7 dialogs (create folder, create doc, create stickies, delete, rename, share, upload).

```tsx
const dialogs = useDriveDialogs();
dialogs.createFolder.openDialog();
dialogs.delete.openDialog(path);
```

### `useTableKeyboard`

Keyboard navigation for the file table (arrows, Enter, Delete, Home/End).

### `useTableDragDrop`

Drag-and-drop to move files between folders.

## Key Components

### `DriveLayout`

Main entry point. Handles dialogs, actions, and layout (mobile/desktop).

```tsx
<DriveLayout
  ownerId={userId}
  mountId={mountId}
  folderContents={items}
  isLoading={loading}
  onRowSelect={handleSelect}
  onRowActivate={handleOpen}
  onBackToList={goBack}
  allowCreateFolder
  allowDelete
  allowShare
  allowUpload
/>
```

### `DriveList`

File browser with toolbar, breadcrumb, and external file drop zone.

### `DriveTable`

Table with sorting, keyboard navigation, context menu, and internal drag-drop for moving items.

### `DriveDetail`

File/folder details: metadata, preview (images, video, audio), and access list.

### Dialogs

- `DriveCreateFolder`, `DriveCreateDoc`, `DriveCreateStickies`
- `DriveDeleteItem`, `DriveRenameItem`
- `DriveAccessDialog` (sharing/ACL)
- `DriveUploadFiles`

## File Index

**Components:**

- `drive-layout.tsx` - Main orchestrator
- `drive-list.tsx` - File list with toolbar
- `drive-table.tsx` - Table with keyboard/drag-drop
- `drive-detail.tsx` - File preview panel
- `drive-create-*.tsx` - Creation dialogs
- `drive-delete-item.tsx` - Delete confirmation
- `drive-rename-item.tsx` - Rename dialog
- `drive-access-*.tsx` - Sharing/ACL components
- `drive-upload-files.tsx` - Upload dialog

**Hooks:**

- `use-drive-dialogs.ts` - Dialog state management
- `use-table-keyboard.ts` - Keyboard navigation
- `use-table-drag-drop.ts` - Drag-drop for moving items

**Helpers:**

- `file-icon-helper.tsx` - File type icons
- `file-upload.tsx` - Upload utilities
