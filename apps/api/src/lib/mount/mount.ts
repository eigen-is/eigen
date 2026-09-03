import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSearchableTextFile } from '@workspace/lib/constants';
import {
    CHATS_FOLDER_NAME,
    DRIVE_MIME_FOLDER,
    DRIVE_TYPE_FOLDER,
    type DriveContainerType,
    type DrivePath,
    type MountConfig,
    parseOwnerId,
} from '@workspace/lib/types';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { AsyncSingleton } from '../../utils/singleton';
import { getServerSettings } from '../config/server-settings';
import { ApiError, type DatabaseConfig, type ManagedDatabase, type SchemaType } from '../core';
import { FileHistory } from '../drive/history';
import { deleteThumbnail } from '../shared/thumbnails';
import { LocalStorage, S3Storage, type StorageBackend, type StorageFile, wrapWithStorageFault } from '../storage';
import type { RetentionPolicy } from '../versioning/retention';
import * as snapshot from '../versioning/snapshot';
import { type ContentExtractor, ContentReindexQueue } from './content-reindex-queue';
import * as copy from './copy';
import { MOUNT_DB_CONFIG } from './db-config';
import * as documentDb from './document-db';
import {
    buildStorageKey,
    docContainerDescendantIds,
    isReservedName,
    rethrowDuplicateActiveName,
    validateName,
} from './helpers';
import type * as schema from './schema';
import { paths } from './schema';
import * as searchIndex from './search-index';
import * as trash from './trash';
import { UploadQueue } from './upload-queue';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string,
) => Promise<ManagedDatabase<S>>;

export type MimeOptions = { excludeDocumentChildren?: boolean };

export class Mount {
    readonly id: string;
    readonly config: MountConfig;

    private baseDir: string;
    storage: StorageBackend; // internal — used by mount/*.ts + versioning/snapshot.ts
    // internal — used by mount/*.ts + versioning/snapshot.ts + drive/history.ts (constructor-injected)
    db!: BunSQLiteDatabase<typeof schema>;
    private getLocalDatabase: LocalDatabaseGetter;
    private ownerId: string;
    // internal — used by mount/*.ts + versioning/snapshot.ts
    documentDbs: Map<string, AsyncSingleton<ManagedDatabase<SchemaType>>> = new Map();
    private pathLocks: Map<string, Promise<void>> = new Map();
    // In-flight document-db closes by pathId — a concurrent open of the same pathId waits on
    // this before building, so a fresh instance never shares the closing one's temp/journal
    // files (see mount/document-db.ts). internal — used by mount/*.ts
    closingDocumentDbs: Map<string, Promise<void>> = new Map();

    // Write-behind upload queue (Phase 1b) — only for isRemote (s3) mounts; undefined otherwise.
    uploadQueue?: UploadQueue; // internal — used by mount/*.ts + versioning/snapshot.ts

    // Per-mount content reindexer — built in init() only when an extractor is injected (the
    // document-loader stack is wired from Drive so it never enters this module's graph).
    reindexQueue?: ContentReindexQueue; // internal — used by mount/*.ts
    private readonly extractContent?: ContentExtractor;

    // init schedules the history prune off the ready path; held so a fast teardown can cancel it
    // before the Home closes metadata.db (else prune scans a closed db — see closeAllDatabases).
    pruneTimer: ReturnType<typeof setTimeout> | null = null; // internal — used by mount/*.ts

    public history!: FileHistory;

    constructor(
        ownerId: string,
        baseDir: string,
        config: MountConfig,
        getLocalDatabase: LocalDatabaseGetter,
        extractContent?: ContentExtractor,
    ) {
        this.ownerId = ownerId;
        this.id = config.id;
        this.config = config;
        this.baseDir = path.join(baseDir, 'mounts', config.id);
        this.getLocalDatabase = getLocalDatabase;
        this.extractContent = extractContent;

        let backend: StorageBackend;
        if (config.storageType === 'local-key' || config.storageType === 'local') {
            // LocalStorage is a strict superset of the flat-key backend; mount.ts gates all
            // mkdir/rename/deleteDir calls behind isPathBased, so the extra methods are inert for local-key.
            backend = new LocalStorage(this.baseDir);
        } else if (config.storageType === 's3') {
            if (!config.s3Config)
                throw new Error(
                    `Mount '${config.id}' uses S3 storage but no S3 configuration found. Configure S3 in admin settings first.`,
                );
            backend = new S3Storage(config.s3Config);
        } else {
            throw new Error(`Storage type ${config.storageType} not yet supported`);
        }
        // Passes the backend through untouched unless EIGEN_STORAGE_FAULT is set (never in production).
        this.storage = wrapWithStorageFault(backend);
    }

    // Read live off config so a settings rename (TeamHome.updateMount) shows up without rebuilding.
    get name(): string {
        return this.config.name;
    }

    // Hot-swap a live settings change. Only fields that don't define the storage backend (name, quota)
    // apply here; storageType/s3Config are bound to this.storage + uploadQueue at build time, so a
    // storage re-point is a rebuild — Drive.updateMount handles it via removeMount + addMount.
    applyConfig(config: MountConfig): void {
        this.config.name = config.name;
        this.config.maxSizeMB = config.maxSizeMB;
    }

    get thumbsDir(): string {
        return path.join(this.baseDir, 'thumbs');
    }

    get tmpDir(): string {
        return path.join(this.baseDir, 'tmp');
    }

    // Frozen VACUUM INTO upload payloads (Phase 1b) live here, NOT in tmpDir — the
    // cleanupStaleFiles sweep must never purge a staged copy whose PUT hasn't acked yet
    // (invariant 2). Only used by isRemote mounts.
    get stagingDir(): string {
        return path.join(this.baseDir, 'staging');
    }

