import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupEntry, BackupLevel, BackupManifest } from '@workspace/lib/types/backup';
import type { MountConfig } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_FORMAT_VERSION } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { getAvatarsDir } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { type DatabaseConfig, isEnoent, PATHS, type SchemaType } from '../core';
import type { Home } from '../home';
import { createMountConfig, Mount } from '../mount';
import { MOUNT_DB_CONFIG } from '../mount/db-config';
import { readMountTotalSize } from '../mount/helpers';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { HOME_DATABASE_PATHS, HOME_DATABASES, isLightSkipped, MAILDIR_ROOT } from './archive-layout';
import { readAuthRows } from './auth-tables';
import { captureFile, captureUnlessGone, captureWrittenFile } from './capture';
import { readHomeMounts } from './enumerate-homes';
import { describeError } from './errors';
import {
    ARCHIVE_AUTH_FILE,
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_MANIFEST_FILE,
    ARCHIVE_SHARES_FILE,
    archiveHomePath,
    archiveMountPath,
    buildHomeFolderName,
    requireBackableOwner,
} from './paths';
import { flushOpenDocumentDbs, snapshotMountData, snapshotMountStaging, snapshotMountThumbs } from './snapshot-mount';

export type SnapshotProgress = (step: string, done: number, total: number) => void;

// `mounts/` is walked from its paths tables instead (snapshotMountData), and each mailbox's `tmp/` delivery spool,
// beside its `cur/` and `new/`, holds half-written deliveries only. Matched on the path from the home root, never on
// the folder name: a folder deeper in the home that happens to be called `mounts` is somebody's own.
function isSkippedHomeDir(rel: string, level: BackupLevel): boolean {
    if (rel === PATHS.DRIVE.ROOT) return true;
    // A whole-server restore of a Light archive keeps what it leaves out in place.
    if (level === 'light' && isLightSkipped(rel)) return true;
    return path.basename(rel) === PATHS.MAIL.TMP && rel.startsWith(`${MAILDIR_ROOT}/`);
}

// Databases are captured with VACUUM INTO through the live handle, never as a file copy, and their
// journals belong to the running server.
const DB_FILE = /\.db(-wal|-shm)?$/;
const JOURNAL_FILE = /\.db-(wal|shm)$/;

// A folder as plain files, the databases found and every directory: an empty Maildir `new/` carries no file to imply
// it, and without it a restored mailbox has nothing for MaildirStore.watch to watch, so mail stops syncing.
type FileTree = { files: string[]; dirs: string[]; databases: string[] };

// Synchronous to narrow the window in which the mail watcher's move from `new/` to `cur/` hides a message from a capture.
export function listFileTree(root: string, skipDir: (rel: string) => boolean = () => false): FileTree {
    const tree: FileTree = { files: [], dirs: [], databases: [] };
    const walk = (relDir: string): void => {
        for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (skipDir(rel)) continue;
                tree.dirs.push(rel);
                walk(rel);
            } else if (entry.isFile()) {
                if (!DB_FILE.test(entry.name)) tree.files.push(rel);
                else if (entry.name.endsWith('.db')) tree.databases.push(rel);
            }
        }
    };
    walk('');
    return tree;
}

const MESSAGE_DIRS: readonly string[] = [PATHS.MAIL.CUR, PATHS.MAIL.NEW];

// A mail client's first look moves a Maildir message from new/ to cur/ and a flag change renames it in cur/, so one
// gone mid-copy is looked for in its mailbox by its unique name, the part before `:2,`.
function renamedMessage(homeDir: string, rel: string): string | null {
    const box = path.dirname(rel);
    if (!rel.startsWith(`${MAILDIR_ROOT}/`) || !MESSAGE_DIRS.includes(path.basename(box))) return null;
    const unique = path.basename(rel).split(':')[0];
    for (const sub of MESSAGE_DIRS) {
        const dir = path.join(path.dirname(box), sub);
        const abs = path.join(homeDir, dir);
        const name = fs.existsSync(abs) && fs.readdirSync(abs).find((found) => found.split(':')[0] === unique);
        if (name) return `${dir}/${name}`;
    }
    return null;
}

// What a capture of the tree stages, at most: its files and databases as they sit on disk. The room check before a
// server backup sizes every home with it while the server runs, so a file or folder gone since its listing counts
// nothing. A folder's files are statted together, its subfolders walked one at a time to keep few handles open.
export async function treeBytes(root: string, skipDir: (rel: string) => boolean = () => false): Promise<number> {
    const gone =
        <T>(value: T) =>
        (error: unknown): T => {
            if (isEnoent(error)) return value;
            throw error;
        };
    const walk = async (relDir: string): Promise<number> => {
        const entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true }).catch(gone([]));
        const rel = (name: string) => (relDir ? `${relDir}/${name}` : name);
        const files = entries.filter((entry) => entry.isFile() && !JOURNAL_FILE.test(entry.name));
        const sizes = await Promise.all(
            files.map((entry) => fsp.stat(path.join(root, rel(entry.name))).then((stat) => stat.size, gone(0))),
        );
        let bytes = sizes.reduce((sum, size) => sum + size, 0);
        for (const entry of entries) {
            if (entry.isDirectory() && !skipDir(rel(entry.name))) bytes += await walk(rel(entry.name));
        }
        return bytes;
    };
    return walk('');
}

