import { describe, expect, test } from 'bun:test';
import { getDriveDownloadUrl, getDriveEmbedUrl, getDriveThumbnailUrl } from '../../core/api';
import { getPreviewMode, subjectFromPath } from '../../core/file-subject';
import type { DrivePath, DrivePathType } from '../../types/drive';
import type { FileSubject } from '../../types/file-subject';

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

function driveSubject(name: string, mimeType: string, type: DrivePathType = 'file'): FileSubject {
    return subjectFromPath(path({ name, type, mimeType }));
}

// A subject with no Drive path behind it: a mail part, once that lands.
function partSubject(name: string, mimeType: string): FileSubject {
    return {
        key: 'mail:owner-1:message-1:0',
        name,
        mimeType,
        size: 1024,
        embedUrl: 'https://example.test/embed',
        downloadUrl: 'https://example.test/download',
    };
}

describe('getPreviewMode', () => {
    test('reads the mime the same way whatever holds the file', () => {
        for (const [name, mime, mode] of [
            ['clip.mp4', 'video/mp4', 'video'],
            ['song.mp3', 'audio/mpeg', 'audio'],
            ['invoice.pdf', 'application/pdf', 'pdf'],
            ['archive.zip', 'application/zip', 'fallback'],
        ] as const) {
            expect(getPreviewMode(driveSubject(name, mime))).toBe(mode);
            expect(getPreviewMode(partSubject(name, mime))).toBe(mode);
        }
    });

    test('a Drive item previews any image mime through the transcode route', () => {
        expect(getPreviewMode(driveSubject('holiday.jpg', 'image/jpeg'))).toBe('image');
        expect(getPreviewMode(driveSubject('holiday.heic', 'image/heic'))).toBe('image');
        expect(getPreviewMode(driveSubject('shoot.cr2', 'application/octet-stream'))).toBe('image');
    });

    test('a file without a Drive path is an image only where the browser decodes it', () => {
        expect(getPreviewMode(partSubject('holiday.png', 'image/png'))).toBe('image');
        expect(getPreviewMode(partSubject('holiday.heic', 'image/heic'))).toBe('fallback');
        expect(getPreviewMode(partSubject('shoot.cr2', 'application/octet-stream'))).toBe('fallback');
    });

    test('the text and vCard modes need the mount they query', () => {
        expect(getPreviewMode(driveSubject('notes.txt', 'text/plain'))).toBe('text');
        expect(getPreviewMode(partSubject('notes.txt', 'text/plain'))).toBe('fallback');
        expect(getPreviewMode(driveSubject('team.vcf', 'text/vcard'))).toBe('vcard');
        expect(getPreviewMode(partSubject('team.vcf', 'text/vcard'))).toBe('fallback');
    });
});
