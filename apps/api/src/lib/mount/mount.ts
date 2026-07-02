import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSearchableTextFile } from '@workspace/lib/constants';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_FOLDER,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_TYPE_FOLDER,
    type DriveContainerType,
    type DrivePath,
    type MountConfig,
    type MountSettings,
} from '@workspace/lib/types';
import { type DriveVisibility, EIGEN_DOCUMENT_TYPES, isContainerType } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { getS3Config, getServerSettings } from '../config/server-settings';
import {
    ApiError,
    type DatabaseConfig,
    ManagedDatabase,
    type SchemaType,
    type SyncCallbacks,
    sanitizeFtsQuery,
} from '../core';
import { FileHistory } from '../drive/history';
import { getUniqueFileName } from '../drive/naming';
import { writeTempWithHash } from '../drive/streaming';
import { deleteThumbnail } from '../shared/thumbnails';
import { LocalStorage, S3Storage, type StorageBackend, type StorageFile } from '../storage';
import { getShutdownDrainDeadline } from '../sync';
import { type RetentionPolicy, selectSnapshotsToPrune } from '../versioning/retention';
import { formatSnapshotTimestamp } from '../versioning/timestamp';
import { type ContentExtractor, ContentReindexQueue } from './content-reindex-queue';
import { MOUNT_DB_CONFIG } from './db-config';
import type * as schema from './schema';
import { paths } from './schema';
import { UploadQueue } from './upload-queue';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string,
) => Promise<ManagedDatabase<S>>;

function validateName(name: string): void {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new ApiError(400, `Invalid file or folder name: "${name}"`);
    }
}

// Subquery: ids of every eigendoc container (doc/stickies/slides/sheets/chat) and
// every path descended from one. Embedded as `parentId NOT IN (…)` to filter out
// container internals (data.db, media, embedded chats) — file rows the user
// never sees in the drive UI and shouldn't see in search.
const docContainerDescendantIds = sql`
    WITH RECURSIVE doc_tree AS (
        SELECT id FROM paths
        WHERE type IN (${sql.join(
            EIGEN_DOCUMENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
        )}) AND trashedAt IS NULL
        UNION ALL
        SELECT child.id FROM paths child INNER JOIN doc_tree dt ON child.parentId = dt.id
    )
    SELECT id FROM doc_tree
`;

// The v7 partial unique index (parentId, LOWER(name)) WHERE trashedAt IS NULL. Its violation on an
// INSERT is what closes the concurrent-create race; insertPathRow maps it to a 409.
const UNIQUE_ACTIVE_NAME_INDEX = 'idx_paths_unique_active_name';

// True only for the losing racer's INSERT tripping that index. bun:sqlite names the expression index
// in the message (`UNIQUE constraint failed: index 'idx_paths_unique_active_name'`); match on it so an
// unrelated UNIQUE (the id PRIMARY KEY) still surfaces as a real error rather than a spurious 409.
function isDuplicateActiveNameError(e: unknown): boolean {
    return e instanceof Error && e.message.includes(`index '${UNIQUE_ACTIVE_NAME_INDEX}'`);
}

export function buildStorageKey(id: string, name: string): string {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.slice(dotIdx + 1).toLowerCase();
        if (ext.length > 0 && ext.length <= 12) {
            return `${id}.${ext}`;
        }
    }
    return id;
}

// A document working copy must be a real SQLite db. The 16-byte magic header is the cheapest proof;
// a 0-byte or partial download (an empty/failed S3 GET) fails it. Used to refuse opening such a file
// as a fresh empty doc and re-uploading it over good stored bytes (the 2026-06-08 data loss).
function isSqliteFile(filePath: string): boolean {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(16);
        const read = fs.readSync(fd, header, 0, 16, 0);
        // SQLite magic: the 15 ASCII bytes "SQLite format 3" followed by a NUL terminator.
        return read === 16 && header.toString('latin1', 0, 15) === 'SQLite format 3' && header[15] === 0;
    } catch {
        return false;
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
}

// A recovered temp is the live working copy after an unclean shutdown: it should be the stored db
// (plus any unsynced writes), never a fraction of it. Refuse it if it isn't a valid SQLite, or if it
// has collapsed far below the last-known stored size (a tiny fresh-init db where a multi-MB doc was) —
// either signals corrupt/empty bytes that must not be adopted and re-uploaded over the good object.
const RECOVERY_COLLAPSE_FLOOR_BYTES = 64 * 1024;
const RECOVERY_COLLAPSE_RATIO = 0.5;
function isViableRecoveryTemp(tempPath: string, knownSize: number): boolean {
    if (!isSqliteFile(tempPath)) return false;
    const tempSize = fs.statSync(tempPath).size;
    return !(knownSize >= RECOVERY_COLLAPSE_FLOOR_BYTES && tempSize < knownSize * RECOVERY_COLLAPSE_RATIO);
}

export class Mount {
    readonly id: string;
    readonly config: MountConfig;

    private baseDir: string;
    private storage: StorageBackend;
    private db!: BunSQLiteDatabase<typeof schema>;
    private getLocalDatabase: LocalDatabaseGetter;
    private ownerId: string;
    private documentDbs: Map<string, () => Promise<ManagedDatabase<SchemaType>>> = new Map();
    private pathLocks: Map<string, Promise<void>> = new Map();

    // Write-behind upload queue (Phase 1b) — only for isRemote (s3) mounts; undefined otherwise.
    private uploadQueue?: UploadQueue;

    // Per-mount content reindexer — built in init() only when an extractor is injected (the
    // document-loader stack is wired from Drive so it never enters this module's graph).
    private reindexQueue?: ContentReindexQueue;
    private readonly extractContent?: ContentExtractor;

    // init schedules the history prune off the ready path; held so a fast teardown can cancel it
    // before the Home closes metadata.db (else prune scans a closed db — see closeAllDatabases).
    private pruneTimer: ReturnType<typeof setTimeout> | null = null;

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

