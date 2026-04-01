# Soft Delete Cleanup

> **TLDR**: Now that delete = trash (soft-delete), the separate `deleteFile`/`deleteFolder` distinction is
> unnecessary. Collapsing them reduces duplicated code across routes, hooks, Drive, SharedDrive, and SSE.

## What to consolidate

The file/folder split exists at every layer:

| Layer | File variant | Folder variant | Replacement |
|-------|-------------|----------------|-------------|
| Drive methods | `deleteFile()` | `deleteFolder()` | Single `trashPath()` (already exists) |
| SharedDrive | `deleteFile()` | `deleteFolder()` | Single `trashPath()` (already exists) |
| Routes | `DELETE /file/:pathId` | `DELETE /folder/:pathId` | Single `DELETE /path/:pathId` |
| Hooks | `useDeleteFile()` | `useDeleteFolder()` | Single `useTrashPath()` |
| SSE events | `DRIVE_FILE_DELETED` | `DRIVE_FOLDER_DELETED` | Keep for permanent delete only |
| SSE handlers | `invalidateItemDeleted` (handles both) | — | No change needed |

## Why not now

- The separate routes are part of the public API (Eden Treaty types)
- `useDeleteFile`/`useDeleteFolder` are used in multiple apps (drive, docs, slides, etc.)
- The current one-liner wrappers work fine — this is cosmetic, not a bug
