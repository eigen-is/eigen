// Restores one home from a backup, or from a safety copy of an earlier restore. The backup is unpacked beside the
// home, on the data disk, and judged and put in place there while the home still serves. Then two renames swap it in:
// the current home folder goes aside as a new safety copy and the unpacked one takes its place. A failed restore puts
// both folders back. Once the home serves again, the owner's rows outside the folder go in, such as their auth rows,
// shares and avatar. The backup routes call it.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupProgress, BackupShare } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { buildBackupStamp, incompleteReason, parseBackupShares } from '@workspace/lib/validation';
import { getAvatarsDir } from '../config/paths';
import { ApiError } from '../core';
import { rotateHomeDataEpoch } from '../home/data-epoch';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { addRegistryEntry } from '../share/registry';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { readUnpackedHome } from './archive';
import { requireArtifact, unpackArtifact } from './artifacts';
import { authRowsToRestore, restoreAuthRows } from './auth-rows';
import { describeError } from './errors';
import { resolveHomeDir } from './home-dir';
import {
    checkDatabases,
    containerDatabasesIn,
    homeDatabasesIn,
    materializeMount,
    mountIdsIn,
    redateTrash,
} from './materialize-mount';
import {
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_SHARES_FILE,
    buildRestoreStagingDir,
    buildRestoreUnpackDir,
    buildSafetyCopyName,
    freeSafetyCopyStamp,
} from './paths';
import { dropRestoringMarker, putHomeBack, wipeRestoreStagingDir, writeRestoringMarker } from './recovery';
import { forgetSafetyCopySize, resolveSafetyCopy } from './safety-copy';
import { requireVerified, verifyFolder } from './verify';

// What a restore does once the home is out of everyone's hands and its folder is aside: put the new
// folder at `homeDir`. The step that prepared it returns it, so it closes over whatever that step judged.
type InstallHome = () => Promise<void>;

// What judging a replacement hands on: the install, and what the restore writes once the home serves again.
type PreparedHome<Judged> = { install: InstallHome; judged: Judged };

export async function restoreHome(
    artifactName: string,
    ownerId: string,
    jobId: string,
    onProgress?: BackupProgress,
): Promise<void> {
    const { artifactPath } = requireArtifact(artifactName);
    const homeDir = await resolveHomeDir(ownerId);

    const identity = await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        async () => {
            // Beside the home, so the swap is a rename on one disk.
            const unpackDir = buildRestoreUnpackDir(homeDir, jobId);
            onProgress?.('extract', 0, 1);
            await unpackArtifact(artifactPath, unpackDir);
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
            // Before materializeMount, which leaves every trash date alone.
            redateRestoredTrash(
                ownerId,
                unpackedHome,
                carried.map((summary) => summary.id),
            );
            // The rows outside the home folder are judged before the home is taken.
            const judged = {
                authRows: authRowsToRestore(ownerId, manifest, folder),
                shares: readShares(folder),
            };
            // An s3 mount's restored files take fresh keys from this stamp. The job id makes it this restore's alone,
            // even when the clock steps back to a second another restore of this home used.
            const keyStamp = `${buildBackupStamp(new Date())}-${jobId}`;
            for (const [index, summary] of carried.entries()) {
                await materializeMount(unpackedHome, summary, keyStamp);
                onProgress?.('mounts', index + 1, carried.length);
            }
            const install: InstallHome = async () => {
                // The archive's `home/` is the home folder, one for one.
                fs.renameSync(unpackedHome, homeDir);
                // Before the job removes the staging folder that holds it.
                await restoreAvatars(ownerId, folder);
            };
            return { install, judged };
        },
        // The new folder of a restore that failed after its swap is not trusted as a home: it keeps a name of its
        // own, which the admin pane lists with a delete and no restore.
        (stamp) => buildSafetyCopyName(homeDir, 'failed-restore', stamp),
    );
    // Only once the home is in place, and nothing rolls the folder back for them. Each write inserts only what is
    // missing, so a failure here fails the job with the home restored, and a retry finishes it.
    if (identity.authRows) restoreAuthRows(ownerId, identity.authRows);
    for (const row of identity.shares) await addRegistryEntry(ownerId, row.targetIdentifier);
    onProgress?.('done', 1, 1);
}