// What a capture of the home at `level` stages at most, read off its folder like pullHomeSize: the
// server backup's room check sizes every home before it starts. Full is every local byte. Light
// walks no Maildir and of each mount only its metadata.db. Full + S3 adds each s3 mount's objects.
export async function captureBytes(homeDir: string, level: BackupLevel): Promise<number> {
    if (!fs.existsSync(homeDir)) return 0;
    if (level === 'light') return treeBytes(homeDir, isLightSkipped);
    const local = await treeBytes(homeDir);
    if (level === 'full') return local;
    const s3Bytes = Object.entries(readHomeMounts(homeDir) ?? {})
        .filter(([, mount]) => mount.storageType === 's3')
        .map(([id]) => readMountTotalSize(path.join(homeDir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB)));
    return s3Bytes.reduce((sum, bytes) => sum + bytes, local);
}

// Writes a storage-independent copy of one home into `{targetDir}/home-{ownerId}/` and returns its manifest. Each
// database copy is one committed state, the folder as a whole is not one instant: the home keeps serving its user.
export async function snapshotHome(
    home: Home,
    targetDir: string,
    { onProgress, level = 'full-s3' }: { onProgress?: SnapshotProgress; level?: BackupLevel } = {},
): Promise<BackupManifest> {
    const ownerId = home.user.id;
    const owner = parseOwnerId(ownerId);
    requireBackableOwner(owner);

    const folder = path.join(targetDir, buildHomeFolderName(ownerId));
    fs.mkdirSync(folder, { recursive: true });
    const entries: BackupEntry[] = [];

    // Counted as they are staged: a user's upload called `notes.db` is a file, as verify sees it too.
    let databases = 0;
    const stageDatabase = async (config: DatabaseConfig<SchemaType>, relPath: string): Promise<void> => {
        const managed = await home.getLocalDatabase(config, relPath);
        const destPath = path.join(folder, ARCHIVE_HOME_DIR, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        managed.stageCopy(destPath);
        entries.push(await captureWrittenFile(destPath, archiveHomePath(relPath)));
        databases++;
    };

    for (const [index, [config, relPath]] of HOME_DATABASES.entries()) {
        if (fs.existsSync(path.join(home.homeDir, relPath))) await stageDatabase(config, relPath);
        onProgress?.('databases', index + 1, HOME_DATABASES.length);
    }

    const mounts = home.drive.getMounts();
    // Every mount the home declares: a disabled one, or one whose init failed, is not in the drive's map, and an
    // archive without it is a restore that drops it.
    const unserved = Object.entries(home.settings.get().mounts ?? {}).filter(
        ([id]) => !mounts.some((mount) => mount.id === id),
    );
    const mountSummaries: BackupManifest['mounts'] = [];

    // One mount: its metadata.db, what the level takes of its files, and its summary. Full leaves an s3 mount's
    // objects to its bucket's versioning and takes its staged uploads; Light reads no storage, so it gets no Mount.
    const archiveMount = async (config: MountConfig, mount?: Mount): Promise<void> => {
        const stagedOnly = level === 'full' && mount?.isRemote === true;
        const metadataOnly = !mount || stagedOnly;
        if (stagedOnly) await flushOpenDocumentDbs(mount);
        const relMetadata = `${PATHS.DRIVE.ROOT}/${config.id}/${PATHS.DRIVE.METADATA_DB}`;
        await stageDatabase(MOUNT_DB_CONFIG, relMetadata);
        const mountEntries: BackupEntry[] = [];
        if (mount) {
            const relFiles = archiveMountPath(mount.id, stagedOnly ? PATHS.DRIVE.STAGING_DIR : PATHS.DRIVE.DATA_DIR);
            const relThumbs = archiveMountPath(mount.id, PATHS.DRIVE.THUMBS_DIR);
            const metadataPath = path.join(folder, ARCHIVE_HOME_DIR, relMetadata);
            const data = stagedOnly
                ? await snapshotMountStaging(mount, path.join(folder, relFiles), relFiles)
                : await snapshotMountData(mount, metadataPath, path.join(folder, relFiles), relFiles, onProgress);
            const thumbs = await snapshotMountThumbs(
                mount.thumbsDir,
                path.join(folder, relThumbs),
                relThumbs,
                data.pathIds,
            );
            mountEntries.push(...data.entries, ...thumbs);
            databases += data.databases;
        }
        entries.push(...mountEntries);
        mountSummaries.push({
            id: config.id,
            storageType: config.storageType,
            files: mountEntries.length,
            bytes: mountEntries.reduce((sum, entry) => sum + entry.bytes, 0),
            ...(metadataOnly && { contents: 'metadata' }),
        });
    };

    const total = mounts.length + unserved.length;
    for (const [index, mount] of mounts.entries()) {
        await archiveMount(mount.config, level === 'light' ? undefined : mount);
        onProgress?.('mounts', index + 1, total);
    }

    for (const [index, [id, settings]] of unserved.entries()) {
        const relMetadata = `${PATHS.DRIVE.ROOT}/${id}/${PATHS.DRIVE.METADATA_DB}`;
        // A mount with no folder has nothing to carry: one nobody ever mounted, or one being added, whose settings
        // are written before the drive creates its folder.
        if (!fs.existsSync(path.join(home.homeDir, relMetadata))) continue;
        const config = createMountConfig(id, settings);
        // A mount that turns out unreadable is taken back out, so the folder holds nothing the manifest does not list.
        const entriesBefore = entries.length;
        const databasesBefore = databases;
        let mount: Mount | undefined;
        try {
            // Through the same Mount as a served one, so the capture rules are spelled once; passive, since nothing
            // serves it, so nothing is created, purged or uploaded.
            if (level === 'light') {
                await archiveMount(config);
            } else {
                mount = new Mount(ownerId, home.homeDir, config, home.getLocalDatabase.bind(home));
                await mount.init({ passive: true });
                await archiveMount(config, mount);
            }
        } catch (error) {
            // An enabled mount that cannot open fails the backup, which would miss files the home serves. One turned
            // off is often unreachable for that reason: it is skipped with the reason.
            if (settings.enabled) throw new Error(`mount ${id} cannot be opened: ${describeError(error)}`);
            entries.length = entriesBefore;
            databases = databasesBefore;
            fs.rmSync(path.join(folder, ARCHIVE_HOME_DIR, PATHS.DRIVE.ROOT, id), { recursive: true, force: true });
            const skipped = describeError(error);
            console.warn(`[backup] ${ownerId}: disabled mount ${id} was skipped — ${skipped}`);
            mountSummaries.push({ id, storageType: config.storageType, files: 0, bytes: 0, skipped });
        } finally {
            // Drive.removeMount's teardown; metadata.db stays open, as it is the Home's cached handle.
            await mount?.closeAllDatabases();
        }
        onProgress?.('mounts', mounts.length + index + 1, total);
    }

    // The home outside its mounts and its databases.
    const tree = listFileTree(home.homeDir, (rel) => isSkippedHomeDir(rel, level));
    // A home database missing from HOME_DATABASES would be dropped from every archive in silence.
    const unlisted = tree.databases.find((rel) => !HOME_DATABASE_PATHS.has(rel));
    if (unlisted) throw new Error(`snapshotHome: unlisted home database ${unlisted} — add it to HOME_DATABASES`);
    for (const rel of tree.dirs) fs.mkdirSync(path.join(folder, ARCHIVE_HOME_DIR, rel), { recursive: true });
    const taken = new Set(tree.files);
    const capture = (rel: string) =>
        captureUnlessGone(
            Bun.file(path.join(home.homeDir, rel)),
            path.join(folder, ARCHIVE_HOME_DIR, rel),
            archiveHomePath(rel),
        );
    for (const [index, rel] of tree.files.entries()) {
        let captured = await capture(rel);
        const renamed = captured ? null : renamedMessage(home.homeDir, rel);
        if (renamed && !taken.has(renamed)) {
            taken.add(renamed);
            captured = await capture(renamed);
        }
        if (captured) entries.push(captured);
        onProgress?.('home files', index + 1, tree.files.length);
    }

    if (owner.type === 'user') {
        const encoder = new TextEncoder();
        entries.push(
            await captureFile(
                encoder.encode(JSON.stringify(readAuthRows(ownerId), null, 2)),
                path.join(folder, ARCHIVE_AUTH_FILE),
                ARCHIVE_AUTH_FILE,
            ),
        );
        const shares = (await getEigenDb())
            .select()
            .from(shareRegistry)
            .where(eq(shareRegistry.fromUserId, ownerId))
            .all();
        entries.push(
            await captureFile(
                encoder.encode(JSON.stringify(shares, null, 2)),
                path.join(folder, ARCHIVE_SHARES_FILE),
                ARCHIVE_SHARES_FILE,
            ),
        );

        const avatarName = `${ownerId}.webp`;
        const avatar = Bun.file(path.join(getAvatarsDir(), avatarName));
        if (await avatar.exists()) {
            entries.push(
                await captureFile(
                    avatar,
                    path.join(folder, ARCHIVE_AVATAR_DIR, avatarName),
                    `${ARCHIVE_AVATAR_DIR}/${avatarName}`,
                ),
            );
        }
    }

    const config = getPublicConfig();
    const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        kind: owner.type,
        ownerId,
        email: owner.type === 'user' ? home.user.email : undefined,
        name: home.user.name,
        createdAt: new Date().toISOString(),
        appVersion: config.version,
        server: { domain: config.domain, orgId: config.orgId },
        counts: {
            databases,
            files: entries.length - databases,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        },
        level,
        mounts: mountSummaries,
        entries,
    };
    await Bun.write(path.join(folder, ARCHIVE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    onProgress?.('done', 1, 1);
    return manifest;
}
