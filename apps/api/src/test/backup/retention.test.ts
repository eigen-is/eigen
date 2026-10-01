import { describe, expect, test } from 'bun:test';
import type { BackupReason } from '@workspace/lib/types/backup';
import { BUCKET_PARTIAL_SUFFIX, buildServerArchiveName } from '../../lib/backup/paths';
import { pruneBucketArchives, pruneServerArchives } from '../../lib/backup/retention';

// One archive a night at 02:00 UTC, `night` days after 1 September.
function archive(reason: BackupReason, night: number, good = true): Parameters<typeof pruneServerArchives>[0][number] {
    const at = new Date(Date.UTC(2026, 8, 1 + night, 2, 0, 0));
    return { name: buildServerArchiveName(reason, 'full', at), reason, at, good };
}

function names(archives: { name: string }[]): string[] {
    return archives.map((entry) => entry.name).sort();
}

describe('Server archive retention', () => {
    test('keeps the newest keep scheduled archives and prunes the rest', () => {
        const nights = [1, 2, 3, 4, 5].map((night) => archive('scheduled', night));
        expect(pruneServerArchives(nights, 3).sort()).toEqual(names(nights.slice(0, 2)));
    });

    test('never prunes a manual archive, however many there are', () => {
        const manual = [1, 2, 3, 4, 5].map((night) => archive('manual', night));
        expect(pruneServerArchives([...manual, archive('scheduled', 6)], 1)).toEqual([]);
    });

    test('keeps the newest two pre-update archives, whatever keep says', () => {
        const updates = [1, 2, 3, 4].map((night) => archive('pre-update', night));
        expect(pruneServerArchives(updates, 10).sort()).toEqual(names(updates.slice(0, 2)));
        expect(pruneServerArchives(updates, 1).sort()).toEqual(names(updates.slice(0, 2)));
    });

    test('failed pre-update attempts never push out the good ones a rollback needs', () => {
        const good = [1, 2, 3].map((night) => archive('pre-update', night));
        const failed = [4, 5, 6].map((night) => archive('pre-update', night, false));
        expect(pruneServerArchives([...good, ...failed], 10).sort()).toEqual(names([good[0], failed[0]]));
        const older = archive('pre-update', 0, false);
        expect(pruneServerArchives([older, ...good], 10).sort()).toEqual(names([older, good[0]]));
    });

    test('keeps the newest good pre-update archive of another build than the one running: ./eigen rollback names it', () => {
        const rollback = { ...archive('pre-update', 1), build: 'api@sha256:old' };
        const retries = [2, 3].map((night) => ({ ...archive('pre-update', night), build: 'api@sha256:new' }));
        expect(pruneServerArchives([rollback, ...retries], 10, 'api@sha256:new')).toEqual([]);
        expect(pruneServerArchives([rollback, ...retries], 10, 'api@sha256:old')).toEqual([rollback.name]);
    });

    test('a failed night never pushes out the last good archive', () => {
        const good = archive('scheduled', 1);
        const failed = [2, 3].map((night) => archive('scheduled', night, false));
        expect(pruneServerArchives([good, ...failed], 2)).toEqual([]);
    });

    test('failed archives newer than the newest good one are capped at keep, newest first', () => {
        const good = archive('scheduled', 1);
        const failed = [2, 3, 4, 5].map((night) => archive('scheduled', night, false));
        expect(pruneServerArchives([good, ...failed], 2).sort()).toEqual(names(failed.slice(0, 2)));
    });

    test('with no good archive at all, the newest keep failed attempts stay and older ones go', () => {
        const failed = [1, 2, 3, 4, 5].map((night) => archive('scheduled', night, false));
        expect(pruneServerArchives(failed, 2).sort()).toEqual(names(failed.slice(0, 3)));
    });

    test('a failed archive older than the newest good one goes, and does not count against keep', () => {
        const older = archive('scheduled', 1);
        const failed = archive('scheduled', 2, false);
        const newest = archive('scheduled', 3);
        expect(pruneServerArchives([older, failed, newest], 2)).toEqual([failed.name]);
    });

    test('groups by reason: a scheduled keep of one leaves a newer manual and pre-update alone', () => {
        const scheduled = [1, 2].map((night) => archive('scheduled', night));
        const others = [archive('manual', 3), archive('pre-update', 3)];
        expect(pruneServerArchives([...scheduled, ...others], 1)).toEqual([scheduled[0].name]);
    });

    test('the bucket counts a partial archive toward keep, but keeps the newest complete one past it', () => {
        const nights = [1, 2, 3, 4, 5].map((night) => archive('scheduled', night).name);
        const marked = (names: string[]) => names.map((name) => `${name}${BUCKET_PARTIAL_SUFFIX}`);
        const partial = marked([nights[3], nights[4]]);
        expect(pruneBucketArchives([...nights, ...partial], 2).sort()).toEqual([nights[0], nights[1]].sort());
        const doomed = nights.slice(0, 3);
        expect(pruneBucketArchives([...nights, ...marked(nights)], 2).sort()).toEqual(
            [...doomed, ...marked(doomed)].sort(),
        );
        const others = [archive('manual', 0).name, archive('pre-update', 0).name, 'notes.txt'];
        expect(pruneBucketArchives([...others, ...nights], 1).sort()).toEqual(nights.slice(0, 4).sort());
    });

    test('the bucket drops a partial marker whose archive never landed', () => {
        const night = archive('scheduled', 1).name;
        expect(pruneBucketArchives([`${night}${BUCKET_PARTIAL_SUFFIX}`], 2)).toEqual([
            `${night}${BUCKET_PARTIAL_SUFFIX}`,
        ]);
    });
});
