import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { parseBackupArtifactName } from '@workspace/lib/validation';
import { closeCollabConnectionsForHome } from '../collab/connections';
import { ApiError, PATHS } from '../core';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { extractArtifact, readUnpackedHome } from './archive';
import {
    checkRestoredDatabases,
    containerDatabasesIn,
    materializeMount,
    movePath,
    restoreAuthRows,
    restoreAvatar,
    restoreShares,
    type VersionedDatabase,
} from './materialize';
import {
    ARCHIVE_HOME_DIR,
    buildSafetyCopyName,
    freeSafetyCopyStamp,
    getBackupStagingDir,
    getBackupsDir,
    resolveHomeDir,
    wipeBackupStagingDir,
} from './paths';
import { markRestoreComplete, writeRestoringMarker } from './recovery';
import { forgetSafetyCopySize, resolveSafetyCopy } from './safety-copy';
import type { SnapshotProgress } from './snapshot-home';
import { FAILURES_IN_MESSAGE, verifyFolder } from './verify';

// A safety copy of a home whose owner is gone is a delete candidate, not a restore: the folder on
// its own leaves a home nobody can sign in to. Restoring a deleted user goes through an artifact,
// which carries their auth rows with it.
async function requireOwnerExists(ownerId: string): Promise<void> {
    const owner = parseOwnerId(ownerId);
    const found = owner.type === 'team' ? await getTeam(owner.id) : await getUserById(owner.id);
    if (!found) throw new ApiError(404, `${ownerId} no longer exists`);
}

// What a restore does once the home is out of everyone's hands and its folder is aside: put the new
// one at `homeDir`. Returned by the step that prepared it, so whatever it needs is a closure over
// the work that judged it.
type InstallHome = (stamp: string) => Promise<void>;

// The moves every restore is made of, in one place: take the home away from everyone holding it,
// put the folder as it stands aside as a safety copy, install the replacement, and on any failure
// put both folders back. `prepare` runs under the mark, before a byte is touched. `parkOnFailure`
// names where the folder in place goes if the install throws. Nothing is ever deleted, and the
// marker written here is the only thing that tells the next boot an interrupted restore happened —
// one writer, so recoverInterruptedRestores covers every kind of restore. Two words, two
// mechanisms: the mark is the in-memory flag every surface refuses the home on, the marker is the
// note on disk the next boot reads.
async function replaceHomeFolder(
    ownerId: string,
    homeDir: string,
    jobId: string,
    prepare: () => Promise<InstallHome>,
    parkOnFailure: (stamp: string) => string,
): Promise<void> {
    // The lock: throws when another restore of this home holds it, before anything below runs.
    markHomeRestoring(ownerId);
    try {
        const install = await prepare();

        // Sessions are untouched: the user stays signed in, every request just meets the 503 until
        // the mark clears.
        closeCollabConnectionsForHome(ownerId);
        await evictHome(ownerId);

        // There is no home folder to move aside on a restore after the user was deleted.
        const stamp = freeSafetyCopyStamp(homeDir, new Date());
        const movedAside = fs.existsSync(homeDir) ? buildSafetyCopyName(homeDir, 'pre-restore', stamp) : null;
        // Always, and before the move: a process killed between here and the install leaves a home
        // folder that is either gone or half written, and only this note tells the next boot which
        // it is — the folders' presence alone means nothing (a deleted user's safety copies outlive
        // them, and an install writes the home folder early).
        writeRestoringMarker(jobId, { ownerId, homeDir, preRestoreName: movedAside && path.basename(movedAside) });
        if (movedAside) fs.renameSync(homeDir, movedAside);

        try {
            await install(stamp);
            // The home folder is whole from here: everything after this only lets go of it. A crash
            // before this line leaves a half-written folder that only the next boot can judge, and
            // the absence of this note is what tells it so.
            markRestoreComplete(jobId);
        } catch (error) {
            // Nothing is deleted, ever: the folder in place keeps a name of its own and the home as
            // it was goes back. A failure while putting it back must not hide the original one.
            try {
                if (fs.existsSync(homeDir)) fs.renameSync(homeDir, parkOnFailure(stamp));
                if (movedAside) fs.renameSync(movedAside, homeDir);
            } catch (rollbackError) {
                console.error(`[backup] could not put ${ownerId}'s home back after a failed restore:`, rollbackError);
            }
            throw error;
        }
    } finally {
        // Whatever happened above is over, and the rollback put the home back itself. Neither call
        // may throw over the failure that brought us here.
        clearHomeRestoring(ownerId);
        try {
            wipeBackupStagingDir(jobId);
        } catch (error) {
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
        }
    }
}

