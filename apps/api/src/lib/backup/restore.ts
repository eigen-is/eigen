// Restores one home from a backup, or from a safety copy of an earlier restore. The backup is unpacked and judged
// while the home still serves. Then the current home folder is moved aside as a new safety copy, the backup goes in
// its place, and a failed restore puts both folders back. Last come the owner's rows outside the folder, such as their
// auth rows, shares and avatar. The backup routes call it.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupProgress, BackupShare } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { incompleteReason, parseBackupShares } from '@workspace/lib/validation';
import { closeCollabConnectionsForHome } from '../collab/connections';
import { getAvatarsDir } from '../config/paths';
import { ApiError } from '../core';
import { rotateHomeDataEpoch } from '../home/data-epoch';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { addRegistryEntry } from '../share/registry';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { extractArtifact, readUnpackedHome } from './archive';
import { requireArtifact } from './artifacts';
import { authRowsToRestore, restoreAuthRows } from './auth-rows';
import { describeError } from './errors';
import { resolveHomeDir } from './home-dir';
import {
    checkRestoredDatabases,
    checkUnpackedHome,
    containerDatabasesIn,
    materializeMount,
    mountIdsIn,
    movePathAsync,
    redateTrash,
} from './materialize-mount';
import {
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_SHARES_FILE,
    buildSafetyCopyName,
    freeSafetyCopyStamp,
    getBackupStagingDir,
    wipeBackupStagingDir,
} from './paths';
import { writeRestoreCompleteMarker, writeRestoringMarker } from './recovery';
import { forgetSafetyCopySize, resolveSafetyCopy } from './safety-copy';
import { requireVerified, verifyFolder } from './verify';

// Replaces one home with the copy inside an artifact: the home as it stands goes aside as `{id}.pre-restore-{ts}`,
// and a failed install as `{id}.failed-restore-{ts}`. The first load after the restore runs migrations and reseeds
// each domain's byte counters from the restored rows.
export async function restoreHome(
    artifactName: string,
    ownerId: string,
    jobId: string,
    onProgress?: BackupProgress,
): Promise<void> {
    const { artifactPath } = requireArtifact(artifactName);
    const homeDir = await resolveHomeDir(ownerId);

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        async () => {
            // Unpack into this job's staging folder and judge the archive while the home still serves.
            const unpackDir = path.join(getBackupStagingDir(jobId), 'restore');
            // A retry of a job whose id was reused would otherwise extract over the last attempt's
            // tree, and stage 1 fails an archive on a file the manifest does not list.
            await fsp.rm(unpackDir, { recursive: true, force: true });
            onProgress?.('extract', 0, 1);
            await extractArtifact(artifactPath, unpackDir);
            onProgress?.('extract', 1, 1);
            const { folder, manifest } = readUnpackedHome(unpackDir, ownerId, artifactName);
            // A member of a whole-server archive that left out what only a restore of that archive puts back.
            const incomplete = incompleteReason(manifest);
            if (incomplete) throw new ApiError(400, `${artifactName} ${incomplete}`);
            requireVerified(await verifyFolder(folder, onProgress), artifactName);
            // A mount the backup skipped carries nothing. It stays disabled in the restored settings.json, and
            // snapshotHome left its folder out.
            const carried = manifest.mounts.filter((summary) => !summary.skipped);
            const unpackedHome = path.join(folder, ARCHIVE_HOME_DIR);
            await checkUnpackedHome(unpackedHome, carried);
            // Here, so a failure refuses while the home still serves. materializeMount leaves every trash date alone.
            redateRestoredTrash(
                ownerId,
                unpackedHome,
                carried.map((summary) => summary.id),
            );
            // Read before the first write, since nothing takes an auth row back: a shares.json that does not read
            // would otherwise leave a deleted user signed in to an empty home.
            const shares = readShares(folder);
            // An archive of somebody else is refused now rather than after the install. The insert reads it again.
            authRowsToRestore(ownerId, manifest, folder);

            return async (stamp) => {
                // The archive's `home/` is the home folder, one for one.
                onProgress?.('home files', 0, 1);
                await movePathAsync(unpackedHome, homeDir);
                onProgress?.('home files', 1, 1);
                for (const [index, summary] of carried.entries()) {
                    materializeMount(homeDir, summary, stamp);
                    onProgress?.('mounts', index + 1, carried.length);
                }

                // The rows that live outside the home folder (users only).
                restoreAuthRows(ownerId, manifest, folder);
                await restoreShares(ownerId, shares);
                await restoreAvatar(ownerId, folder);
            };
        },
        // A half-written extraction is not a home: it keeps a name of its own, which the admin pane
        // lists with a delete and no restore.
        (stamp) => buildSafetyCopyName(homeDir, 'failed-restore', stamp),
    );
    onProgress?.('done', 1, 1);
}

