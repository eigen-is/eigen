// Which whole-server archives to delete, decided from their names and records alone. It runs locally after every
// server backup, and in the backup bucket after every upload. Each reason for a backup keeps its own count. A
// failed night never pushes out the last good archive. In the bucket, the newest complete archive stays, even with
// warnings. The pre-update archive that ./eigen rollback needs always stays.

import type { BackupReason } from '@workspace/lib/types/backup';
import { parseServerArchiveNames } from '@workspace/lib/validation';
import { BUCKET_PARTIAL_SUFFIX } from './paths';

// What `./eigen rollback` restores, and the one before it.
const PRE_UPDATE_KEEP = 2;

// One archive as retention sees it. `done`: the job ended done, warnings or not, so the archive restores. `good`:
// done with no warnings. `build` is the API image that made it, absent where no image was pinned.
export type RetentionCandidate = {
    name: string;
    reason: BackupReason;
    at: Date;
    good: boolean;
    done: boolean;
    build?: string;
};

// The whole-server archives to delete from the backups folder, by name. `archives` is newest first, as the folder
// lists them, and is grouped by the reason in the name. Scheduled ones keep `keep`, pre-update ones two, and manual
// ones are the owner's to delete. A pre-update archive of another build than `running` also stays when it is the
// newest done one, because ./eigen rollback may need it. Which one the last update made is in .eigen/last-update,
// which the API cannot read. Warnings do not stop an update, and retries that failed after their backup may be
// newer. A name the grammar does not read is never touched.
export function pruneServerArchives(archives: RetentionCandidate[], keep: number, running?: string): string[] {
    const scheduled = archives.filter((archive) => archive.reason === 'scheduled');
    const preUpdate = archives.filter((archive) => archive.reason === 'pre-update');
    const rollback = preUpdate.find((archive) => archive.done && archive.build !== running);
    const kept = new Set([...keptNewest(scheduled, keep), ...keptNewest(preUpdate, PRE_UPDATE_KEEP), rollback]);
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

// The newest `keep` good ones, plus up to `keep` failed ones newer than the newest good one: a failed
// attempt never pushes out the last good archive, and attempts that keep failing do not pile up.
function keptNewest(archives: RetentionCandidate[], keep: number): RetentionCandidate[] {
    const good = archives.filter((archive) => archive.good);
    const newestGood = good[0];
    const failedSinceGood = archives.filter((archive) => !archive.good && (!newestGood || archive.at > newestGood.at));
    return [...good.slice(0, keep), ...failedSinceGood.slice(0, keep)];
}