// Replaces one home with the copy inside an artifact. Nothing is ever deleted: the home as it stands
// is renamed aside as `{id}.pre-restore-{ts}`, and a failure after that point leaves the incomplete
// folder as `{id}.failed-restore-{ts}` and puts the original back. The home is refused on every
// surface for the duration (markHomeRestoring, which is also the lock against a second restore) and
// its collab sockets are told to reload; the first load after the mark clears runs migrations,
// reconciles contacts and refreshes shared-with-me.
export async function restoreHome(
    artifactName: string,
    ownerId: string,
    jobId: string,
    onProgress?: SnapshotProgress,
): Promise<void> {
    if (!parseBackupArtifactName(artifactName)) {
        throw new ApiError(400, `${artifactName} is not a backup artifact name`);
    }
    const artifactPath = path.join(getBackupsDir(), artifactName);
    if (!fs.existsSync(artifactPath)) {
        throw new ApiError(404, `${artifactName} is not in the backups folder`);
    }
    const homeDir = await resolveHomeDir(ownerId);

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        async () => {
            // Unpack into this job's staging folder and judge the archive before anything is touched.
            const unpackDir = path.join(getBackupStagingDir(jobId), 'restore');
            // A retry of a job whose id was reused would otherwise extract over the last attempt's
            // tree, and stage 1 fails an archive on a file the manifest does not list.
            fs.rmSync(unpackDir, { recursive: true, force: true });
            onProgress?.('extract', 0, 1);
            await extractArtifact(artifactPath, unpackDir);
            onProgress?.('extract', 1, 1);
            const { folder, manifest } = readUnpackedHome(unpackDir, ownerId, artifactName);
            const verified = await verifyFolder(folder, onProgress);
            if (verified.status !== 'verified') {
                const failures = verified.failures.slice(0, FAILURES_IN_MESSAGE).join('; ');
                // The whole list is in the record; a few of them are enough for a message.
                throw new ApiError(400, `${artifactName} did not verify: ${failures}`);
            }

            return async (stamp) => {
                // The archive's `home/` IS the home folder, one for one.
                onProgress?.('home files', 0, 1);
                movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
                onProgress?.('home files', 1, 1);
                const containerDatabases: VersionedDatabase[] = [];
                for (const [index, summary] of manifest.mounts.entries()) {
                    containerDatabases.push(...materializeMount(homeDir, summary, stamp));
                    onProgress?.('mounts', index + 1, manifest.mounts.length);
                }

                // What landed is still a database this server can open. Before the identity write,
                // not after it (the spec has these the other way around): the rollback moves folders,
                // and nothing takes a users3.db row back. A restore of a deleted user that failed
                // this check after re-inserting would leave a user who can sign in with no home —
                // and whose retry would find that user and skip the insert for good.
                checkRestoredDatabases(
                    homeDir,
                    manifest.mounts.map((summary) => summary.id),
                    containerDatabases,
                );

                // The rows that live outside the home folder (users only).
                restoreAuthRows(ownerId, manifest, folder);
                await restoreShares(ownerId, folder);
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
// of its own and the chosen folder takes its place. No bytes are written and none are deleted — a
// remote mount needs no work either, because the copy still points at the objects it was restored
// away from (materializeMount gives every restore fresh keys). A `.failed-restore-` copy is refused:
// it is the half-written folder of a restore that never finished, not a home.
export async function restoreSafetyCopy(
    ownerId: string,
    name: string,
    jobId: string,
    onProgress?: SnapshotProgress,
): Promise<void> {
    const { folder, homeDir, kind } = await resolveSafetyCopy(ownerId, name);
    if (kind !== 'pre-restore') throw new ApiError(400, `${name} is not a pre-restore copy of this home`);
    if (!fs.existsSync(folder)) throw new ApiError(404, `${name} is not beside this home`);
    await requireOwnerExists(ownerId);

    const install: InstallHome = async () => {
        onProgress?.('home files', 0, 1);
        fs.renameSync(folder, homeDir);
        // The copy is not at that path any more, and a later one can land on the same name (one
        // stamp per second) — it would then list the size measured for this folder.
        forgetSafetyCopySize(folder);
        onProgress?.('home files', 1, 1);
        // The verdict a restore from an archive ends on: SQLite's on the bytes, and this build's on
        // every schema stamp. A copy this server made passes both; one carried over from a newer
        // server does not, and that has to surface here rather than on the next load.
        const mountsDir = path.join(homeDir, PATHS.DRIVE.ROOT);
        const mountIds = fs.existsSync(mountsDir)
            ? fs
                  .readdirSync(mountsDir, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => entry.name)
            : [];
        checkRestoredDatabases(homeDir, mountIds, containerDatabasesIn(homeDir, mountIds));
    };

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        // Nothing to unpack or judge: the folder is right there, and resolveSafetyCopy vouched for it.
        async () => install,
        // Back under the name it came from. A `.failed-restore-` name would make a pristine home
        // unrestorable, and the only action left on one deletes its bytes.
        () => folder,
    );
    onProgress?.('done', 1, 1);
}
