import { parseServerArchiveName } from '@workspace/lib/validation';

// Kept beside the newest `keep` scheduled ones: what `./eigen rollback` restores, and the one before it.
const PRE_UPDATE_KEEP = 2;

// The whole-server archives to delete, by name, for the backups folder and the bucket alike. Grouped
// by the reason in the name: scheduled ones keep the newest `keep` that are good plus every failed
// one newer than the newest good one, so a failed night never pushes out the last good archive;
// pre-update ones keep the newest two; manual ones are the owner's to delete. A name the grammar
// does not read is never touched.
export function pruneServerArchives(archives: { name: string; good: boolean }[], keep: number): string[] {
    const dated = archives.flatMap((archive) => {
        const parsed = parseServerArchiveName(archive.name);
        return parsed ? [{ ...archive, ...parsed }] : [];
    });
    dated.sort((a, b) => b.at.getTime() - a.at.getTime());

    const preUpdate = dated.filter((archive) => archive.reason === 'pre-update').slice(PRE_UPDATE_KEEP);
    const scheduled = dated.filter((archive) => archive.reason === 'scheduled');
    const newestGood = scheduled.find((archive) => archive.good);
    const keptGood = new Set(scheduled.filter((archive) => archive.good).slice(0, keep));
    const prunedScheduled = scheduled.filter((archive) =>
        archive.good ? !keptGood.has(archive) : newestGood !== undefined && archive.at < newestGood.at,
    );
    return [...prunedScheduled, ...preUpdate].map((archive) => archive.name);
}
