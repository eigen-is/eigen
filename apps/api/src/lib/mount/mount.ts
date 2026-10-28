// A Mount is one storage root of a Drive, such as a user's default drive or one team drive. Its
// metadata.db holds the tree of files and folders, and a storage backend holds the bytes, such as name
// paths on local disk or objects in an S3 bucket. Drive calls it for every file read and change, and a
// backup opens one to read a mount the home does not serve. Some of its work lives in sibling modules,
// such as trash, copy, search and the document databases.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSearchableTextFile } from '@workspace/lib/constants';
import { CHATS_FOLDER_NAME } from '@workspace/lib/types/chat';
import type { DriveContainerType, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER, DRIVE_TYPE_FOLDER, EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import type { MountConfig } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { CONTROL_CHARS } from '@workspace/lib/validation';
import type { BunFile } from 'bun';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { RWLock } from '../../utils/rw-lock';
import { PATHS } from '../config/paths';
import { getServerSettings } from '../config/server-settings';
import type { DatabaseConfig, ManagedDatabase, SchemaType } from '../core';
import { ApiError, computeEtag, matchesIfMatch, StaleWriteError, storageGone } from '../core';
import { FileHistory } from '../drive/history';
import { deleteThumbnail } from '../shared/thumbnails';
import type { StorageBackend, StorageFile } from '../storage';
import { isMissingObjectCause, readStorageFile, writeTempWithHash } from '../storage';
import type { RetentionPolicy } from '../versioning/retention';
import * as snapshot from '../versioning/snapshot';
import type { ContentExtractor } from './content-reindex-queue';
import { ContentReindexQueue } from './content-reindex-queue';
import * as copy from './copy';
import { MOUNT_DB_CONFIG } from './db-config';
import type { DocumentDbSlot } from './document-db';
import * as documentDb from './document-db';
import {
    ancestorIds,
    buildUploadDestinationKey,
    createMountStorage,
    docContainerDescendantIds,
    nameTakenError,
    renameThenWriteRow,
    rethrowPathWriteError,
} from './helpers';
import { buildStorageKey, foldName, isReservedName, trashStorageKey, validateName } from './names';
import type * as schema from './schema';
import { paths } from './schema';
import * as searchIndex from './search-index';
import * as trash from './trash';
import { UploadQueue } from './upload-queue';

type LocalDatabaseGetter = <S extends SchemaType>(
    config: DatabaseConfig<S>,
    relativePath: string,
) => Promise<ManagedDatabase<S>>;

type Tx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

type FolderLocks = { paths: Map<string, Promise<void>>; tree: RWLock };

// The locks belong to the mount's folder, not to one Mount object. A backup opens its own Mount of a
// disabled mount, and turning a mount on or giving it new storage builds a new one. Each of them must
// wait on the same locks as the Mount the drive serves. An entry is small and stays for the process.
const folderLocks = new Map<string, FolderLocks>();

function locksFor(folder: string): FolderLocks {
    let locks = folderLocks.get(folder);
    if (!locks) {
        locks = { paths: new Map(), tree: new RWLock() };
        folderLocks.set(folder, locks);
    }
    return locks;
}

// A walk up the tree throws this when it meets a folder twice. No write makes a parentId loop, but a
// corrupt table can hold one, and the walk must still end.
function treeCycleError(id: string): ApiError {
    return new ApiError(500, `Folder tree has a cycle at ${id}`);
}

export class Mount {
    public readonly id: string;
    public readonly config: MountConfig;
    public storage: StorageBackend;
    public db!: BunSQLiteDatabase<typeof schema>;
    public history!: FileHistory;

    // The open document databases by path id. A slot also queues the opens and closes of its path.
    public documentDbs: Map<string, DocumentDbSlot> = new Map();
    // Set once by closeAllDatabases. From then on every document database open is refused.
    public closing = false;

    // Only an s3 mount has an upload queue. It takes staged copies, such as document databases, to the
    // bucket in the background.
    public uploadQueue?: UploadQueue;
    // init builds the reindex queue only when Drive passes a content extractor. The extractor is
    // passed in so the document loaders stay out of this module's imports.
    public reindexQueue?: ContentReindexQueue;

    // init schedules the history prune after it returns. The timer is kept so a fast teardown can
    // cancel it before the Home closes metadata.db.
    public pruneTimer: ReturnType<typeof setTimeout> | null = null;
    // The purge of expired trash that init starts. closeAllDatabases stops it between items and waits
    // for it, so no row delete runs against a closed metadata.db.
    public trashPurge?: Promise<void>;
    // Thumbnail jobs run in the background. closeAllDatabases waits for them, so no sharp worker or
    // row update outlives metadata.db.
    public thumbnailJobs = new Set<Promise<void>>();
    // Aborted at teardown, so no close or Home shutdown waits on a download or an extraction read.
    public readonly downloads = new AbortController();

    private readonly ownerId: string;
    private readonly baseDir: string;
    private readonly getLocalDatabase: LocalDatabaseGetter;
    private readonly extractContent?: ContentExtractor;
    // One map holds three kinds of lock key: a path id, a folder id with a folded name for a create, and
    // the one key that permanent deletes share. Ids are UUIDs, so the kinds never collide.
    private readonly pathLocks: Map<string, Promise<void>>;
    private readonly treeLock: RWLock;

    public constructor(
        ownerId: string,
        baseDir: string,
        config: MountConfig,
        getLocalDatabase: LocalDatabaseGetter,
        extractContent?: ContentExtractor,
    ) {
        this.ownerId = ownerId;
        this.id = config.id;
        this.config = config;
        this.baseDir = path.join(baseDir, PATHS.DRIVE.ROOT, config.id);
        ({ paths: this.pathLocks, tree: this.treeLock } = locksFor(this.baseDir));
        this.getLocalDatabase = getLocalDatabase;
        this.extractContent = extractContent;

        this.storage = createMountStorage(config, this.baseDir);
    }

    // Read from the config each time, so a rename in the settings shows without a rebuild.
    public get name(): string {
        return this.config.name;
    }

    public get dataDir(): string {
        return path.join(this.baseDir, PATHS.DRIVE.DATA_DIR);
    }

    public get thumbsDir(): string {
        return path.join(this.baseDir, PATHS.DRIVE.THUMBS_DIR);
    }

    public get tmpDir(): string {
        return path.join(this.baseDir, PATHS.DRIVE.TMP_DIR);
    }

    public get previewsDir(): string {
        return path.join(this.tmpDir, PATHS.DRIVE.PREVIEWS_DIR);
    }

    // The staged copies of pending uploads live here and not in tmpDir. The stale-file sweep of tmpDir
    // must never remove a copy whose upload has not landed yet.
    public get stagingDir(): string {
        return path.join(this.baseDir, PATHS.DRIVE.STAGING_DIR);
    }

    private get trashDir(): string {
        return path.join(this.dataDir, '.trash');
    }

    public get isRemote(): boolean {
        return this.config.storageType === 's3';
    }

    // On `local` a storage key is the item's name path, so a rename or move also moves the bytes.
    public get isPathBased(): boolean {
        return this.config.storageType === 'local';
    }

    // A document database is opened from a temp copy, except on `local-key`, where the stored file is
    // opened in place.
    public get needsTempCopy(): boolean {
        return this.isRemote || this.isPathBased;
    }

    // How many uploads on this mount still wait for the bucket to accept them.
    public get pendingUploadCount(): number {
        return this.uploadQueue?.pendingCount ?? 0;
    }

    // ---- Lifecycle ----

    // `passive` opens a mount the home does not serve, for reading only. A backup archives a disabled
    // mount through this same code and must not turn it back on. So a passive init creates no folders,
    // writes no root row, and starts no queue, sweep, purge or prune. It does build the upload queue
    // object, because that answers whether a staged copy is newer than the stored object
    // (pendingStagedCopy). Only reconcile() uploads, and a passive init never calls it.
    public async init(opts?: { passive?: boolean }): Promise<void> {
        const passive = opts?.passive === true;
        if (!passive) {
            const dirs = [this.thumbsDir, this.previewsDir];
            if (this.isRemote) dirs.push(this.stagingDir);
            if (this.isPathBased) dirs.push(this.trashDir);
            for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
        }

        const dbPath = path.join(PATHS.DRIVE.ROOT, this.config.id, PATHS.DRIVE.METADATA_DB);
        const managedDb = await this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath);
        this.db = managedDb.db;
        this.history = new FileHistory(this.db, this.ownerId, this.id);

        // The destination key puts all uploads to one provider on one concurrency limiter, so a slow
        // bucket can't hold up uploads to another one.
        const destinationKey = buildUploadDestinationKey(this.config);
        if (destinationKey) {
            this.uploadQueue = new UploadQueue({
                db: this.db,
                storage: this.storage,
                stagingDir: this.stagingDir,
                destinationKey,
                label: this.id,
            });
        }

        if (passive) return;

        await this.ensureRootFolder();

        // Pending uploads resume before the tmp sweep below. Their staged copies live in stagingDir,
        // which the sweep never touches.
        this.uploadQueue?.reconcile();

        // The dirty bit on each row is the reindex queue. Rows left dirty by a backfill or an unclean
        // shutdown drain now, the same way pending uploads resume.
        if (this.extractContent) {
            this.reindexQueue = new ContentReindexQueue({ mount: this, extract: this.extractContent, label: this.id });
            this.reindexQueue.kick();
        }

        // A temp file older than an hour is left over from an interrupted upload or a crash. An open
        // document's crash-recovery copy stays (see cleanupStaleFiles).
        this.cleanupStaleFiles(this.tmpDir, 60 * 60 * 1000, true);
        this.cleanupStaleFiles(this.previewsDir, 7 * 24 * 60 * 60 * 1000);

        const retentionDays = getServerSettings().quotas.trashRetentionDays;
        if (retentionDays > 0) {
            this.trashPurge = this.purgeTrash(retentionDays).catch((e) =>
                console.error(`[Mount] Failed to purge expired trash:`, e),
            );
        }
        // The prune scans whole tables, so it runs after the mount is ready.
        this.pruneTimer = setTimeout(() => {
            this.pruneTimer = null;
            try {
                this.history.prune();
            } catch (e) {
                console.error('[Mount] Failed to prune file history:', e);
            }
        }, 0);
    }

    public async closeAllDatabases(): Promise<void> {
        return documentDb.closeAllDatabases(this);
    }

    // A settings change that keeps the storage applies here: the name and the quota. The storage
    // type and the S3 settings are bound to this.storage and the upload queue when the Mount is
    // built, so new storage needs a new Mount (Drive.updateMount).
    public applyConfig(config: MountConfig): void {
        this.config.name = config.name;
        this.config.maxSizeMB = config.maxSizeMB;
    }

    private async ensureRootFolder(): Promise<void> {
        const root = await this.db.select().from(paths).where(isNull(paths.parentId)).get();
        if (root) return;

        const rootId = crypto.randomUUID();
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

        // Only a user's default drive starts with a chats folder. Other mounts get one when they first
        // need it (Drive.ensureChatsFolder).
        if (this.config.isDefault && parseOwnerId(this.ownerId).type === 'user') {
            await this.createFolder(rootId, CHATS_FOLDER_NAME);
        }
    }

    private cleanupStaleFiles(dir: string, maxAgeMs: number, preserveLivePathIds = false): void {
        try {
            const cutoff = Date.now() - maxAgeMs;
            // An open document's working copy sits in tmpDir under its data.db path id (getTempPath).
            // After a long downtime it is older than maxAgeMs, but crash recovery adopts it only when the
            // document opens next. So an entry named after a live path id stays, or the sweep would delete
            // the last unsynced edits. Other temps use random ids that never match a row, so they go.
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
                // A crash temp's journals hold its unsynced tail, so they stay with it.
                if (liveIds?.has(entry.replace(/-(wal|shm|journal)$/, ''))) continue;
                const filePath = path.join(dir, entry);
                try {
                    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
                } catch {}
            }
        } catch {}
    }

    // ---- Reading the tree ----

    public async getRootFolder(): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(isNull(paths.parentId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    public async getPath(pathId: string): Promise<DrivePath | null> {
        const result = await this.db.select().from(paths).where(eq(paths.id, pathId)).get();

        return result ? this.toDrivePath(result) : null;
    }

    public async getActivePath(pathId: string): Promise<DrivePath> {
        const path = await this.getPath(pathId);
        if (!path) throw new ApiError(404, 'Path not found');
        if (path.trashedAt) throw new ApiError(404, 'File is in trash');
        return path;
    }

    public async listFolder(parentId: string): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
            .all();

        return results.map((r) => this.toDrivePath(r));
    }

    public async listFolderAll(parentId: string): Promise<DrivePath[]> {
        const results = await this.db.select().from(paths).where(eq(paths.parentId, parentId)).all();
        return results.map((r) => this.toDrivePath(r));
    }

    public async getChildByName(parentId: string, name: string): Promise<DrivePath | null> {
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

    public async resolvePath(pathStr: string): Promise<DrivePath | null> {
        const segments = pathStr
            .split('/')
            .filter((s) => s.length > 0)
            .map((s) => s.normalize('NFC'));
        if (segments.some((seg) => seg === '..' || seg === '.' || CONTROL_CHARS.test(seg))) {
            throw new ApiError(400, 'Invalid path');
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

    // Only a copy needs this check, because copyPath would recurse forever. A move checks inside the
    // transaction of its row write (assertMovableInTx).
    public async isSelfOrDescendant(ancestorId: string, candidateId: string): Promise<boolean> {
        if (ancestorId === candidateId) return true;
        const seen = new Set<string>();
        let current = await this.getPath(candidateId);
        while (current?.parentId) {
            if (seen.has(current.id)) throw treeCycleError(current.id);
            seen.add(current.id);
            if (current.parentId === ancestorId) return true;
            current = await this.getPath(current.parentId);
        }
        return false;
    }

    public collectDescendantIds(parentId: string): string[] {
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

    public async getBreadcrumb(pathId: string): Promise<DrivePath[]> {
        const [crumbs] = await this.getBreadcrumbs([pathId]);
        return crumbs;
    }

    // One chain per id, in the order given, each from the root down. An id with no row gets [].
    public async getBreadcrumbs(pathIds: string[]): Promise<DrivePath[][]> {
        if (pathIds.length === 0) return [];
        const rows = await this.db
            .select()
            .from(paths)
            .where(sql`${paths.id} IN (${ancestorIds(...pathIds)})`)
            .all();

        const byId = new Map(rows.map((r) => [r.id, this.toDrivePath(r)]));
        return pathIds.map((pathId) => {
            const ordered: DrivePath[] = [];
            const seen = new Set<string>();
            let current = byId.get(pathId);
            while (current) {
                if (seen.has(current.id)) throw treeCycleError(current.id);
                seen.add(current.id);
                ordered.unshift(current);
                current = current.parentId ? byId.get(current.parentId) : undefined;
            }
            return ordered;
        });
    }

    // The insides of a document container, such as its data.db and media, are never listed.
    public async getPathsByMimeType(mimeTypePrefix: string): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(
                and(
                    sql`${paths.mimeType} LIKE ${`${mimeTypePrefix}%`}`,
                    isNull(paths.trashedAt),
                    sql`${paths.parentId} NOT IN (${docContainerDescendantIds})`,
                ),
            )
            .all();
        return results.map((r) => this.toDrivePath(r));
    }

    public async getPathsWithACL(): Promise<DrivePath[]> {
        const results = await this.db
            .select()
            .from(paths)
            .where(and(sql`${paths.acl} IS NOT NULL AND json_array_length(${paths.acl}) > 0`, isNull(paths.trashedAt)))
            .all();
        return results.map((r) => this.toDrivePath(r));
    }

    // A folder whose cached size was cleared gets it computed and stored again here, so a plain read
    // can write.
    public toDrivePath(row: typeof paths.$inferSelect): DrivePath {
        let size = row.size;
        if (row.type !== 'file' && size === null) {
            size = this.db.transaction((tx) => this.computeFolderSizeInTx(tx, row.id));
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
            sharingRestricted: row.sharingRestricted,
            details: row.details ?? null,
            trashedAt: row.trashedAt ?? null,
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
        };
    }

    // SQLite's LOWER() folds ASCII only. A case-insensitive disk such as APFS also treats non-ASCII
    // case pairs as one file, so on `local` those names must match too (foldName).
    // It runs only for a non-ASCII name on `local`. Every other lookup keeps SQLite's fold, and the
    // unique index stays the safety net for races. An ASCII name whose stored twin is not ASCII still
    // passes, such as strasse beside straße. On `local` the disk check of a create, rename, move or
    // restore catches those (trash.renameTarget).
    private async findCaseFoldedChild(parentId: string, name: string): Promise<{ id: string } | null> {
        if (!this.isPathBased || !/\P{ASCII}/u.test(name)) return null;
        const folded = foldName(name);
        const siblings = await this.db
            .select({ id: paths.id, name: paths.name })
            .from(paths)
            .where(and(eq(paths.parentId, parentId), isNull(paths.trashedAt)))
            .all();
        return siblings.find((s) => foldName(s.name) === folded) ?? null;
    }

    // ---- Creating ----

    public async createFolder(parentId: string, name: string, type: DriveContainerType = 'folder'): Promise<string> {
        name = validateName(name);
        const folderId = crypto.randomUUID();
        // A document container takes its mime type from the eigendoc registry. Only a plain folder has
        // no entry there.
        const mimeType = type === DRIVE_TYPE_FOLDER ? DRIVE_MIME_FOLDER : EIGEN_DOC_TYPE_INFO[type].mime;
        const fileValue = this.isPathBased ? name : '';

        await this.withCreateLock(parentId, name, async () => {
            this.assertLiveFolder(folderId, parentId);
            // Checked under the lock, because on `local` a rename that took the lock first owns the
            // key this create would replace.
            await this.assertUniqueName(parentId, name);
            if (this.isPathBased && this.storage.mkdir) {
                const key = await this.resolveWriteKey(parentId, fileValue);
                await this.claimCreateKey(parentId, key, folderId, name);
                await this.storage.mkdir(key);
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
        });

        return folderId;
    }

    public async createFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined,
    ): Promise<string> {
        name = validateName(name);
        const hash = data !== undefined ? await this.computeHash(data) : null;
        return this.insertFile(parentId, name, mimeType, size, hash, async (storageKey) => {
            if (data !== undefined) await this.storage.write(storageKey, data);
        });
    }

    public async createFileFromTemp(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        hash: string,
        tempId: string,
    ): Promise<string> {
        return this.insertFile(parentId, validateName(name), mimeType, size, hash, (storageKey) =>
            this.uploadFromTemp(storageKey, tempId),
        );
    }

    // An empty file row with no bytes yet, such as the one createDatabase then fills.
    public async touchFile(parentId: string, name: string, mimeType: string): Promise<string> {
        return this.createFile(parentId, name, mimeType, 0, undefined);
    }

    // The name is validated already. writeBytes puts the bytes at the new storage key.
    private async insertFile(
        parentId: string,
        name: string,
        mimeType: string,
        size: number,
        hash: string | null,
        writeBytes: (storageKey: string) => Promise<void>,
    ): Promise<string> {
        const fileId = crypto.randomUUID();
        const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);

        const searchable = isSearchableTextFile(mimeType, name);
        await this.withCreateLock(parentId, name, async () => {
            this.assertLiveFolder(fileId, parentId);
            // Checked under the lock, because on `local` a rename that took the lock first owns the
            // key this create would replace.
            await this.assertUniqueName(parentId, name);
            const storageKey = await this.resolveWriteKey(parentId, fileValue);
            await this.claimCreateKey(parentId, storageKey, fileId, name);
            // The bytes land before the row. After a crash, bytes no row owns do less harm than a row
            // whose bytes are missing.
            await writeBytes(storageKey);

            try {
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
            } catch (e) {
                // Off `local` the key is this create's own, so no other row can need the object.
                if (!this.isPathBased) {
                    await this.removeObject(fileId, storageKey).catch((err) =>
                        console.error(`[Mount] Could not remove the object of failed create ${fileId}:`, err),
                    );
                }
                throw e;
            }
        });

        await this.invalidateSizesFrom(parentId);
        if (searchable) this.reindexQueue?.markDirty(fileId);

        return fileId;
    }

    private async assertUniqueName(parentId: string, name: string, excludeId?: string): Promise<void> {
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
            throw nameTakenError(name);
        }
    }

    // A create checks its folder before it writes any bytes. A folder that went to the trash while the
    // create waited is a 404, the same as for a move. On `local` the create then holds the tree lock
    // shared, so no trash can land before its row is in.
    private assertLiveFolder(id: string, parentId: string): void {
        const error = this.db.transaction((tx) => this.targetFolderErrorInTx(tx, id, parentId));
        if (error) throw error;
    }

    // assertUniqueName's SELECT leaves a race open: two creates can both pass it before either inserts.
    // Off `local` no lock keeps a trash or a permanent delete of the folder out of a create either. So
    // the folder is checked again in the transaction of the insert.
    private async insertPathRow(values: typeof paths.$inferInsert): Promise<void> {
        try {
            this.db.transaction((tx) => {
                const error = this.targetFolderErrorInTx(tx, values.id, values.parentId ?? null);
                if (error) throw error;
                tx.insert(paths).values(values).run();
            });
        } catch (e) {
            rethrowPathWriteError(e, values.name);
        }
    }

    // On `local` a new key is the parent's key plus the name. Other backends use the file value as it is.
    private async resolveWriteKey(parentId: string, fileValue: string): Promise<string> {
        if (!this.isPathBased) return fileValue;
        const parentKey = await this.getStorageKey(parentId);
        return parentKey ? `${parentKey}/${fileValue}` : fileValue;
    }

    // Runs under the tree lock, right before a create writes. On `local` the disk may fold a name the
    // table check missed (ſ onto s), and that is a 409. Bytes no row owns, left by a crash, would be
    // replaced by a write or adopted by a mkdir, so they are moved aside first.
    private async claimCreateKey(parentId: string, key: string, id: string, name: string): Promise<void> {
        if (!this.isPathBased || !this.storage.rename) return;
        const occupant = await trash.renameTarget(this, parentId, key);
        if (occupant === 'live') {
            throw nameTakenError(name);
        }
        if (occupant === 'leftover') {
            await trash.moveAside(this.storage.rename.bind(this.storage), key, trashStorageKey(id, name));
        }
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

    // ---- Renaming, moving and deleting ----

    public async updatePath(
        pathId: string,
        updates: Partial<Omit<DrivePath, 'id' | 'ownerId' | 'createdAt'>>,
    ): Promise<DrivePath> {
        // Validated first, so the row and the `local` storage key both get the name's NFC form.
        if (updates.name !== undefined) {
            updates.name = validateName(updates.name);
        }
        const values: Partial<typeof paths.$inferInsert> = { ...updates };

        // The name a racing rename or move would collide on. A sibling of that name can land between
        // assertUniqueName's SELECT and the UPDATE, and the unique index then refuses the UPDATE. It
        // stays empty only when neither the name nor the parent changes, and then the index can't fire.
        let targetName = updates.name ?? '';

        // The folder a move takes the row out of. It is read in the transaction that moves the row, so
        // a racing move can't make it stale, and the right folder sizes get cleared.
        let oldParentId: string | null = null;

        // Both branches below write the row this way. On `local` it runs once the bytes have moved, so
        // a refused disk rename writes nothing.
        const writeRow = async (): Promise<void> => {
            // A caller's updatedAt wins: collab stamps the time of the edit, not of the write.
            const set = { updatedAt: new Date(), ...values };
            const targetParentId = updates.parentId;
            try {
                if (updates.name === undefined && targetParentId === undefined) {
                    // An ACL goes only onto a live row. A trash can land after the caller checked the
                    // path, and a new sharee would then get the item, an email included, while it is
                    // in the trash.
                    const live = updates.acl !== undefined ? isNull(paths.trashedAt) : undefined;
                    const written = await this.db
                        .update(paths)
                        .set(set)
                        .where(and(eq(paths.id, pathId), live))
                        .returning({ id: paths.id })
                        .get();
                    if (live && !written) throw new ApiError(404, 'File is in trash');
                } else {
                    // One synchronous transaction, so no trash or opposite move lands between the checks
                    // and the UPDATE.
                    this.db.transaction((tx) => {
                        this.assertMovableInTx(tx, pathId, targetParentId);
                        const old = tx
                            .select({ parentId: paths.parentId })
                            .from(paths)
                            .where(eq(paths.id, pathId))
                            .get();
                        oldParentId = old?.parentId ?? null;
                        tx.update(paths).set(set).where(eq(paths.id, pathId)).run();
                    });
                }
            } catch (e) {
                rethrowPathWriteError(e, targetName);
            }
        };

        let wroteUnderLock = false;
        if (updates.name !== undefined || updates.parentId !== undefined) {
            const current = await this.getPath(pathId);
            if (current) {
                const targetParent = updates.parentId ?? current.parentId;
                targetName = updates.name ?? current.name;
                // A row named `.trash` from before the name rule must not move. At the mount root its
                // disk rename would land on the real trash folder, so it has to be renamed first. The
                // check uses targetName, so a move that also renames it away is fine.
                if (updates.parentId !== undefined && isReservedName(targetName)) {
                    throw new ApiError(400, `"${targetName}" is a reserved name`);
                }
                if (targetParent) {
                    await this.assertUniqueName(targetParent, targetName, pathId);
                }

                const renameFn = this.storage.rename;
                if (this.isPathBased && renameFn) {
                    wroteUnderLock = true;
                    await this.withPathLock(pathId, () =>
                        this.withTreeExclusive(async () => {
                            const oldPath = await this.getStorageKey(pathId);
                            // Only the root has the empty key. A rename or move of the root writes nothing.
                            if (!oldPath) return;
                            if (updates.name !== undefined) {
                                values.file = targetName;
                            }
                            const parentKey = updates.parentId
                                ? await this.getStorageKey(updates.parentId)
                                : path.posix.dirname(oldPath);
                            const newPath = path.posix.join(parentKey, values.file ?? path.posix.basename(oldPath));
                            if (oldPath === newPath) {
                                await writeRow();
                                return;
                            }
                            // Checked before the bytes move. A disk rename would replace a sibling that raced
                            // in at the target, and a rename into its own subtree throws a bare EINVAL.
                            this.db.transaction((tx) => this.assertMovableInTx(tx, pathId, updates.parentId));
                            const parentId = updates.parentId ?? (await this.getPath(pathId))?.parentId;
                            const newName = path.posix.basename(newPath);
                            const rename = renameFn.bind(this.storage);
                            if (parentId) {
                                await this.assertUniqueName(parentId, newName, pathId);
                                const occupant = await trash.renameTarget(this, parentId, newPath, oldPath);
                                if (occupant === 'live') {
                                    throw new ApiError(409, `"${newName}" is taken on disk by another item`);
                                }
                                if (occupant === 'leftover') {
                                    await trash.moveAside(rename, newPath, trashStorageKey(pathId, newName));
                                }
                            }
                            await renameThenWriteRow(rename, oldPath, newPath, writeRow);
                        }),
                    );
                }
            }
        }

        if (!wroteUnderLock) await writeRow();
        if (updates.parentId !== undefined) {
            await this.invalidateSizesFrom(oldParentId);
            await this.invalidateSizesFrom(updates.parentId);
        }

        // getPath, not getActivePath, because collab still updates a trashed document's row while it closes.
        const updated = await this.getPath(pathId);
        if (!updated) throw new ApiError(500, 'Path not found after update');
        return updated;
    }

    public async deletePath(pathId: string): Promise<void> {
        const pathEntry = await this.getPath(pathId);
        if (!pathEntry) return;
        if (pathEntry.parentId === null) throw new ApiError(400, 'Cannot delete root folder');

        // The cached databases under this subtree close first. A dirty one left open would stage its
        // dead key again on a later tick, and its temp file and timer would leak. The cancel and the
        // storage delete below then clear whatever the close flushed.
        await documentDb.closeCachedDbsUnder(this, pathId);

        // The rows go before the bytes, the mirror of a create. After a crash, bytes no row owns are
        // the safe leftover. A missing key, or no row deleted, means a delete of the same row got
        // there first.
        const deleteDir = this.storage.deleteDir;
        if (pathEntry.type === 'file') {
            await this.withTreeShared(async () => {
                const storageKey = await this.findStorageKey(pathId);
                if (storageKey === null) return;
                const deleted = await this.db
                    .delete(paths)
                    .where(eq(paths.id, pathId))
                    .returning({ id: paths.id })
                    .get();
                if (deleted) await this.removeObject(pathId, storageKey);
            });
        } else if (this.isPathBased && deleteDir) {
            await this.withTreeExclusive(async () => {
                const storageKey = await this.findStorageKey(pathId);
                if (storageKey === null) return;
                const files = this.db.transaction((tx) => this.deleteSubtreeInTx(tx, pathId));
                for (const { id } of files) {
                    await deleteThumbnail(this.thumbsDir, id);
                }
                if (storageKey && !(await deleteDir.call(this.storage, storageKey))) {
                    console.warn(`[Mount] deleted ${pathId}, but its folder ${storageKey} stays behind`);
                }
            });
        } else {
            // An id key does not depend on its folder, so every object goes after all the rows, as
            // for a single file.
            const files = this.db.transaction((tx) => this.deleteSubtreeInTx(tx, pathId));
            for (const { id, file } of files) await this.removeObject(id, file || id);
        }

        await this.invalidateSizesFrom(pathEntry.parentId);
    }

    // Refuses to move a row that is in trash. A trash may have landed while the move waited, and on
    // `local` the move would carry its bytes out of .trash/.
    private assertMovableInTx(tx: Tx, pathId: string, targetParentId: string | null | undefined): void {
        const row = tx.select({ trashedAt: paths.trashedAt }).from(paths).where(eq(paths.id, pathId)).get();
        if (row?.trashedAt) throw new ApiError(404, 'File is in trash');
        if (targetParentId === undefined) return;
        const error = this.targetFolderErrorInTx(tx, pathId, targetParentId);
        if (error) throw error;
    }

    // Why pathId can't go into targetParentId, or null when it can. A move or a restore runs this in the
    // transaction of its row write, and a restore also runs it to pick its folder. The target must not be in
    // the row's own subtree. No folder from the target up to the root may be in trash either: that answers
    // the 404 of a deleted folder, because the folder's permanent delete would take the row with it.
    // `seen` stops the walk on a tree that already has a cycle.
    public targetFolderErrorInTx(tx: Tx, pathId: string, targetParentId: string | null): ApiError | null {
        const seen = new Set<string>();
        let current = targetParentId;
        while (current) {
            if (current === pathId) {
                return new ApiError(400, 'Cannot move a folder into itself or its own descendant');
            }
            if (seen.has(current)) throw treeCycleError(current);
            seen.add(current);
            const row = tx
                .select({ parentId: paths.parentId, trashedAt: paths.trashedAt })
                .from(paths)
                .where(eq(paths.id, current))
                .get();
            if (!row || row.trashedAt) return new ApiError(404, 'Folder not found');
            current = row.parentId;
        }
        return null;
    }

    // Deletes the folder and everything under it. It returns the deleted files, because only a file
    // owns a thumbnail and an object, and those go after the rows.
    private deleteSubtreeInTx(tx: Tx, folderId: string): { id: string; file: string }[] {
        const children = tx
            .select({ id: paths.id, type: paths.type, file: paths.file })
            .from(paths)
            .where(eq(paths.parentId, folderId))
            .all();
        const files: { id: string; file: string }[] = [];
        for (const child of children) {
            if (child.type !== 'file') {
                files.push(...this.deleteSubtreeInTx(tx, child.id));
                continue;
            }
            files.push({ id: child.id, file: child.file });
            tx.delete(paths).where(eq(paths.id, child.id)).run();
        }
        tx.delete(paths).where(eq(paths.id, folderId)).run();
        return files;
    }

    // Every delete of one object ends here, such as a file's delete or a failed create. The queued upload
    // and its staged copy are canceled first, so a PUT in flight can't bring back the object this deletes.
    private async removeObject(pathId: string, storageKey: string): Promise<void> {
        await deleteThumbnail(this.thumbsDir, pathId);
        if (this.uploadQueue) await this.uploadQueue.cancel(storageKey);
        if (!(await this.storage.delete(storageKey))) {
            console.warn(`[Mount] deleted ${pathId}, but its object ${storageKey} stays behind`);
        }
    }

    // ---- Trash ----

    public async trashPath(pathId: string): Promise<DrivePath> {
        return trash.trashPath(this, pathId);
    }

    public async listTrash(): Promise<DrivePath[]> {
        return trash.listTrash(this);
    }

    public async getTrashedFrom(pathId: string): Promise<string | null> {
        return trash.getTrashedFrom(this, pathId);
    }

    public async listTrashRootsInside(folderId: string): Promise<DrivePath[]> {
        return trash.listTrashRootsInside(this, folderId);
    }

    public async restorePath(pathId: string): Promise<DrivePath> {
        return trash.restorePath(this, pathId);
    }

    public async permanentlyDeleteFromTrash(pathId: string): Promise<boolean> {
        return trash.permanentlyDeleteFromTrash(this, pathId);
    }

    public async purgeTrash(maxAgeDays: number): Promise<void> {
        return trash.purgeTrash(this, maxAgeDays);
    }

    // ---- Copy ----

    public async copyPath(
        srcPathId: string,
        destParentId: string,
        name: string,
        actor?: { id: string; email: string },
    ): Promise<DrivePath> {
        return copy.copyPath(this, srcPathId, destParentId, name, actor);
    }

    // ---- Storage keys ----

    // With no row, an id key is still the id, so a read of a deleted file finds no object. A name path
    // with no row is a 404. It must never be the root's empty key, or a create into a deleted folder
    // would write at the mount root.
    public async getStorageKey(pathId: string): Promise<string> {
        const storageKey = await this.findStorageKey(pathId);
        if (storageKey !== null) return storageKey;
        if (!this.isPathBased) return pathId;
        throw new ApiError(404, 'Path not found');
    }

    // Null once the row is gone. It is for a caller that races a permanent delete, which takes no path lock.
    public async findStorageKey(pathId: string): Promise<string | null> {
        if (!this.isPathBased) {
            const row = await this.db.select({ file: paths.file }).from(paths).where(eq(paths.id, pathId)).get();
            return row ? row.file || pathId : null;
        }
        const rows = await this.db
            .select({
                id: paths.id,
                file: paths.file,
                parentId: paths.parentId,
            })
            .from(paths)
            .where(sql`${paths.id} IN (${ancestorIds(pathId)})`)
            .all();

        if (rows.length === 0) return null;

        const byId = new Map(rows.map((r) => [r.id, r]));
        const segments: string[] = [];
        const seen = new Set<string>();
        let current = byId.get(pathId);
        while (current?.parentId) {
            if (seen.has(current.id)) throw treeCycleError(current.id);
            seen.add(current.id);
            if (current.file) segments.unshift(current.file);
            current = byId.get(current.parentId);
        }
        return segments.join('/');
    }

    // ---- Reading bytes ----

    public async readFile(pathId: string): Promise<StorageFile | null> {
        return this.readKey(await this.getStorageKey(pathId));
    }

    // Reads by storage key, for a caller that has the key already, such as a backup that derives every
    // key from the paths table it holds. It serves the freshest bytes. While an upload is pending, its
    // staged copy is newer than the stored object, which may not even exist yet. That copy is a
    // document database on its way to the bucket, or a plain file a home restore staged.
    public async readKey(storageKey: string): Promise<StorageFile | null> {
        const staged = this.pendingStagedCopy(storageKey);
        if (staged) return Bun.file(staged);
        if (await this.storage.exists(storageKey)) {
            return this.storage.read(storageKey);
        }
        return null;
    }

    public async readRange(pathId: string, start: number, end: number): Promise<StorageFile | null> {
        const file = await this.readFile(pathId);
        return file ? file.slice(start, end) : null;
    }

    // A file's bytes, or only the first `limit` of them, freshest first. The teardown abort also ends the read.
    public async readBytes(pathId: string, limit?: number): Promise<ArrayBuffer | null> {
        const file = limit === undefined ? await this.readFile(pathId) : await this.readRange(pathId, 0, limit);
        return file ? readStorageFile(file, { signal: this.downloads.signal }) : null;
    }

    // The staged copy of a pending upload holds bytes newer than the stored object. This returns its
    // path, or null when storage is up to date: on a mount with no queue, for a key with nothing staged,
    // or once the upload landed. It is synchronous, so a caller can copy the file before an await lets
    // a new enqueue unlink it.
    public pendingStagedCopy(storageKey: string): string | null {
        const staged = this.uploadQueue?.getPendingStagingPath(storageKey) ?? null;
        return staged && fs.existsSync(staged) ? staged : null;
    }

    // ---- Overwriting ----

    // ifMatch is an If-Match value: one etag, a list of them or `*`. The write happens only when the
    // file's etag matches it. It answers the row it committed, taken under the lock, so a write that
    // lands after this one can't hand its etag or updatedAt to this caller.
    public async writeFile(
        pathId: string,
        data: Buffer | Uint8Array | ArrayBuffer | BunFile,
        ifMatch?: string,
    ): Promise<DrivePath> {
        const size = data instanceof Blob ? data.size : data.byteLength;
        const hash = await this.computeHash(data);

        return this.withPathLock(pathId, () =>
            this.withTreeShared(async () => {
                await this.assertOverwritable(pathId, ifMatch);
                const storageKey = await this.getStorageKey(pathId);
                await this.storage.write(storageKey, data);
                return this.commitOverwrite(pathId, storageKey, size, hash);
            }),
        );
    }

    // Overwrites from a temp file whose size and hash are known already (writeTempWithHash), so nothing
    // hashes the bytes twice.
    public async writeFileFromTemp(
        pathId: string,
        tempId: string,
        size: number,
        hash: string,
        ifMatch?: string,
    ): Promise<DrivePath> {
        return this.withPathLock(pathId, () =>
            this.withTreeShared(async () => {
                await this.assertOverwritable(pathId, ifMatch);
                const storageKey = await this.getStorageKey(pathId);
                await this.uploadFromTemp(storageKey, tempId);
                return this.commitOverwrite(pathId, storageKey, size, hash);
            }),
        );
    }

    // Runs before any byte lands, so a trashed file keeps the bytes it was trashed with. It runs under
    // the path lock every overwrite takes, so of two saves from the same base only the first writes.
    // And it runs under the tree lock, so on `local` an ancestor's trash can't land between the check
    // and the write.
    private async assertOverwritable(pathId: string, ifMatch: string | undefined): Promise<void> {
        const etag = computeEtag(await this.getActivePath(pathId));
        if (ifMatch !== undefined && !matchesIfMatch(ifMatch, etag)) throw new StaleWriteError(etag);
    }

    // Runs under the path lock once the bytes landed. deletePath doesn't wait for that lock, so a delete
    // during the write leaves the new bytes behind, and they go here. Off `local` no lock this holds
    // stops an ancestor's trash either. The row then still records the new bytes, and the caller gets a 404.
    // It answers the row as the update stored it, so its etag and updatedAt are what a GET reads: the
    // column keeps whole seconds, which a Date taken here would not.
    private async commitOverwrite(pathId: string, storageKey: string, size: number, hash: string): Promise<DrivePath> {
        const row = await this.db
            .select({ name: paths.name, mimeType: paths.mimeType })
            .from(paths)
            .where(eq(paths.id, pathId))
            .get();
        const searchable = !!row && isSearchableTextFile(row.mimeType, row.name);
        if (searchable) this.reindexQueue?.bumpGeneration(pathId);
        const committed = await this.db
            .update(paths)
            .set({ size, hash, updatedAt: new Date(), contentDirty: searchable ? 1 : 0 })
            .where(eq(paths.id, pathId))
            .returning()
            .get();
        if (!committed) {
            await this.removeObject(pathId, storageKey);
            throw new ApiError(404, 'File not found');
        }
        await this.invalidateAncestorsOf(pathId);
        if (searchable) this.reindexQueue?.kick();
        if (committed.trashedAt) throw new ApiError(404, 'File is in trash');
        return this.toDrivePath(committed);
    }

    // ---- Temp files ----

    public getTempPath(pathId: string): string {
        return path.join(this.tmpDir, pathId.replace(/\//g, '_'));
    }

    // Downloads a stored file to a temp path the caller can open directly, such as a SQLite snapshot
    // on any backend. tempId must be new for each call (a randomUUID), or two downloads of one file
    // overwrite each other. The caller removes it with cleanupTemp(tempId).
    public async downloadToTemp(pathId: string, tempId: string): Promise<string> {
        // An open document's working copy is the temp path named after its data.db path id. A tempId
        // equal to one would truncate it.
        if (this.documentDbs.has(tempId)) {
            throw new Error(
                `[Mount] downloadToTemp ${pathId}: tempId ${tempId} is an open document DB — refusing to overwrite its live working copy`,
            );
        }
        // Under the tree lock, like a document open, because on `local` an ancestor rename during the
        // read would make the file look gone.
        return this.withTreeShared(async () => {
            const storageKey = await this.getStorageKey(pathId);
            // Freshest first, like readKey: a version saved during an outage exists only as its staged copy.
            const staged = this.pendingStagedCopy(storageKey);
            if (staged) {
                try {
                    await this.replaceTempFrom(tempId, Bun.file(staged));
                    return this.getTempPath(tempId);
                } catch (err) {
                    // The queue unlinks a staged copy once its upload landed, which may happen during the
                    // read. The bytes are in the bucket by then, so the download below gets them.
                    if (!isMissingObjectCause(err)) {
                        console.error(`[Mount] download of staged ${storageKey} failed:`, err);
                        throw err;
                    }
                }
            }
            return this.downloadKeyToTemp(storageKey, tempId);
        });
    }

    // The plain download, with no look at the staged copy. Its callers look at that first.
    public async downloadKeyToTemp(storageKey: string, tempId: string): Promise<string> {
        const start = Bun.nanoseconds();
        const tempPath = this.getTempPath(tempId);
        await this.cleanupTemp(tempId);
        // A -wal that survived the cleanup would be replayed into the fresh main file.
        if (fs.existsSync(`${tempPath}-wal`))
            throw new Error(`[Mount] download ${storageKey}: stale ${tempPath}-wal could not be removed`);
        let size: number;
        try {
            size = await this.replaceTempFrom(tempId, this.storage.read(storageKey));
        } catch (err) {
            console.error(`[Mount] download ${storageKey} failed:`, err);
            // Only the GET body can tell a gone object (410) from an outage (503), and the read's own
            // failures arrive as ApiErrors. A raw error is local, such as the tmp/ write or rename. It
            // stays a 500, and its ENOENT does not mean the object is gone.
            if (isMissingObjectCause(err)) throw storageGone(err.cause);
            throw err;
        }
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(`[timing] Mount.download ${storageKey} ${(size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
        return tempPath;
    }

    // Writes into a side file and renames it on success. A process death mid-read must not leave a
    // truncated file at the temp path, because the next open would adopt it as crash recovery.
    // Returns the byte count.
    public async replaceTempFrom(tempId: string, source: StorageFile): Promise<number> {
        const sideId = crypto.randomUUID();
        let size: number;
        try {
            ({ size } = await writeTempWithHash(this.getTempPath(sideId), source, { signal: this.downloads.signal }));
            fs.renameSync(this.getTempPath(sideId), this.getTempPath(tempId));
        } catch (err) {
            await this.cleanupTemp(sideId);
            throw err;
        }
        return size;
    }

    public async uploadFromTemp(storageKey: string, tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        const tempFile = Bun.file(tempPath);
        if (!(await tempFile.exists())) {
            // The caller writes the temp file first. A missing one throws instead of doing nothing, so
            // a failed sync at close is loud and never drops unflushed writes in silence.
            throw new Error(`[Mount] uploadFromTemp ${storageKey}: tempfile missing at ${tempPath}`);
        }
        const start = Bun.nanoseconds();
        await this.storage.write(storageKey, tempFile);
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(`[timing] Mount.upload ${storageKey} ${(tempFile.size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
    }

    public async cleanupTemp(tempId: string): Promise<void> {
        const tempPath = this.getTempPath(tempId);
        // The journals go too: SQLite replays a leftover -wal into whatever main file lands here next.
        try {
            fs.rmSync(`${tempPath}-wal`, { force: true });
            fs.rmSync(`${tempPath}-shm`, { force: true });
            fs.rmSync(tempPath, { force: true });
        } catch (e) {
            console.error(`[Mount] Failed to remove temp ${tempId}:`, e);
        }
    }

    // ---- Locks ----

    public async withPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T> {
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

    // Like withPathLock, but returns null at once when the lock is held. Nothing can take the lock
    // between the check and the acquire: on a free lock withPathLock skips its wait loop and takes the
    // lock before its first await.
    public async tryWithPathLock<T>(pathId: string, fn: () => Promise<T>): Promise<T | null> {
        if (this.pathLocks.has(pathId)) return null;
        return this.withPathLock(pathId, fn);
    }

    // On `local` a storage key is a name path, so a folder rename changes the keys of everything under
    // it. A write that derives a key holds the tree lock shared until its row is written. A folder
    // rename holds it exclusive. Other backends have id keys and take no tree lock. The locks are taken
    // in one order: the path lock, then the document database slot, then the tree lock. A create's lock
    // comes right before the tree lock. A holder never takes the tree lock a second time, because a
    // shared lock inside a shared lock deadlocks once an exclusive one waits.
    public async withTreeShared<T>(fn: () => Promise<T>): Promise<T> {
        return this.isPathBased ? this.treeLock.shared(fn) : fn();
    }

    public async withTreeExclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.isPathBased ? this.treeLock.exclusive(fn) : fn();
    }

    // On `local` two creates of one name in one folder would write to one name path. So a create also
    // holds a path lock on its folder and its name, folded the way the disk folds it. The second create
    // then sees the first one's row, or its bytes on disk, and answers 409 before it writes. It is taken
    // right before the tree lock, and its holder takes no database slot. So a snapshot that holds a slot
    // can take it without a deadlock.
    private async withCreateLock<T>(parentId: string, name: string, fn: () => Promise<T>): Promise<T> {
        if (!this.isPathBased) return fn();
        return this.withPathLock(`${parentId}/${foldName(name)}`, () => this.withTreeShared(fn));
    }

    // ---- Document databases and versions ----

    // Opens an existing document database. A missing storage object is a 410, never a fresh empty
    // database. createDatabase makes a new one.
    public async openDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return documentDb.openDatabase(this, config, pathId);
    }

    // Makes a new document database at a row touchFile created. It refuses when the storage object
    // exists already. It writes the empty schema to storage before it returns, so a later openDatabase
    // finds it, even after a restart.
    public async createDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        pathId: string,
    ): Promise<ManagedDatabase<S>> {
        return documentDb.createDatabase(this, config, pathId);
    }

    public async closeDatabase(pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        return documentDb.closeDatabase(this, pathId, opts);
    }

    // Flushes the container's open data.db, so a byte copy of its storage holds the pending Yjs edits.
    // A container whose data.db is closed or missing needs nothing.
    public async flushContainerDb(containerId: string): Promise<void> {
        const dataDb = await this.getChildByName(containerId, 'data.db');
        if (!dataDb) return;
        await documentDb.withDocumentDb(this, dataDb.id, async (slot) => {
            await slot.db?.flush();
        });
    }

    public async snapshotContainerDataDb(containerId: string, policy: RetentionPolicy): Promise<DrivePath> {
        return snapshot.snapshotContainerDataDb(this, containerId, policy);
    }

    // Like snapshotContainerDataDb, but it skips instead of waiting when the container is locked, so a
    // background snapshot never queues behind a save.
    public async trySnapshotContainerDataDb(
        containerId: string,
        policy: RetentionPolicy,
    ): Promise<'taken' | 'skipped'> {
        return snapshot.trySnapshotContainerDataDb(this, containerId, policy);
    }

    public async replaceContainerDataDb(containerId: string, sourcePath: string): Promise<void> {
        return snapshot.replaceContainerDataDb(this, containerId, sourcePath);
    }

    // ---- Content index and search ----

    public upsertPathContent(pathId: string, body: string): void {
        searchIndex.upsertPathContent(this, pathId, body);
    }

    public clearPathContent(pathId: string): void {
        searchIndex.clearPathContent(this, pathId);
    }

    public getContentDirtyPaths(reindexCapSeconds: number, limit: number): DrivePath[] {
        return searchIndex.getContentDirtyPaths(this, reindexCapSeconds, limit);
    }

    public earliestPendingReindexAt(reindexCapSeconds: number): number | null {
        return searchIndex.earliestPendingReindexAt(this, reindexCapSeconds);
    }

    public markContentIndexed(pathId: string): void {
        searchIndex.markContentIndexed(this, pathId);
    }

    public markContentIndexAttempted(pathId: string): void {
        searchIndex.markContentIndexAttempted(this, pathId);
    }

    public searchPaths(opts: { q: string; limit: number }): DrivePath[] {
        return searchIndex.searchPaths(this, opts);
    }

    // ---- Sizes ----

    public async getTotalSize(): Promise<number> {
        const result = await this.db
            .select({
                total: sql<number>`COALESCE(SUM(${paths.size}), 0)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.total ?? 0;
    }

    public async getFileCount(): Promise<number> {
        const result = await this.db
            .select({
                count: sql<number>`COUNT(*)`,
            })
            .from(paths)
            .where(eq(paths.type, 'file'))
            .get();

        return result?.count ?? 0;
    }

    public async invalidateAncestorsOf(pathId: string): Promise<void> {
        let parentId: string | null;
        try {
            const row = await this.db
                .select({ parentId: paths.parentId })
                .from(paths)
                .where(eq(paths.id, pathId))
                .get();
            parentId = row?.parentId ?? null;
        } catch (e) {
            console.error(`[Mount] Could not invalidate the folder sizes above ${pathId}:`, e);
            return;
        }
        await this.invalidateSizesFrom(parentId);
    }

    // Clears the cached size of parentId and of every folder above it. Every caller has committed its
    // change already, so a failure is logged and leaves a stale size instead of a 500.
    public async invalidateSizesFrom(parentId: string | null): Promise<void> {
        if (!parentId) return;
        try {
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
        } catch (e) {
            console.error(`[Mount] Could not invalidate the folder sizes from ${parentId}:`, e);
        }
    }

    private computeFolderSizeInTx(tx: Tx, folderId: string): number {
        const row = tx.select({ size: paths.size, type: paths.type }).from(paths).where(eq(paths.id, folderId)).get();
        if (!row) return 0;
        if (row.type === 'file') return row.size ?? 0;
        if (row.size !== null) return row.size;

        // A trashed item moves to the root but keeps its trashedFrom, so it does not count there. The
        // items trashed along with it stay in its subtree and count toward its own size, as in Google Drive.
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
