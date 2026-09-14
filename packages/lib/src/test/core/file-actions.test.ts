import { describe, expect, test } from 'bun:test';
import { IMPORT_MAX_BYTES } from '../../constants/contact';
import { DOCX_MIME, XLSX_MIME } from '../../constants/mime';
import { fileActionsFor } from '../../core/file-actions';
import { subjectFromMailAttachment, subjectFromPath } from '../../core/file-subject';
import type { DrivePath, DrivePathType } from '../../types/drive';
import type { FileActionId, FileSubject } from '../../types/file-subject';

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
            ids: ['quick-look', 'download'],
        },
        {
            item: path({ name: 'Budget.XLSX', type: 'file', mimeType: XLSX_MIME }),
            ids: ['quick-look', 'download', 'convert-to-sheet'],
        },
        {
            item: path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME }),
            ids: ['quick-look', 'download', 'convert-to-document'],
        },
        {
            item: path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard' }),
            ids: ['quick-look', 'download', 'import-contacts'],
        },
        // The convert gate is the extension alone, matching the server: a spreadsheet or a document
        // that lost its name — a mail part called `attachment-2` — offers no convert, because the
        // import refuses it.
        {
            item: path({ name: 'budget', type: 'file', mimeType: XLSX_MIME }),
            ids: ['quick-look', 'download'],
        },
        {
            item: path({ name: 'report', type: 'file', mimeType: DOCX_MIME }),
            ids: ['quick-look', 'download'],
        },
        // Over the import ceiling the row is gone: the route answers a bigger vCard with a 413.
        {
            item: path({ name: 'huge.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES + 1 }),
            ids: ['quick-look', 'download'],
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
        expect(fileActionsFor(subjectFromPath(item), ['quick-look']).map((action) => action.id)).toEqual(['download']);
    });
});

describe('fileActionsFor on a subject without a Drive path', () => {
    function mailSubject(part: { contentType: string; filename?: string; size: number }): FileSubject {
        return subjectFromMailAttachment('owner-1', 'message-1', 2, part);
    }

    const subject = mailSubject({ contentType: 'application/pdf', filename: 'invoice.pdf', size: 2048 });

    test('a chat attachment is a Drive path that still saves to Drive: its copy sits in a hidden media folder', () => {
        const attachment: FileSubject = {
            ...subjectFromPath(path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' })),
            attachment: true,
        };
        expect(fileActionsFor(attachment).map((action) => action.id)).toEqual([
            'quick-look',
            'download',
            'save-to-drive',
        ]);
    });

    test('quick look applies without a path to check the type of', () => {
        expect(fileActionsFor(subject).map((action) => action.id)).toEqual(['quick-look', 'download', 'save-to-drive']);
    });

    // A container has no bytes to hand out, wherever its copy sits: it is a directory of databases.
    test('nothing that needs bytes applies to an attached container', () => {
        const noBytes: FileSubject = {
            ...subjectFromPath(path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' })),
            attachment: true,
        };
        expect(fileActionsFor(noBytes).map((action) => action.id)).toEqual(['quick-look']);
    });

    test('a vCard part imports to contacts on its name alone', () => {
        const vcard = mailSubject({ contentType: 'application/octet-stream', filename: 'team.vcf', size: 2048 });
        expect(fileActionsFor(vcard).map((action) => action.id)).toContain('import-contacts');
    });
});
