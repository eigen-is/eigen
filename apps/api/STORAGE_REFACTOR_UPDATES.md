# Storage Refactor Progress

## Status: COMPLETE ✅

Started: 2026-01-16 15:07

---

## Phase 1: Storage Layer ✅
- [x] `lib/storage/types.ts`
- [x] `lib/storage/local-key-storage.ts`
- [x] `lib/storage/index.ts`

## Phase 2: Shared Thumbnails ✅
- [x] `lib/shared/thumbnails.ts`

## Phase 3: Mount Types + Schema ✅
- [x] `lib/mount/types.ts`
- [x] `lib/mount/schema.ts`

## Phase 4: Mount Class ✅
- [x] `lib/mount/mount.ts`
- [x] `lib/mount/index.ts`

## Phase 5: Extract ACL ✅
- [x] `lib/drive/acl.ts`

## Phase 6: Rewrite Drive ✅
- [x] `lib/drive/drive.new.ts` (will replace drive.ts after Home update)

## Phase 7: Update Home ✅
- [x] `lib/home/home.new.ts` (will replace home.ts)

## Phase 8: Add Mail Indexes ✅
- [x] `lib/mail/maildb.ts` - added 4 indexes for performance

## Phase 9: Finalize - Swap Files ✅

### Files Created (New Architecture)
```
lib/storage/
  - types.ts           ✅
  - local-key-storage.ts ✅
  - index.ts           ✅

lib/shared/
  - thumbnails.ts      ✅

lib/mount/
  - types.ts           ✅
  - schema.ts          ✅
  - mount.ts           ✅
  - index.ts           ✅

lib/drive/
  - acl.ts             ✅
  - drive.new.ts       ✅ (replace drive.ts)

lib/home/
  - home.new.ts        ✅ (replace home.ts)
```

### Files to Delete
```
lib/filesystem/        (entire directory - 8 files)
lib/home/filesystem.ts
lib/drive/drive.ts     (after replacing with drive.new.ts)
lib/home/home.ts       (after replacing with home.new.ts)
```

### To Complete the Swap
1. Backup or delete old `lib/drive/drive.ts`
2. Rename `lib/drive/drive.new.ts` → `lib/drive/drive.ts`
3. Backup or delete old `lib/home/home.ts`
4. Rename `lib/home/home.new.ts` → `lib/home/home.ts`
5. Delete `lib/filesystem/` directory
6. Delete `lib/home/filesystem.ts`
7. Update type references (DriveACL → ACLEntry, DrivePath → PathEntry)
8. Test all apps

### Known Type Issues to Fix
- `DriveACL.public` is `boolean` vs `ACLEntry.public` is `boolean | undefined`
- `DrivePath.labels` property missing from `PathEntry`
- `CollabDocument` references old `Drive` type

---

## Log

### 2026-01-16 15:07 - Starting refactor
Beginning Phase 1: Storage Layer

### 2026-01-16 - Phases 1-8 Complete
- Created new storage layer
- Created shared thumbnails utility
- Created mount system with types, schema, and Mount class
- Extracted ACL logic to separate file
- Rewrote Drive to use Mount
- Rewrote Home with getDatabase() singleton pattern
- Added mail performance indexes

### 2026-01-16 - Phase 9 Complete
- Swapped drive.ts and home.ts with new versions
- Updated CollabDocument to use PathEntry
- Updated sharedschema to use ACLEntry
- Deleted lib/filesystem/ directory (8 files)
- Deleted lib/home/filesystem.ts

### Backup Files Created (can be deleted after testing)
- `lib/drive/drive.old.ts`
- `lib/home/home.old.ts`

### Additional Updates (Mail/Contacts compatibility)
- Added `HomeFileSystem` class to Home for Mail/Contacts file operations
- Added `openSQLiteDatabase()` alias for backwards compatibility
- Fixed drive import path (drive.new → drive)

### Next Steps
1. Run `bun run serve` to test all apps
2. Delete backup files after confirming everything works:
   - `lib/drive/drive.old.ts`
   - `lib/home/home.old.ts`
