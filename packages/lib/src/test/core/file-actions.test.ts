import { describe, expect, test } from 'bun:test';
import { IMPORT_MAX_BYTES } from '../../constants/contact';
import { DOCX_MIME, XLSX_MIME } from '../../constants/mime';
import { type FileActionId, fileActionsFor } from '../../core/file-actions';
import { subjectFromPath } from '../../core/file-subject';
import type { DrivePath, DrivePathType } from '../../types/drive';
import type { FileSubject } from '../../types/file-subject';

function path(p: Partial<DrivePath> & { name: string; type: DrivePathType }): DrivePath {
    return {
        id: 'path-1',
        mountId: 'mount-1',
        parentId: 'parent-1',
        ownerId: 'owner-1',
        mimeType: 'application/octet-stream',
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
        ...p,
    };
}

function idsFor(item: DrivePath): string[] {
    return fileActionsFor(subjectFromPath(item)).map((action) => action.id);
}

// The Drive item menu draws whatever the registry returns, so these fixtures are the contract for
// what a Drive item offers. Rows come back in registry order.
describe('fileActionsFor on a Drive item', () => {
    const items: { item: DrivePath; ids: FileActionId[] }[] = [
        { item: path({ name: 'Photos', type: 'folder', mimeType: 'folder' }), ids: [] },
        { item: path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' }), ids: ['quick-look'] },
        {
            item: path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' }),
            ids: ['quick-look', 'download', 'save-to-drive'],
        },
        {
            item: path({ name: 'Budget.XLSX', type: 'file', mimeType: XLSX_MIME }),
            ids: ['quick-look', 'download', 'save-to-drive', 'convert-to-sheet'],
        },
        {
            item: path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME }),
            ids: ['quick-look', 'download', 'save-to-drive', 'convert-to-document'],
        },
        {
            item: path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard' }),
            ids: ['quick-look', 'download', 'save-to-drive', 'import-contacts'],
        },
        // The convert gate is the extension alone, matching the server: a spreadsheet that lost its
        // name — a mail part called `attachment-2` — offers no convert, because the import refuses it.
        {
            item: path({ name: 'budget', type: 'file', mimeType: XLSX_MIME }),
            ids: ['quick-look', 'download', 'save-to-drive'],
        },
        // Over the import ceiling the row is gone: the route answers a bigger vCard with a 413.
        {
            item: path({ name: 'huge.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES + 1 }),
            ids: ['quick-look', 'download', 'save-to-drive'],
        },
    ];

    for (const { item, ids } of items) {
        test(`${item.name} offers ${ids.join(', ') || 'nothing'}`, () => {
            expect(idsFor(item)).toEqual(ids);
        });
    }

    test('a .vcf imports to contacts right up to the ceiling', () => {
        const atCeiling = path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES });
        expect(idsFor(atCeiling)).toContain('import-contacts');
    });

    test('exclude drops a row the registry approved', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' });
        expect(fileActionsFor(subjectFromPath(item), ['quick-look']).map((action) => action.id)).toEqual([
            'download',
            'save-to-drive',
        ]);
    });
});

describe('fileActionsFor on a subject without a Drive path', () => {
    const subject: FileSubject = {
        key: 'mail:owner-1:message-1:2',
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        embedUrl: 'https://example.test/embed',
        downloadUrl: 'https://example.test/download',
        mail: { ownerId: 'owner-1', messageId: 'message-1', index: 2 },
    };

    test('quick look applies without a path to check the type of', () => {
        expect(fileActionsFor(subject).map((action) => action.id)).toEqual(['quick-look', 'download', 'save-to-drive']);
    });

    test('nothing that needs bytes applies without a download URL', () => {
        const noBytes: FileSubject = { ...subject, downloadUrl: undefined };
        expect(fileActionsFor(noBytes).map((action) => action.id)).toEqual(['quick-look']);
    });

    test('a vCard part imports to contacts on its name alone', () => {
        const vcard: FileSubject = { ...subject, name: 'team.vcf', mimeType: 'application/octet-stream' };
        expect(fileActionsFor(vcard).map((action) => action.id)).toContain('import-contacts');
    });
});