    get previewsDir(): string {
        return path.join(this.tmpDir, 'previews');
    }

    get trashDir(): string {
        return path.join(this.dataDir, '.trash');
    }

    async init(): Promise<void> {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
        if (!fs.existsSync(this.thumbsDir)) {
            fs.mkdirSync(this.thumbsDir, { recursive: true });
        }
        if (!fs.existsSync(this.previewsDir)) {
            fs.mkdirSync(this.previewsDir, { recursive: true });
        }
        if (this.isRemote && !fs.existsSync(this.stagingDir)) {
            fs.mkdirSync(this.stagingDir, { recursive: true });
        }
        if (this.isPathBased && !fs.existsSync(this.trashDir)) {
            fs.mkdirSync(this.trashDir, { recursive: true });
        }

        const dbPath = path.join('mounts', this.config.id, 'metadata.db');
        const managedDb = await this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath);
        this.db = managedDb.db;
        this.history = new FileHistory(this.db, this.ownerId, this.id);

        await this.ensureRootFolder();

        // Stand up the upload queue and replay persisted pending uploads BEFORE the tmp sweep
        // (invariant 5) so a restart or home-reopen resumes them; staging lives in stagingDir, which
        // the sweep never touches. The destination key groups uploads to the same provider onto one
        // concurrency limiter, so a slow bucket can't block uploads to other buckets.
        if (this.isRemote) {
            const s3 = this.config.s3Config!;
            this.uploadQueue = new UploadQueue({
                db: this.db,
                storage: this.storage,
                stagingDir: this.stagingDir,
                destinationKey: `${s3.endpoint}/${s3.bucket}`,
                label: this.id,
            });
            this.uploadQueue.reconcile();
        }

        // Stand up the content reindexer and kick it to drain rows left dirty by the v6 backfill or
        // an unclean shutdown (the dirty bit is the durable queue — same replay-on-open as uploads).
        if (this.extractContent) {
            this.reindexQueue = new ContentReindexQueue({ mount: this, extract: this.extractContent, label: this.id });
            this.reindexQueue.kick();
        }

        // Cleanup stale temp files older than 1 hour (e.g. from interrupted uploads or crashes),
        // but preserve any that are an open doc's crash-recovery working copy (see cleanupStaleFiles).
        this.cleanupStaleFiles(this.tmpDir, 60 * 60 * 1000, true);

        // Cleanup preview cache files older than 7 days
        this.cleanupStaleFiles(this.previewsDir, 7 * 24 * 60 * 60 * 1000);

