import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBackupStagingDir, getStagingRoot, parseSafetyCopyName } from './paths';

// What tells the next boot that a restore died with a home folder that is not a home: the notes a
// restore leaves in its staging folder, and the pass over them that runs before the API listens.

// The note a restore leaves in its staging folder while the home folder is not where it belongs.
// Written before the move-aside, removed when the mark clears, read once at the next boot.
const RESTORING_MARKER = 'restoring.json';
// Written beside it the moment the install is done, before the mark clears. A marker without this
// beside it means the process died with a home folder that is somewhere between the two states.
const RESTORE_COMPLETE_MARKER = 'restore-complete.json';
// `preRestoreName` is null when there was no home folder to move aside (a restore of a deleted
// user). The marker is still written: the folder the install is halfway through is not a home
// either, and nothing but this says so. `parkName` is what that folder goes aside as: a
// `.failed-restore-` name for an extraction, the copy's own name for a safety copy put back.
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string | null; parkName: string };

function restoringMarkerPath(jobId: string): string {
    return path.join(getBackupStagingDir(jobId), RESTORING_MARKER);
}

export function writeRestoringMarker(jobId: string, marker: RestoringMarker): void {
    fs.writeFileSync(restoringMarkerPath(jobId), JSON.stringify(marker));
}

export function markRestoreComplete(jobId: string): void {
    fs.writeFileSync(
        path.join(getBackupStagingDir(jobId), RESTORE_COMPLETE_MARKER),
        JSON.stringify({ completedAt: new Date().toISOString() }),
    );
}

// The marker survived a crash and names two paths this then renames, so it is read as untrusted
// input: both names have to be safety copies of exactly the home folder it claims, the one to put back a
// pre-restore copy.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    if (!fs.existsSync(markerPath)) return null;
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    if (!('ownerId' in value) || !('homeDir' in value) || !('preRestoreName' in value) || !('parkName' in value)) {
        return null;
    }
    const { ownerId, homeDir, preRestoreName, parkName } = value;
    if (typeof ownerId !== 'string' || typeof homeDir !== 'string' || typeof parkName !== 'string') return null;
    if (preRestoreName !== null && typeof preRestoreName !== 'string') return null;
    if (parseSafetyCopyName(parkName)?.homeName !== path.basename(homeDir)) return null;
    if (preRestoreName !== null) {
        const parsed = parseSafetyCopyName(preRestoreName);
        if (parsed?.kind !== 'pre-restore' || parsed.homeName !== path.basename(homeDir)) return null;
    }
    return { ownerId, homeDir, preRestoreName, parkName };
}

// Boot: a restore killed anywhere between the move-aside and the last install step left the home
// folder either gone or half written, with its real contents under the `{id}.pre-restore-{ts}` its
// marker names. The process that knew about it is dead, so nothing else will ever put it back —
// this does, loudly. The install writes a completion note beside the marker, so a restore that
// finished is told from one that did not. It runs before the staging wipe, which is what clears the
// markers of both. A safety copy with no marker is not evidence of anything: nothing deletes them
// automatically, so a deleted user leaves one behind.
export function recoverInterruptedRestores(): void {
    const stagingRoot = getStagingRoot();
    if (!fs.existsSync(stagingRoot)) return;
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jobDir = path.join(stagingRoot, entry.name);
        const marker = readRestoringMarker(path.join(jobDir, RESTORING_MARKER));
        if (!marker) continue;
        // The install finished; whatever the job did after that is nobody's business now.
        if (fs.existsSync(path.join(jobDir, RESTORE_COMPLETE_MARKER))) continue;
        const aside = marker.preRestoreName && path.join(path.dirname(marker.homeDir), marker.preRestoreName);
        // A copy the restore's own rollback already put back is not there any more, and this must
        // not move the home folder that is in place over it.
        if (aside && !fs.existsSync(aside)) continue;
        // A folder that is there without the completion note is the one the install was writing: an
        // extraction whose mount materialization, checks or identity writes did not land, or a safety
        // copy renamed into place before its checks. It goes aside under the name the marker gives,
        // exactly as a failure the job itself caught would have left it. Nothing is deleted — this
        // holds whether or not there is a copy to put back afterwards.
        if (fs.existsSync(marker.homeDir)) {
            fs.renameSync(marker.homeDir, path.join(path.dirname(marker.homeDir), marker.parkName));
            console.error(
                `[backup] a restore of ${marker.ownerId} was interrupted mid-install: the folder it was installing is ${marker.parkName}`,
            );
        }
        if (!aside) {
            // A restore of a deleted user: there was no home to move aside, so the only thing to do
            // is refuse to leave the half-written folder standing as one.
            console.error(`[backup] a restore of ${marker.ownerId} was interrupted: they have no home folder again`);
            continue;
        }
        fs.renameSync(aside, marker.homeDir);
        console.error(
            `[backup] a restore of ${marker.ownerId} was interrupted: ${marker.preRestoreName} is back in place as the home folder`,
        );
    }
}
