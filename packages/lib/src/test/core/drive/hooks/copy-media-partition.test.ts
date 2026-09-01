import { describe, expect, test } from 'bun:test';
import { partitionCopyResults } from '../../../../core/drive/hooks/copy-media-partition';
import type { DrivePath } from '../../../../types/drive';

const path = (id: string): DrivePath => ({ id }) as DrivePath;

const fulfilled = (id: string): PromiseSettledResult<DrivePath> => ({ status: 'fulfilled', value: path(id) });
const rejected = (): PromiseSettledResult<DrivePath> => ({ status: 'rejected', reason: new Error('nope') });

describe('partitionCopyResults', () => {
    test('all fulfilled → every path returned, nothing failed, not a total failure', () => {
        const { copied, failedCount, totalFailure } = partitionCopyResults([fulfilled('a'), fulfilled('b')]);
        expect(copied.map((p) => p.id)).toEqual(['a', 'b']);
        expect(failedCount).toBe(0);
        expect(totalFailure).toBe(false);
    });

    test('mixed → successes returned, failure count surfaced, not a total failure', () => {
        const { copied, failedCount, totalFailure } = partitionCopyResults([
            fulfilled('a'),
            rejected(),
            fulfilled('c'),
        ]);
        expect(copied.map((p) => p.id)).toEqual(['a', 'c']);
        expect(failedCount).toBe(1);
        expect(totalFailure).toBe(false);
    });

    test('all rejected → nothing copied, total-failure signal set', () => {
        const { copied, failedCount, totalFailure } = partitionCopyResults([rejected(), rejected()]);
        expect(copied).toEqual([]);
        expect(failedCount).toBe(2);
        expect(totalFailure).toBe(true);
    });

    test('empty input → not a total failure', () => {
        const { copied, failedCount, totalFailure } = partitionCopyResults([]);
        expect(copied).toEqual([]);
        expect(failedCount).toBe(0);
        expect(totalFailure).toBe(false);
    });
});
