import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_OWNER_ID, buildBackupStamp, parseBackupManifest } from '@workspace/lib/validation';
import {
    CERT_FILES,
    CERTS_DIR,
    DKIM_DIR,
    ORG_HOMES_DIR,
    SERVER_DIR,
    SERVER_RUNTIME_FILES,
    TEAM_HOMES_DIR,
    USER_HOMES_DIR,
} from '../config/paths';
import { PATHS } from '../core/constants';
import { ApiError } from '../core/errors';
import { isUsableName } from '../mount/names';
import { type ArchiveMember, copyArchiveMember, extractArtifact, readUnpackedHome } from './archive';
import { archivePath, flatStorageKey, readMountPathRows } from './archive-layout';
import { describeError } from './errors';
import { checkRestoredDatabases, materializeMount, movePath, type VersionedDatabase } from './materialize-mount';
import {
    ARCHIVE_HOME_DIR,
    ARCHIVE_MANIFEST_FILE,
    buildServerFolderName,
    requireMountDir,
    resolveInside,
    SERVER_ARCHIVE_CERTS_DIR,
    SERVER_ARCHIVE_DKIM_DIR,
    SERVER_ARCHIVE_SERVER_MEMBER,
} from './paths';
import { FAILURES_IN_MESSAGE, verifyFolder } from './verify';

// ./eigen restore stages a whole-server archive into data/.restoring while the API runs on data/, then swaps it in
// with the API stopped. This is the stage's work on the tree; cli/restore.ts asks, refuses and swaps. Nothing it
// imports opens a file on load: the API's own users3.db sits beside the tree it writes.
export const RESTORING_DIR = '.restoring';
// Inside it, the new data/, with the archive's .env.production beside it.
export const RESTORING_DATA_DIR = 'data';

export type ServerArchive = { name: string; manifest: ServerArchiveManifest; members: Map<string, ArchiveMember> };

// Where an owner's home folder sits under a data root.
export function homeDirUnder(dataRoot: string, ownerId: string): string {
    const owner = parseOwnerId(ownerId);
    return path.join(dataRoot, owner.type === 'team' ? TEAM_HOMES_DIR : USER_HOMES_DIR, owner.id);
}

function requireVerified(verified: Awaited<ReturnType<typeof verifyFolder>>, name: string): void {
    if (verified.status === 'verified') return;
    throw new ApiError(400, `${name} did not verify: ${verified.failures.slice(0, FAILURES_IN_MESSAGE).join('; ')}`);
}

// server/ and org/ out of server.tar.zst. The runtime files are never captured; one found here goes, so the
// restored server draws a new data epoch and every tab from before reloads.
async function stageServerMember(archive: ServerArchive, dataDir: string, unpackDir: string): Promise<void> {
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

// The install folders an archive may carry beside its members, each into its folder in data/. The containers that
// use them give them their owners and modes when they start.
const CERT_NAMES = new Set<string>(Object.values(CERT_FILES));
const INSTALL_FOLDERS = [
    { member: SERVER_ARCHIVE_DKIM_DIR, dir: DKIM_DIR, what: 'DKIM', accepts: isUsableName },
    { member: SERVER_ARCHIVE_CERTS_DIR, dir: CERTS_DIR, what: 'TLS', accepts: (file: string) => CERT_NAMES.has(file) },
];

// What the stage leaves out of the pending uploads it finds: `settled` the ones data/ here already uploaded or
// canceled, `missing` the ones whose bytes the archive does not hold. Their rows name missing files, which
// reconcile drops.
export type NotReplayed = { settled: number; missing: number };

// The storage keys the live mount still has to upload, or null for a mount that never ran here.
function livePendingKeys(liveMountDir: string): Set<string> | null {
    const metadata = path.join(liveMountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadata)) return null;
    const db = new Database(metadata, { readonly: true });
    try {
        const rows = db.query<{ storageKey: string }, []>('SELECT storageKey FROM pending_uploads').all();
        return new Set(rows.map((row) => row.storageKey));
    } finally {
        db.close();
    }
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
            const source = fromFiles ? row && resolveInside(dataDir, archivePath(row, byId)) : staged;
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

// The trash starts over, so a purge never deletes bucket objects the data/ kept aside may still name, and the
// operator has the whole retention window. In seconds, as trashPath writes it.
function redateTrash(metadataPath: string, now: number): void {
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        db.run('UPDATE paths SET trashedAt = ? WHERE trashedAt IS NOT NULL', [now]);
    } finally {
        db.close();
    }
}

// How much server.tar.zst can grow unpacked: its manifest carries no inner count, and SQLite shrinks that much.
const SERVER_MEMBER_EXPANSION = 10;

