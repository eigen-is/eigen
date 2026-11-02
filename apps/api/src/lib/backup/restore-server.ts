// The first half of restoring a whole server: unpacking and checking the server archive into a staging folder in
// the data root, while Eigen still runs. The homes are rebuilt there from the archive, so that the later swap only
// has to rename folders. For a Light archive it also counts the files here that the swap leaves out of Drive. The
// restore command of the launcher calls it. It runs beside the live API, whose own users3.db sits next to the tree
// it writes, so nothing it imports may open a file on load.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { DRIVE_TYPE_FOLDER } from '@workspace/lib/types/drive';
import { BACKUP_OWNER_ID, buildBackupStamp, parseBackupManifest } from '@workspace/lib/validation';
import { getDataRoot, homeDirUnder, ORG_HOMES_DIR, PATHS, SERVER_DIR, SERVER_RUNTIME_FILES } from '../config/paths';
import { ApiError } from '../core/errors';
import { isUsableName } from '../mount/names';
import type { HashedArchiveMember } from './archive';
import { copyArchiveMember, extractArtifact, readUnpackedHome } from './archive';
import type { MountPathRow } from './archive-layout';
import { flatStorageKey, insideDocument, readMountPathRows, rowArchivePath, storageKeyOf } from './archive-layout';
import { describeError } from './errors';
import type { VersionedDatabase } from './materialize-mount';
import {
    checkRestoredDatabases,
    materializeMount,
    mountIdsIn,
    movePath,
    openToCheck,
    redateTrash,
} from './materialize-mount';
import {
    ARCHIVE_HOME_DIR,
    ARCHIVE_MANIFEST_FILE,
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

// What the stage leaves out of the pending uploads it finds: `settled` the ones data/ here already uploaded or
// canceled, `missing` the ones whose bytes the archive does not hold. Their rows name missing files, which
// reconcile drops.
type NotReplayed = { settled: number; missing: number };

// The files of a home here that a Light swap leaves out of Drive or puts back without their bytes: `created` since the
// backup, which have no row in it; `moved`, renamed, moved or trashed since on a mount that stores files by name,
// whose row names a path their bytes left; `deleted` for good since, whose row comes back; and `unmounted`, those of a
// mount removed since, whose rows come back and may not open. The stage prints them per home before it asks to swap,
// and a home whose count is null as not counted.
type LostFiles = { created: number; moved: number; deleted: number; unmounted: number };
type StagedArchive = NotReplayed & { lost: { home: string; count: LostFiles | null }[] };

const NOTHING_LOST: LostFiles = { created: 0, moved: 0, deleted: 0, unmounted: 0 };

type StageContext = {
    dataDir: string;
    unpackDir: string;
    s3FromArchive: boolean;
    stamp: string;
    now: number;
};

// How much server.tar.zst can grow unpacked: its manifest carries no inner count, and SQLite shrinks that much.
const SERVER_MEMBER_EXPANSION = 10;

// What the stage takes on the data disk, at most: every member unpacked, a home by its inner count. Once: it
// streams each member out of the archive and renames what it unpacked into place.
export function stageBytesNeeded(manifest: ServerArchiveManifest): number {
    const homes = new Map(manifest.homes.map((home) => [home.member, home.bytes ?? 0]));
    const unpacked = (entry: ServerArchiveManifest['entries'][number]) =>
        entry.path === SERVER_ARCHIVE_SERVER_MEMBER
            ? SERVER_MEMBER_EXPANSION * entry.bytes
            : Math.max(entry.bytes, homes.get(entry.path) ?? 0);
    return manifest.entries.reduce((sum, entry) => sum + unpacked(entry), 0);
}

// Every member of the archive into `restoringDir`/data, each verified as it lands. Throws on the first one that
// is refused; the caller takes the staged tree back.
export async function stageServerArchive(
    archive: ServerArchiveFile,
    restoringDir: string,
    { s3FromArchive, onStep }: { s3FromArchive: boolean; onStep: (step: string) => void },
): Promise<StagedArchive> {
    const context: StageContext = {
        dataDir: path.join(restoringDir, RESTORING_DATA_DIR),
        unpackDir: path.join(restoringDir, 'unpack'),
        s3FromArchive,
        stamp: buildBackupStamp(new Date()),
        now: Math.floor(Date.now() / 1000),
    };
    onStep("the server's own databases and settings");
    await stageServerMember(archive, context.dataDir, path.join(context.unpackDir, SERVER_DIR));

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
    const staged: StagedArchive = { settled: 0, missing: 0, lost: [] };
    for (const [index, home] of homes.entries()) {
        onStep(`home ${index + 1} of ${homes.length}: ${home.name}`);
        const { settled, missing, lost } = await stageHome(archive, home, context);
        staged.settled += settled;
        staged.missing += missing;
        if (!lost || Object.values(lost).some(Boolean)) staged.lost.push({ home: home.name, count: lost });
    }
    fs.rmSync(context.unpackDir, { recursive: true, force: true });
    return staged;
}

// server/ and org/ out of server.tar.zst. The runtime files are never captured; one found here goes, so the
// restored server draws a new data epoch and every tab from before reloads.
async function stageServerMember(archive: ServerArchiveFile, dataDir: string, unpackDir: string): Promise<void> {
    const member = archive.members.get(SERVER_ARCHIVE_SERVER_MEMBER);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${SERVER_ARCHIVE_SERVER_MEMBER}`);
    await extractArtifact(member, unpackDir);
    const folder = path.join(unpackDir, buildServerFolderName(new Date(archive.manifest.createdAt)));
    const manifestPath = path.join(folder, ARCHIVE_MANIFEST_FILE);
    const manifest = fs.existsSync(manifestPath) ? parseBackupManifest(fs.readFileSync(manifestPath, 'utf8')) : null;
    if (manifest?.kind !== 'server') {
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

// One home member into the staged tree, by the mode of each mount. Light carries every database and no files:
// the swap merges it into the live home. An s3 mount stays on the bucket as it is, with its staged uploads
// replayed, unless the archive holds its objects and the operator asked for them (fresh keys, as a per-home
// restore does).
async function stageHome(
    archive: ServerArchiveFile,
    home: ServerArchiveManifest['homes'][number] & { member: string },
    { dataDir, unpackDir, s3FromArchive, stamp, now }: StageContext,
): Promise<NotReplayed & { lost: LostFiles | null }> {
    if (!BACKUP_OWNER_ID.test(home.ownerId)) throw new ApiError(400, `${home.ownerId} is not a home id`);
    const member = archive.members.get(home.member);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${home.member}`);
    const unpacked = path.join(unpackDir, home.ownerId);
    await extractArtifact(member, unpacked);
    const { folder, manifest } = readUnpackedHome(unpacked, home.ownerId, home.member);
    requireVerified(await verifyFolder(folder), home.member);
    // The swap goes by the outer level: a light home under a full one would replace a home with no files.
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
    // A Light home carries no files, so its mounts have nothing to put in place.
    for (const summary of level === 'light' ? [] : carried) {
        if (summary.storageType !== 's3' || (s3FromArchive && summary.contents !== 'metadata')) {
            containerDatabases.push(...materializeMount(homeDir, summary, stamp));
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
    await checkRestoredDatabases(homeDir, mountIds, containerDatabases);
    try {
        redateTrash(homeDir, mountIds, now);
    } catch (error) {
        throw new ApiError(400, `the trash of ${home.name} cannot be dated: ${describeError(error)}`);
    }
    fs.rmSync(unpacked, { recursive: true, force: true });
    const lost = level === 'light' ? countLostFiles(homeDir, liveHomeDir, carried) : NOTHING_LOST;
    return { ...notReplayed, lost };
}

// An s3 mount the bucket stays as it is for. Each pending row's bytes go to staging/ under the name its row gives
// them: from staging/ as archived, or, when the archive holds the mount's files, from its data/, which goes.
// A key the live mount has no row for any more was acked or canceled here: replaying it puts older bytes on the
// key. A live row, under whatever name, means the bucket still lacks what the archive holds.
function replayPendingUploads(mountDir: string, liveMountDir: string, fromFiles: boolean): NotReplayed {
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const stagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
    const live = livePendingKeys(liveMountDir);
    const notReplayed: NotReplayed = { settled: 0, missing: 0 };
    const db = new Database(path.join(mountDir, PATHS.DRIVE.METADATA_DB), { readwrite: true, create: false });
    try {
        const rows = fromFiles ? readMountPathRows(db) : [];
        const byId = new Map(rows.map((row) => [row.id, row]));
        const byKey = new Map(rows.filter((row) => row.type === 'file').map((row) => [flatStorageKey(row), row]));
        const pending = db
            .query<{ storageKey: string; stagingPath: string }, []>(
                'SELECT storageKey, stagingPath FROM pending_uploads',
            )
            .all();
        for (const { storageKey, stagingPath } of pending) {
            // A legacy row holds an absolute path on the server that made it; it gets the name the file lands under.
            const name = path.basename(stagingPath);
            const staged = path.join(stagingDir, name);
            if (live && !live.has(storageKey)) {
                if (!fromFiles && isUsableName(name)) fs.rmSync(staged, { force: true });
                notReplayed.settled++;
                continue;
            }
            const row = byKey.get(storageKey);
            const source = fromFiles ? row && resolveInside(dataDir, rowArchivePath(row, byId)) : staged;
            if (!source || !isUsableName(name) || !fs.existsSync(source)) {
                notReplayed.missing++;
                continue;
            }
            if (fromFiles) movePath(source, staged);
            if (name !== stagingPath) {
                db.run('UPDATE pending_uploads SET stagingPath = ? WHERE storageKey = ?', [name, storageKey]);
            }
        }
    } finally {
        db.close();
    }
    if (fromFiles) fs.rmSync(dataDir, { recursive: true, force: true });
    return notReplayed;
}

// The storage keys the live mount still has to upload, or null when its metadata.db cannot tell.
function livePendingKeys(liveMountDir: string): Set<string> | null {
    const rows = readMetadata(
        liveMountDir,
        (db) => db.query<{ storageKey: string }, []>('SELECT storageKey FROM pending_uploads').all(),
        'every pending upload in the archive is replayed',
    );
    return rows && new Set(rows.map((row) => row.storageKey));
}

// What `read` finds in a mount's metadata.db, or null for a mount that never ran here or whose metadata.db does not
// read: a damaged live database is a reason to restore, not to refuse one, and the warning says what that costs.
function readMetadata<T>(mountDir: string, read: (db: Database) => T, otherwise: string): T | null {
    const metadata = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadata)) return null;
    let db: Database | undefined;
    try {
        db = openToCheck(metadata);
        return read(db);
    } catch (error) {
        console.warn(`${metadata} does not read (${describeError(error)}): ${otherwise}`);
        return null;
    } finally {
        db?.close();
    }
}

