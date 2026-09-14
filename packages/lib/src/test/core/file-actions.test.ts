import { describe, expect, test } from 'bun:test';
import { IMPORT_MAX_BYTES } from '../../constants/contact';
import { DOCX_MIME, XLSX_MIME } from '../../constants/mime';
import { type FileActionId, fileActionsFor } from '../../core/file-actions';
import { subjectFromPath } from '../../core/file-subject';
import { type DrivePath, type DrivePathType, isFolderType, isVCardFile } from '../../types/drive';
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

// The five booleans drive-item-menu.tsx gates its rows on today. The registry has to answer the
// same for every Drive item, or a row appears (or vanishes) on the surfaces that read it.
function menuGates(item: DrivePath) {
    const nameLower = item.name.toLowerCase();
    return {
        'quick-look': !isFolderType(item.type),
        download: item.type === 'file',
        'convert-to-sheet': item.type === 'file' && nameLower.endsWith('.xlsx'),
        'convert-to-document': item.type === 'file' && nameLower.endsWith('.docx'),
        'import-contacts': item.type === 'file' && isVCardFile(item.mimeType, item.name),
    };
}

function idsFor(item: DrivePath): string[] {
    return fileActionsFor(subjectFromPath(item)).map((action) => action.id);
}

describe('fileActionsFor parity with the Drive item menu', () => {
    // `answers` is where the registry deliberately answers differently from the menu's gates: every
    // widening and narrowing is named here, so neither can happen by accident.
    const items: { item: DrivePath; answers?: Partial<Record<FileActionId, boolean>> }[] = [
        { item: path({ name: 'Photos', type: 'folder', mimeType: 'folder' }) },
        { item: path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' }) },
        { item: path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' }) },
        { item: path({ name: 'Budget.XLSX', type: 'file', mimeType: XLSX_MIME }) },
        { item: path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME }) },
        { item: path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard' }) },
        // Wider than the menu, which reads the extension alone: an .xlsx that lost its name still
        // converts, the way a mail part named `attachment` would.
        {
            item: path({ name: 'budget', type: 'file', mimeType: XLSX_MIME }),
            answers: { 'convert-to-sheet': true },
        },
        // Narrower than the menu, which offers the row on a file the import answers with a 413.
        {
            item: path({ name: 'huge.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES + 1 }),
            answers: { 'import-contacts': false },
        },
    ];

    for (const { item, answers } of items) {
        test(`${item.name} offers the menu's rows`, () => {
            const ids = idsFor(item);
            for (const [id, expected] of Object.entries({ ...menuGates(item), ...answers })) {
                expect({ name: item.name, id, applies: ids.includes(id) }).toEqual({
                    name: item.name,
                    id,
                    applies: expected,
                });
            }
        });
    }

    test('a folder offers nothing', () => {
        expect(idsFor(path({ name: 'Photos', type: 'folder', mimeType: 'folder' }))).toEqual([]);
    });

    test('an eigendoc offers quick look only', () => {
        expect(idsFor(path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' }))).toEqual([
            'quick-look',
        ]);
    });

    test('a plain file offers quick look, download and save to Drive', () => {
        expect(idsFor(path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' }))).toEqual([
            'quick-look',
            'download',
            'save-to-drive',
        ]);
    });

    test('an .xlsx converts to a sheet, a .docx to a document, neither to the other', () => {
        expect(idsFor(path({ name: 'Budget.xlsx', type: 'file', mimeType: XLSX_MIME }))).toContain('convert-to-sheet');
        expect(idsFor(path({ name: 'Budget.xlsx', type: 'file', mimeType: XLSX_MIME }))).not.toContain(
            'convert-to-document',
        );
        expect(idsFor(path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME }))).toContain(
            'convert-to-document',
        );
        expect(idsFor(path({ name: 'Report.docx', type: 'file', mimeType: DOCX_MIME }))).not.toContain(
            'convert-to-sheet',
        );
    });

    test('a mime-only .xlsx and .docx convert without the extension', () => {
        expect(idsFor(path({ name: 'budget', type: 'file', mimeType: XLSX_MIME }))).toContain('convert-to-sheet');
        expect(idsFor(path({ name: 'report', type: 'file', mimeType: DOCX_MIME }))).toContain('convert-to-document');
    });

    test('a .vcf imports to contacts under the ceiling and not over it', () => {
        const small = path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES });
        const large = path({ name: 'team.vcf', type: 'file', mimeType: 'text/vcard', size: IMPORT_MAX_BYTES + 1 });
        expect(idsFor(small)).toContain('import-contacts');
        expect(idsFor(large)).not.toContain('import-contacts');
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
