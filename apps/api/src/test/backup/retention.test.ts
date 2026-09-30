import { describe, expect, test } from 'bun:test';
import type { BackupReason } from '@workspace/lib/types/backup';
import { buildServerArchiveName } from '../../lib/backup/paths';
import { pruneBucketArchives, pruneServerArchives } from '../../lib/backup/retention';

// One archive a night at 02:00 UTC, `night` days after 1 September.
function archive(reason: BackupReason, night: number, good = true): { name: string; good: boolean } {
    const at = new Date(Date.UTC(2026, 8, 1 + night, 2, 0, 0));
    return { name: buildServerArchiveName(reason, 'full', at), good };
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

    test('a name the grammar does not parse is never pruned', () => {
        const stray = { name: 'server-scheduled-full-latest.tar', good: false };
        expect(pruneServerArchives([stray, archive('scheduled', 1), archive('scheduled', 2)], 1)).toEqual([
            archive('scheduled', 1).name,
        ]);
    });

    test('the bucket counts a partial archive toward keep, but keeps the newest complete one past it', () => {
        const nights = [1, 2, 3, 4, 5].map((night) => archive('scheduled', night).name);
        const partial = new Set([nights[3], nights[4]]);
        expect(pruneBucketArchives(nights, partial, 2).sort()).toEqual([nights[0], nights[1]].sort());
        expect(pruneBucketArchives(nights, new Set(nights), 2).sort()).toEqual(nights.slice(0, 3).sort());
        const others = [archive('manual', 0).name, archive('pre-update', 0).name, 'notes.txt'];
        expect(pruneBucketArchives([...others, ...nights], new Set(), 1).sort()).toEqual(nights.slice(0, 4).sort());
    });
});
