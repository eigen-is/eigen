import { describe, expect, mock, test } from 'bun:test';
import { navCommands } from '../../../../core/command-palette/commands/nav';
import { selectionCommands } from '../../../../core/command-palette/commands/selection';
import { driveActionsFor } from '../../../../core/drive/drive-actions';
import type {
    CommandContext,
    PaletteSelectionAction,
    PaletteSelectionActions,
} from '../../../../types/command-palette';
import type { DrivePath, DrivePathType } from '../../../../types/drive';
import type { DriveActionId } from '../../../../types/drive-actions';
import type { DriveCapabilities } from '../../../../types/drive-view';

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

function context(items: DrivePath[], selectionActions: PaletteSelectionActions, mailEnabled = true): CommandContext {
    return {
        ownerId: 'owner-1',
        mailEnabled,
        selection: items.length > 0 ? { items } : null,
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

// A view that allows everything, so a document is offered every row the tests publish.
const browse: DriveCapabilities = {
    canCreateFolder: true,
    canUpload: true,
    canWrite: true,
    canDelete: true,
    canRename: true,
    canMove: true,
    canShare: true,
    showBreadcrumb: true,
};

// A published row for a Drive catalog row, as a page binds it to its selection.
function row(id: DriveActionId, run: PaletteSelectionAction['run'] = () => {}): PaletteSelectionAction {
    const action = driveActionsFor({ items: [doc], capabilities: browse, isSharedWithMe: () => false }).find(
        (a) => a.id === id,
    );
    if (!action) throw new Error(`No Drive action ${id}`);
    return { action, run };
}

const file = path({ name: 'holiday.jpg', type: 'file', mimeType: 'image/jpeg' });
const doc = path({ id: 'doc-1', name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' });
const sheet = path({ id: 'sheet-1', name: 'Budget.eigensheets', type: 'sheets', mimeType: 'application/eigensheets' });

const titles = (ctx: CommandContext) => selectionCommands(ctx).map((c) => [c.title, c.subtitle]);

describe('selection commands', () => {
    test('each published row is one command under the menu label, the item named beside it', () => {
        const ctx = context([doc], [row('open'), row('rename'), row('trash')]);
        expect(titles(ctx)).toEqual([
            ['Open', 'Notes'],
            ['Rename', 'Notes'],
            ['Move to trash', 'Notes'],
        ]);
    });

    test('a multi-selection reads the plural label and names no single item', () => {
        const ctx = context([doc, sheet], [row('move-to'), row('trash')]);
        expect(titles(ctx)).toEqual([
            ['Move 2 items to…', undefined],
            ['Move 2 items to trash', undefined],
        ]);
    });

    test('running a command runs the row the page bound, in the published order', () => {
        const open = mock(() => {});
        const ctx = context([doc], [row('open', open), row('rename')]);
        const commands = selectionCommands(ctx);
        commands[0].run(ctx);
        expect(open).toHaveBeenCalledTimes(1);
        expect(commands.map((c) => c.group)).toEqual(['selection', 'selection']);
        expect(commands[0].baseRank ?? 0).toBeGreaterThan(commands[1].baseRank ?? 0);
    });

    test('nothing selected or nothing published offers nothing', () => {
        expect(selectionCommands(context([], [row('open')]))).toEqual([]);
        expect(selectionCommands(context([doc], null))).toEqual([]);
    });

    test('a row is found by its synonyms and by the item name too', () => {
        const [trash] = selectionCommands(context([file], [row('trash')]));
        expect(trash.keywords).toContain('delete');
        expect(trash.keywords).toContain('holiday.jpg');
    });
});

// Published by the File menu and by Drive, so a document offers exactly its File › Download formats.
describe('download as', () => {
    test('is one command per format of the item type, after every other row', () => {
        const ctx = context([sheet], [row('download-as'), row('trash')]);
        expect(titles(ctx)).toEqual([
            ['Move to trash', 'Budget'],
            ['Download as Microsoft Excel (.xlsx)', 'Budget'],
            ['Download as PDF (.pdf)', 'Budget'],
            ['Download as Web page (.html)', 'Budget'],
        ]);
    });

    test('runs the row with its format', () => {
        const run = mock((_format?: string) => {});
        const ctx = context([doc], [row('download-as', run)]);
        selectionCommands(ctx)
            .find((c) => c.title === 'Download as Microsoft Word (.docx)')
            ?.run(ctx);
        expect(run.mock.calls).toEqual([['docx']]);
    });
});

describe('the catalog', () => {
    test('the Mail commands stand down on a server without hosted mail', () => {
        const available = (id: string, mailEnabled: boolean) =>
            navCommands.find((c) => c.id === id)?.availability?.(context([], null, mailEnabled)) ?? true;
        expect(available('nav.mail', true)).toBe(true);
        expect(available('nav.mail', false)).toBe(false);
        expect(available('nav.drive', false)).toBe(true);
    });
});
