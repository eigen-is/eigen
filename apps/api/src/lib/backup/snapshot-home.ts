import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { eq } from 'drizzle-orm';
import { account, apikey, member, teamMember, twoFactor, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
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
import { captureFile, captureWrittenFile } from './capture';
import { buildHomeFolderName } from './paths';
import { snapshotMountData } from './snapshot-mount';

export type SnapshotProgress = (step: string, done: number, total: number) => void;

// Home-level databases outside the mounts. Absent files are skipped: a team home has no mail,
// contacts or notifications, and opening one through getLocalDatabase would create it empty.
const HOME_DATABASES: [DatabaseConfig<SchemaType>, string][] = [
    [SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB],
    [MAIL_DB_CONFIG, PATHS.MAIL.DB],
    [CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB],
    [CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB],
    [NOTIFICATION_CENTER_DB_CONFIG, PATHS.NOTIFICATIONS.DB],
];

// `mounts` is walked from its paths tables instead (snapshotMountData); the rest are caches and
// scratch space: mount thumbnails, temp working copies, the Maildir delivery spool, frozen upload
// payloads and the contacts avatar cache, all rebuilt from what the archive does carry.
const SKIPPED_HOME_DIRS = new Set(['mounts', 'thumbs', 'tmp', 'staging', 'avatars']);

// Databases are captured with VACUUM INTO through the live handle, never as a file copy, and their
// journals belong to the running server.
const DB_FILE = /\.db(-wal|-shm)?$/;

function listHomeFiles(dir: string, relDir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIPPED_HOME_DIRS.has(entry.name)) listHomeFiles(path.join(dir, entry.name), rel, out);
        } else if (entry.isFile() && !DB_FILE.test(entry.name)) {
            out.push(rel);
        }
    }
}

function readAuthRows(userId: string) {
    const db = getAuthDrizzleDb();
    // Sessions and verification rows are deliberately absent — a restore re-inserts identity, not
    // live logins. Every column of the rest rides along so the insert on restore is complete.
    return {
        user: db.select().from(user).where(eq(user.id, userId)).all(),
        account: db.select().from(account).where(eq(account.userId, userId)).all(),
        apikey: db.select().from(apikey).where(eq(apikey.referenceId, userId)).all(),
        two_factor: db.select().from(twoFactor).where(eq(twoFactor.userId, userId)).all(),
        member: db.select().from(member).where(eq(member.userId, userId)).all(),
        team_member: db.select().from(teamMember).where(eq(teamMember.userId, userId)).all(),
    };
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

    const stageDatabase = async (config: DatabaseConfig<SchemaType>, relPath: string): Promise<void> => {
        const managed = await home.getLocalDatabase(config, relPath);
        const destPath = path.join(folder, 'home', relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        managed.stageCopy(destPath);
        entries.push(await captureWrittenFile(destPath, `home/${relPath}`));
    };

    for (const [index, [config, relPath]] of HOME_DATABASES.entries()) {
        onProgress?.('databases', index, HOME_DATABASES.length);
        if (!fs.existsSync(path.join(home.homeDir, relPath))) continue;
        await stageDatabase(config, relPath);
    }

    const mounts = home.drive.getMounts();
    const mountSummaries: BackupManifest['mounts'] = [];
    for (const [index, mount] of mounts.entries()) {
        onProgress?.('mounts', index, mounts.length);
        const relPrefix = `home/mounts/${mount.id}`;
        const before = entries.length;
        await stageDatabase(MOUNT_DB_CONFIG, `mounts/${mount.id}/${PATHS.DRIVE.METADATA_DB}`);
        entries.push(...(await snapshotMountData(mount, path.join(folder, relPrefix, 'data'), `${relPrefix}/data`)));
        const mine = entries.slice(before);
        mountSummaries.push({
            id: mount.id,
            storageType: mount.config.storageType,
            files: mine.length,
            bytes: mine.reduce((sum, entry) => sum + entry.bytes, 0),
        });
    }

    const homeFiles: string[] = [];
    listHomeFiles(home.homeDir, '', homeFiles);
    for (const [index, rel] of homeFiles.entries()) {
        onProgress?.('home files', index, homeFiles.length);
        entries.push(
            await captureFile(Bun.file(path.join(home.homeDir, rel)), path.join(folder, 'home', rel), `home/${rel}`),
        );
    }

    if (owner.type === 'user') {
        const encoder = new TextEncoder();
        entries.push(
            await captureFile(
                encoder.encode(JSON.stringify(readAuthRows(ownerId), null, 2)),
                path.join(folder, 'auth.json'),
                'auth.json',
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
                path.join(folder, 'shares.json'),
                'shares.json',
            ),
        );

        const avatarName = `${ownerId}.webp`;
        const avatar = Bun.file(path.join(getAvatarsDir(), avatarName));
        if (await avatar.exists()) {
            entries.push(await captureFile(avatar, path.join(folder, 'avatar', avatarName), `avatar/${avatarName}`));
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
    onProgress?.('done', 1, 1);
    return manifest;
}
