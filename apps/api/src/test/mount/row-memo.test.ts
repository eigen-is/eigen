import { afterEach, expect, jest, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { RowMemo } from '../../lib/mount/helpers';
import { DAY_MS } from '../../lib/versioning/retention';

afterEach(() => {
    jest.setSystemTime();
});

function file(id: string, size = 10, updatedAt = new Date(0)): DrivePath {
    return {
        id,
        mountId: 'default',
        name: `${id}.svg`,
        type: 'file',
        parentId: 'media',
        ownerId: 'owner-1',
        mimeType: 'image/svg+xml',
        size,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt,
    };
}

test('a value is read once, and again once the row changed', async () => {
    const memo = new RowMemo<string>();
    const read = mock(async () => `read ${read.mock.calls.length}`);
    expect(await memo.get(file('a'), read)).toBe('read 1');
    expect(await memo.get(file('a'), read)).toBe('read 1');
    expect(await memo.get(file('a', 11), read)).toBe('read 2');
    expect(await memo.get(file('a', 11, new Date(1)), read)).toBe('read 3');
});

test('an entry unused for a week goes when another is read', async () => {
    const memo = new RowMemo<string>();
    const read = mock(async () => 'names');
    const start = Date.now();
    await memo.get(file('a'), read);
    jest.setSystemTime(new Date(start + 7 * DAY_MS));
    await memo.get(file('b'), read);
    await memo.get(file('a'), read);
    expect(read).toHaveBeenCalledTimes(3);
});
