import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_OWNER_ID, buildBackupStamp, parseBackupManifest } from '@workspace/lib/validation';
import {
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
import { checkRestoredDatabases, materializeMount, movePath, type VersionedDatabase } from './materialize-mount';
import {
    ARCHIVE_HOME_DIR,
    ARCHIVE_MANIFEST_FILE,
    buildServerFolderName,
    requireMountDir,
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

// A staged upload the live mount no longer holds was acked, superseded or canceled: replaying it puts older bytes
// on the key. Its pending row then names a missing file, which reconcile drops. A live mount without staging/
// never ran here, so the archive's copy is the only one.
function dropSettledUploads(stagingDir: string, liveStagingDir: string): number {
    if (!fs.existsSync(stagingDir) || !fs.existsSync(liveStagingDir)) return 0;
    let dropped = 0;
    for (const name of fs.readdirSync(stagingDir)) {
        if (fs.existsSync(path.join(liveStagingDir, name))) continue;
        fs.rmSync(path.join(stagingDir, name));
        dropped++;
    }
    return dropped;
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
// restore does). Returns how many staged uploads were not replayed.
async function stageHome(
    archive: ServerArchive,
    home: ServerArchiveManifest['homes'][number] & { member: string },
    { dataDir, unpackDir, liveDataRoot, s3FromArchive, stamp, now }: StageContext,
): Promise<number> {
    if (!BACKUP_OWNER_ID.test(home.ownerId)) throw new ApiError(400, `${home.ownerId} is not a home id`);
    const member = archive.members.get(home.member);
    if (!member) throw new ApiError(400, `${archive.name} holds no ${home.member}`);
    const unpacked = path.join(unpackDir, home.ownerId);
    await extractArtifact(member, unpacked);
    const { folder, manifest } = readUnpackedHome(unpacked, home.ownerId, home.member);
    requireVerified(await verifyFolder(folder), home.member);

    const homeDir = homeDirUnder(dataDir, home.ownerId);
    const liveHomeDir = homeDirUnder(liveDataRoot, home.ownerId);
    movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
    const carried = manifest.mounts.filter((summary) => !summary.skipped);
    const containerDatabases: VersionedDatabase[] = [];
    let notReplayed = 0;
    for (const summary of carried) {
        if (manifest.level === 'light') continue;
        const mountDir = requireMountDir(homeDir, summary.id);
        if (summary.storageType !== 's3' || (s3FromArchive && summary.contents !== 'metadata')) {
            containerDatabases.push(...materializeMount(homeDir, summary, stamp));
        } else if (summary.contents === 'metadata') {
            const staging = PATHS.DRIVE.STAGING_DIR;
            notReplayed += dropSettledUploads(
                path.join(mountDir, staging),
                path.join(liveHomeDir, PATHS.DRIVE.ROOT, summary.id, staging),
            );
        } else {
            // The bucket holds these objects under the keys metadata.db names.
            fs.rmSync(path.join(mountDir, PATHS.DRIVE.DATA_DIR), { recursive: true, force: true });
        }
    }
    const mountIds = carried.map((summary) => summary.id);
    checkRestoredDatabases(homeDir, mountIds, containerDatabases);
    for (const id of mountIds) redateTrash(path.join(requireMountDir(homeDir, id), PATHS.DRIVE.METADATA_DB), now);
    fs.rmSync(unpacked, { recursive: true, force: true });
    return notReplayed;
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
): Promise<{ notReplayed: number }> {
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
        if (!name.startsWith(`${SERVER_ARCHIVE_DKIM_DIR}/`)) continue;
        const file = name.slice(SERVER_ARCHIVE_DKIM_DIR.length + 1);
        if (!isUsableName(file)) throw new ApiError(400, `${name} is not a DKIM file`);
        const target = path.join(context.dataDir, DKIM_DIR, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await copyArchiveMember(member, target);
        fs.chmodSync(target, 0o600);
    }

    const homes = archive.manifest.homes.flatMap((home) => (home.member ? [{ ...home, member: home.member }] : []));
    let notReplayed = 0;
    for (const [index, home] of homes.entries()) {
        onStep(`home ${index + 1} of ${homes.length}: ${home.name}`);
        notReplayed += await stageHome(archive, home, context);
    }
    fs.rmSync(context.unpackDir, { recursive: true, force: true });
    return { notReplayed };
}