// Puts a `.pre-restore-` copy back where it came from: the home as it stands becomes a safety copy
// of its own and the chosen folder takes its place. No file is copied and none is deleted. A remote
// mount needs no work either, because the copy still points at the objects it was restored away from:
// materializeMount gives every restore fresh keys. A `.failed-restore-` copy is refused, because it is
// the half-written folder of a restore that never finished, not a home.
export async function restoreSafetyCopy(
    ownerId: string,
    name: string,
    jobId: string,
    onProgress?: BackupProgress,
): Promise<void> {
    const { folder, homeDir, kind } = await resolveSafetyCopy(ownerId, name);
    if (kind !== 'pre-restore') throw new ApiError(400, `${name} is not a pre-restore copy of this home`);
    if (!fs.existsSync(folder)) throw new ApiError(404, `${name} is not beside this home`);
    await requireOwnerExists(ownerId);
    const mountIds = mountIdsIn(folder);

    const install: InstallHome = async () => {
        onProgress?.('home files', 0, 1);
        fs.renameSync(folder, homeDir);
        // The copy is not at that path any more. A later one can land on the same name, since the
        // stamp has one-second steps, and it would then list the size measured for this folder.
        forgetSafetyCopySize(folder);
        onProgress?.('home files', 1, 1);
        // Only once the copy is in place. A refusal here can leave some of the copy's trash re-dated, which only
        // lengthens its retention.
        redateRestoredTrash(ownerId, homeDir, mountIds);
    };

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        // Nothing to unpack: the folder is right there. It gets the verdict a restore from an archive ends on, while
        // the home still serves: SQLite's on the bytes, and this build's on every schema stamp. A copy this server
        // made passes both, and one carried over from a newer server does not.
        async () => {
            await checkRestoredDatabases(folder, mountIds, containerDatabasesIn(folder, mountIds));
            return install;
        },
        // Back under the name it came from, here and at boot after a kill. A `.failed-restore-` name would make a
        // pristine home unrestorable, and the only action left on one deletes its bytes.
        () => folder,
    );
    onProgress?.('done', 1, 1);
}

// Every restore starts the restored trash over. A metadata.db that cannot take the write refuses the restore by name.
function redateRestoredTrash(ownerId: string, homeDir: string, mountIds: readonly string[]): void {
    try {
        redateTrash(homeDir, mountIds, Math.floor(Date.now() / 1000));
    } catch (error) {
        throw new ApiError(400, `the trash of ${ownerId}'s home cannot be dated: ${describeError(error)}`);
    }
}

// The share-registry rows the archive holds: none for a team, which has no shares.json.
export function readShares(folder: string): BackupShare[] {
    const sharesPath = path.join(folder, ARCHIVE_SHARES_FILE);
    if (!fs.existsSync(sharesPath)) return [];
    const rows = parseBackupShares(fs.readFileSync(sharesPath, 'utf8'));
    if (!rows) throw new ApiError(400, `${ARCHIVE_SHARES_FILE} is not a set of share-registry rows`);
    return rows;
}

// Inserts only the missing rows: a registry row that is already there describes a live share.
export async function restoreShares(ownerId: string, rows: readonly BackupShare[]): Promise<void> {
    for (const row of rows) await addRegistryEntry(ownerId, row.targetIdentifier);
}

