// The first half of restoring a whole server: unpacking and checking the server archive into a staging folder in
// the data root, while Eigen still runs. The homes are rebuilt there from the archive, so that the later swap only
// has to rename folders. The restore command of the launcher calls it. It runs beside the live API, whose own
// users3.db sits next to the tree it writes, so nothing it imports may open a file on load.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { BACKUP_OWNER_ID, buildBackupStamp } from '@workspace/lib/validation';
import { getDataRoot, homeDirUnder, ORG_HOMES_DIR, PATHS, SERVER_DIR, SERVER_RUNTIME_FILES } from '../config/paths';
import { ApiError } from '../core/errors';
import { isUsableName } from '../mount/names';
import type { HashedArchiveMember } from './archive';
import {
    copyArchiveMember,
    declaredUnpackBytes,
    extractArtifact,
    readArtifactManifest,
    readManifestFile,
    readUnpackedHome,
    unpackBound,
    withUnpackSlack,
} from './archive';
import { archivePaths, flatStorageKey, readMountPathRows } from './archive-layout';
import { describeError } from './errors';
import type { VersionedDatabase } from './materialize-mount';
import { checkRestoredDatabases, materializeMount, movePath, openToCheck, redateTrash } from './materialize-mount';
import {
    ARCHIVE_HOME_DIR,
    buildServerFolderName,
    INSTALL_FOLDERS,
    requireMountDir,
    resolveInside,
    SERVER_ARCHIVE_SERVER_MEMBER,
} from './paths';
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

// What every member's step of the stage shares. `boundOf` is the most one member's unpack may write.
type StageContext = {
    dataDir: string;
    unpackDir: string;
    s3FromArchive: boolean;
    stamp: string;
    now: number;
    boundOf: (member: HashedArchiveMember) => Promise<number>;
};

// The manifest of each archive inside a server archive, the server member's and every home's, by member name. Each
// is the last entry of its member, so reading one decompresses the whole member. The stage reads them once, for its
// room check, and bounds each unpack by them.
export type MemberManifests = ReadonlyMap<string, BackupManifest>;

export async function readMemberManifests({ manifest, members }: ServerArchiveFile): Promise<MemberManifests> {
    const manifests = new Map<string, BackupManifest>();
    for (const name of [SERVER_ARCHIVE_SERVER_MEMBER, ...manifest.homes.flatMap((home) => home.member ?? [])]) {
        const member = members.get(name);
        if (member) manifests.set(name, await readArtifactManifest(member));
    }
    return manifests;
}

// What the stage takes on the data disk, at most: what each member's unpack declares, with the slack and the reserve
// added once. The server member and each home declare it in their own manifest, and the rest are copied at their
// size. Counted once: the stage streams each member out and renames what it unpacked into place. A caller that also
// stages passes the manifests it read, so no member is decompressed for them twice.
export async function stageBytesNeeded(archive: ServerArchiveFile, manifests?: MemberManifests): Promise<number> {
    const declaredBy = manifests ?? (await readMemberManifests(archive));
    let declared = 0;
    for (const entry of archive.manifest.entries) {
        const inner = declaredBy.get(entry.path);
        declared += inner ? declaredUnpackBytes(inner) : entry.bytes;
    }
    return withUnpackSlack(declared);
}

// Every member of the archive into `restoringDir`/data, each verified as it lands. Throws on the first one that
// is refused; the caller takes the staged tree back. Each unpack stops at what its manifest declares: from
// `manifests` when the caller read them for its room check, or read here.
export async function stageServerArchive(
    archive: ServerArchiveFile,
    restoringDir: string,
    {
        s3FromArchive,
        onStep,
        manifests,
    }: { s3FromArchive: boolean; onStep: (step: string) => void; manifests?: MemberManifests },
): Promise<NotReplayed> {
    const context: StageContext = {
        dataDir: path.join(restoringDir, RESTORING_DATA_DIR),
        unpackDir: path.join(restoringDir, 'unpack'),
        s3FromArchive,
        stamp: buildBackupStamp(new Date()),
        now: Math.floor(Date.now() / 1000),
        boundOf: async (member) => unpackBound(manifests?.get(member.name) ?? (await readArtifactManifest(member))),
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
    { dataDir, boundOf }: StageContext,
    unpackDir: string,
): Promise<void> {
    const member = archive.members.get(SERVER_ARCHIVE_SERVER_MEMBER);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${SERVER_ARCHIVE_SERVER_MEMBER}`);
    await extractArtifact(member, unpackDir, await boundOf(member));
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
    { dataDir, unpackDir, s3FromArchive, stamp, now, boundOf }: StageContext,
): Promise<NotReplayed> {
    if (!BACKUP_OWNER_ID.test(home.ownerId)) throw new ApiError(400, `${home.ownerId} is not a home id`);
    const member = archive.members.get(home.member);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${home.member}`);
    const unpacked = path.join(unpackDir, home.ownerId);
    await extractArtifact(member, unpacked, await boundOf(member));
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
    const containerDatabases: VersionedDatabase[] = [];
    const notReplayed: NotReplayed = { settled: 0, missing: 0 };
    for (const summary of carried) {
        if (summary.storageType !== 's3' || (s3FromArchive && summary.contents !== 'metadata')) {
            containerDatabases.push(...(await materializeMount(homeDir, summary, stamp)));
            continue;
        }
        const replay = replayPendingUploads(
            requireMountDir(homeDir, summary.id),
            path.join(liveHomeDir, PATHS.DRIVE.ROOT, summary.id),
            summary.contents !== 'metadata',
        );
        notReplayed.settled += replay.settled;
        notReplayed.missing += replay.missing;
    }
    const mountIds = carried.map((summary) => summary.id);
    // verifyFolder checked these pages. Since then each file was only renamed, or written through SQLite itself.
    await checkRestoredDatabases(homeDir, mountIds, containerDatabases, { verified: true });
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
        const byKey = new Map(rows.filter((row) => row.type === 'file').map((row) => [flatStorageKey(row), row]));
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
            const source = fromFiles ? row && resolveInside(dataDir, archivePath(row)) : staged;
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
        const files = db
            .query<{ id: string; file: string }, []>("SELECT id, file FROM paths WHERE type = 'file'")
            .all();
        const uploaded = new Set(files.map(flatStorageKey));
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