        if (config.storageType === 'local-key' || config.storageType === 'local') {
            // LocalStorage is a strict superset of the flat-key backend; mount.ts gates all
            // mkdir/rename/deleteDir calls behind isPathBased, so the extra methods are inert for local-key.
            this.storage = new LocalStorage(this.baseDir);
        } else if (config.storageType === 's3') {
            if (!config.s3Config)
                throw new Error(
                    `Mount '${config.id}' uses S3 storage but no S3 configuration found. Configure S3 in admin settings first.`,
                );
            this.storage = new S3Storage(config.s3Config);
        } else {
            throw new Error(`Storage type ${config.storageType} not yet supported`);
        }
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

        if (!root) {
            await this.db.insert(paths).values({
                id: randomUUID(),
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

        return result ? this.toDrivePath(result) : null;
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

    private async assertUniqueName(parentId: string, name: string, excludeId?: string): Promise<void> {
        const existing = await this.db
            .select({ id: paths.id })
            .from(paths)
            .where(
                and(eq(paths.parentId, parentId), sql`LOWER(${paths.name}) = LOWER(${name})`, isNull(paths.trashedAt)),
            )
            .get();

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
            if (isDuplicateActiveNameError(e)) {
                throw new ApiError(409, `A file or folder named "${values.name}" already exists in this directory`);
            }
            throw e;
        }
    }

    private async resolveWriteKey(parentId: string, fileValue: string): Promise<string> {
        return this.isPathBased ? this.resolveStoragePathForNew(parentId, fileValue) : fileValue;
    }

    async createFolder(parentId: string, name: string, type: DriveContainerType = 'folder'): Promise<string> {
        validateName(name);
        await this.assertUniqueName(parentId, name);
        const folderId = randomUUID();
        const mimeTypeMap: Record<string, string> = {
            folder: DRIVE_MIME_FOLDER,
            doc: DRIVE_MIME_DOC,
            stickies: DRIVE_MIME_STICKIES,
            slides: DRIVE_MIME_SLIDES,
            sheets: DRIVE_MIME_SHEETS,
            chat: DRIVE_MIME_CHAT,
        };
        const mimeType = mimeTypeMap[type] ?? DRIVE_MIME_FOLDER;
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
        validateName(name);
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
        if (searchable) this.reindexQueue?.kick();

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
        validateName(name);
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
        if (searchable) this.reindexQueue?.kick();

        return fileId;
    }

    async copyPath(
        srcPathId: string,
        destParentId: string,
        name: string,
        actor?: { id: string; email: string },
    ): Promise<DrivePath> {
        const src = await this.getPath(srcPathId);
        if (!src || src.trashedAt) throw new ApiError(404, 'Source not found');

        if (isContainerType(src.type)) {
            const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
            if (isEigenDoc) await this.flushContainerDb(srcPathId);
            const containerType: DriveContainerType | undefined = isEigenDoc ? src.type : undefined;
            const newId = await this.createFolder(destParentId, name, containerType);
            if (actor) {
                await this.history.record({
                    pathId: newId,
                    eventType: 'copied',
                    actor,
                    details: {
                        sourceOwnerId: this.history.ownerId,
                        sourceMountId: this.history.mountId,
                        sourcePathId: srcPathId,
                    },
                });
            }
            const children = await this.listFolder(srcPathId);
            for (const child of children) {
                // Inside an eigen-doc container, versions/ is snapshot history — a
                // fresh copy starts clean rather than inheriting old snapshots.
                if (isEigenDoc && child.type === DRIVE_TYPE_FOLDER && child.name === 'versions') continue;
                await this.copyPath(child.id, newId, child.name, actor);
            }
            // The copied container's data.db is byte-copied as raw bytes — no onSync fires
            // for the new container, so mark it dirty here and kick the reindexer to extract its
            // body. Plain folders have no body and stay unmarked.
            if (isEigenDoc) {
                await this.db.update(paths).set({ contentDirty: 1 }).where(eq(paths.id, newId)).run();
                this.reindexQueue?.kick();
            }
            const created = await this.getPath(newId);
            if (!created) throw new ApiError(500, 'Failed to copy folder');
            return created;
        }

        // Freshest-first source: readFile surfaces an un-acked pending upload's staged bytes (a
        // just-created / outage-staged data.db) rather than the possibly-stale-or-absent storage
        // object. The container branch above flushed the doc first, so its pending staging holds the
        // current bytes; a regular file is never staged, so this is a plain storage read for it.
        const srcFile = await this.readFile(srcPathId);
        if (!srcFile) throw new ApiError(404, 'Source file missing on storage');
        const tempId = randomUUID();
        const { size, hash } = await writeTempWithHash(this.getTempPath(tempId), srcFile);
        try {
            const newId = await this.createFileFromTemp(destParentId, name, src.mimeType, size, hash, tempId);
            if (actor) {
                await this.history.record({
                    pathId: newId,
                    eventType: 'copied',
                    actor,
                    details: {
                        sourceOwnerId: this.history.ownerId,
                        sourceMountId: this.history.mountId,
                        sourcePathId: srcPathId,
                    },
                });
            }
            const created = await this.getPath(newId);
            if (!created) throw new ApiError(500, 'Failed to copy file');
            return created;
        } finally {
            await this.cleanupTemp(tempId);
        }
    }

    // Snapshots the container's data.db into versions/<iso-ts>.db, then prunes per
    // the retention policy. Self-locked on the container: the timer, close, manual
    // save and a restore's pre-restore snapshot all call this directly and serialize
    // here — no caller has to remember to lock, and nothing holds the lock across
    // another snapshot, so there is no deadlock to reason about.
    async snapshotContainerDataDb(containerId: string, policy: RetentionPolicy): Promise<DrivePath> {
        return this.withPathLock(containerId, async () => {
            const dataDb = await this.getChildByName(containerId, 'data.db');
            if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);

            // Flush any cached managedDb so the on-storage data.db reflects pending
            // writes. No-op if not cached, or cached and not dirty.
            const cached = this.documentDbs.get(dataDb.id);
            if (cached) await (await cached()).flush();

            let versions = await this.getChildByName(containerId, 'versions');
            if (!versions) {
                const newId = await this.createFolder(containerId, 'versions');
                const created = await this.getPath(newId);
                if (!created) throw new ApiError(500, 'Failed to create versions folder');
                versions = created;
            }

            const snapshotName = formatSnapshotTimestamp(new Date());
            // Two snapshots in the same millisecond capture the same instant — reuse
            // the existing one rather than failing on the duplicate name.
            const existing = await this.getChildByName(versions.id, snapshotName);
            if (existing) return existing;
            // isRemote sources the version from the freshest LOCAL bytes and ENQUEUES its upload
            // (§3), so a close-time snapshot never blocks on the backend — copyPath would instead
            // write the new version to storage synchronously. Local backends are synchronously
            // current, so they keep the direct copyPath.
            const copy = this.isRemote
                ? await this.snapshotDataDbToVersionStaged(dataDb, versions.id, snapshotName)
                : await this.copyPath(dataDb.id, versions.id, snapshotName);

            // Prune. Exclude the just-written copy: retention keeps the newest per
            // hour bucket, and excluding the fresh one lets a second snapshot taken
            // within the same hour preserve the first until the hour rolls over.
            const toPrune = selectSnapshotsToPrune(
                (await this.listFolder(versions.id))
                    .filter((e) => e.id !== copy.id)
                    .map((e) => ({ id: e.id, name: e.name })),
                policy,
            );
            for (const item of toPrune) await this.deletePath(item.id);

            return copy;
        });
    }

    // isRemote version snapshot: create the version metadata row, source its bytes from the
    // freshest LOCAL copy of data.db, and enqueue the upload (so a close-time snapshot never
    // blocks on the backend). Caller holds the container lock.
    private async snapshotDataDbToVersionStaged(
        dataDb: DrivePath,
        versionsId: string,
        snapshotName: string,
    ): Promise<DrivePath> {
        const versionPathId = await this.touchFile(versionsId, snapshotName, dataDb.mimeType);
        const versionKey = await this.getStorageKey(versionPathId);
        const queue = this.uploadQueue!; // isRemote-only path (snapshotContainerDataDb branch)
        const versionStaging = queue.newStagingPath();
        await this.stageDataDbSnapshot(dataDb.id, versionStaging);
        const size = fs.statSync(versionStaging).size;
        await this.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, versionPathId));
        await this.invalidateAncestorsOf(versionPathId);
        queue.enqueueStaged(versionKey, versionStaging);
        const created = await this.getPath(versionPathId);
        if (!created) throw new ApiError(500, 'Failed to create version snapshot');
        return created;
    }

    // The frozen staged copy of a pending (un-acked) upload for storageKey holds bytes newer than
    // the storage object; returns its on-disk path, or null when there's nothing fresher than
    // storage: local mounts (no queue), regular files (only managed data.db/comments.db/version
    // snapshots are ever staged), or an already-acked upload. Synchronous, so a caller can copy the
    // returned path with no await before a concurrent enqueue could unlink it.
    private pendingStagedCopy(storageKey: string): string | null {
        const staged = this.uploadQueue?.getPendingStagingPath(storageKey) ?? null;
        return staged && fs.existsSync(staged) ? staged : null;
    }

    // Produce a local copy of data.db's current bytes at destPath, freshest source first.
    private async stageDataDbSnapshot(dataDbPathId: string, destPath: string): Promise<void> {
        const storageKey = await this.getStorageKey(dataDbPathId);
        // The caller (snapshotContainerDataDb) flushed the cached db first, so the pending staged
        // copy already holds the current bytes — reuse it instead of a second VACUUM INTO. Copy it
        // SYNCHRONOUSLY: with no await between pendingStagedCopy's existsSync and the copy, a
        // concurrent enqueue can't unlink it mid-read.
        const pendingStaging = this.pendingStagedCopy(storageKey);
        if (pendingStaging) {
            fs.copyFileSync(pendingStaging, destPath);
            return;
        }
        // Nothing pending: a live VACUUM INTO if the doc is open, else the storage object — which is
        // current because every upload acked (§3).
        const cached = this.documentDbs.get(dataDbPathId);
        if (cached) {
            (await cached()).stageCopy(destPath);
            return;
        }
        await Bun.write(destPath, this.storage.read(storageKey));
    }

    // Replaces the container's data.db with the file at `sourcePath` — a snapshot the
    // caller grabbed into the OS temp dir (downloadToTemp) before the pre-restore
    // snapshot could prune it. Self-locked so a concurrent snapshot can't read a
    // half-written data.db. Closes the live db with skipFinalSnapshot (we're
    // discarding it, and snapshotting here would re-enter this lock), then deletes and
    // recreates — a fresh inode, because overwriting the file in place hands SQLite a
    // stale vnode (SQLITE_IOERR_VNODE) when the db is reopened.
    async replaceContainerDataDb(containerId: string, sourcePath: string): Promise<void> {
        return this.withPathLock(containerId, async () => {
            const file = Bun.file(sourcePath);
            // data.db is normally present, but a prior restore that crashed between the
            // delete and recreate below would leave it absent; tolerate that so simply
            // re-running restore self-heals instead of 404-ing forever. The fallback
            // mime matches provisionManagedDbs.
            const dataDb = await this.getChildByName(containerId, 'data.db');
            if (dataDb) {
                await this.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
                await this.deletePath(dataDb.id);
            }
            await this.createFile(containerId, 'data.db', dataDb?.mimeType ?? 'application/x-sqlite3', file.size, file);
        });
    }

    async touchFile(parentId: string, name: string, mimeType: string) {
        return this.createFile(parentId, name, mimeType, 0, undefined);
    }

    private async withPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T> {
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

    async updatePath(pathId: string, updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>): Promise<void> {
        // DrivePath uses boolean, Drizzle column uses integer
        const dbUpdates: Record<string, unknown> = { ...updates };
        if (updates.sharingRestricted !== undefined) {
            dbUpdates['sharingRestricted'] = updates.sharingRestricted ? 1 : 0;
        }

        if (updates.name !== undefined) {
            validateName(updates.name);
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

        if (updates.name !== undefined || updates.parentId !== undefined) {
            const current = await this.getPath(pathId);
            if (current) {
                const targetParent = updates.parentId ?? current.parentId;
                const targetName = updates.name ?? current.name;
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
                            await this.db
                                .update(paths)
                                .set({ ...dbUpdates, updatedAt: new Date() })
                                .where(eq(paths.id, pathId));
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

        await this.db
            .update(paths)
            .set({
                ...dbUpdates,
                updatedAt: new Date(),
            })
            .where(eq(paths.id, pathId));

        if (updates.parentId !== undefined) {
            await this.invalidateSizesFrom(oldParentId ?? null);
            await this.invalidateSizesFrom(updates.parentId);
        }
    }

    private async getStorageKey(pathId: string): Promise<string> {
        if (!this.isPathBased) {
            const row = await this.db.select({ file: paths.file }).from(paths).where(eq(paths.id, pathId)).get();
            return row?.file || pathId;
        }
        return this.resolveStoragePath(pathId);
    }

    private async resolveStoragePath(pathId: string): Promise<string> {
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
        await this.closeCachedDbsUnder(pathId);

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

    async trashPath(pathId: string): Promise<DrivePath> {
        const item = await this.getPath(pathId);
        if (!item) throw new ApiError(404, 'Path not found');
        if (item.parentId === null) throw new ApiError(400, 'Cannot trash root folder');

        const root = await this.getRootFolder();
        if (!root) throw new ApiError(500, 'Root folder not found');

        // Flush + close cached DBs BEFORE the storage rename, so their final bytes are written to the
        // current location and then moved into .trash/ with everything else — and so no post-trash
        // sync writes a data.db outside .trash/ (a chat's data.db is never closed by the collab path).
        await this.closeCachedDbsUnder(pathId);

        return this.withPathLock(pathId, async () => {
            // Path-based storage: move file/folder to .trash/
            let trashKey: string | undefined;
            if (this.isPathBased && this.storage.rename) {
                const oldKey = await this.resolveStoragePath(pathId);
                trashKey = `.trash/${buildStorageKey(pathId, item.name)}`;
                await this.storage.rename(oldKey, trashKey);
            }

            // Direct DB update — do NOT use updatePath()
            const now = new Date();
            await this.db
                .update(paths)
                .set({
                    trashedAt: now,
                    trashedFrom: item.parentId,
                    parentId: root.id,
                    ...(trashKey !== undefined ? { file: trashKey } : {}),
                    updatedAt: now,
                })
                .where(eq(paths.id, pathId));

            if (item.type !== 'file') {
                this.trashDescendants(pathId, now);
            }

            await this.invalidateSizesFrom(item.parentId);

            const updated = await this.getPath(pathId);
            return updated!;
        });
    }

    async listTrash(): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(isNotNull(paths.trashedFrom))
            .orderBy(desc(paths.trashedAt))
            .all();

        return results.map((r) => this.toDrivePath(r));
    }

    // trashedFrom is trash bookkeeping, not part of DrivePath — permanentlyDelete
    // needs the original parent to notify the old folder's watchers.
    async getTrashedFrom(pathId: string): Promise<string | null> {
        const row = await this.db
            .select({ trashedFrom: paths.trashedFrom })
            .from(paths)
            .where(eq(paths.id, pathId))
            .get();
        return row?.trashedFrom ?? null;
    }

    async restorePath(pathId: string): Promise<DrivePath> {
        const row = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();
        if (!row) throw new ApiError(404, 'Path not found');
        if (!row.trashedFrom) throw new ApiError(400, 'Item is not in trash');

        const root = await this.getRootFolder();
        if (!root) throw new ApiError(500, 'Root folder not found');

        // Determine target parent
        let targetParentId = root.id;
        const originalParent = await this.getPath(row.trashedFrom);
        if (originalParent && !originalParent.trashedAt) {
            targetParentId = originalParent.id;
        }

        // Check name conflict and auto-rename if needed
        let restoreName = row.name;
        try {
            await this.assertUniqueName(targetParentId, restoreName, pathId);
        } catch {
            // Name conflict: generate unique name
            const siblings = await this.db
                .select({ name: paths.name })
                .from(paths)
                .where(and(eq(paths.parentId, targetParentId), isNull(paths.trashedAt)))
                .all();
            const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
            restoreName = getUniqueFileName(row.name, usedNames);
        }

        return this.withPathLock(pathId, async () => {
            // Path-based storage: move back from .trash/
            if (this.isPathBased && this.storage.rename) {
                const currentKey = await this.resolveStoragePath(pathId);
                const parentPath = await this.resolveStoragePath(targetParentId);
                const targetKey = parentPath ? `${parentPath}/${restoreName}` : restoreName;
                await this.storage.rename(currentKey, targetKey);
            }

            // Direct DB update
            const now = new Date();
            await this.db
                .update(paths)
                .set({
                    parentId: targetParentId,
                    trashedAt: null,
                    trashedFrom: null,
                    name: restoreName,
                    ...(this.isPathBased ? { file: restoreName } : {}),
                    updatedAt: now,
                })
                .where(eq(paths.id, pathId));

            if (row.type !== 'file') {
                this.restoreDescendants(pathId, now);
            }

            await this.invalidateSizesFrom(targetParentId);

            const updated = await this.getPath(pathId);
            return updated!;
        });
    }

    private collectDescendantIds(parentId: string): string[] {
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

    // Recursively set trashedAt on all non-trashed descendants
    private trashDescendants(parentId: string, now: Date): void {
        const epoch = Math.floor(now.getTime() / 1000);
        this.db.run(sql`
            WITH RECURSIVE descendants AS (
                SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
                UNION ALL
                SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
            )
            UPDATE ${paths}
            SET ${sql.raw('trashedAt')} = ${epoch}, ${sql.raw('updatedAt')} = ${epoch}
            WHERE id IN (SELECT id FROM descendants) AND ${paths.trashedAt} IS NULL
        `);
    }

    // Recursively clear trashedAt on descendants, skipping independently trashed items
    private restoreDescendants(parentId: string, now: Date): void {
        const epoch = Math.floor(now.getTime() / 1000);
        this.db.run(sql`
            WITH RECURSIVE descendants AS (
                SELECT id FROM ${paths} WHERE ${paths.parentId} = ${parentId}
                UNION ALL
                SELECT p.id FROM ${paths} p JOIN descendants d ON p.${sql.raw('parentId')} = d.id
            )
            UPDATE ${paths}
            SET ${sql.raw('trashedAt')} = NULL, ${sql.raw('updatedAt')} = ${epoch}
            WHERE id IN (SELECT id FROM descendants)
            AND ${paths.trashedAt} IS NOT NULL
            AND ${paths.trashedFrom} IS NULL
        `);
    }

    async permanentlyDeleteFromTrash(pathId: string): Promise<void> {
        const row = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();
        if (!row) return;
        if (!row.trashedAt) throw new ApiError(400, 'Item is not in trash');

        if (row.type !== 'file') {
            const descendantIds = this.collectDescendantIds(pathId);
            const allIds = [pathId, ...descendantIds];
            const orphans = await this.db
                .select({ id: paths.id })
                .from(paths)
                .where(
                    sql`${paths.trashedFrom} IN (${sql.join(
                        allIds.map((id) => sql`${id}`),
                        sql`, `,
                    )})`,
                )
                .all();
            for (const orphan of orphans) {
                await this.deletePath(orphan.id);
            }
        }

        await this.deletePath(pathId);
    }

    async purgeTrash(maxAgeDays?: number): Promise<void> {
        let items: DrivePath[];
        if (maxAgeDays !== undefined) {
            const cutoffEpoch = Math.floor((Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) / 1000);
            const results = await this.db
                .select()
                .from(paths)
                .where(sql`${paths.trashedFrom} IS NOT NULL AND ${paths.trashedAt} < ${cutoffEpoch}`)
                .all();
            items = results.map((r) => this.toDrivePath(r));
        } else {
            items = await this.listTrash();
        }
        for (const item of items) {
            await this.permanentlyDeleteFromTrash(item.id);
        }
    }

    async readFile(pathId: string): Promise<StorageFile | null> {
        const storageKey = await this.getStorageKey(pathId);
        // Freshest-first: an un-acked pending upload's frozen staged copy holds bytes newer than the
        // storage object (a just-created or outage-staged data.db whose PUT hasn't landed), so serve
        // it — copy/download must never capture stale/absent storage. A no-op for local mounts (no
        // queue) and regular files (never staged), and once an upload acks the row is gone and storage
        // is current. Safe for readFile's real callers: data.db is internal (never served to a user),
        // and a regular served file is never an open doc, so pending-staging-first can't serve stale
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
        const storageKey = await this.getStorageKey(pathId);
        const probe = this.storage.read(storageKey);
        if (!(await probe.exists())) return null;
        if (this.storage.readRange) return this.storage.readRange(storageKey, start, end);
        return probe.slice(start, end);
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
        await this.db
            .update(paths)
            .set({ size, hash, updatedAt: new Date(), contentDirty: 1 })
            .where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
        this.reindexQueue?.kick();
        return written;
    }

    // Overwrite using a temp file with size+hash already known (from writeTempWithHash).
    // Mirrors createFileFromTemp on the create side and avoids re-hashing.
    async writeFileFromTemp(pathId: string, tempId: string, size: number, hash: string): Promise<void> {
        const storageKey = await this.getStorageKey(pathId);
        await this.uploadFromTemp(storageKey, tempId);
        await this.db
            .update(paths)
            .set({ size, hash, updatedAt: new Date(), contentDirty: 1 })
            .where(eq(paths.id, pathId));
        await this.invalidateAncestorsOf(pathId);
        this.reindexQueue?.kick();
    }

    getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    // Download a stored file to a local temp path the caller can open directly
    // (e.g. reading a SQLite snapshot on any storage backend). Caller owns
    // cleanupTemp(pathId).
    async downloadToTemp(pathId: string): Promise<string> {
        return this.downloadKeyToTemp(await this.getStorageKey(pathId), pathId);
    }

    private async downloadKeyToTemp(storageKey: string, tempId: string): Promise<string> {
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

    private async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
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
            const file = Bun.file(this.getTempPath(tempId));
            if (await file.exists()) await file.delete();
        } catch {}
    }

    private get isRemote(): boolean {
        return this.config.storageType !== 'local-key' && this.config.storageType !== 'local';
    }

    private get isPathBased(): boolean {
        return this.config.storageType === 'local';
    }

    private get needsTempCopy(): boolean {
        return this.isRemote || this.isPathBased;
    }

    // Open an EXISTING managed document database. Throws ApiError(503) if the
    // backing storage object isn't there — never silently creates fresh.
    // Use createDatabase for the first-time provisioning instead.
    async openDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        return this.openDocumentDb(config, pathId, 'open');
    }

    // Provision a NEW managed document database. Asserts the storage object
    // does not already exist, creates fresh schema, and flushes to storage
    // before returning so subsequent openDatabase calls (incl. after API
    // restart) find a real object. Caller must touchFile() the path first.
    async createDatabase<S extends SchemaType>(config: DatabaseConfig<S>, pathId: string): Promise<ManagedDatabase<S>> {
        if (this.documentDbs.has(pathId)) {
            throw new Error(`Mount.createDatabase ${pathId}: already in cache`);
        }
        return this.openDocumentDb(config, pathId, 'create');
    }

    private async openDocumentDb<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
        mode: 'open' | 'create',
    ): Promise<ManagedDatabase<S>> {
        if (!this.documentDbs.has(pathId)) {
            this.documentDbs.set(
                pathId,
                createAsyncSingleton(async () => {
                    // Clean up the map entry if the factory throws — otherwise a
                    // failed createDatabase leaves a getter behind whose closed-over
                    // `mode` would silently steer the next openDatabase down the
                    // create path.
                    try {
                        return await this.buildDocumentDb(config, pathId, mode);
                    } catch (err) {
                        this.documentDbs.delete(pathId);
                        throw err;
                    }
                }),
            );
        }
        return this.documentDbs.get(pathId)!() as Promise<ManagedDatabase<S>>;
    }

    private async buildDocumentDb<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
        mode: 'open' | 'create',
    ): Promise<ManagedDatabase<S>> {
        const storageKey = await this.getStorageKey(pathId);
        const localPath = this.needsTempCopy ? this.getTempPath(pathId) : this.storage.getPath!(storageKey);

        if (mode === 'create') {
            if (await this.storage.exists(storageKey)) {
                throw new Error(`Mount.createDatabase ${pathId}: storage object ${storageKey} already exists`);
            }
        } else if (!this.needsTempCopy && !(await this.storage.exists(storageKey))) {
            throw new ApiError(503, `Storage object for ${pathId} not available`);
        }

        const onSnapshot: SyncCallbacks['onSnapshot'] = config.snapshot
            ? async () => {
                  const path = await this.getPath(pathId);
                  if (!path?.parentId) return; // standalone or already-deleted; skip
                  await this.snapshotContainerDataDb(path.parentId, config.snapshot!.policy);
              }
            : undefined;

        // Set when onOpen reuses a temp that survived an unclean shutdown — those bytes
        // never synced, so the DB must be force-dirtied after open (Phase 1a, below).
        let recoveredFromCrash = false;

        // Captured by onSync to VACUUM INTO-stage the live DB (Phase 1b).
        const managed = new ManagedDatabase(
            config,
            localPath,
            this.needsTempCopy
                ? {
                      onOpen: async () => {
                          if (mode === 'create') return;
                          const tempPath = this.getTempPath(pathId);
                          if (fs.existsSync(tempPath)) {
                              // A surviving temp signals an unclean shutdown. Adopt it as recovered live
                              // state ONLY if it's a real, non-collapsed SQLite. A 0-byte/partial/fresh-init
                              // temp (e.g. from a failed or empty S3 GET) must NOT be opened as an empty doc
                              // and re-uploaded over the good stored object (the 2026-06-08 wipe) — discard
                              // it and fall through to the authoritative copy.
                              const known = await this.getPath(pathId);
                              if (isViableRecoveryTemp(tempPath, known?.size ?? 0)) {
                                  console.log(`[Mount] Recovering from crash: using existing tmp file for ${pathId}`);
                                  recoveredFromCrash = true;
                                  return;
                              }
                              const tempSize = fs.statSync(tempPath).size;
                              console.warn(
                                  `[Mount] Discarding unusable crash temp for ${pathId} ` +
                                      `(temp=${tempSize}B, stored=${known?.size ?? 0}B); re-fetching from storage`,
                              );
                              fs.rmSync(tempPath, { force: true });
                          }
                          // Clean close during an outage: the live temp was cleaned but a staged
                          // copy holds bytes newer than storage (upload not yet acked). Recover
                          // from it rather than downloading a stale object.
                          if (this.uploadQueue) {
                              const staged = this.uploadQueue.getPendingStagingPath(storageKey);
                              if (staged && fs.existsSync(staged)) {
                                  console.log(`[Mount] Recovering from staged upload for ${pathId}`);
                                  await Bun.write(tempPath, Bun.file(staged));
                                  return;
                              }
                          }
                          if (!(await this.storage.exists(storageKey))) {
                              throw new ApiError(503, `Storage object for ${pathId} not available`);
                          }
                          await this.downloadKeyToTemp(storageKey, pathId);
                          // No empty-check here: a 0-byte/partial GET is caught by ManagedDatabase's
                          // mustExist guard (openCold refuses to open an empty working copy as a fresh db).
                      },
                      // isRemote: stage a frozen copy + enqueue, off the request/close path.
                      // Local path-based: keep the synchronous local copy (Bun.write never 503s,
                      // and async-queuing it would only weaken its on-completion durability).
                      onSync: async () => {
                          // Resolve the key on EVERY sync, never the once-captured one: on `local` it
                          // is the hierarchical path, so a move/rename since open would otherwise write
                          // data.db to the pre-move location (a zombie tree, silently rebuilt via
                          // createPath:true) and orphan every post-move edit. A vanished row means the
                          // doc was deleted — skip, so a stale sync can't resurrect a dead key.
                          // (s3/local-key keys are id-stable, so this re-resolves to the same value.)
                          if (!(await this.getPath(pathId))) return;
                          const currentKey = await this.getStorageKey(pathId);
                          if (this.uploadQueue) {
                              const stagingPath = this.uploadQueue.newStagingPath();
                              managed.stageCopy(stagingPath);
                              this.uploadQueue.enqueueStaged(currentKey, stagingPath);
                          } else {
                              await this.uploadFromTemp(currentKey, pathId);
                          }
                          await this.syncDocumentDbSize(pathId, localPath);
                          await this.markContainerContentDirty(pathId);
                      },
                      // onClose runs after wal_checkpoint(TRUNCATE), so the final stat captures
                      // any pages PASSIVE left in WAL. cleanupTemp is safe under async: the
                      // staged copy (not the live temp) is the upload payload.
                      onClose: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                          await this.cleanupTemp(pathId);
                      },
                      onSnapshot,
                  }
                : {
                      onSync: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                          await this.markContainerContentDirty(pathId);
                      },
                      onClose: async () => {
                          await this.syncDocumentDbSize(pathId, localPath);
                      },
                      onSnapshot,
                  },
            mode === 'open',
        );

        await managed.open();

        // Phase 1a (crash-recovery durability): a surviving temp means a prior process
        // died before its writes synced. The fresh connection's total_changes() reset to
        // 0, so the DB looks clean and the close-time cleanupTemp would silently drop
        // those bytes (the most plausible cause of the 2026-05-30 chat loss). Force the
        // next sync so they re-reach storage. Safe because a clean close always
        // cleanupTemp's the temp — a surviving temp is always an unclean-shutdown signal.
        if (recoveredFromCrash) {
            managed.markDirty();
        }

        // For temp-copy backends (s3, path-based local), push the
        // freshly-created schema to storage before returning.
        // Local-key writes go straight to the backing file so no
        // flush is needed. Without this, the storage object only
        // appears on the next 30s sync — and an API restart in
        // that window would make subsequent strict openDatabase
        // calls throw.
        if (mode === 'create' && this.needsTempCopy) {
            await managed.flush();
        }

        return managed;
    }

    async closeDatabase(pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const getter = this.documentDbs.get(pathId);
        if (getter) {
            // Delete BEFORE closing — a concurrent openDatabase() during the async
            // close must create a fresh ManagedDatabase, not reuse the closing one.
            this.documentDbs.delete(pathId);
            const db = await getter();
            await db.close(opts);
        }
    }

    // Flush + close every cached document DB at or below `rootId` (the container's own data.db, its
    // comments.db, any nested doc/chat). The documentDbs cache is otherwise decoupled from row
    // mutations — trash/delete change rows without it noticing — so a still-open dirty DB keeps its
    // 30s timer alive and syncs data.db to the pre-mutation key: a zombie tree on `local`, a
    // resurrected object on `s3`. Callers invoke this while the rows still exist (the walk needs
    // them): trashPath before the storage rename so the final bytes ride into .trash/ with the rest;
    // deletePath before the row/storage removal so cancel()/deleteDir() then clears what was flushed.
    // Yjs collab docs are already torn down by Drive.closeCollabDocumentsRecursively; this catches
    // the rest (chat data.db, comments.db). skipFinalSnapshot: the container is going away, and a
    // snapshot would re-enter its path lock.
    private async closeCachedDbsUnder(rootId: string): Promise<void> {
        for (const id of [rootId, ...this.collectDescendantIds(rootId)]) {
            if (this.documentDbs.has(id)) {
                await this.closeDatabase(id, { skipFinalSnapshot: true });
            }
        }
    }

    async closeAllDatabases(): Promise<void> {
        // Cancel the init-scheduled history prune so a fast teardown doesn't fire it against a
        // metadata.db the Home is about to close (the mount stops its own timers here — the same seam
        // as the upload/reindex queues below).
        if (this.pruneTimer) {
            clearTimeout(this.pruneTimer);
            this.pruneTimer = null;
        }

        // Reindex FIRST, awaiting its in-flight drain: an extract mid-await opens a doc DB via
        // openDatabase and leaves it for the mount lifecycle to close. Draining before we snapshot
        // documentDbs means that last-extract DB lands in the map and is closed by the pass below —
        // closing the queue last (after the clear) would let the post-clear open leak (30s timer, fd,
        // temp; dirty syncs into a closed metadata.db). Leftover dirty rows still replay on the next
        // open (only the current extract is drained, not the backlog).
        await this.reindexQueue?.close();

        const entries = [...this.documentDbs.entries()];
        this.documentDbs.clear();
        for (const [pathId, getter] of entries) {
            try {
                const db = await getter();
                await db.close(); // isRemote: onClose-time sync stages + enqueues the final state
            } catch (err) {
                console.error(`[Mount] closeAllDatabases close failed for ${pathId}:`, err);
            }
        }

        if (this.uploadQueue) {
            // Process shutdown only: flush the queue (bounded by the global deadline) AFTER the
            // final close-time enqueues, so healthy uploads finish before metadata.db closes.
            // Idle teardown leaves the deadline null and skips the flush — leftover pending rows
            // replay on the next mount open. Then stop the queue (cancels its retry timer).
            const deadline = getShutdownDrainDeadline();
            if (deadline !== null) {
                await this.uploadQueue
                    .drain({ flushNow: true, deadline })
                    .catch((e) => console.error(`[Mount] shutdown drain failed:`, e));
            }
            this.uploadQueue.close();
        }
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

    async getPathsByMimeType(
        mimeTypePrefix: string,
        options?: {
            excludeDocumentChildren?: boolean;
        },
    ): Promise<DrivePath[]> {
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

    upsertPathContent(pathId: string, body: string): void {
        this.db.run(sql`
            INSERT INTO path_content (pathId, body) VALUES (${pathId}, ${body})
            ON CONFLICT(pathId) DO UPDATE SET body = excluded.body
        `);
    }

    clearPathContent(pathId: string): void {
        this.db.run(sql`DELETE FROM path_content WHERE pathId = ${pathId}`);
    }

    // Indexable rows whose body is stale: dirty AND (never indexed OR indexed longer ago than
    // the cap). The dirty bit is only ever set on a real body write, so this is the work-list;
    // `limit` keeps one drain turn (and its id-hydrate) bounded.
    getContentDirtyPaths(reindexCapSeconds: number, limit: number): DrivePath[] {
        const dirty = this.db.all(sql`
            SELECT id FROM paths
            WHERE contentDirty = 1
              AND trashedAt IS NULL
              AND (contentIndexedAt IS NULL OR contentIndexedAt < (unixepoch() - ${reindexCapSeconds}))
            LIMIT ${limit}
        `) as { id: string }[];
        if (dirty.length === 0) return [];
        const ids = dirty.map((r) => r.id);
        const rows = this.db.select().from(paths).where(inArray(paths.id, ids)).all();
        return rows.map((r) => this.toDrivePath(r));
    }

    // Epoch ms when the earliest not-yet-due dirty row becomes eligible, or null if none are
    // dirty. A never-indexed row reads as due-now (0) so a row that slipped in mid-drain is never
    // stranded. Drives the reindexer's self-timer in place of a poll.
    earliestPendingReindexAt(reindexCapSeconds: number): number | null {
        const row = this.db.all(sql`
            SELECT MIN(CASE WHEN contentIndexedAt IS NULL THEN 0 ELSE contentIndexedAt + ${reindexCapSeconds} END) AS dueSec
            FROM paths
            WHERE contentDirty = 1 AND trashedAt IS NULL
        `) as { dueSec: number | null }[];
        const dueSec = row[0]?.dueSec;
        return dueSec == null ? null : dueSec * 1000;
    }

    markContentIndexed(pathId: string): void {
        this.db.update(paths).set({ contentDirty: 0, contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
    }

    // A failed extract stamps the attempt time but keeps contentDirty = 1, so the cap window defers the
    // retry to a later drain instead of dropping the doc from body search (see the reindex catch).
    markContentIndexAttempted(pathId: string): void {
        this.db.update(paths).set({ contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
    }

    searchPaths(opts: { q: string; limit: number }): DrivePath[] {
        const match = sanitizeFtsQuery(opts.q);
        if (!match) return [];

        // Pass 1a: name hits, FTS-ranked. docContainerDescendantIds keeps eigendoc internals
        // (data.db, embedded media, embedded chats) out — same exclusion as the body pass.
        const nameRanked = this.db.all(sql`
            SELECT p.id AS id
            FROM paths_fts
            JOIN paths p ON p.rowid = paths_fts.rowid
            WHERE paths_fts MATCH ${match}
              AND p.trashedAt IS NULL
              AND p.parentId IS NOT NULL
              AND p.parentId NOT IN (${docContainerDescendantIds})
            ORDER BY bm25(paths_fts), p.updatedAt DESC, p.id DESC
            LIMIT ${opts.limit}
        `) as { id: string }[];

        // Pass 1b: body hits via the sibling content index.
        const bodyRanked = this.db.all(sql`
            SELECT p.id AS id
            FROM paths_content_fts
            JOIN path_content pc ON pc.rowid = paths_content_fts.rowid
            JOIN paths p ON p.id = pc.pathId
            WHERE paths_content_fts MATCH ${match}
              AND p.trashedAt IS NULL
              AND p.parentId IS NOT NULL
              AND p.parentId NOT IN (${docContainerDescendantIds})
            ORDER BY bm25(paths_content_fts), p.updatedAt DESC, p.id DESC
            LIMIT ${opts.limit}
        `) as { id: string }[];

        // Merge: name hits first, then body-only hits. The name boost is structural — a
        // file whose name matches always outranks one matched only on body. Dedup by id.
        const seen = new Set<string>();
        const orderedIds: string[] = [];
        for (const r of [...nameRanked, ...bodyRanked]) {
            if (!seen.has(r.id)) {
                seen.add(r.id);
                orderedIds.push(r.id);
            }
        }
        const ids = orderedIds.slice(0, opts.limit);
        if (ids.length === 0) return [];

        // Pass 2: hydrate through Drizzle so timestamp columns come back as Date. Order
        // preserved via the id-keyed map.
        const rows = this.db.select().from(paths).where(inArray(paths.id, ids)).all();
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ids
            .map((id) => byId.get(id))
            .filter((r): r is NonNullable<typeof r> => r !== undefined)
            .map((r) => this.toDrivePath(r));
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

    private toDrivePath(row: typeof paths.$inferSelect): DrivePath {
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
            visibility: (row.visibility ?? 'private') as DriveVisibility,
            sharingRestricted: !!row.sharingRestricted,
            details: row.details ?? null,
            trashedAt: row.trashedAt ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
        };
    }

    // Update paths.size for a ManagedDatabase row from disk, then invalidate
    // ancestors — eigendoc containers stay in sync with data.db growth.
    private async syncDocumentDbSize(pathId: string, localPath: string): Promise<void> {
        if (!fs.existsSync(localPath)) {
            console.warn(`[Mount] syncDocumentDbSize ${pathId}: localPath missing at ${localPath}`);
            return;
        }
        const size = fs.statSync(localPath).size;
        await this.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, pathId));
        console.log(`[Mount] syncDocumentDbSize ${pathId} size=${size}`);
        await this.invalidateAncestorsOf(pathId);
    }

    private async invalidateAncestorsOf(pathId: string): Promise<void> {
        const row = await this.db.select({ parentId: paths.parentId }).from(paths).where(eq(paths.id, pathId)).get();
        if (row) await this.invalidateSizesFrom(row.parentId);
    }

    // A container's data.db just synced. Mark the CONTAINER (the data.db's parent) for
    // content re-extraction. Gated on the synced file being the primary `data.db` so
    // sibling DBs (e.g. comments.db) don't mark the parent. Touches ONLY contentDirty —
    // never name/updatedAt — so paths_fts is not churned.
    private async markContainerContentDirty(dataDbPathId: string): Promise<void> {
        const dataDb = await this.getPath(dataDbPathId);
        if (dataDb?.name !== 'data.db' || !dataDb.parentId) return;
        await this.db.update(paths).set({ contentDirty: 1 }).where(eq(paths.id, dataDb.parentId));
        this.reindexQueue?.kick();
    }

    // NULL the cached size on `parentId` and every ancestor up to the mount root.
    private async invalidateSizesFrom(parentId: string | null): Promise<void> {
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

export function createDefaultMountConfig(
    id: string = 'default',
    storageType: MountConfig['storageType'] = 'local',
): MountConfig {
    return {
        id,
        name: 'My Drive',
        storageType,
        isDefault: true,
        s3Config: storageType === 's3' ? getS3Config() : undefined,
    };
}

export function createMountConfig(id: string, settings: MountSettings): MountConfig {
    return {
        id,
        name: settings.name ?? (id === 'default' ? 'My Drive' : id),
        storageType: settings.storageType,
        isDefault: id === 'default',
        maxSizeMB: settings.maxSizeMB,
        s3Config: settings.s3Config ?? (settings.storageType === 's3' ? getS3Config() : undefined),
    };
}