        const retentionDays = getServerSettings().quotas.trashRetentionDays;
        if (retentionDays > 0) {
            this.purgeTrash(retentionDays).catch((e) => console.error(`[Mount] Failed to purge expired trash:`, e));
        }
        // Off the init path — the prune's table scans shouldn't delay mount readiness. Held so a fast
        // teardown (idle eviction / a quick open+close) cancels it before metadata.db closes.
        this.pruneTimer = setTimeout(() => {
            this.pruneTimer = null;
            try {
                this.history.prune();
            } catch (e) {
                console.error('[Mount] Failed to prune file history:', e);
            }
        }, 0);
    }

    get dataDir(): string {
        return path.join(this.baseDir, 'data');
    }

    private cleanupStaleFiles(dir: string, maxAgeMs: number, preserveLivePathIds = false): void {
        try {
            const cutoff = Date.now() - maxAgeMs;
            // An open document's working copy lives in tmpDir keyed by its data.db pathId (getTempPath).
            // A delayed restart makes it >maxAge, but crash-recovery only adopts it when the doc is next
            // opened — so skip any entry whose basename is a live paths.id, or the sweep deletes the last
            // un-synced edits before recovery can run. Transient stream/upload/download temps use random
            // UUID ids that are never a paths row, so they're still swept.
            const liveIds = preserveLivePathIds
                ? new Set(
                      this.db
                          .select({ id: paths.id })
                          .from(paths)
                          .all()
                          .map((r) => r.id),
                  )
                : null;
            for (const entry of fs.readdirSync(dir)) {
                if (liveIds?.has(entry)) continue;
                const filePath = path.join(dir, entry);
                try {
                    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
                } catch {}
            }
        } catch {}
    }

    private async ensureRootFolder(): Promise<void> {
        const root = await this.db.select().from(paths).where(isNull(paths.parentId)).get();
        if (root) return;

        const rootId = randomUUID();
        await this.db.insert(paths).values({
            id: rootId,
            file: '',
            name: 'Drive',
            type: DRIVE_TYPE_FOLDER,
            parentId: null,
            ownerId: this.ownerId,
            mimeType: DRIVE_MIME_FOLDER,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Seed the chats folder on default personal drives only — other mounts opt in lazily
        // via Drive.ensureChatsFolder.
        if (this.config.isDefault && parseOwnerId(this.ownerId).type === 'user') {
            await this.createFolder(rootId, CHATS_FOLDER_NAME);
        }
    }

    async getRootFolder(): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(isNull(paths.parentId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    async getPath(pathId: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    async listFolder(parentId: string): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
            .all();

        return results.map((r) => this.toDrivePath(r));
    }

    async listFolderAll(parentId: string): Promise<DrivePath[]> {
        const results = await this.db.select().from(paths).where(eq(paths.parentId, parentId)).all();
        return results.map((r) => this.toDrivePath(r));
    }

    async getActivePath(pathId: string): Promise<DrivePath> {
        const path = await this.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        if (path.trashedAt) throw new ApiError(404, 'File is in trash');
        return path;
    }

    // True if `candidateId` is `ancestorId` itself or any descendant of it.
    // Used to reject moving/copying a folder into its own subtree (which would
    // also make copyPath recurse forever).
    async isSelfOrDescendant(ancestorId: string, candidateId: string): Promise<boolean> {
        if (ancestorId === candidateId) return true;
        let current = await this.getPath(candidateId);
        while (current?.parentId) {
            if (current.parentId === ancestorId) return true;
            current = await this.getPath(current.parentId);
        }
        return false;
    }

    // Flush the container's cached live data.db so an on-storage byte copy
    // reflects pending Yjs ops. No-op if the doc isn't open or has no data.db.
    // Mirrors the flush step in snapshotContainerDataDb.
    async flushContainerDb(containerId: string): Promise<void> {
        const dataDb = await this.getChildByName(containerId, 'data.db');
        if (!dataDb) return;
        const cached = this.documentDbs.get(dataDb.id);
        if (cached) await (await cached()).flush();
    }

    async getChildByName(parentId: string, name: string): Promise<DrivePath | null> {
        name = name.normalize('NFC');
        const result = await this.db
            .select()
            .from(paths)
            .where(
                and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`, isNull(paths.trashedAt)),
            )
            .get();
        if (result) return this.toDrivePath(result);

        const folded = await this.findCaseFoldedChild(parentId, name);
        return folded ? this.getPath(folded.id) : null;
    }

    // SQLite's LOWER() folds ASCII only. On path-based mounts names are disk paths, and
    // case-insensitive filesystems (APFS, Windows) also alias non-ASCII case pairs to one file —
    // so those must compare equal too. JS toLowerCase() is the stricter fold; only consulted for
    // non-ASCII names on path-based mounts, keeping ASCII lookups and id-keyed backends at
    // today's exact semantics. The v7 unique index stays the ASCII race net.
    // Accepted residual: an ASCII query never scans, so a stored-side-only alias (U+212A 'K'.txt
    // vs ASCII k.txt) still clobbers; pairs JS can't fold either way (ſ/s) likewise. Both are
    // single-codepoint oddities far rarer than the é/É class this closes.
    private async findCaseFoldedChild(parentId: string, name: string): Promise<{ id: string } | null> {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: \x00-\x7F is the ASCII range, not a control-char match
        if (!this.isPathBased || !/[^\x00-\x7F]/.test(name)) return null;
        const folded = name.toLowerCase();
        const siblings = await this.db
            .select({ id: paths.id, name: paths.name })
            .from(paths)
            .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
            .all();
        return siblings.find((s) => s.name.toLowerCase() === folded) ?? null;
    }

    async resolvePath(pathStr: string): Promise<DrivePath | null> {
        const segments = pathStr
            .split('/')
            .filter((s) => s.length > 0)
            .map((s) => s.normalize('NFC'));
        for (const seg of segments) {
            if (seg === '..' || seg === '.') throw new ApiError(400, 'Invalid path');
            // biome-ignore lint/suspicious/noControlCharactersInRegex: WebDAV paths must reject control bytes per RFC 4918
            if (/[\x00-\x1f]/.test(seg)) throw new ApiError(400, 'Invalid path');
        }
        let current: DrivePath | null = await this.getRootFolder();
        for (const seg of segments) {
            if (!current) return null;
            const child = await this.getChildByName(current.id, seg);
            if (!child || child.trashedAt) return null;
            current = child;
        }
        return current;
    }

    // internal — used by mount/*.ts
    async assertUniqueName(parentId: string, name: string, excludeId?: string): Promise<void> {
        const existing =
            (await this.db
                .select({ id: paths.id })
                .from(paths)
                .where(
                    and(
                        eq(paths.parentId, parentId),
                        sql`LOWER(${paths.name}) = LOWER(${name})`,
                        isNull(paths.trashedAt),
                    ),
                )
                .get()) ?? (await this.findCaseFoldedChild(parentId, name));

        if (existing && existing.id !== excludeId) {
            throw new ApiError(409, `A file or folder named "${name}" already exists in this directory`);
        }
    }

    private buildFileValue(id: string, name: string): string {
        return this.isPathBased ? name : buildStorageKey(id, name);
    }

    // Insert a path row, translating the v7 unique-index violation into the SAME 409 assertUniqueName
    // raises. assertUniqueName's SELECT still handles the friendly common case; this closes the RACE —
    // two racers both pass the SELECT, the DB serializes their INSERTs, and the second trips the index
    // here → 409 instead of a silent clobber.
    // WHY not reorder to avoid the orphaned object: the storage write MUST precede the insert (crash
    // safety — orphaned bytes beat a row pointing at missing bytes). So on the race the loser already
    // wrote its storage object before this throws: id-based → a harmless orphaned id-keyed object (never
    // referenced; a minor leak); path-based → the shared-path write already happened (both racers
    // targeted the same name → same path). Leaving that is correct; reordering would break the invariant.
    private async insertPathRow(values: typeof paths.$inferInsert): Promise<void> {
        try {
            await this.db.insert(paths).values(values);
        } catch (e) {
            rethrowDuplicateActiveName(e, values.name);
        }
    }

    private async resolveWriteKey(parentId: string, fileValue: string): Promise<string> {
        return this.isPathBased ? this.resolveStoragePathForNew(parentId, fileValue) : fileValue;
    }

    async createFolder(parentId: string, name: string, type: DriveContainerType = 'folder'): Promise<string> {
        name = validateName(name);
        await this.assertUniqueName(parentId, name);
        const folderId = randomUUID();
        // Derive the container mime from the canonical registry; only plain folders
        // have no eigendoc entry.
        const mimeType = type === DRIVE_TYPE_FOLDER ? DRIVE_MIME_FOLDER : EIGEN_DOC_TYPE_INFO[type].mime;
        const fileValue = this.isPathBased ? name : '';

        // Create directory before DB insert so a crash leaves an orphaned
        // directory (harmless) instead of a DB entry for a missing directory.
        if (this.isPathBased && this.storage.mkdir) {
            await this.storage.mkdir(await this.resolveWriteKey(parentId, fileValue));
        }

        await this.insertPathRow({
            id: folderId,
            file: fileValue,
            name,
            type,
            parentId,
            ownerId: this.ownerId,
            mimeType,
            acl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        return folderId;
    }

    private async computeHash(data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<string> {
        const hasher = new Bun.CryptoHasher('sha256');
        if (data instanceof Blob) {
            hasher.update(new Uint8Array(await data.arrayBuffer()));
        } else {
            hasher.update(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        }
        return hasher.digest('hex');
    }

    async createFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined,
    ): Promise<string> {
        name = validateName(name);
        await this.assertUniqueName(parentId, name);
        const fileId = randomUUID();
        const fileValue = this.buildFileValue(fileId, name);
        const hash = data !== undefined ? await this.computeHash(data) : null;

        // Write storage first, then DB. On crash between the two, we get an
        // orphaned file on disk (harmless) instead of a DB entry pointing to
        // a non-existent file (broken).
        if (data !== undefined) {
            await this.storage.write(await this.resolveWriteKey(parentId, fileValue), data);
        }

        const searchable = isSearchableTextFile(mimeType, name);
        await this.insertPathRow({
            id: fileId,
            file: fileValue,
            name,
            type: 'file',
            parentId,
            ownerId: this.ownerId,
            mimeType,
            size,
            hash,
            acl: null,
            contentDirty: searchable ? 1 : 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await this.invalidateSizesFrom(parentId);
        if (searchable) this.reindexQueue?.markDirty(fileId);

        return fileId;
    }

    async createFileFromTemp(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        hash: string,
        tempId: string,
    ): Promise<string> {
        name = validateName(name);
        await this.assertUniqueName(parentId, name);
        const fileId = randomUUID();
        const fileValue = this.buildFileValue(fileId, name);

        const storageKey = await this.resolveWriteKey(parentId, fileValue);

        // Storage write before DB insert (crash safety: orphaned file > orphaned row)
        await this.uploadFromTemp(storageKey, tempId);

        const searchable = isSearchableTextFile(mimeType, name);
        await this.insertPathRow({
            id: fileId,
            file: fileValue,
            name,
            type: 'file',
            parentId,
            ownerId: this.ownerId,
            mimeType,
            size,
            hash,
            acl: null,
            contentDirty: searchable ? 1 : 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await this.invalidateSizesFrom(parentId);
        if (searchable) this.reindexQueue?.markDirty(fileId);

        return fileId;
    }

    // Recursive same-mount copy — implementation in mount/copy.ts.
    async copyPath(
        srcPathId: string,
        destParentId: string,
        name: string,
        actor?: { id: string; email: string },
    ): Promise<DrivePath> {
        return copy.copyPath(this, srcPathId, destParentId, name, actor);
    }

    // Versioning mechanics — implementation in lib/versioning/snapshot.ts (next to restore.ts).
    async snapshotContainerDataDb(containerId: string, policy: RetentionPolicy): Promise<DrivePath> {
        return snapshot.snapshotContainerDataDb(this, containerId, policy);
    }

    // Skip-if-contended twin for the tick/close snapshot callback — never parks on the
    // container lock (see document-db.ts onSnapshot).
    async trySnapshotContainerDataDb(containerId: string, policy: RetentionPolicy): Promise<'taken' | 'skipped'> {
        return snapshot.trySnapshotContainerDataDb(this, containerId, policy);
    }

    async replaceContainerDataDb(containerId: string, sourcePath: string): Promise<void> {
        return snapshot.replaceContainerDataDb(this, containerId, sourcePath);
    }

    // The frozen staged copy of a pending (un-acked) upload for storageKey holds bytes newer than
    // the storage object; returns its on-disk path, or null when there's nothing fresher than
    // storage: local mounts (no queue), regular files (only managed data.db/comments.db/version
    // snapshots are ever staged), or an already-acked upload. Synchronous, so a caller can copy the
    // returned path with no await before a concurrent enqueue could unlink it.
    // internal — used by mount/*.ts + versioning/snapshot.ts
    pendingStagedCopy(storageKey: string): string | null {
        const staged = this.uploadQueue?.getPendingStagingPath(storageKey) ?? null;
        return staged && fs.existsSync(staged) ? staged : null;
    }

    async touchFile(parentId: string, name: string, mimeType: string) {
        return this.createFile(parentId, name, mimeType, 0, undefined);
    }

    // internal — used by mount/*.ts + versioning/snapshot.ts + Drive.withPathLock (ChatRoom.init)
    async withPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T> {
        while (this.pathLocks.has(pathId)) {
            await this.pathLocks.get(pathId);
        }
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.pathLocks.set(pathId, promise);
        try {
            return await fn();
        } finally {
            this.pathLocks.delete(pathId);
            resolve();
        }
    }

    // Atomic try-acquire twin of withPathLock: returns null when the lock is held. The has-check
    // and the set share one synchronous block — no await between them, so no TOCTOU.
    // internal — used by versioning/snapshot.ts
    async tryWithPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T | null> {
        if (this.pathLocks.has(pathId)) return null;
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.pathLocks.set(pathId, promise);
        try {
            return await fn();
        } finally {
            this.pathLocks.delete(pathId);
            resolve();
        }
    }

    async updatePath(pathId: string, updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>): Promise<void> {
        // Normalize before the spread so the stored name and the path-based storage key both use NFC.
        if (updates.name !== undefined) {
            updates.name = validateName(updates.name);
        }

        // DrivePath uses boolean, Drizzle column uses integer
        const dbUpdates: Record<string, unknown> = { ...updates };
        if (updates.sharingRestricted !== undefined) {
            dbUpdates['sharingRestricted'] = updates.sharingRestricted ? 1 : 0;
        }

        let oldParentId: string | null | undefined;
        if (updates.parentId !== undefined) {
            const old = await this.db
                .select({ parentId: paths.parentId })
                .from(paths)
                .where(eq(paths.id, pathId))
                .get();
            oldParentId = old?.parentId;
        }

        // The name a raced rename/move would collide on: the UPDATEs below trip the v7 unique index
        // when a same-name sibling lands between assertUniqueName's SELECT and the UPDATE. Empty only
        // when neither name nor parent changes — then the index can't fire.
        let targetName = updates.name ?? '';
        if (updates.name !== undefined || updates.parentId !== undefined) {
            const current = await this.getPath(pathId);
            if (current) {
                const targetParent = updates.parentId ?? current.parentId;
                targetName = updates.name ?? current.name;
                // A legacy pre-guard row named `.trash` must not be re-parented — at the mount
                // root its storage rename would land on the real trash dir (rename it first).
                // targetName, not current.name: a move that simultaneously renames away is safe.
                if (updates.parentId !== undefined && isReservedName(targetName)) {
                    throw new ApiError(400, `"${targetName}" is a reserved name`);
                }
                if (targetParent) {
                    await this.assertUniqueName(targetParent, targetName, pathId);
                }

                const renameFn = this.storage.rename;
                if (this.isPathBased && renameFn) {
                    await this.withPathLock(pathId, async () => {
                        const oldPath = await this.resolveStoragePath(pathId);
                        if (oldPath) {
                            if (updates.name !== undefined) {
                                dbUpdates['file'] = targetName;
                            }
                            try {
                                await this.db
                                    .update(paths)
                                    .set({ ...dbUpdates, updatedAt: new Date() })
                                    .where(eq(paths.id, pathId));
                            } catch (e) {
                                rethrowDuplicateActiveName(e, targetName);
                            }
                            // Invalidate before the storage rename — a rename failure
                            // here still leaves the DB updated, so the size caches must
                            // already reflect the new parent.
                            if (updates.parentId !== undefined) {
                                await this.invalidateSizesFrom(oldParentId ?? null);
                                await this.invalidateSizesFrom(updates.parentId);
                            }
                            const newPath = await this.resolveStoragePath(pathId);
                            if (oldPath !== newPath) {
                                await renameFn.call(this.storage, oldPath, newPath);
                            }
                        }
                    });
                    return;
                }
            }
        }

        try {
            await this.db
                .update(paths)
                .set({
                    ...dbUpdates,
                    updatedAt: new Date(),
                })
                .where(eq(paths.id, pathId));
        } catch (e) {
            rethrowDuplicateActiveName(e, targetName);
        }

        if (updates.parentId !== undefined) {
            await this.invalidateSizesFrom(oldParentId ?? null);
            await this.invalidateSizesFrom(updates.parentId);
        }
    }

    // internal — used by mount/*.ts + versioning/snapshot.ts
    async getStorageKey(pathId: string): Promise<string> {
        if (!this.isPathBased) {
            const row = await this.db.select({ file: paths.file }).from(paths).where(eq(paths.id, pathId)).get();
            return row?.file || pathId;
        }
        return this.resolveStoragePath(pathId);
    }

    // internal — used by mount/*.ts
    async resolveStoragePath(pathId: string): Promise<string> {
        const rows = await this.db
            .select({
                id: paths.id,
                file: paths.file,
                parentId: paths.parentId,
            })
            .from(paths)
            .where(sql`${paths.id} IN (
                WITH RECURSIVE ancestors AS (
                    SELECT id, parentId FROM paths WHERE id = ${pathId}
                    UNION ALL
                    SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
                )
                SELECT id FROM ancestors
            )`)
            .all();

        if (rows.length === 0) return '';

        const byId = new Map(rows.map((r) => [r.id, r]));
        const segments: string[] = [];
        let current = byId.get(pathId);
        while (current) {
            if (current.parentId === null) break;
            if (current.file) segments.unshift(current.file);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }

        return segments.join('/');
    }

    private async resolveStoragePathForNew(parentId: string, fileValue: string): Promise<string> {
        const parentPath = await this.resolveStoragePath(parentId);
        return parentPath ? `${parentPath}/${fileValue}` : fileValue;
    }

    async deletePath(pathId: string): Promise<void> {
        const pathEntry = await this.getPath(pathId);
        if (!pathEntry) return;
        if (pathEntry.parentId === null) throw new ApiError(400, 'Cannot delete root folder');

        // Tear down any cached DBs under this subtree first, so a still-open dirty DB can't re-stage
        // its now-dead key on a later tick (resurrection) and its temp/timer don't leak; the
        // cancel()/storage.delete below then clears whatever the close flushed.
        await documentDb.closeCachedDbsUnder(this, pathId);

        // Delete DB records before storage cleanup. On crash between the two,
        // we get orphaned files on disk (harmless) instead of DB entries
        // pointing to non-existent files (broken).
        if (pathEntry.type === 'file') {
            const storageKey = await this.getStorageKey(pathId);
            await this.db.delete(paths).where(eq(paths.id, pathId));
            await deleteThumbnail(this.thumbsDir, pathId);
            // Cancel any queued upload + staged copy first, so an in-flight/queued PUT can't
            // resurrect the object we're about to delete (invariant 7). Covers container
            // deletes (recursive deletePath), provisionManagedDbs rollback, and the chat-restore
            // replace, which all route data.db deletion through here.
            if (this.uploadQueue) await this.uploadQueue.cancel(storageKey);
            await this.storage.delete(storageKey);
        } else if (this.isPathBased && this.storage.deleteDir) {
            const storageKey = await this.getStorageKey(pathId);
            const fileIds = this.collectDescendantFileIds(pathId);
            this.db.transaction((tx) => {
                this.deleteDescendantsInTx(tx, pathId);
                tx.delete(paths).where(eq(paths.id, pathId)).run();
            });
            for (const fileId of fileIds) {
                await deleteThumbnail(this.thumbsDir, fileId);
            }
            if (storageKey) {
                await this.storage.deleteDir(storageKey);
            }
        } else {
            const children = await this.listFolderAll(pathId);
            for (const child of children) {
                await this.deletePath(child.id);
            }
            await this.db.delete(paths).where(eq(paths.id, pathId));
        }

        await this.invalidateSizesFrom(pathEntry.parentId);
    }

    private collectDescendantFileIds(parentId: string): string[] {
        const fileIds: string[] = [];
        const collect = (pid: string) => {
            const children = this.db
                .select({ id: paths.id, type: paths.type })
                .from(paths)
                .where(eq(paths.parentId, pid))
                .all();
            for (const child of children) {
                if (child.type !== 'file') {
                    collect(child.id);
                } else {
                    fileIds.push(child.id);
                }
            }
        };
        collect(parentId);
        return fileIds;
    }

    private deleteDescendantsInTx(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        parentId: string,
    ): void {
        const children = tx
            .select({ id: paths.id, type: paths.type })
            .from(paths)
            .where(eq(paths.parentId, parentId))
            .all();
        for (const child of children) {
            if (child.type !== 'file') {
                this.deleteDescendantsInTx(tx, child.id);
            }
            tx.delete(paths).where(eq(paths.id, child.id)).run();
        }
    }

    // ---- Trash facade — implementation in mount/trash.ts ----

    async trashPath(pathId: string): Promise<DrivePath> {
        return trash.trashPath(this, pathId);
    }

    async listTrash(): Promise<DrivePath[]> {
        return trash.listTrash(this);
    }

    async getTrashedFrom(pathId: string): Promise<string | null> {
        return trash.getTrashedFrom(this, pathId);
    }

    async restorePath(pathId: string): Promise<DrivePath> {
        return trash.restorePath(this, pathId);
    }

    async permanentlyDeleteFromTrash(pathId: string): Promise<void> {
        return trash.permanentlyDeleteFromTrash(this, pathId);
    }

    async purgeTrash(maxAgeDays?: number): Promise<void> {
        return trash.purgeTrash(this, maxAgeDays);
    }

    // internal — used by mount/*.ts
    collectDescendantIds(parentId: string): string[] {
        const ids: string[] = [];
        const collect = (pid: string) => {
            const children = this.db.select({ id: paths.id }).from(paths).where(eq(paths.parentId, pid)).all();
            for (const child of children) {
                ids.push(child.id);
                collect(child.id);
            }
        };
        collect(parentId);
        return ids;
    }

    async readFile(pathId: string): Promise<StorageFile | null> {
        const storageKey = await this.getStorageKey(pathId);
        // Freshest-first: an un-acked pending upload's frozen staged copy holds bytes newer than the
        // storage object (a just-created or outage-staged data.db whose PUT hasn't landed), so serve
        // it — copy/download must never capture stale/absent storage. A no-op for local mounts (no
        // queue) and regular files (never staged), and once an upload acks the row is gone and storage
        // is current. Safe for readFile's real callers: data.db is never on a hot serve path (a
        // container-internal read gets fresher-or-equal bytes, never staler), and a regular served
        // file is never an open doc, so pending-staging-first can't serve stale
        // bytes. (The lazy handle races an ack that unlinks the staging file — a bounded transient
        // read error, never data loss; snapshotting instead uses stageDataDbSnapshot's sync copy.)
        const staged = this.pendingStagedCopy(storageKey);
        if (staged) return Bun.file(staged);
        const file = this.storage.read(storageKey);
        if (await file.exists()) {
            return file;
        }
        return null;
    }

    async readRange(pathId: string, start: number, end: number): Promise<StorageFile | null> {
        // NOT freshest-first (unlike readFile): a ranged GET of a container-internal db with a pending
        // upload reads storage. Pre-existing and container-internal-db-only; future follow-up.
        const storageKey = await this.getStorageKey(pathId);
        const probe = this.storage.read(storageKey);
        if (!(await probe.exists())) return null;
        if (this.storage.readRange) return this.storage.readRange(storageKey, start, end);
        return probe.slice(start, end);
    }

    // Overwrites aren't handed mimeType/name like createFile — resolve the searchable gate from the row.
    private async isSearchableRow(pathId: string): Promise<boolean> {
        const row = await this.db
            .select({ name: paths.name, mimeType: paths.mimeType })
            .from(paths)
            .where(eq(paths.id, pathId))
            .get();
        return !!row && isSearchableTextFile(row.mimeType, row.name);
    }

    async writeFile(pathId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const storageKey = await this.getStorageKey(pathId);
        const written = await this.storage.write(storageKey, data);

        let size: number;
        if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
            size = data.length;
        } else if (data instanceof ArrayBuffer) {
            size = data.byteLength;
        } else {
            size = data.size;
        }

        const hash = await this.computeHash(data);
        const searchable = await this.isSearchableRow(pathId);
        if (searchable) this.reindexQueue?.bumpGeneration(pathId);
        await this.db
            .update(paths)
            .set({ size, hash, updatedAt: new Date(), contentDirty: searchable ? 1 : 0 })
            .where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
        if (searchable) this.reindexQueue?.kick();
        return written;
    }

    // Overwrite using a temp file with size+hash already known (from writeTempWithHash).
    // Mirrors createFileFromTemp on the create side and avoids re-hashing.
    async writeFileFromTemp(pathId: string, tempId: string, size: number, hash: string): Promise<void> {
        const storageKey = await this.getStorageKey(pathId);
        await this.uploadFromTemp(storageKey, tempId);
        const searchable = await this.isSearchableRow(pathId);
        if (searchable) this.reindexQueue?.bumpGeneration(pathId);
        await this.db
            .update(paths)
            .set({ size, hash, updatedAt: new Date(), contentDirty: searchable ? 1 : 0 })
            .where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
        if (searchable) this.reindexQueue?.kick();
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    // Download a stored file to a local temp path the caller can open directly
    // (e.g. reading a SQLite snapshot on any storage backend). tempId must be
    // unique per invocation (a fresh randomUUID): a shared id lets concurrent
    // downloads of one file clobber each other. Caller owns cleanupTemp(tempId).
    async downloadToTemp(pathId: string, tempId: string): Promise<string> {
        // Invariant: an open doc's live working copy is the temp path keyed by its
        // data.db pathId (getTempPath) — a tempId colliding with one would truncate it.
        if (this.documentDbs.has(tempId)) {
            throw new Error(
                `[Mount] downloadToTemp ${pathId}: tempId ${tempId} is an open document DB — refusing to overwrite its live working copy`,
            );
        }
        return this.downloadKeyToTemp(await this.getStorageKey(pathId), tempId);
    }

    // internal — used by mount/*.ts
    async downloadKeyToTemp(storageKey: string, tempId: string): Promise<string> {
        const start = Bun.nanoseconds();
        const tempPath = this.getTempPath(tempId);
        const file = this.storage.read(storageKey);
        try {
            await Bun.write(tempPath, file);
        } catch (err) {
            // A failed/partial GET can leave a truncated or 0-byte temp behind. Remove it so a later
            // crash-recovery open can't adopt those bytes as a fresh empty doc.
            fs.rmSync(tempPath, { force: true });
            throw err;
        }
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(
            `[timing] Mount.download ${storageKey} ${(Bun.file(tempPath).size / 1024) | 0}KB ${ms.toFixed(1)}ms`,
        );
        return tempPath;
    }

    // internal — used by mount/*.ts
    async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        const tempFile = Bun.file(tempPath);
        if (!(await tempFile.exists())) {
            // Invariant violation: caller must have written tempPath before sync. A missing
            // tempfile here used to silently no-op, masking data loss when the live session
            // had unflushed writes. Throw so close-time sync failures alarm.
            throw new Error(`[Mount] uploadFromTemp ${storageKey}: tempfile missing at ${tempPath}`);
        }
        const start = Bun.nanoseconds();
        await this.storage.write(storageKey, tempFile);
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(`[timing] Mount.upload ${storageKey} ${(tempFile.size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
    }

    async cleanupTemp(tempId: string): Promise<void> {
        try {
            const tempPath = this.getTempPath(tempId);
            const file = Bun.file(tempPath);
            if (await file.exists()) await file.delete();
            // A lazily-closed (zombie) connection keeps its journals on disk; a stale WAL next
            // to a later re-download of the same path would be replayed into foreign bytes.
            fs.rmSync(`${tempPath}-wal`, { force: true });
            fs.rmSync(`${tempPath}-shm`, { force: true });
        } catch {}
    }

    // internal — used by mount/*.ts + versioning/snapshot.ts
    get isRemote(): boolean {
        return this.config.storageType !== 'local-key' && this.config.storageType !== 'local';
    }

    // internal — used by mount/*.ts
    get isPathBased(): boolean {
        return this.config.storageType === 'local';
    }

    // internal — used by mount/*.ts
    get needsTempCopy(): boolean {
        return this.isRemote || this.isPathBased;
    }

    // ---- Managed document-DB facade — implementation in mount/document-db.ts ----

    // Open an EXISTING managed document database. Throws ApiError(503) if the
    // backing storage object isn't there — never silently creates fresh.
    // Use createDatabase for the first-time provisioning instead.
    async openDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        return documentDb.openDatabase(this, config, pathId);
    }

    // Provision a NEW managed document database. Asserts the storage object
    // does not already exist, creates fresh schema, and flushes to storage
    // before returning so subsequent openDatabase calls (incl. after API
    // restart) find a real object. Caller must touchFile() the path first.
    async createDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        return documentDb.createDatabase(this, config, pathId);
    }

    async closeDatabase(pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        return documentDb.closeDatabase(this, pathId, opts);
    }

    async closeAllDatabases(): Promise<void> {
        return documentDb.closeAllDatabases(this);
    }

    // Force-drain this mount's content reindex queue and await it. The queue otherwise self-drives
    // (on dirty-mark + cap timer); this facade exists for tests and ad-hoc ops. No-op until init
    // builds the queue (i.e. when no extractor was injected).
    flushContentReindex(): Promise<void> {
        return this.reindexQueue?.drain() ?? Promise.resolve();
    }

    // ---- Upload-queue facade (Phase 1b) — thin delegation to the per-mount UploadQueue ----

    // Force a drain of this mount's pending uploads. The queue otherwise self-drives (on enqueue +
    // backoff), and process shutdown flushes via uploadQueue.drain() directly (see closeAllDatabases),
    // so this thin facade exists only for tests and ad-hoc ops. No-op for non-S3 mounts.
    drainPendingUploads(opts?: { flushNow?: boolean; deadline?: number }): Promise<void> {
        return this.uploadQueue?.drain(opts) ?? Promise.resolve();
    }

    // Queue depth (observability, §9): how many uploads are awaiting an ack on this mount.
    get pendingUploadCount(): number {
        return this.uploadQueue?.pendingCount ?? 0;
    }

    async getTotalSize(): Promise<number> {
        const result = await this.db
            .select({
                total: sql<number>`COALESCE(SUM(${paths.size}), 0)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.total ?? 0;
    }

    async getFileCount(): Promise<number> {
        const result = await this.db
            .select({
                count: sql<number>`COUNT(*)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.count ?? 0;
    }

    async getPathsByMimeType(mimeTypePrefix: string, options?: MimeOptions): Promise<DrivePath[]> {
        const conditions = [];
        if (mimeTypePrefix) {
            conditions.push(sql`${paths.mimeType} LIKE ${`${mimeTypePrefix}%`}`);
        }
        conditions.push(isNull(paths.trashedAt));
        if (options?.excludeDocumentChildren) {
            conditions.push(sql`${paths.parentId} NOT IN (${docContainerDescendantIds})`);
        }

        const query = this.db
            .select()
            .from(paths)
            .where(and(...conditions));

        const results = await query.all();
        return results.map((r) => this.toDrivePath(r));
    }

    // ---- Content index + search facade — implementation in mount/search-index.ts ----

    upsertPathContent(pathId: string, body: string): void {
        searchIndex.upsertPathContent(this, pathId, body);
    }

    clearPathContent(pathId: string): void {
        searchIndex.clearPathContent(this, pathId);
    }

    getContentDirtyPaths(reindexCapSeconds: number, limit: number): DrivePath[] {
        return searchIndex.getContentDirtyPaths(this, reindexCapSeconds, limit);
    }

    earliestPendingReindexAt(reindexCapSeconds: number): number | null {
        return searchIndex.earliestPendingReindexAt(this, reindexCapSeconds);
    }

    markContentIndexed(pathId: string): void {
        searchIndex.markContentIndexed(this, pathId);
    }

    markContentIndexAttempted(pathId: string): void {
        searchIndex.markContentIndexAttempted(this, pathId);
    }

    searchPaths(opts: { q: string; limit: number }): DrivePath[] {
        return searchIndex.searchPaths(this, opts);
    }

    async getPathsWithACL(): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(sql`${paths.acl} IS NOT NULL AND json_array_length(${paths.acl}) > 0`, isNull(paths.trashedAt)))
            .all();
        return results.map((r) => this.toDrivePath(r));
    }

    async getBreadcrumb(pathId: string): Promise<DrivePath[]> {
        const rows = await this.db
            .select()
            .from(paths)
            .where(sql`${paths.id} IN (
                WITH RECURSIVE ancestors AS (
                    SELECT id, parentId FROM paths WHERE id = ${pathId}
                    UNION ALL
                    SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
                )
                SELECT id FROM ancestors
            )`)
            .all();

        if (rows.length === 0) return [];

        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered: typeof rows = [];
        let current = byId.get(pathId);
        while (current) {
            ordered.unshift(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }

        return ordered.map((r) => this.toDrivePath(r));
    }

    // internal — used by mount/*.ts
    toDrivePath(row: typeof paths.$inferSelect): DrivePath {
        let size = row.size;
        if (row.type !== 'file' && size === null) {
            size = this.computeAndCacheFolderSize(row.id);
        }
        return {
            id: row.id,
            mountId: this.id,
            name: row.name,
            type: row.type,
            parentId: row.parentId,
            ownerId: row.ownerId,
            mimeType: row.mimeType,
            size: size ?? 0,
            hash: row.hash,
            thumbnail: row.thumbnail,
            acl: row.acl,
            visibility: row.visibility ?? 'private',
            sharingRestricted: !!row.sharingRestricted,
            details: row.details ?? null,
            trashedAt: row.trashedAt ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
        };
    }

    // internal — used by mount/*.ts + versioning/snapshot.ts
    async invalidateAncestorsOf(pathId: string): Promise<void> {
        const row = await this.db.select({ parentId: paths.parentId }).from(paths).where(eq(paths.id, pathId)).get();
        if (row) await this.invalidateSizesFrom(row.parentId);
    }

    // NULL the cached size on `parentId` and every ancestor up to the mount root.
    // internal — used by mount/*.ts
    async invalidateSizesFrom(parentId: string | null): Promise<void> {
        if (!parentId) return;
        await this.db.run(sql`
            WITH RECURSIVE ancestors(id) AS (
                SELECT ${parentId} AS id
                UNION ALL
                SELECT p.parentId FROM paths p
                    JOIN ancestors a ON p.id = a.id
                    WHERE p.parentId IS NOT NULL
            )
            UPDATE paths SET size = NULL WHERE id IN (SELECT id FROM ancestors)
        `);
    }

    // Trash-boundary filter (trashedFrom IS NULL) excludes the top-level trashed
    // item but includes its cascade-trashed descendants — matches Google Drive.
    private computeAndCacheFolderSize(folderId: string): number {
        return this.db.transaction((tx) => this.computeFolderSizeInTx(tx, folderId));
    }

    private computeFolderSizeInTx(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        folderId: string,
    ): number {
        const row = tx.select({ size: paths.size, type: paths.type }).from(paths).where(eq(paths.id, folderId)).get();
        if (!row) return 0;
        if (row.type === 'file') return row.size ?? 0;
        if (row.size !== null) return row.size;

        const children = tx
            .select({ id: paths.id, size: paths.size, type: paths.type })
            .from(paths)
            .where(and(eq(paths.parentId, folderId), isNull(paths.trashedFrom)))
            .all();

        let total = 0;
        for (const c of children) {
            if (c.type === 'file') {
                total += c.size ?? 0;
            } else if (c.size !== null) {
                total += c.size;
            } else {
                total += this.computeFolderSizeInTx(tx, c.id);
            }
        }

        tx.update(paths).set({ size: total }).where(eq(paths.id, folderId)).run();
        return total;
    }
}