// The avatar is server data, not home data. It goes back only where the server has none, so a picture
// the user changed after the backup is not quietly reverted. The name comes from the archive and lands
// in the server-wide avatars folder, so it must be this user's, `{ownerId}.{ext}`: otherwise a hostile
// archive could plant a picture for somebody who has none.
async function restoreAvatar(ownerId: string, folder: string): Promise<void> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
        if (path.parse(name).name !== ownerId) {
            console.warn(`[backup] ${ownerId}: ${name} in the archive is not this user's avatar, not restored`);
            continue;
        }
        const target = path.join(getAvatarsDir(), name);
        if (fs.existsSync(target)) continue;
        await Bun.write(target, Bun.file(path.join(avatarDir, name)));
    }
}

// What a restore does once the home is out of everyone's hands and its folder is aside: put the new
// folder at `homeDir`. The step that prepared it returns it, so it closes over whatever that step judged.
type InstallHome = (stamp: string) => Promise<void>;

// The moves every restore is made of: judge the replacement while the home still serves, so a refusal costs nobody a
// page, then take the home from everyone, put its folder aside, install the replacement, and on a failure put both
// folders back, deleting nothing. The marker written here is the only note the next boot reads of an interrupted
// restore, so recoverInterruptedRestores covers every kind.
async function replaceHomeFolder(
    ownerId: string,
    homeDir: string,
    jobId: string,
    prepare: () => Promise<InstallHome>,
    parkOnFailure: (stamp: string) => string,
): Promise<void> {
    try {
        const install = await prepare();
        // Throws when another restore or a deletion of this home holds it, before anything below runs.
        markHomeRestoring(ownerId);
        try {
            await takeAndReplace(ownerId, homeDir, jobId, install, parkOnFailure);
        } finally {
            // Whatever happened is over, and a failed install put the home back itself.
            clearHomeRestoring(ownerId);
        }
    } finally {
        // It may not throw over the failure that brought us here.
        try {
            await wipeBackupStagingDir(jobId);
        } catch (error) {
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
        }
    }
}

// The part of a restore that runs while the home is marked restoring, and every request to it meets the 503.
async function takeAndReplace(
    ownerId: string,
    homeDir: string,
    jobId: string,
    install: InstallHome,
    parkOnFailure: (stamp: string) => string,
): Promise<void> {
    // Sessions are untouched: the user stays signed in, every request just meets the 503 until the mark clears.
    closeCollabConnectionsForHome(ownerId);
    await evictHome(ownerId);

    // There is no home folder to move aside on a restore after the user was deleted.
    const stamp = freeSafetyCopyStamp(homeDir, new Date());
    const movedAside = fs.existsSync(homeDir) ? buildSafetyCopyName(homeDir, 'pre-restore', stamp) : null;
    const parked = parkOnFailure(stamp);
    // Before the move: a process killed from here on leaves a home folder gone or half written, and which one
    // only this note tells the next boot, with the name the folder at the home's path goes aside under.
    writeRestoringMarker(jobId, {
        ownerId,
        homeDir,
        preRestoreName: movedAside && path.basename(movedAside),
        parkName: path.basename(parked),
    });
    if (movedAside) fs.renameSync(homeDir, movedAside);

    try {
        await install(stamp);
        // Every tab of the home reloads, once the folder is whole and before the completion note: a crash
        // between the two costs an extra reload, never a stale tab over the new home.
        await rotateHomeDataEpoch(ownerId);
        writeRestoreCompleteMarker(jobId);
    } catch (error) {
        // A failure while putting the home back must not hide the one that brought us here.
        try {
            if (fs.existsSync(homeDir)) fs.renameSync(homeDir, parked);
            if (movedAside) fs.renameSync(movedAside, homeDir);
        } catch (rollbackError) {
            console.error(`[backup] could not put ${ownerId}'s home back after a failed restore:`, rollbackError);
        }
        throw error;
    }
}

// A safety copy of a home whose owner is gone is a delete candidate, not a restore: the folder on
// its own leaves a home nobody can sign in to. Restoring a deleted user goes through an artifact,
// which carries their auth rows with it.
async function requireOwnerExists(ownerId: string): Promise<void> {
    const owner = parseOwnerId(ownerId);
    const found = owner.type === 'team' ? await getTeam(owner.id) : await getUserById(owner.id);
    if (!found) throw new ApiError(404, `${ownerId} no longer exists`);
}
