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
import { closeCollabConnectionsForHome } from '../collab/connections';
import { getAvatarsDir, getDataRoot } from '../config/paths';
import { ApiError } from '../core';
import { rotateHomeDataEpoch } from '../home/data-epoch';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { addRegistryEntry } from '../share/registry';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { extractArtifact, readUnpackedHome, unpackBound } from './archive';
import { readDeclaredManifest, requireArtifact } from './artifacts';
import { authRowsToRestore, restoreAuthRows } from './auth-rows';
import { describeError } from './errors';
import { resolveHomeDir } from './home-dir';
import {
    checkRestoredDatabases,
    checkUnpackedHome,
    containerDatabasesIn,
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
    roomShortfall,
} from './paths';
import { wipeRestoreStagingDir, writeRestoreCompleteMarker, writeRestoringMarker } from './recovery';
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

    const identity = await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        async () => {
            // Beside the home, so the swap is a rename on one disk.
            const unpackDir = buildRestoreUnpackDir(homeDir, jobId);
            // Refused before a byte is written. The unpack stops at the same bound, so an archive that holds more than
            // it declares takes no more of the disk the homes share than the room check found free.
            const bound = unpackBound(await readDeclaredManifest(artifactPath));
            const shortfall = roomShortfall(`Restoring ${artifactName}`, bound.maxBytes, getDataRoot(), 'data/');
            if (shortfall) throw new ApiError(507, shortfall);
            onProgress?.('extract', 0, 1);
            await extractArtifact(artifactPath, unpackDir, bound);
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
            // Before materializeMount, which leaves every trash date alone.
            redateRestoredTrash(
                ownerId,
                unpackedHome,
                carried.map((summary) => summary.id),
            );
            // The rows outside the home folder are judged now too, so an archive of somebody else, or a shares.json
            // that does not read, is refused before the home is taken. The avatar is read now because the staging
            // folder is gone by the time it is written.
            const judged = {
                authRows: authRowsToRestore(ownerId, manifest, folder),
                shares: readShares(folder),
                avatars: await readAvatars(ownerId, folder),
            };
            // An s3 mount's restored files take fresh keys from this stamp. The job id makes it this restore's alone,
            // even when the clock steps back to a second another restore of this home used.
            const keyStamp = `${buildBackupStamp(new Date())}-${jobId}`;
            for (const [index, summary] of carried.entries()) {
                await materializeMount(unpackedHome, summary, keyStamp);
                onProgress?.('mounts', index + 1, carried.length);
            }
            // The archive's `home/` is the home folder, one for one.
            const install: InstallHome = async () => fs.renameSync(unpackedHome, homeDir);
            return { install, judged };
        },
        // The new folder of a restore that failed after its swap is not trusted as a home: it keeps a name of its
        // own, which the admin pane lists with a delete and no restore.
        (stamp) => buildSafetyCopyName(homeDir, 'failed-restore', stamp),
    );
    // Only once the home is in place, and nothing rolls the folder back for them. Each write inserts only what is
    // missing, so a failure here fails the job with the home restored, and a retry finishes it.
    if (identity.authRows) restoreAuthRows(ownerId, identity.authRows);
    await restoreShares(ownerId, identity.shares);
    await restoreAvatars(identity.avatars);
    onProgress?.('done', 1, 1);
}

// Puts a `.pre-restore-` copy back where it came from: the home as it stands becomes a safety copy
// of its own and the chosen folder takes its place. No file is copied and none is deleted. A remote
// mount needs no work either, because the copy still points at the objects it was restored away from:
// materializeMount gives every restore fresh keys. A `.failed-restore-` copy is refused, because it is
// the folder of a restore that never finished, not a home.
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

// The avatar is server data, not home data. Its name comes from the archive and lands in the server-wide avatars
// folder, so it must be this user's, `{ownerId}.{ext}`. Otherwise a hostile archive could plant a picture for
// somebody who has none.
async function readAvatars(ownerId: string, folder: string): Promise<RestoredAvatar[]> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return [];
    const avatars: RestoredAvatar[] = [];
    for (const name of fs.readdirSync(avatarDir)) {
        if (path.parse(name).name !== ownerId) {
            console.warn(`[backup] ${ownerId}: ${name} in the archive is not this user's avatar, not restored`);
            continue;
        }
        avatars.push({ name, bytes: await Bun.file(path.join(avatarDir, name)).bytes() });
    }
    return avatars;
}

// An avatar goes back only where the server has none, so a picture the user changed after the backup is not quietly
// reverted.
async function restoreAvatars(avatars: readonly RestoredAvatar[]): Promise<void> {
    for (const avatar of avatars) {
        const target = path.join(getAvatarsDir(), avatar.name);
        if (fs.existsSync(target)) continue;
        await Bun.write(target, avatar.bytes);
    }
}