// A remote mount needs no work: every restore takes fresh keys, so the objects the copy points at are still there.
export async function restoreSafetyCopy(
    ownerId: string,
    name: string,
    jobId: string,
    onProgress?: BackupProgress,
): Promise<void> {
    const { folder, homeDir, kind } = await resolveSafetyCopy(ownerId, name);
    if (kind !== 'pre-restore') throw new ApiError(400, `${name} is not a pre-restore copy of this home`);
    if (!fs.existsSync(folder)) throw new ApiError(404, `${name} is not beside this home`);
    // A safety copy of a home whose owner is gone is a delete candidate, not a restore: the folder on its own leaves a
    // home nobody can sign in to. Restoring a deleted user goes through an artifact, which carries their auth rows.
    const owner = parseOwnerId(ownerId);
    const found = owner.type === 'team' ? await getTeam(owner.id) : await getUserById(owner.id);
    if (!found) throw new ApiError(404, `${ownerId} no longer exists`);
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
        // Nothing to unpack, but the copy gets the database checks an unpacked archive gets, while the home serves.
        async () => {
            await checkDatabases([...homeDatabasesIn(folder, mountIds), ...containerDatabasesIn(folder, mountIds)]);
            return { install, judged: null };
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
function readShares(folder: string): BackupShare[] {
    const sharesPath = path.join(folder, ARCHIVE_SHARES_FILE);
    if (!fs.existsSync(sharesPath)) return [];
    const rows = parseBackupShares(fs.readFileSync(sharesPath, 'utf8'));
    if (!rows) throw new ApiError(400, `${ARCHIVE_SHARES_FILE} is not a set of share-registry rows`);
    return rows;
}

// The name lands in the server-wide avatars folder, so only `{ownerId}.{ext}` passes. An avatar goes back only where
// the server has none, so a picture the user changed after the backup is not quietly reverted.
async function restoreAvatars(ownerId: string, folder: string): Promise<void> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
        if (path.parse(name).name !== ownerId) {
            console.warn(`[backup] ${ownerId}: ${name} in the archive is not this user's avatar, not restored`);
            continue;
        }
        const target = path.join(getAvatarsDir(), name);
        if (!fs.existsSync(target)) await fsp.copyFile(path.join(avatarDir, name), target);
    }
}

// The replacement is judged while the home still serves, so a refusal costs nobody a page.
async function replaceHomeFolder<Judged>(
    ownerId: string,
    homeDir: string,
    jobId: string,
    prepare: () => Promise<PreparedHome<Judged>>,
    parkOnFailure: (stamp: string) => string,
): Promise<Judged> {
    const restoreDir = buildRestoreStagingDir(homeDir, jobId);
    // Set when the rollback below could not put the home back. Its note and its mark then stay, for the next boot
    // to finish it.
    let homeOutOfPlace = false;
    try {
        const { install, judged } = await prepare();
        // Throws when another restore or a deletion of this home holds it, before anything below runs.
        markHomeRestoring(ownerId);
        try {
            await evictHome(ownerId);

            // Picked now, so the safety copies are dated by the swap, however long the unpack took.
            const stamp = freeSafetyCopyStamp(homeDir, new Date());
            // There is no home folder to move aside on a restore after the user was deleted.
            const movedAside = fs.existsSync(homeDir) ? buildSafetyCopyName(homeDir, 'pre-restore', stamp) : null;
            const marker = {
                ownerId,
                preRestoreName: movedAside && path.basename(movedAside),
                parkName: path.basename(parkOnFailure(stamp)),
            };
            // Before the move: a process killed from here on leaves the home's path empty or holding a folder the
            // restore did not finish with, and only this note tells the next boot which.
            writeRestoringMarker(restoreDir, marker);
            if (movedAside) fs.renameSync(homeDir, movedAside);

            try {
                await install();
                // Every tab of the home reloads, once the folder is whole and before the note goes: a crash between
                // the two costs an extra reload, never a stale tab over the new home.
                await rotateHomeDataEpoch(ownerId);
                dropRestoringMarker(restoreDir);
            } catch (error) {
                // The boot's own undo, from the same note. A failure in it must not hide the one that brought us here.
                try {
                    putHomeBack(marker, homeDir);
                } catch (rollbackError) {
                    homeOutOfPlace = true;
                    console.error(
                        `[backup] could not put ${ownerId}'s home back after a failed restore:`,
                        rollbackError,
                    );
                    // A refusal keeps its own status: it is not the server's fault.
                    throw new ApiError(
                        error instanceof ApiError ? error.status : 500,
                        `${describeError(error)}, and the home could not be put back. The account is shut until Eigen restarts, which puts it back: run ./eigen stop, then ./eigen restart`,
                        { cause: error },
                    );
                }
                throw error;
            }
        } finally {
            // A home the rollback left out of place stays shut until the boot puts it back: a request would make a new
            // home folder at its empty path.
            if (!homeOutOfPlace) clearHomeRestoring(ownerId);
        }
        return judged;
    } finally {
        // It may not throw over the failure that brought us here.
        try {
            if (homeOutOfPlace) await fsp.rm(buildRestoreUnpackDir(homeDir, jobId), { recursive: true, force: true });
            else await wipeRestoreStagingDir(homeDir, jobId);
        } catch (error) {
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
        }
    }
}