// Against each mount of the home, here or in the archive: a mount only here drops out of Drive whole. The files of one
// only in the archive come back and may not open, but they are not `deleted`: an s3 mount's objects may still be in
// its bucket. A folder is not counted, and neither is anything inside a document, such as its databases, media and
// versions: a document made or renamed since counts once, and every file in a folder renamed since counts. A home that
// is not here yet is not counted, since the stage already said it comes back without its files. Null when a
// metadata.db does not read: the count must not come out lower than the loss.
function countLostFiles(homeDir: string, liveHomeDir: string, mounts: BackupManifest['mounts']): LostFiles | null {
    if (!fs.existsSync(liveHomeDir)) return NOTHING_LOST;
    const lost: LostFiles = { ...NOTHING_LOST };
    const archivedMounts = new Map(mounts.map((summary) => [summary.id, summary.storageType]));
    for (const id of new Set([...archivedMounts.keys(), ...mountIdsIn(liveHomeDir)])) {
        const liveMountDir = path.join(liveHomeDir, PATHS.DRIVE.ROOT, id);
        const isGone = !fs.existsSync(path.join(liveMountDir, PATHS.DRIVE.METADATA_DB));
        const live = mountRows(liveMountDir);
        const archived = archivedMounts.has(id) ? mountRows(requireMountDir(homeDir, id)) : [];
        if (!live || !archived) return null;
        const liveById = new Map(live.map((row) => [row.id, row]));
        const archivedById = new Map(archived.map((row) => [row.id, row]));
        const isPathBased = archivedMounts.get(id) === 'local';
        for (const row of live) {
            if (!isCounted(row, liveById)) continue;
            const before = archivedById.get(row.id);
            if (!before) lost.created++;
            else if (isPathBased && storageKeyOf(before, archivedById, true) !== storageKeyOf(row, liveById, true)) {
                lost.moved++;
            }
        }
        for (const row of archived) {
            if (!isCounted(row, archivedById) || liveById.has(row.id)) continue;
            if (isGone) lost.unmounted++;
            else lost.deleted++;
        }
    }
    return lost;
}

// Whether Drive shows a row as a file of its own.
function isCounted(row: MountPathRow, byId: ReadonlyMap<string, MountPathRow>): boolean {
    return row.type !== DRIVE_TYPE_FOLDER && !insideDocument(row, byId);
}

// A mount's rows: none for a mount with no metadata.db, and null for one whose metadata.db does not read.
function mountRows(mountDir: string): MountPathRow[] | null {
    if (!fs.existsSync(path.join(mountDir, PATHS.DRIVE.METADATA_DB))) return [];
    return readMetadata(mountDir, readMountPathRows, 'the files of its home are not counted');
}
