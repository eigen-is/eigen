// The first half of restoring a whole server: unpacking and checking the server archive into a staging folder in
// the data root, while Eigen still runs. The homes are rebuilt there from the archive, so that the later swap only
// has to rename folders. The restore command of the launcher calls it. It runs beside the live API, whose own
// users3.db sits next to the tree it writes, so nothing it imports may open a file on load.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveManifest } from '@workspace/lib/types/backup';
import { BACKUP_OWNER_ID, buildBackupStamp } from '@workspace/lib/validation';
import { getDataRoot, homeDirUnder, ORG_HOMES_DIR, PATHS, SERVER_DIR, SERVER_RUNTIME_FILES } from '../config/paths';
import { ApiError } from '../core/errors';
import { isUsableName } from '../mount/names';
import type { HashedArchiveMember } from './archive';
import {
    copyArchiveMember,
    extractArtifact,
    readArtifactManifest,
    readManifestFile,
    readUnpackedHome,
    withUnpackSlack,
} from './archive';
import { archivePaths, readMountPathRows } from './archive-layout';
import { describeError } from './errors';
import { materializeMount, movePath, openToCheck, redateTrash } from './materialize-mount';
import { ARCHIVE_HOME_DIR, buildServerFolderName, INSTALL_FOLDERS, SERVER_ARCHIVE_SERVER_MEMBER } from './paths';
import { requireVerified, verifyFolder } from './verify';

// The staging folder in the data root, data/.restoring, which the swap renames into place.
export const RESTORING_DIR = '.restoring';
// Inside it, the new data/, with the archive's .env.production beside it.
export const RESTORING_DATA_DIR = 'data';

export type ServerArchiveFile = {
    name: string;
    manifest: ServerArchiveManifest;
    members: Map<string, HashedArchiveMember>;
};

// What the stage leaves out of the pending uploads it finds: `settled` the ones data/ here already uploaded,
// `missing` the ones whose bytes the archive does not hold. The rows of the missing name missing files, which
// reconcile drops.
type NotReplayed = { settled: number; missing: number };

// What every member's step of the stage shares.
type StageContext = { dataDir: string; unpackDir: string; s3FromArchive: boolean; stamp: string; now: number };

// What the stage takes on the data disk, at most: the bytes of each member, with the slack and the reserve added once.
// The server member and each home count theirs in their own manifest, and the rest are copied at their size. Each
// inner manifest is the last entry of its member, so reading one decompresses the whole member. Counted once: the stage
// streams each member out and renames what it unpacked into place.
export async function stageBytesNeeded({ manifest, members }: ServerArchiveFile): Promise<number> {
    const unpacked = new Set([SERVER_ARCHIVE_SERVER_MEMBER, ...manifest.homes.flatMap((home) => home.member ?? [])]);
    let declared = 0;
    for (const entry of manifest.entries) {
        const member = members.get(entry.path);
        const inner = member && unpacked.has(entry.path) ? await readArtifactManifest(member) : undefined;
        declared += inner ? inner.counts.bytes : entry.bytes;
    }
    return withUnpackSlack(declared);
}

