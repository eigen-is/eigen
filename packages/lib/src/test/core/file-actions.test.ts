import { describe, expect, test } from 'bun:test';
import { ICS_MAX_BYTES } from '../../constants/calendar';
import { VCARD_MAX_BYTES } from '../../constants/contact';
import { EML_MAX_BYTES } from '../../constants/mail';
import { DOCX_MIME, XLSX_MIME } from '../../constants/mime';
import { fileActionsFor, GUEST_DENIED_ACTIONS } from '../../core/file-actions';
import { subjectFromMailAttachment, subjectFromPath } from '../../core/file-subject';
import { type DrivePath, type DrivePathType, EML_MIME, ICS_MIME } from '../../types/drive';
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
        {
            item: path({ name: 'engine notes.eml', type: 'file', mimeType: EML_MIME }),
            ids: ['quick-look', 'download', 'import-mail'],
        },
        {
            item: path({ name: 'festival.ics', type: 'file', mimeType: ICS_MIME }),
            ids: ['quick-look', 'download', 'import-calendar'],
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
            item: path({ name: 'huge.vcf', type: 'file', mimeType: 'text/vcard', size: VCARD_MAX_BYTES + 1 }),
            ids: ['quick-look', 'download'],
        },
        {
            item: path({ name: 'huge.eml', type: 'file', mimeType: EML_MIME, size: EML_MAX_BYTES + 1 }),
            ids: ['quick-look', 'download'],
        },
        {
            item: path({ name: 'huge.ics', type: 'file', mimeType: ICS_MIME, size: ICS_MAX_BYTES + 1 }),
            ids: ['quick-look', 'download'],
        },
    ];

    for (const { item, ids } of items) {
        test(`${item.name} offers ${ids.join(', ') || 'nothing'}`, () => {
            expect(idsFor(item)).toEqual(ids);
        });
    }

    test('a .vcf imports to contacts right up to the ceiling', () => {
        const atCeiling = path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard', size: VCARD_MAX_BYTES });
        expect(idsFor(atCeiling)).toContain('import-contacts');
    });

    // A watched feed is read-only: a convert would write the new document into a folder the viewer
    // cannot write to, and the route would refuse it.
    test('a read-only listing offers no convert', () => {
        const xlsx = path({ name: 'Budget.xlsx', type: 'file', mimeType: XLSX_MIME });
        const docx = path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME });
        const readOnly = false;
        expect(fileActionsFor(subjectFromPath(xlsx, readOnly)).map((action) => action.id)).toEqual([
            'quick-look',
            'download',
        ]);
        expect(fileActionsFor(subjectFromPath(docx, readOnly)).map((action) => action.id)).toEqual([
            'quick-look',
            'download',
        ]);
        expect(fileActionsFor(subjectFromPath(xlsx, true)).map((action) => action.id)).toContain('convert-to-sheet');
        expect(fileActionsFor(subjectFromPath(docx, true)).map((action) => action.id)).toContain('convert-to-document');
    });

    test('an .eml imports to mail right up to the ceiling', () => {
        const atCeiling = path({ name: 'notes.eml', type: 'file', mimeType: EML_MIME, size: EML_MAX_BYTES });
        expect(idsFor(atCeiling)).toContain('import-mail');
    });

    test('an .ics imports to calendar right up to the ceiling', () => {
        const atCeiling = path({ name: 'festival.ics', type: 'file', mimeType: ICS_MIME, size: ICS_MAX_BYTES });
        expect(idsFor(atCeiling)).toContain('import-calendar');
    });

    test('exclude drops a row the registry approved', () => {
        const item = path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' });
        expect(fileActionsFor(subjectFromPath(item), ['quick-look']).map((action) => action.id)).toEqual(['download']);
    });
});

describe('fileActionsFor on an attachment subject', () => {
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

    // The picker saves it where the user points, so where its Drive copy sits says nothing.
    test('an attachment converts, through the picker', () => {
        const attachment: FileSubject = {
            ...subjectFromPath(path({ name: 'Budget.xlsx', type: 'file', mimeType: XLSX_MIME })),
            attachment: true,
        };
        expect(fileActionsFor(attachment).map((action) => action.id)).toContain('convert-to-sheet');
    });

    test('a vCard part imports to contacts on its name alone', () => {
        const vcard = mailSubject({ contentType: 'application/octet-stream', filename: 'team.vcf', size: 2048 });
        expect(fileActionsFor(vcard).map((action) => action.id)).toContain('import-contacts');
    });

    test('an attached message imports to mail on its name alone', () => {
        const eml = mailSubject({ contentType: 'application/octet-stream', filename: 'fwd.eml', size: 2048 });
        expect(fileActionsFor(eml).map((action) => action.id)).toContain('import-mail');
    });

    // An invitation's calendar part carries no filename at all, so the media type with its own
    // parameters is all there is to go on.
    test('a calendar part imports to calendar on its media type alone', () => {
        const ics = mailSubject({ contentType: 'text/calendar; method=REQUEST; charset=utf-8', size: 2048 });
        expect(fileActionsFor(ics).map((action) => action.id)).toContain('import-calendar');
    });
});

// The import routes refuse a guest (requireNonGuest) and a registry predicate cannot see the user, so
// the rows a guest may not run are named once here and excluded by the one caller that knows who is asking.
describe('GUEST_DENIED_ACTIONS', () => {
    test('names every import row and nothing else', () => {
        expect([...GUEST_DENIED_ACTIONS]).toEqual(['import-contacts', 'import-mail', 'import-calendar']);
    });

    test('excluding them leaves a .vcf, an .eml and an .ics with what a guest may run', () => {
        const vcard = path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard' });
        const eml = path({ name: 'notes.eml', type: 'file', mimeType: EML_MIME });
        const ics = path({ name: 'festival.ics', type: 'file', mimeType: ICS_MIME });
        for (const item of [vcard, eml, ics]) {
            const ids = fileActionsFor(subjectFromPath(item), GUEST_DENIED_ACTIONS).map((action) => action.id);
            expect(ids).toEqual(['quick-look', 'download']);
        }
    });
});
