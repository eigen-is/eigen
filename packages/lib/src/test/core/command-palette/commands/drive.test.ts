import { describe, expect, test } from 'bun:test';
import { driveCommands } from '../../../../core/command-palette/commands/drive';
import type { CommandContext } from '../../../../types/command-palette';
import type { DrivePath, DrivePathType } from '../../../../types/drive';

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

function context(items: DrivePath[]): CommandContext {
    return {
        ownerId: 'owner-1',
        selection: { items },
        selectionActions: { onDownload: () => {} },
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

function isAvailable(commandId: string, items: DrivePath[]): boolean {
    const command = driveCommands.find((c) => c.id === commandId);
    if (!command) throw new Error(`No command ${commandId}`);
    return command.availability?.(context(items)) ?? true;
}

const file = path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' });
const folder = path({ name: 'Photos', type: 'folder', mimeType: 'folder' });
const doc = path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' });

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
});