// Every member of the archive into `restoringDir`/data, each verified as it lands. Throws on the first one that
// is refused; the caller takes the staged tree back.
export async function stageServerArchive(
    archive: ServerArchiveFile,
    restoringDir: string,
    { s3FromArchive, onStep }: { s3FromArchive: boolean; onStep: (step: string) => void },
): Promise<NotReplayed> {
    const context: StageContext = {
        dataDir: path.join(restoringDir, RESTORING_DATA_DIR),
        unpackDir: path.join(restoringDir, 'unpack'),
        s3FromArchive,
        stamp: buildBackupStamp(new Date()),
        now: Math.floor(Date.now() / 1000),
    };
    onStep("the server's own databases and settings");
    await stageServerMember(archive, context, path.join(context.unpackDir, SERVER_DIR));

    // Each install folder into its folder in data/. The containers that use them give them their owners and modes
    // when they start.
    for (const [name, member] of archive.members) {
        const folder = INSTALL_FOLDERS.find((candidate) => name.startsWith(`${candidate.dir}/`));
        if (!folder) continue;
        const file = name.slice(folder.dir.length + 1);
        if (!(folder.names ? folder.names.includes(file) : isUsableName(file))) {
            throw new ApiError(400, `${name} is not a ${folder.what} file`);
        }
        const target = path.join(context.dataDir, folder.dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await copyArchiveMember(member, target);
        fs.chmodSync(target, 0o600);
    }

    const homes = archive.manifest.homes.flatMap((home) => (home.member ? [{ ...home, member: home.member }] : []));
    const staged: NotReplayed = { settled: 0, missing: 0 };
    for (const [index, home] of homes.entries()) {
        onStep(`home ${index + 1} of ${homes.length}: ${home.name}`);
        const { settled, missing } = await stageHome(archive, home, context);
        staged.settled += settled;
        staged.missing += missing;
    }
    fs.rmSync(context.unpackDir, { recursive: true, force: true });
    return staged;
}

// server/ and org/ out of server.tar.zst. The runtime files are never captured; one found here goes, so the
// restored server draws a new data epoch and every tab from before reloads.
async function stageServerMember(
    archive: ServerArchiveFile,
    { dataDir }: StageContext,
    unpackDir: string,
): Promise<void> {
    const member = archive.members.get(SERVER_ARCHIVE_SERVER_MEMBER);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${SERVER_ARCHIVE_SERVER_MEMBER}`);
    await extractArtifact(member, unpackDir);
    const folder = path.join(unpackDir, buildServerFolderName(new Date(archive.manifest.createdAt)));
    if (readManifestFile(folder)?.kind !== 'server') {
        throw new ApiError(400, `${SERVER_ARCHIVE_SERVER_MEMBER} carries no server manifest`);
    }
    requireVerified(await verifyFolder(folder), SERVER_ARCHIVE_SERVER_MEMBER);
    movePath(path.join(folder, SERVER_DIR), path.join(dataDir, SERVER_DIR));
    if (fs.existsSync(path.join(folder, ORG_HOMES_DIR))) {
        movePath(path.join(folder, ORG_HOMES_DIR), path.join(dataDir, ORG_HOMES_DIR));
    }
    for (const name of Object.values(SERVER_RUNTIME_FILES)) {
        fs.rmSync(path.join(dataDir, SERVER_DIR, name), { force: true });
    }
}

// One home member into the staged tree, by the mode of each mount. An s3 mount stays on the bucket as it is, with its
// staged uploads replayed, unless the archive holds its objects and the operator asked for them (fresh keys, as a
// per-home restore does).
async function stageHome(
    archive: ServerArchiveFile,
    home: ServerArchiveManifest['homes'][number] & { member: string },
    { dataDir, unpackDir, s3FromArchive, stamp, now }: StageContext,
): Promise<NotReplayed> {
    if (!BACKUP_OWNER_ID.test(home.ownerId)) throw new ApiError(400, `${home.ownerId} is not a home id`);
    const member = archive.members.get(home.member);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${home.member}`);
    const unpacked = path.join(unpackDir, home.ownerId);
    await extractArtifact(member, unpacked);
    const { folder, manifest } = readUnpackedHome(unpacked, home.ownerId, home.member);
    requireVerified(await verifyFolder(folder), home.member);
    // --s3-from-archive trusts the outer level, so every home in the archive is captured at it.
    const { level } = manifest;
    if (level !== archive.manifest.level) {
        throw new ApiError(400, `${home.member} is a ${level} capture in a ${archive.manifest.level} archive`);
    }

    const homeDir = homeDirUnder(dataDir, home.ownerId);
    const liveHomeDir = homeDirUnder(getDataRoot(), home.ownerId);
    movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
    const carried = manifest.mounts.filter((summary) => !summary.skipped);
    const notReplayed: NotReplayed = { settled: 0, missing: 0 };
    for (const summary of carried) {
        if (summary.storageType !== 's3' || (s3FromArchive && summary.contents !== 'metadata')) {
            await materializeMount(homeDir, summary, stamp);
            continue;
        }
        const replay = replayPendingUploads(
            path.join(homeDir, PATHS.DRIVE.ROOT, summary.id),
            path.join(liveHomeDir, PATHS.DRIVE.ROOT, summary.id),
            summary.contents !== 'metadata',
        );
        notReplayed.settled += replay.settled;
        notReplayed.missing += replay.missing;
    }
    const mountIds = carried.map((summary) => summary.id);
    try {
        redateTrash(homeDir, mountIds, now);
    } catch (error) {
        throw new ApiError(400, `the trash of ${home.name} cannot be dated: ${describeError(error)}`);
    }
    fs.rmSync(unpacked, { recursive: true, force: true });
    return notReplayed;
}

