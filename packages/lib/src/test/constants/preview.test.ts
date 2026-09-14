import { describe, expect, test } from 'bun:test';
import { getPreviewMode, getTextPreviewMode, isSearchableTextFile } from '../../constants/preview';
import { subjectFromPath } from '../../core/file-subject';
import type { DrivePath, DrivePathType } from '../../types/drive';
import type { FileSubject } from '../../types/file-subject';

describe('isSearchableTextFile', () => {
    test('plaintext + markdown + code are searchable', () => {
        expect(isSearchableTextFile('text/plain', 'notes.txt')).toBe(true);
        expect(isSearchableTextFile('text/markdown', 'README.md')).toBe(true);
        expect(isSearchableTextFile('application/json', 'data.json')).toBe(true);
    });
    test('eigen container mimes are NOT plaintext-searchable (handled via onSync)', () => {
        expect(isSearchableTextFile('application/eigendoc', 'doc.eigendoc')).toBe(false);
        expect(isSearchableTextFile('application/eigensheets', 's.eigensheets')).toBe(false);
        expect(isSearchableTextFile('application/eigenvector', 'plan.eigenvector')).toBe(false);
    });
    test('binary is not searchable', () => {
        expect(isSearchableTextFile('image/png', 'photo.png')).toBe(false);
    });
    // The extractor indexes the cards a .vcf holds, not its raw body — which is mostly base64 photo.
    test('a vCard is searchable, on every mime its exporters spell', () => {
        expect(isSearchableTextFile('text/vcard', 'team.vcf')).toBe(true);
        expect(isSearchableTextFile('text/x-vcard', 'team.vcf')).toBe(true);
        expect(isSearchableTextFile('application/octet-stream', 'team.vcf')).toBe(true);
    });
});

describe('getTextPreviewMode', () => {
    test('a vector drawing is a text preview — its body is the compositor page', () => {
        expect(getTextPreviewMode('application/eigenvector', 'plan.eigenvector')).toBe('eigenvector');
    });
    test('a vCard has no text preview — the drive hero would render its base64 photo wall', () => {
        expect(getTextPreviewMode('text/vcard', 'team.vcf')).toBeNull();
        expect(getTextPreviewMode('text/x-vcard', 'team.vcf')).toBeNull();
        expect(getTextPreviewMode('application/octet-stream', 'team.vcf')).toBeNull();
    });
});

function driveSubject(name: string, mimeType: string, type: DrivePathType = 'file'): FileSubject {
    const path: DrivePath = {
        id: 'path-1',
        mountId: 'mount-1',
        name,
        type,
        parentId: 'parent-1',
        ownerId: 'owner-1',
        mimeType,
        size: 1024,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
    return subjectFromPath(path);
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
