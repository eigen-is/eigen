import { parseServerArchiveName } from '@workspace/lib/validation';

// Kept beside the newest `keep` scheduled ones: what `./eigen rollback` restores, and the one before it.
const PRE_UPDATE_KEEP = 2;

// The whole-server archives to delete from the backups folder, by name. Grouped by the reason in the
// name: scheduled ones keep the newest `keep` that are good, plus the newest `keep` failed ones newer
// than the newest good one, so a failed night never pushes out the last good archive and nights that
// keep failing do not pile up; pre-update ones keep the newest two; manual ones are the owner's to
// delete. A name the grammar does not read is never touched.
export function pruneServerArchives(archives: { name: string; good: boolean }[], keep: number): string[] {
    const dated = archives.flatMap((archive) => {
        const parsed = parseServerArchiveName(archive.name);
        return parsed ? [{ ...archive, ...parsed }] : [];
    });
    dated.sort((a, b) => b.at.getTime() - a.at.getTime());

    const preUpdate = dated.filter((archive) => archive.reason === 'pre-update').slice(PRE_UPDATE_KEEP);
    const scheduled = dated.filter((archive) => archive.reason === 'scheduled');
    const good = scheduled.filter((archive) => archive.good);
    const newestGood = good[0];
    const failedSinceGood = scheduled.filter((archive) => !archive.good && (!newestGood || archive.at > newestGood.at));
    const kept = new Set([...good.slice(0, keep), ...failedSinceGood.slice(0, keep)]);
    return [...scheduled.filter((archive) => !kept.has(archive)), ...preUpdate].map((archive) => archive.name);
}

// The bucket's scheduled archives to delete, by name. A partial one, whose manifest names a home that failed,
// counts toward `keep` like any other, but the newest complete one stays whatever came after it: only it
// restores every home. An archive `partial` does not name counts as complete.
export function pruneBucketArchives(names: string[], partial: ReadonlySet<string>, keep: number): string[] {
    const scheduled = names.flatMap((name) => {
        const parsed = parseServerArchiveName(name);
        return parsed?.reason === 'scheduled' ? [{ name, at: parsed.at }] : [];
    });
    scheduled.sort((a, b) => b.at.getTime() - a.at.getTime());
    const newestComplete = scheduled.find((archive) => !partial.has(archive.name));
    return scheduled
        .slice(keep)
        .filter((archive) => archive !== newestComplete)
        .map((archive) => archive.name);
}
