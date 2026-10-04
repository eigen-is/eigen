import type { BackupReason } from '@workspace/lib/types/backup';
import { parseServerArchiveNames } from '@workspace/lib/validation';
import { BUCKET_PARTIAL_SUFFIX } from './paths';

// What `./eigen rollback` restores, and the one before it.
const PRE_UPDATE_KEEP = 2;

// `done`: the job ended done, warnings or not, so the archive restores; `good`: done with no warnings.
type Dated = { name: string; good: boolean; done: boolean; build?: string; at: Date };

// The newest `keep` good ones, plus up to `keep` failed ones newer than the newest good one: a failed
// attempt never pushes out the last good archive, and attempts that keep failing do not pile up.
function keptOf(archives: Dated[], keep: number): Dated[] {
    const good = archives.filter((archive) => archive.good);
    const newestGood = good[0];
    const failedSinceGood = archives.filter((archive) => !archive.good && (!newestGood || archive.at > newestGood.at));
    return [...good.slice(0, keep), ...failedSinceGood.slice(0, keep)];
}

export type RetainedArchive = Dated & { reason: BackupReason };

// The whole-server archives to delete from the backups folder, by name, of `archives` newest first as the folder
// lists them, grouped by the reason in the name. Scheduled ones keep `keep`, pre-update ones two, and manual ones
// are the owner's to delete. A pre-update archive of another build than `running` stays too when it is the newest
// done one: an update that switched builds recorded it in .eigen/last-update, which the API cannot read, warnings
// do not stop an update, and retries that failed after their backup may be newer. A name the grammar does not read is never touched.
export function pruneServerArchives(archives: RetainedArchive[], keep: number, running?: string): string[] {
    const scheduled = archives.filter((archive) => archive.reason === 'scheduled');
    const preUpdate = archives.filter((archive) => archive.reason === 'pre-update');
    const rollback = preUpdate.find((archive) => archive.done && archive.build !== running);
    const kept = new Set([...keptOf(scheduled, keep), ...keptOf(preUpdate, PRE_UPDATE_KEEP), rollback]);
    return [...scheduled, ...preUpdate].filter((archive) => !kept.has(archive)).map((archive) => archive.name);
}

// The bucket's scheduled archives to delete, by name, with their partial markers. A partial one, whose manifest
// names a home that failed, counts toward `keep` like any other, but the newest complete one stays whatever came
// after it: only it restores every home. A marker whose archive never landed goes too.
export function pruneBucketArchives(names: string[], keep: number): string[] {
    const listed = new Set(names);
    const scheduled = parseServerArchiveNames(names).filter((archive) => archive.reason === 'scheduled');
    const newestComplete = scheduled.find((archive) => !listed.has(`${archive.name}${BUCKET_PARTIAL_SUFFIX}`));
    const doomed = new Set(
        scheduled
            .slice(keep)
            .filter((archive) => archive !== newestComplete)
            .map((archive) => archive.name),
    );
    const markers = names.filter((name) => {
        if (!name.endsWith(BUCKET_PARTIAL_SUFFIX)) return false;
        const archive = name.slice(0, -BUCKET_PARTIAL_SUFFIX.length);
        return doomed.has(archive) || !listed.has(archive);
    });
    return [...doomed, ...markers];
}
