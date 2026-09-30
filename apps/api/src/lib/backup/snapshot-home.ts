import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupLevel, BackupManifest } from '@workspace/lib/types/backup';
import type { MountConfig } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_FORMAT_VERSION } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { getAvatarsDir } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { type DatabaseConfig, PATHS, type SchemaType } from '../core';
import type { Home } from '../home';
import { createMountConfig, Mount } from '../mount';
import { MOUNT_DB_CONFIG } from '../mount/db-config';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { HOME_DATABASE_PATHS, HOME_DATABASES, MAILDIR_ROOT } from './archive-layout';
import { readAuthRows } from './auth-tables';
import { captureFile, captureUnlessGone, captureWrittenFile } from './capture';
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

// `mounts/` is walked from its paths tables instead (snapshotMountData). Matched on the path from
// the home root, never on the folder name: a folder deeper in the home that happens to be called
// `mounts` is somebody's own and belongs in the archive.
// The contacts avatar cache is archived rather than re-derived: the served webp carries what the card's Apple-safe PHOTO gave up.
const SKIPPED_HOME_DIRS = new Set<string>([PATHS.DRIVE.ROOT]);

// The other skip, which has no fixed path: every mailbox in the Maildir has a `tmp/` delivery spool
// beside its `cur/` and `new/`, holding half-written deliveries only.

function isSkippedHomeDir(rel: string, level: BackupLevel): boolean {
    if (SKIPPED_HOME_DIRS.has(rel)) return true;
    // Light leaves the mail where it is: a whole-server restore of one keeps the Maildir in place.
    if (level === 'light' && rel === MAILDIR_ROOT) return true;
    return path.basename(rel) === PATHS.MAIL.TMP && rel.startsWith(`${MAILDIR_ROOT}/`);
}

// Databases are captured with VACUUM INTO through the live handle, never as a file copy, and their
// journals belong to the running server.
const DB_FILE = /\.db(-wal|-shm)?$/;

// A folder as plain files: every file to copy, every directory to create in the archive folder, and
// the databases found, which are not copied (the caller says what one found there means). Journals
// are left out. Directories are listed because an empty one carries no file to imply it — a Maildir
// `new/` nobody has delivered to, an empty mailbox — and the tar writer emits an entry per directory
// in the staging folder. Without them a restored Maildir has no `new/` for MaildirStore.watch to
// install its watcher on, and mail stops syncing in silence.
export type FileTree = { files: string[]; dirs: string[]; databases: string[] };

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

// What a capture of the tree stages, at most: its files and databases as they sit on disk. The room
// check before a server backup sizes with it; a file gone since the listing counts nothing.
export function treeBytes(root: string, skipDir?: (rel: string) => boolean): number {
    const tree = listFileTree(root, skipDir);
    return [...tree.files, ...tree.databases].reduce(
        (sum, rel) => sum + (fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.size ?? 0),
        0,
    );
}

