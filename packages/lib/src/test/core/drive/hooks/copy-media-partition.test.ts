import { describe, expect, test } from 'bun:test';
import { partitionCopyResults } from '../../../../core/drive/hooks/copy-media-partition';
import type { DrivePath } from '../../../../types/drive';

// A full, honest DrivePath fixture (no cast) — partitionCopyResults only reads `id` back, but the
// value is a real DrivePath, matching the makeDrivePath style in the clipboard test.
const path = (id: string): DrivePath => ({
    id,
    name: `${id}.png`,
    mountId: 'mt',
    type: 'file',
    parentId: 'parent',
    ownerId: 'o',
    mimeType: 'image/png',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

const fulfilled = (id: string): PromiseSettledResult<DrivePath> => ({ status: 'fulfilled', value: path(id) });
const rejected = (): PromiseSettledResult<DrivePath> => ({ status: 'rejected', reason: new Error('nope') });

describe('partitionCopyResults', () => {
    test('all fulfilled → every path returned, nothing failed', () => {
        const { copied, failedCount } = partitionCopyResults([fulfilled('a'), fulfilled('b')]);
        expect(copied.map((p) => p.id)).toEqual(['a', 'b']);
        expect(failedCount).toBe(0);
    });

    test('mixed → successes returned, failure count surfaced', () => {
        const { copied, failedCount } = partitionCopyResults([fulfilled('a'), rejected(), fulfilled('c')]);
        expect(copied.map((p) => p.id)).toEqual(['a', 'c']);
        expect(failedCount).toBe(1);
    });

    test('all rejected → nothing copied, every result counted as failed', () => {
        const { copied, failedCount } = partitionCopyResults([rejected(), rejected()]);
        expect(copied).toEqual([]);
        expect(failedCount).toBe(2);
    });

    test('empty input → nothing copied, no failures', () => {
        const { copied, failedCount } = partitionCopyResults([]);
        expect(copied).toEqual([]);
        expect(failedCount).toBe(0);
    });
});
