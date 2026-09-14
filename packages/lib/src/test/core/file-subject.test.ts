import { describe, expect, test } from 'bun:test';
import {
    getDriveDownloadUrl,
    getDriveEmbedUrl,
    getDriveThumbnailUrl,
    getMailAttachmentEmbedUrl,
    getMailAttachmentUrl,
} from '../../core/api';
import { getPreviewMode, subjectFromMailAttachment, subjectFromPath, subjectInfo } from '../../core/file-subject';
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

function driveInfo(p: Partial<DrivePath> & { name: string; type: DrivePathType }) {
    return subjectInfo(subjectFromPath(path(p)));
}

describe('subjectFromPath', () => {
    test('stores the Drive path alone', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', thumbnail: 'thumb-1.webp' });
        expect(subjectFromPath(item)).toEqual({ drive: item });
    });
});

describe('subjectInfo on a Drive item', () => {
    test('derives the item identity and the URLs the preview overlay requests', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', thumbnail: 'thumb-1.webp' });

        expect(subjectInfo(subjectFromPath(item))).toEqual({
            key: 'drive:owner-1:mount-1:path-1',
            name: 'holiday.jpg',
            mimeType: 'image/jpeg',
            size: 4096,
            embedUrl: getDriveEmbedUrl('owner-1', 'mount-1', 'path-1', 'holiday.jpg', item.updatedAt),
            downloadUrl: getDriveDownloadUrl('owner-1', 'mount-1', 'path-1', item.updatedAt),
            thumbnailUrl: getDriveThumbnailUrl('owner-1', 'mount-1', 'thumb-1.webp', item.updatedAt),
        });
    });

    test('keys siblings apart by id', () => {
        const a = driveInfo({ name: 'a.jpg', type: 'file' });
        const b = driveInfo({ name: 'b.jpg', type: 'file', id: 'path-2' });
        expect(a.key).not.toBe(b.key);
    });

    test('has no thumbnail URL when the item has no thumbnail', () => {
        expect(driveInfo({ name: 'notes.txt', type: 'file' }).thumbnailUrl).toBeUndefined();
    });

    test('offers bytes for a plain file only', () => {
        expect(driveInfo({ name: 'holiday.jpg', type: 'file' }).downloadUrl).toBeDefined();
        expect(driveInfo({ name: 'Photos', type: 'folder' }).downloadUrl).toBeUndefined();
        expect(driveInfo({ name: 'Notes.eigendoc', type: 'doc' }).downloadUrl).toBeUndefined();
    });

    test('cache-busts every URL with the item version', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', thumbnail: 'thumb-1.webp' });
        const version = `v=${item.updatedAt.getTime()}`;
        const info = subjectInfo(subjectFromPath(item));
        expect(info.embedUrl).toContain(version);
        expect(info.downloadUrl).toContain(version);
        expect(info.thumbnailUrl).toContain(version);
    });
});

function driveSubject(name: string, mimeType: string, type: DrivePathType = 'file'): FileSubject {
    return subjectFromPath(path({ name, type, mimeType }));
}

function mailSubject(name: string, mimeType: string): FileSubject {
    return subjectFromMailAttachment('owner-1', 'message-1', 0, { contentType: mimeType, filename: name, size: 1024 });
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
            expect(getPreviewMode(mailSubject(name, mime))).toBe(mode);
        }
    });

    test('a Drive item previews any image mime through the transcode route', () => {
        expect(getPreviewMode(driveSubject('holiday.jpg', 'image/jpeg'))).toBe('image');
        expect(getPreviewMode(driveSubject('holiday.heic', 'image/heic'))).toBe('image');
        expect(getPreviewMode(driveSubject('shoot.cr2', 'application/octet-stream'))).toBe('image');
    });

    test('a mail part is an image only where the browser decodes it', () => {
        expect(getPreviewMode(mailSubject('holiday.png', 'image/png'))).toBe('image');
        expect(getPreviewMode(mailSubject('holiday.heic', 'image/heic'))).toBe('fallback');
        expect(getPreviewMode(mailSubject('shoot.cr2', 'application/octet-stream'))).toBe('fallback');
    });

    test('the text and card previews answer for a Drive item and a mail part alike', () => {
        for (const subject of [driveSubject, mailSubject]) {
            expect(getPreviewMode(subject('notes.txt', 'text/plain'))).toBe('text');
            expect(getPreviewMode(subject('readme.md', 'text/markdown'))).toBe('text');
            expect(getPreviewMode(subject('team.vcf', 'text/vcard'))).toBe('vcard');
        }
    });

    // A mime is the uploader's or the sender's word; only a real container earns the document modes,
    // which is the gate the preview routes run on the bytes they hold.
    test('an eigen mime on loose bytes previews as what its name deserves, never as a document', () => {
        expect(getPreviewMode(driveSubject('report.bin', 'application/eigendoc'))).toBe('fallback');
        expect(getPreviewMode(mailSubject('report.bin', 'application/eigendoc'))).toBe('fallback');
        expect(getPreviewMode(driveSubject('report.txt', 'application/eigendoc'))).toBe('text');
    });

    test('a Drive container previews as text, from its own document body', () => {
        expect(getPreviewMode(driveSubject('Notes.eigendoc', 'application/eigendoc', 'doc'))).toBe('text');
        expect(getPreviewMode(driveSubject('Team.eigenchat', 'application/eigenchat', 'chat'))).toBe('fallback');
    });
});

const part = { contentType: 'application/pdf', filename: 'invoice.pdf', size: 1234 };

describe('subjectFromMailAttachment', () => {
    test('stores the part reference, the part itself and nothing else', () => {
        expect(subjectFromMailAttachment('owner-1', 'msg-1', 2, part)).toEqual({
            mail: { ownerId: 'owner-1', messageId: 'msg-1', index: 2 },
            part,
            attachment: true,
        });
    });
});

describe('subjectInfo on a mail part', () => {
    test('derives the part identity and the URLs the two mail byte routes answer on', () => {
        expect(subjectInfo(subjectFromMailAttachment('owner-1', 'msg-1', 2, part))).toEqual({
            key: 'mail:owner-1:msg-1:2',
            name: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 1234,
            embedUrl: getMailAttachmentEmbedUrl('owner-1', 'msg-1', 2, 'invoice.pdf'),
            downloadUrl: getMailAttachmentUrl('owner-1', 'msg-1', 2, 'invoice.pdf'),
        });
    });

    test('names a filename-less part the way the server does', () => {
        const info = subjectInfo(
            subjectFromMailAttachment('owner-1', 'msg-1', 1, { contentType: 'image/png', size: 9 }),
        );
        expect(info.name).toBe('attachment-2');
        expect(info.downloadUrl).toContain('attachment-2');
    });

    // The reader hides calendar parts but still addresses the parts around them by their raw index.
    test('keys on the raw part index, gaps included', () => {
        const first = subjectInfo(subjectFromMailAttachment('owner-1', 'msg-1', 0, part));
        const third = subjectInfo(subjectFromMailAttachment('owner-1', 'msg-1', 2, part));
        expect(first.key).not.toBe(third.key);
        expect(third.key).toBe('mail:owner-1:msg-1:2');
    });

    test('has no thumbnail', () => {
        expect(subjectInfo(subjectFromMailAttachment('owner-1', 'msg-1', 0, part)).thumbnailUrl).toBeUndefined();
    });
});
