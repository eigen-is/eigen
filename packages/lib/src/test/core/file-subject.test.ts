import { describe, expect, test } from 'bun:test';
import { getDriveDownloadUrl, getDriveEmbedUrl, getDriveThumbnailUrl } from '../../core/api';
import { subjectFromPath } from '../../core/file-subject';
import type { DrivePath, DrivePathType } from '../../types/drive';

function path(p: Partial<DrivePath> & { name: string; type: DrivePathType }): DrivePath {
    return {
        id: 'path-1',
        mountId: 'mount-1',
        parentId: 'parent-1',
        ownerId: 'owner-1',
        mimeType: 'image/jpeg',
        size: 4096,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date('2026-09-14T10:11:12.000Z'),
        ...p,
    };
}

describe('subjectFromPath', () => {
    test('carries the item identity and the URLs the preview overlay requests', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', thumbnail: 'thumb-1.webp' });
        const subject = subjectFromPath(item);

        expect(subject).toEqual({
            key: 'drive:owner-1:mount-1:path-1',
            name: 'holiday.jpg',
            mimeType: 'image/jpeg',
            size: 4096,
            embedUrl: getDriveEmbedUrl('owner-1', 'mount-1', 'path-1', 'holiday.jpg', item.updatedAt),
            downloadUrl: getDriveDownloadUrl('owner-1', 'mount-1', 'path-1', item.updatedAt),
            thumbnailUrl: getDriveThumbnailUrl('owner-1', 'mount-1', 'thumb-1.webp', item.updatedAt),
            drive: item,
        });
    });

    test('keys siblings apart by id', () => {
        const a = subjectFromPath(path({ name: 'a.jpg', type: 'file' }));
        const b = subjectFromPath(path({ name: 'b.jpg', type: 'file', id: 'path-2' }));
        expect(a.key).not.toBe(b.key);
    });

    test('has no thumbnail URL when the item has no thumbnail', () => {
        expect(subjectFromPath(path({ name: 'notes.txt', type: 'file' })).thumbnailUrl).toBeUndefined();
    });

    test('offers bytes for a plain file only', () => {
        expect(subjectFromPath(path({ name: 'holiday.jpg', type: 'file' })).downloadUrl).toBeDefined();
        expect(subjectFromPath(path({ name: 'Photos', type: 'folder' })).downloadUrl).toBeUndefined();
        expect(subjectFromPath(path({ name: 'Notes.eigendoc', type: 'doc' })).downloadUrl).toBeUndefined();
    });

    test('cache-busts every URL with the item version', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', thumbnail: 'thumb-1.webp' });
        const version = `v=${item.updatedAt.getTime()}`;
        const subject = subjectFromPath(item);
        expect(subject.embedUrl).toContain(version);
        expect(subject.downloadUrl).toContain(version);
        expect(subject.thumbnailUrl).toContain(version);
    });
});
