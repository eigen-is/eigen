import { describe, expect, test } from 'bun:test';
import { driveCommands } from '../../../../core/command-palette/commands/drive';
import { navCommands } from '../../../../core/command-palette/commands/nav';
import type { CommandContext, PaletteSelectionActions } from '../../../../types/command-palette';
import type { DrivePath, DrivePathType, ExportFormat } from '../../../../types/drive';

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

function context(
    items: DrivePath[],
    mailEnabled = true,
    selectionActions: PaletteSelectionActions = { onDownload: () => {} },
): CommandContext {
    return {
        ownerId: 'owner-1',
        mailEnabled,
        selection: { items },
        selectionActions,
        docSearch: null,
        docSearchSession: null,
        docCommentSearch: null,
        navigate: () => {},
        openDriveCreate: () => {},
        openMailComposeWith: () => {},
        openPreview: () => {},
        toggleTheme: () => {},
    };
}

function isAvailable(commandId: string, items: DrivePath[], mailEnabled = true): boolean {
    const command = [...driveCommands, ...navCommands].find((c) => c.id === commandId);
    if (!command) throw new Error(`No command ${commandId}`);
    return command.availability?.(context(items, mailEnabled)) ?? true;
}

const file = path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' });
const folder = path({ name: 'Photos', type: 'folder', mimeType: 'folder' });
const doc = path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' });
const sheet = path({ name: 'Budget.eigensheets', type: 'sheets', mimeType: 'application/eigensheets' });
const deck = path({ name: 'Pitch.eigenslides', type: 'slides', mimeType: 'application/eigenslides' });

function downloadAsFormats(items: DrivePath[], selectionActions: PaletteSelectionActions): string[] {
    const ctx = context(items, true, selectionActions);
    return driveCommands
        .filter((c) => c.id.startsWith('drive.download-as.') && (c.availability?.(ctx) ?? true))
        .map((c) => c.id.replace('drive.download-as.', ''));
}

// Both gates read the file-action registry, so these pin that the palette offers exactly what the
// item menu does for the same item.
describe('drive selection commands', () => {
    test('quick preview covers everything that is not a folder', () => {
        expect(isAvailable('drive.quick-preview', [file])).toBe(true);
        expect(isAvailable('drive.quick-preview', [doc])).toBe(true);
        expect(isAvailable('drive.quick-preview', [folder])).toBe(false);
    });

    test('download covers plain files only', () => {
        expect(isAvailable('drive.download', [file])).toBe(true);
        expect(isAvailable('drive.download', [doc])).toBe(false);
        expect(isAvailable('drive.download', [folder])).toBe(false);
    });

    test('neither offers itself for a multi-selection or an empty one', () => {
        for (const id of ['drive.quick-preview', 'drive.download']) {
            expect(isAvailable(id, [file, folder])).toBe(false);
            expect(isAvailable(id, [])).toBe(false);
        }
    });

    test('the Mail commands stand down on a server without hosted mail', () => {
        expect(isAvailable('drive.mail-to', [file])).toBe(true);
        expect(isAvailable('drive.mail-to', [file], false)).toBe(false);
        expect(isAvailable('nav.mail', [], false)).toBe(false);
        expect(isAvailable('nav.drive', [], false)).toBe(true);
    });
});

// Published by the File menu and by Drive, so a document offers exactly its File › Download formats.
describe('download as', () => {
    const onExport = () => {};

    test('offers the formats of the item type, in menu order', () => {
        expect(downloadAsFormats([doc], { onExport })).toEqual(['docx', 'pdf', 'html']);
        expect(downloadAsFormats([sheet], { onExport })).toEqual(['xlsx', 'pdf', 'html']);
        expect(downloadAsFormats([deck], { onExport })).toEqual(['pptx', 'pdf', 'html']);
    });

    test('offers nothing for a plain file, a multi-selection or without a published onExport', () => {
        expect(downloadAsFormats([file], { onExport })).toEqual([]);
        expect(downloadAsFormats([doc, sheet], { onExport })).toEqual([]);
        expect(downloadAsFormats([doc], { onDownload: () => {} })).toEqual([]);
    });

    test('runs onExport with its format and labels itself as the Download submenu does, naming the item', () => {
        const calls: [string, ExportFormat][] = [];
        const ctx = context([doc], true, { onExport: (item, format) => calls.push([item.name, format]) });
        const command = driveCommands.find((c) => c.id === 'drive.download-as.docx');
        command?.run(ctx);
        expect(calls).toEqual([['Notes.eigendoc', 'docx']]);
        expect(command?.title).toBe('Download as Microsoft Word (.docx)');
        expect(command?.dynamicTitle?.(ctx)).toBe('Download Notes as Microsoft Word (.docx)');
    });
});
