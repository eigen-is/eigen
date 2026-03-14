# Drive UI Components

> **TLDR**: `DriveLayout` orchestrates file management UI (list + detail + dialogs). Used by Drive, Docs, Stickies apps.
> All components in `packages/ui/src/components/layout/drive/`.

## Architecture

```
DriveLayout (orchestrator)
├── DriveList (toolbar + breadcrumb + external drop zone)
│   └── DriveTable (rows, keyboard nav, internal drag-drop, context menu)
├── DriveDetail (file preview, metadata, access list)
└── Dialogs (create, delete, rename, share, upload)
```

## Components

| Component             | File                         | Description                                           |
|-----------------------|------------------------------|-------------------------------------------------------|
| `DriveLayout`         | `drive-layout.tsx`           | Main entry point with dialogs + actions               |
| `DriveList`           | `drive-list.tsx`             | File browser with toolbar + breadcrumb                |
| `DriveTable`          | `drive-table.tsx`            | Table with sorting, keyboard, drag-drop, context menu |
| `DriveDetail`         | `drive-detail.tsx`           | Metadata, preview (image/video/audio), access list    |
| `DriveCreateFolder`   | `drive-create-folder.tsx`    | Create folder dialog                                  |
| `DriveCreateDoc`      | `drive-create-doc.tsx`       | Create document dialog                                |
| `DriveCreateStickies` | `drive-create-stickies.tsx`  | Create stickies board dialog                          |
| `DriveCreateChat`     | `drive-create-chat.tsx`      | Create chat dialog                                    |
| `DriveCreateSlides`   | `drive-create-slides.tsx`    | Create slides dialog                                  |
| `DriveCreateSheets`   | `drive-create-sheets.tsx`    | Create sheets dialog                                  |
| `DriveDeleteItem`     | `drive-delete-item.tsx`      | Delete confirmation                                   |
| `DriveRenameItem`     | `drive-rename-item.tsx`      | Rename dialog                                         |
| `DriveAccessDialog`   | `drive-access-dialog.tsx`    | Share/ACL management                                  |
| `DriveAccessListEdit` | `drive-access-list-edit.tsx` | Editable access list                                  |
| `DriveAccessList`     | `drive-access-list.tsx`      | Read-only access list                                 |
| `DriveShareSummary`   | `drive-share-summary.tsx`    | Sharing status badge                                  |
| `DriveUploadFiles`    | `drive-upload-files.tsx`     | Upload with drag-drop                                 |
| `FilePreview`         | `file-preview.tsx`           | Lightbox for images/videos/PDFs                       |
| `fileIconHelper`      | `file-icon-helper.tsx`       | MIME type → Lucide icon                               |
| `useDriveDialogs`     | `use-drive-dialogs.ts`       | Dialog state for all 7+ dialogs                       |