// Writes a storage-independent copy of one home into `{targetDir}/home-{ownerId}/` and returns the
// manifest describing it. Every database copy is internally consistent (VACUUM INTO); the folder as a
// whole is not one instant, which is the standard guarantee for a live-system backup — the home keeps
// serving its user throughout. `full-s3`, the default, always holds a complete home. The other levels
// are capture modes of the whole-server archive: their manifest says what they left out (BackupLevel),
// and a Full member of a home with no s3 mount left out nothing (incompleteReason).
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

    // Every tick doubles as a keep-alive: a home whose idle timer (5 minutes for a user) fires
    // mid-walk destructs itself, and the next stageCopy hits a closed database.
    const report: SnapshotProgress = (step, done, total) => {
        home.touch();
        onProgress?.(step, done, total);
    };

    // Eigen's own databases, counted as they are staged: a file a user happens to have uploaded
    // called `notes.db` is a file, and the manifest's counts have to say so (verify draws the same
    // line when it decides what it may open).
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
        report('databases', index + 1, HOME_DATABASES.length);
    }

    const mounts = home.drive.getMounts();
    // Every mount the home declares, not only the ones it serves: a disabled mount is not in the
    // drive's map and its folder is walked by nothing else here, so an archive without it is a
    // restore that drops it. It comes back as disabled, because settings.json rides along as it is.
    const disabled = Object.entries(home.settings.get().mounts ?? {}).filter(
        ([id, settings]) => !settings.enabled && !mounts.some((mount) => mount.id === id),
    );
    const mountSummaries: BackupManifest['mounts'] = [];

    // One mount's own bytes, enabled or disabled: its metadata.db, whatever else the level takes of
    // it, and the summary row. metadata.db is counted as a database, so the summary means the files
    // the archive holds for this mount. Light takes no more; Full leaves an s3 mount's objects to its
    // bucket (whose versioning is their history) and takes the uploads still in staging/ instead.
    // Light reads no storage, so it hands over no Mount, and a mount without one is its metadata.db
    // alone: a disabled mount whose storage cannot even be built keeps that much at Light.
    const archiveMount = async (config: MountConfig, mount?: Mount): Promise<void> => {
        const stagedOnly = level === 'full' && mount?.isRemote === true;
        const metadataOnly = !mount || stagedOnly;
        if (stagedOnly) await flushOpenDocumentDbs(mount);
        await stageDatabase(MOUNT_DB_CONFIG, `${PATHS.DRIVE.ROOT}/${config.id}/${PATHS.DRIVE.METADATA_DB}`);
        const mountEntries: BackupEntry[] = [];
        if (mount) {
            const relFiles = archiveMountPath(mount.id, stagedOnly ? PATHS.DRIVE.STAGING_DIR : PATHS.DRIVE.DATA_DIR);
            const relThumbs = archiveMountPath(mount.id, PATHS.DRIVE.THUMBS_DIR);
            const data = stagedOnly
                ? await snapshotMountStaging(mount, path.join(folder, relFiles), relFiles)
                : await snapshotMountData(mount, path.join(folder, relFiles), relFiles, report);
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

    const total = mounts.length + disabled.length;
    for (const [index, mount] of mounts.entries()) {
        await archiveMount(mount.config, level === 'light' ? undefined : mount);
        report('mounts', index + 1, total);
    }

    for (const [index, [id, settings]] of disabled.entries()) {
        const relMetadata = `${PATHS.DRIVE.ROOT}/${id}/${PATHS.DRIVE.METADATA_DB}`;
        // A mount whose folder is gone (a disabled entry nobody ever mounted) has nothing to carry.
        if (!fs.existsSync(path.join(home.homeDir, relMetadata))) continue;
        const config = createMountConfig(id, settings);
        // Where the archive stands before this mount: a mount that turns out to be unreadable is
        // taken back out again, entries and all, so the folder never holds bytes the manifest does
        // not list (which is what verify's transport stage would fail it on).
        const entriesBefore = entries.length;
        const databasesBefore = databases;
        let mount: Mount | undefined;
        try {
            // Archived through the same Mount an enabled one goes through — one spelling of the
            // capture rules (freshest-first, managed databases, manifest entries) for both. Opened
            // passively because the drive does not serve this one: nothing is created, purged or
            // uploaded (Mount.init). Its metadata.db is the Home's own cached handle, the one
            // archiveMount stages its copy from, so this opens nothing a second time. Light builds
            // no Mount at all.
            if (level === 'light') {
                await archiveMount(config);
            } else {
                mount = new Mount(ownerId, home.homeDir, config, home.getLocalDatabase.bind(home));
                await mount.init({ passive: true });
                await archiveMount(config, mount);
            }
        } catch (error) {
            // A mount an admin turned off must not be able to fail the backup of everything else —
            // its storage is often unreachable BECAUSE it was turned off. It is recorded as skipped
            // with the reason instead, and a restore leaves it disabled and absent. An ENABLED
            // mount's storage failure still fails the whole backup: that archive would be missing
            // files the home is serving.
            entries.length = entriesBefore;
            databases = databasesBefore;
            fs.rmSync(path.join(folder, ARCHIVE_HOME_DIR, PATHS.DRIVE.ROOT, id), { recursive: true, force: true });
            const skipped = describeError(error);
            console.warn(`[backup] ${ownerId}: disabled mount ${id} was skipped — ${skipped}`);
            mountSummaries.push({ id, storageType: config.storageType, files: 0, bytes: 0, skipped });
        } finally {
            // The Drive's own teardown for a mount it drops (Drive.removeMount): this one opened no
            // document database and never reconciled its queue, so it cancels the queue's timer and
            // returns. It cannot flush at shutdown either — gracefulShutdown runs drainBackupJobs
            // before setShutdownDrainDeadline. metadata.db stays open: it belongs to the Home's
            // cache, which closes it when the home evicts.
            await mount?.closeAllDatabases();
        }
        report('mounts', mounts.length + index + 1, total);
    }

    // The home outside its mounts and its databases.
    const tree = listFileTree(home.homeDir, (rel) => isSkippedHomeDir(rel, level));
    // A home database missing from HOME_DATABASES would be dropped from every archive in silence.
    // Fail loudly instead, so a new subsystem's db is noticed the day it lands.
    const unlisted = tree.databases.find((rel) => !HOME_DATABASE_PATHS.has(rel));
    if (unlisted) throw new Error(`snapshotHome: unlisted home database ${unlisted} — add it to HOME_DATABASES`);
    for (const rel of tree.dirs) fs.mkdirSync(path.join(folder, ARCHIVE_HOME_DIR, rel), { recursive: true });
    for (const [index, rel] of tree.files.entries()) {
        const source = Bun.file(path.join(home.homeDir, rel));
        // A mail client's first look moves a Maildir message from new/ to cur/, so one can go mid-copy.
        const captured = await captureUnlessGone(
            source,
            path.join(folder, ARCHIVE_HOME_DIR, rel),
            archiveHomePath(rel),
        );
        if (captured) entries.push(captured);
        report('home files', index + 1, tree.files.length);
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
    report('done', 1, 1);
    return manifest;
}
