import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getDriveComparator } from './drive-sort';

function item(p: Partial<DrivePath> & { name: string }): DrivePath {
    return {
        id: p.name,
        mountId: 'm',
        name: p.name,
        type: p.type ?? 'file',
        parentId: null,
        ownerId: 'o',
        mimeType: p.type === 'folder' ? 'folder' : 'text/plain',
        size: p.size ?? 0,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: p.updatedAt ?? new Date(0),
    } as DrivePath;
}

describe('getDriveComparator', () => {
    test('folders always sort before files regardless of key/dir', () => {
        const folder = item({ name: 'zzz', type: 'folder' });
        const file = item({ name: 'aaa', type: 'file' });
        for (const dir of ['asc', 'desc'] as const) {
            const sorted = [file, folder].sort(getDriveComparator('name', dir));
            expect(sorted[0].name).toBe('zzz');
        }
    });

    test('name asc is case-insensitive A→Z; desc reverses', () => {
        const a = [item({ name: 'banana' }), item({ name: 'Apple' }), item({ name: 'cherry' })];
        expect(
            a
                .slice()
                .sort(getDriveComparator('name', 'asc'))
                .map((x) => x.name),
        ).toEqual(['Apple', 'banana', 'cherry']);
        expect(
            a
                .slice()
                .sort(getDriveComparator('name', 'desc'))
                .map((x) => x.name),
        ).toEqual(['cherry', 'banana', 'Apple']);
    });

    test('modified sorts by updatedAt', () => {
        const older = item({ name: 'older', updatedAt: new Date(1000) });
        const newer = item({ name: 'newer', updatedAt: new Date(9000) });
        expect([older, newer].sort(getDriveComparator('modified', 'desc'))[0].name).toBe('newer');
        expect([newer, older].sort(getDriveComparator('modified', 'asc'))[0].name).toBe('older');
    });

    test('size sorts numerically', () => {
        const small = item({ name: 'small', size: 10 });
        const big = item({ name: 'big', size: 9000 });
        expect([small, big].sort(getDriveComparator('size', 'desc'))[0].name).toBe('big');
    });

    test('ties break by name ascending for a stable order', () => {
        const a = item({ name: 'a', size: 5 });
        const b = item({ name: 'b', size: 5 });
        expect([b, a].sort(getDriveComparator('size', 'desc')).map((x) => x.name)).toEqual(['a', 'b']);
    });
});