// One picture from the archive's avatar folder, read into memory while the archive is judged.
type RestoredAvatar = { name: string; bytes: Uint8Array };

// What a restore does once the home is out of everyone's hands and its folder is aside: put the new
// folder at `homeDir`. The step that prepared it returns it, so it closes over whatever that step judged.
type InstallHome = () => Promise<void>;

// What judging a replacement hands on: the install, and what the restore writes once the home serves again.
type PreparedHome<Judged> = { install: InstallHome; judged: Judged };

// The moves every restore is made of: judge the replacement while the home still serves, so a refusal costs nobody a
// page, then take the home from everyone, put its folder aside, install the replacement, and on a failure put both
// folders back, deleting nothing. The marker written here is the only note the next boot reads of an interrupted
// restore, so recoverInterruptedRestores covers every kind, and a rollback that failed too. It hands back what the
// preparing step judged.
async function replaceHomeFolder<Judged>(
    ownerId: string,
    homeDir: string,
    jobId: string,
    prepare: () => Promise<PreparedHome<Judged>>,
    parkOnFailure: (stamp: string) => string,
): Promise<Judged> {
    const restoreDir = buildRestoreStagingDir(homeDir, jobId);
    // Set when the rollback below could not put the home back. Its notes and its mark then stay, for the next boot
    // to finish it.
    let homeOutOfPlace = false;
    try {
        const { install, judged } = await prepare();
        // Throws when another restore or a deletion of this home holds it, before anything below runs.
        markHomeRestoring(ownerId);
        try {
            // Every request to the home meets the 503 from here until the mark clears. Sessions are untouched, so
            // the user stays signed in.
            closeCollabConnectionsForHome(ownerId);
            await evictHome(ownerId);

            // Picked now, so the safety copies are dated by the swap, however long the unpack took.
            const stamp = freeSafetyCopyStamp(homeDir, new Date());
            // There is no home folder to move aside on a restore after the user was deleted.
            const movedAside = fs.existsSync(homeDir) ? buildSafetyCopyName(homeDir, 'pre-restore', stamp) : null;
            const parked = parkOnFailure(stamp);
            // Before the move: a process killed from here on leaves the home's path empty or holding a folder the
            // restore did not finish with. Only this note tells the next boot which, with the name that folder goes
            // aside under.
            writeRestoringMarker(restoreDir, {
                ownerId,
                homeDir,
                preRestoreName: movedAside && path.basename(movedAside),
                parkName: path.basename(parked),
            });
            if (movedAside) fs.renameSync(homeDir, movedAside);

            try {
                await install();
                // Every tab of the home reloads, once the folder is whole and before the completion note: a crash
                // between the two costs an extra reload, never a stale tab over the new home.
                await rotateHomeDataEpoch(ownerId);
                writeRestoreCompleteMarker(restoreDir);
            } catch (error) {
                // A failure while putting the home back must not hide the one that brought us here.
                try {
                    if (fs.existsSync(homeDir)) fs.renameSync(homeDir, parked);
                    if (movedAside) fs.renameSync(movedAside, homeDir);
                } catch (rollbackError) {
                    homeOutOfPlace = true;
                    console.error(
                        `[backup] could not put ${ownerId}'s home back after a failed restore:`,
                        rollbackError,
                    );
                    // The job's error is all an admin learns of it, beside a 503 and a second restore refused as running.
                    // A restart alone leaves a running API as it is, so only a stop first runs the boot that puts the
                    // home back. A refusal keeps its own status: it is not the server's fault.
                    throw new ApiError(
                        error instanceof ApiError ? error.status : 500,
                        `${describeError(error)}, and the home could not be put back. The account is shut until Eigen restarts, which puts it back: run ./eigen stop, then ./eigen restart`,
                        { cause: error },
                    );
                }
                throw error;
            }
        } finally {
            // The job is over. A failed install put the home back, or left the notes that let the next boot do it.
            // A home left out of place stays marked until then: a request would open it at its empty path and make
            // a new home folder there, which the boot could not park under the name the rollback already took.
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

// A safety copy of a home whose owner is gone is a delete candidate, not a restore: the folder on
// its own leaves a home nobody can sign in to. Restoring a deleted user goes through an artifact,
// which carries their auth rows with it.
async function requireOwnerExists(ownerId: string): Promise<void> {
    const owner = parseOwnerId(ownerId);
    const found = owner.type === 'team' ? await getTeam(owner.id) : await getUserById(owner.id);
    if (!found) throw new ApiError(404, `${ownerId} no longer exists`);
}