// An s3 mount the bucket stays as it is for. Each pending row's bytes go to staging/ under the name its row gives
// them: from staging/ as archived, or, when the archive holds the mount's files, from its data/, which goes.
// A key the live mount uploaded is not replayed, since that would put older bytes on it. Every other key is: the
// bucket may never have had it, such as after a restore of the home gave its files new keys.
function replayPendingUploads(mountDir: string, liveMountDir: string, fromFiles: boolean): NotReplayed {
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const stagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
    const uploaded = liveUploadedKeys(liveMountDir);
    const notReplayed: NotReplayed = { settled: 0, missing: 0 };
    const db = new Database(path.join(mountDir, PATHS.DRIVE.METADATA_DB), { readwrite: true, create: false });
    try {
        const rows = fromFiles ? readMountPathRows(db) : [];
        const archivePath = archivePaths(rows);
        const byKey = new Map(rows.filter((row) => row.type === 'file').map((row) => [row.file, row]));
        const pending = db
            .query<{ storageKey: string; stagingPath: string }, []>(
                'SELECT storageKey, stagingPath FROM pending_uploads',
            )
            .all();
        for (const { storageKey, stagingPath } of pending) {
            const staged = path.join(stagingDir, stagingPath);
            if (uploaded?.has(storageKey)) {
                if (!fromFiles) fs.rmSync(staged, { force: true });
                notReplayed.settled++;
                continue;
            }
            const row = byKey.get(storageKey);
            const source = fromFiles ? row && path.join(dataDir, archivePath(row)) : staged;
            if (!source || !fs.existsSync(source)) {
                notReplayed.missing++;
                continue;
            }
            if (fromFiles) movePath(source, staged);
        }
    } finally {
        db.close();
    }
    if (fromFiles) fs.rmSync(dataDir, { recursive: true, force: true });
    return notReplayed;
}

// The storage keys the live mount has uploaded: those of its files with no pending upload. It is null for a mount that
// never ran here or whose metadata.db does not read: a damaged live database is a reason to restore, not to refuse
// one, and the warning says what that costs.
function liveUploadedKeys(liveMountDir: string): Set<string> | null {
    const metadata = path.join(liveMountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadata)) return null;
    let db: Database | undefined;
    try {
        db = openToCheck(metadata);
        const files = db.query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'").all();
        const uploaded = new Set(files.map((row) => row.file));
        for (const { storageKey } of db
            .query<{ storageKey: string }, []>('SELECT storageKey FROM pending_uploads')
            .all()) {
            uploaded.delete(storageKey);
        }
        return uploaded;
    } catch (error) {
        console.warn(
            `${metadata} does not read (${describeError(error)}): every pending upload in the archive is replayed`,
        );
        return null;
    } finally {
        db?.close();
    }
}
