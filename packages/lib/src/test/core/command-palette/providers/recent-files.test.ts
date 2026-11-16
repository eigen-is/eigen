import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CommandContext, PaletteResult, PaletteScope } from '../../../../types/command-palette';
import type { RecentPath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER } from '../../../transfer-harness';

installTransferHarness();

function recent(id: string, name: string): RecentPath {
    return {
        id,
        name,
        mountId: 'm1',
        type: 'file',
        parentId: 'root',
        ownerId: OWNER,
        mimeType: 'text/plain',
        size: 0,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lastActivityAt: new Date(0),
    };
}

const OPEN = recent('open', 'Open doc.txt');
const PATHS = [OPEN, recent('a', 'Budget.txt'), recent('b', 'Plan.txt')];

const ctx: CommandContext = {
    ownerId: OWNER,
    mailEnabled: true,
    selection: { items: [OPEN] },
    selectionActions: null,
    docSearch: null,
    docSearchSession: null,
    docCommentSearch: null,
    navigate: () => {},
    openDriveCreate: () => {},
    openMailComposeWith: () => {},
    openPreview: () => {},
    toggleTheme: () => {},
};

// Renders the source over a cache that already holds the recent list and returns the rows it gave.
async function recentRows(input: string, scope: PaletteScope | undefined): Promise<PaletteResult[]> {
    const { useRecentFileResults } = await import('../../../../core/command-palette/providers/recent-files');
    const queryClient = new QueryClient();
    queryClient.setQueryData(['drive', OWNER, 'recent'], PATHS);
    const { latest, unmount } = await renderHook(() => useRecentFileResults(ctx, input, scope, true), queryClient);
    await unmount();
    return latest;
}

describe('the recent files source', () => {
    test('an empty box lists the recent files, leaving out the open document', async () => {
        const rows = await recentRows('', undefined);
        expect(rows.map((r) => [r.id, r.group])).toEqual([
            ['file.a', 'recent'],
            ['file.b', 'recent'],
        ]);
    });

    test('typed text keeps the recent files whose title matches, as files', async () => {
        const rows = await recentRows('bud', undefined);
        expect(rows.map((r) => [r.id, r.group])).toEqual([['file.a', 'file']]);
    });

    test('a scope other than files hides them', async () => {
        expect(await recentRows('', 'mail')).toEqual([]);
        expect((await recentRows('', 'file')).length).toBe(2);
    });
});
