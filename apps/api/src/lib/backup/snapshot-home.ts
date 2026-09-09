import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { eq } from 'drizzle-orm';
import { CALENDAR_DB_CONFIG } from '../calendar/db-config';
import { getAvatarsDir } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { CONTACTS_DB_CONFIG } from '../contacts/db-config';
import { ApiError, type DatabaseConfig, PATHS, type SchemaType } from '../core';
import { SHARED_DB_CONFIG } from '../drive/db-config';
import type { Home } from '../home';
import { MAIL_DB_CONFIG } from '../mail/db-config';
import { MOUNT_DB_CONFIG } from '../mount/db-config';
import { NOTIFICATION_CENTER_DB_CONFIG } from '../notification-center/db-config';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { readAuthRows } from './auth-tables';
import { captureFile, captureWrittenFile } from './capture';
import {
    ARCHIVE_AUTH_FILE,
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_SHARES_FILE,
    archiveHomePath,
    archiveMountPath,
    buildHomeFolderName,
} from './paths';
import { snapshotMountData } from './snapshot-mount';

export type SnapshotProgress = (step: string, done: number, total: number) => void;

// Home-level databases outside the mounts. Absent files are skipped: a team home has no mail,
// contacts or notifications, and opening one through getLocalDatabase would create it empty.
export const HOME_DATABASES: [DatabaseConfig<SchemaType>, string][] = [
    [SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB],
    [MAIL_DB_CONFIG, PATHS.MAIL.DB],
    [CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB],
    [CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB],
    [NOTIFICATION_CENTER_DB_CONFIG, PATHS.NOTIFICATIONS.DB],
];

// `mounts/` is walked from its paths tables instead (snapshotMountData); the Maildir delivery spool
// holds half-written deliveries, and the contacts avatar cache is derived from the cards.
const SKIPPED_HOME_DIRS = new Set<string>([PATHS.DRIVE.ROOT, PATHS.MAIL.TMP, PATHS.CONTACTS.AVATARS]);

// Home-relative paths of the databases above; verify reads them back to know which archived .db
// files are Eigen's own.
export const HOME_DATABASE_PATHS = new Set(HOME_DATABASES.map(([, relPath]) => relPath));

// Databases are captured with VACUUM INTO through the live handle, never as a file copy, and their
// journals belong to the running server.
const DB_FILE = /\.db(-wal|-shm)?$/;

function listHomeFiles(dir: string, relDir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIPPED_HOME_DIRS.has(entry.name)) listHomeFiles(path.join(dir, entry.name), rel, out);
            continue;
        }
        if (!entry.isFile()) continue;
        if (DB_FILE.test(entry.name)) {
            // A home database missing from HOME_DATABASES would be dropped from every archive in
            // silence. Fail loudly instead, so a new subsystem's db is noticed the day it lands.
            if (entry.name.endsWith('.db') && !HOME_DATABASE_PATHS.has(rel)) {
                throw new Error(`snapshotHome: unlisted home database ${rel} — add it to HOME_DATABASES`);
            }
            continue;
        }
        out.push(rel);
    }
}

// Writes a complete, storage-independent copy of one home into `{targetDir}/home-{ownerId}/` and
// returns the manifest describing it. Every database copy is internally consistent (VACUUM INTO);
// the folder as a whole is not one instant, which is the standard guarantee for a live-system
// backup — the home keeps serving its user throughout.
export async function snapshotHome(
    home: Home,
    targetDir: string,
    onProgress?: SnapshotProgress,
): Promise<BackupManifest> {
    const ownerId = home.user.id;
    const owner = parseOwnerId(ownerId);
    if (owner.type !== 'user' && owner.type !== 'team') {
        throw new ApiError(400, `Cannot back up a ${owner.type} home`);
    }

    const folder = path.join(targetDir, buildHomeFolderName(ownerId));
    fs.mkdirSync(folder, { recursive: true });
    const entries: BackupEntry[] = [];

    // Every tick doubles as a keep-alive: a home whose idle timer (5 minutes for a user) fires
    // mid-walk destructs itself, and the next stageCopy hits a closed database.
    const report: SnapshotProgress = (step, done, total) => {
        home.touch();
        onProgress?.(step, done, total);
    };

    const stageDatabase = async (config: DatabaseConfig<SchemaType>, relPath: string): Promise<void> => {
        const managed = await home.getLocalDatabase(config, relPath);
        const destPath = path.join(folder, ARCHIVE_HOME_DIR, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        managed.stageCopy(destPath);
        entries.push(await captureWrittenFile(destPath, archiveHomePath(relPath)));
    };

    for (const [index, [config, relPath]] of HOME_DATABASES.entries()) {
        if (fs.existsSync(path.join(home.homeDir, relPath))) await stageDatabase(config, relPath);
        report('databases', index + 1, HOME_DATABASES.length);
    }

    const mounts = home.drive.getMounts();
    const mountSummaries: BackupManifest['mounts'] = [];
    for (const [index, mount] of mounts.entries()) {
        const relData = archiveMountPath(mount.id, PATHS.DRIVE.DATA_DIR);
        await stageDatabase(MOUNT_DB_CONFIG, `${PATHS.DRIVE.ROOT}/${mount.id}/${PATHS.DRIVE.METADATA_DB}`);
        // Counted from here, so the summary means the mount's data files — metadata.db is a database,
        // and counts.databases already has it.
        const data = await snapshotMountData(mount, path.join(folder, relData), relData, report);
        entries.push(...data);
        mountSummaries.push({
            id: mount.id,
            storageType: mount.config.storageType,
            files: data.length,
            bytes: data.reduce((sum, entry) => sum + entry.bytes, 0),
        });
        report('mounts', index + 1, mounts.length);
    }

    const homeFiles: string[] = [];
    listHomeFiles(home.homeDir, '', homeFiles);
    for (const [index, rel] of homeFiles.entries()) {
        const source = Bun.file(path.join(home.homeDir, rel));
        // A file can vanish between the listing and the read — a Maildir new/→cur/ move, a card
        // rewrite. It is out of the archive either way; losing the whole snapshot over it is not.
        if (await source.exists()) {
            entries.push(await captureFile(source, path.join(folder, ARCHIVE_HOME_DIR, rel), archiveHomePath(rel)));
        }
        report('home files', index + 1, homeFiles.length);
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
    const databases = entries.filter((entry) => entry.path.endsWith('.db')).length;
    const manifest: BackupManifest = {
        formatVersion: 1,
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
        mounts: mountSummaries,
        entries,
    };
    await Bun.write(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    report('done', 1, 1);
    return manifest;
}
