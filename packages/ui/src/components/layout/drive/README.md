# Shared Drive UI Components

This directory provides a comprehensive, modular set of React components and helpers for building Google Drive-like file management experiences in Eigen apps. All components are written in TypeScript, use Tailwind CSS and shadcn/ui for styling, and are designed to work seamlessly with Bun, TanStack Query, and the Eigen monorepo architecture.

## Overview

The components here allow apps to:
- Render lists and tables of files/folders
- Show file/folder details and sharing info
- Create, upload, and delete files/folders
- Manage access control (sharing, permissions)
- Display breadcrumbs and icons
- Support drag-and-drop uploads
- Integrate with Eigen's backend and shared libraries

## Key Components

### 1. `DriveLayout`
The main orchestrator for a file manager UI. Handles state for selection, dialogs, uploads, and delegates to subcomponents.

```tsx
import { DriveLayout } from "@workspace/ui/components/layout/drive";

<DriveLayout
  ownerId={userId}
  folderContents={folderItems}
  isLoading={loading}
  error={error}
  onRowSelect={handleSelect}
  onRowActivate={handleOpen}
  onBackToList={goBack}
  onAfterAction={refresh}
  allowCreateFolder
  allowDelete
  allowShare
  allowCreateDoc
  allowUpload
  showBreadcrumb
/>
```

### 2. `DriveList` & `DriveTable`
- `DriveList`: Renders a list/table of files/folders with toolbar, breadcrumbs, and actions (create, upload, etc.).
- `DriveTable`: Low-level table with keyboard navigation, context menu, and row click handlers.

```tsx
<DriveList
  items={items}
  isLoading={loading}
  onRowSelect={select}
  onCreateFolder={openCreateFolder}
  onUploadFile={openUpload}
  ownerId={ownerId}
  pathId={pathId}
/>
```

### 3. `DriveDetail`
Shows details of a selected file/folder, including metadata, preview, and sharing info.

```tsx
<DriveDetail
  path={selectedPath}
  onDelete={deleteItem}
  onShareClick={openShare}
  onDownload={download}
  onBackClick={goBack}
/>
```

### 4. Creation Dialogs
- `DriveCreateFolder`, `DriveCreateDoc`, `DriveCreateStickies`: Dialogs for creating folders, documents, or stickies boards.
- All use `DriveCreateItemDialog` for consistent UI.

```tsx
<DriveCreateFolder
  path={currentPath}
  open={show}
  onOpenChange={setShow}
  onSave={refresh}
/>
```

### 5. Sharing & Access Control
- `DriveAccessDialog`: Modal for editing sharing settings.
- `DriveAccessListEdit`: Inline editor for ACLs.
- `DriveAccessList`: Read-only view of who has access.
- `DriveShareSummary`: Small avatar+icon summary for quick sharing status.

```tsx
<DriveAccessDialog
  open={open}
  onOpenChange={setOpen}
  path={selectedPath}
/>
```

### 6. Upload & File Helpers
- `DriveUploadFiles`: Handles file uploads (drag-and-drop or dialog).
- `file-icon-helper.tsx`: Function to get the right icon for a file/folder.
- `file-upload.tsx`: Hook for custom upload flows.

## Example: Integrating in an App
```tsx
import {
  DriveLayout,
  DriveAccessDialog,
  DriveCreateFolder,
  DriveUploadFiles,
  getFileIcon,
} from "@workspace/ui/components/layout/drive";

// Use DriveLayout as the main file manager
// Use DriveAccessDialog, DriveCreateFolder, etc. for modals/dialogs
```

## File Index
- `drive-layout.tsx`: Main orchestrator, manages state and renders subcomponents
- `drive-list.tsx`: File/folder list/table with toolbar
- `drive-table.tsx`: Table view with context menu, sorting, keyboard nav
- `drive-detail.tsx`: File/folder detail panel
- `drive-create-folder-item.tsx`: Dialog UI for creating items (used by all creation dialogs)
- `drive-create-folder.tsx`, `drive-create-doc.tsx`, `drive-create-stickies.tsx`: Dialog logic for creating items
- `drive-delete-item.tsx`: Dialog for confirming deletion
- `drive-access-dialog.tsx`: Modal for editing sharing/ACL
- `drive-access-list-edit.tsx`: Inline ACL editor
- `drive-access-list.tsx`: Read-only ACL list
- `drive-share-summary.tsx`: Avatar summary of sharing
- `drive-upload-files.tsx`: File upload handler
- `file-icon-helper.tsx`: File/folder icon util
- `file-upload.tsx`: Upload hook
- `index.ts`: Barrel export

## Best Practices
- Use the provided dialogs/components for all create/delete/share flows
- Use TanStack Query for data fetching and mutation
- Use the `onAfterAction` prop to refresh data after mutations
- Use `getFileIcon` for consistent iconography
- Compose these components for a full-featured, extensible Drive UI

---

For more details, see the code and prop types in each file. All components are designed for composability and can be extended as needed.