// What the stage takes on the data disk, at most: every member unpacked, a home by its inner count, and as much
// again for a mount materialized beside its unpacked tree.
export function stageBytesNeeded(manifest: ServerArchiveManifest): number {
    const homes = new Map(manifest.homes.map((home) => [home.member, home.bytes ?? 0]));
    const unpacked = (entry: ServerArchiveManifest['entries'][number]) =>
        entry.path === SERVER_ARCHIVE_SERVER_MEMBER
            ? SERVER_MEMBER_EXPANSION * entry.bytes
            : Math.max(entry.bytes, homes.get(entry.path) ?? 0);
    return 2 * manifest.entries.reduce((sum, entry) => sum + unpacked(entry), 0);
}

type StageContext = {
    dataDir: string;
    unpackDir: string;
    liveDataRoot: string;
    s3FromArchive: boolean;
    stamp: string;
    now: number;
};

// One home member into the staged tree, by the mode of each mount. Light carries every database and no files:
// the swap merges it into the live home. An s3 mount stays on the bucket as it is, with its staged uploads
// replayed, unless the archive holds its objects and the operator asked for them (fresh keys, as a per-home
// restore does).
async function stageHome(
    archive: ServerArchive,
    home: ServerArchiveManifest['homes'][number] & { member: string },
    { dataDir, unpackDir, liveDataRoot, s3FromArchive, stamp, now }: StageContext,
    notReplayed: NotReplayed,
): Promise<void> {
    if (!BACKUP_OWNER_ID.test(home.ownerId)) throw new ApiError(400, `${home.ownerId} is not a home id`);
    const member = archive.members.get(home.member);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${home.member}`);
    const unpacked = path.join(unpackDir, home.ownerId);
    await extractArtifact(member, unpacked);
    const { folder, manifest } = readUnpackedHome(unpacked, home.ownerId, home.member);
    requireVerified(await verifyFolder(folder), home.member);
    // The swap goes by the outer level: a light home under a full one would replace a home with no files.
    const level = manifest.level ?? 'full-s3';
    if (level !== archive.manifest.level) {
        throw new ApiError(400, `${home.member} is a ${level} capture in a ${archive.manifest.level} archive`);
    }

    const homeDir = homeDirUnder(dataDir, home.ownerId);
    const liveHomeDir = homeDirUnder(liveDataRoot, home.ownerId);
    movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
    const carried = manifest.mounts.filter((summary) => !summary.skipped);
    const containerDatabases: VersionedDatabase[] = [];
    for (const summary of carried) {
        if (level === 'light') continue;
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
    checkRestoredDatabases(homeDir, mountIds, containerDatabases);
    for (const id of mountIds) {
        try {
            redateTrash(path.join(requireMountDir(homeDir, id), PATHS.DRIVE.METADATA_DB), now);
        } catch (error) {
            throw new ApiError(400, `the trash of ${home.name} cannot be dated: ${describeError(error)}`);
        }
    }
    fs.rmSync(unpacked, { recursive: true, force: true });
}

// Every member of the archive into `restoringDir`/data, each verified as it lands. Throws on the first one that
// is refused; the caller takes the staged tree back.
export async function stageServerArchive(
    archive: ServerArchive,
    restoringDir: string,
    {
        liveDataRoot,
        s3FromArchive,
        onStep,
    }: { liveDataRoot: string; s3FromArchive: boolean; onStep: (step: string) => void },
): Promise<NotReplayed> {
    const context: StageContext = {
        dataDir: path.join(restoringDir, RESTORING_DATA_DIR),
        unpackDir: path.join(restoringDir, 'unpack'),
        liveDataRoot,
        s3FromArchive,
        stamp: buildBackupStamp(new Date()),
        now: Math.floor(Date.now() / 1000),
    };
    onStep('server');
    await stageServerMember(archive, context.dataDir, path.join(context.unpackDir, SERVER_DIR));

    for (const [name, member] of archive.members) {
        const folder = INSTALL_FOLDERS.find((candidate) => name.startsWith(`${candidate.member}/`));
        if (!folder) continue;
        const file = name.slice(folder.member.length + 1);
        if (!folder.accepts(file)) throw new ApiError(400, `${name} is not a ${folder.what} file`);
        const target = path.join(context.dataDir, folder.dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await copyArchiveMember(member, target);
        fs.chmodSync(target, 0o600);
    }

    const homes = archive.manifest.homes.flatMap((home) => (home.member ? [{ ...home, member: home.member }] : []));
    const notReplayed: NotReplayed = { settled: 0, missing: 0 };
    for (const [index, home] of homes.entries()) {
        onStep(`home ${index + 1} of ${homes.length}: ${home.name}`);
        await stageHome(archive, home, context, notReplayed);
    }
    fs.rmSync(context.unpackDir, { recursive: true, force: true });
    return notReplayed;
}
