import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildSafetyCopyName,
    freeSafetyCopyStamp,
    getBackupStagingDir,
    getStagingRoot,
    parseSafetyCopyName,
} from './paths';

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
// either, and nothing but this says so.
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string | null };

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
// input: the name has to be a pre-restore copy of exactly the home folder it claims.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    if (!fs.existsSync(markerPath)) return null;
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    if (!('ownerId' in value) || !('homeDir' in value) || !('preRestoreName' in value)) return null;
    const { ownerId, homeDir, preRestoreName } = value;
    if (typeof ownerId !== 'string' || typeof homeDir !== 'string') return null;
    if (preRestoreName !== null && typeof preRestoreName !== 'string') return null;
    if (preRestoreName !== null) {
        const parsed = parseSafetyCopyName(preRestoreName);
        if (parsed?.kind !== 'pre-restore' || parsed.homeName !== path.basename(homeDir)) return null;
    }
    return { ownerId, homeDir, preRestoreName };
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
        // A folder that is there without the completion note is the half-written one: the extract
        // landed and the mount materialization, the checks or the identity writes did not. It keeps
        // a name of its own, exactly as a failure the job itself caught would have left it. Nothing
        // is deleted — this holds whether or not there is a copy to put back afterwards.
        if (fs.existsSync(marker.homeDir)) {
            const parked = buildSafetyCopyName(
                marker.homeDir,
                'failed-restore',
                freeSafetyCopyStamp(marker.homeDir, new Date()),
            );
            fs.renameSync(marker.homeDir, parked);
            console.error(
                `[backup] a restore of ${marker.ownerId} was interrupted mid-install: the half-written folder is ${path.basename(parked)}`,
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
