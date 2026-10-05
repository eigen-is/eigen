import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CommandContext, PaletteScope } from '../../../../types/command-palette';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

// The Eden search client, stubbed to count the requests the palette's async sources make.
const realApiModule = await import('../../../../core/api');
const requested: string[] = [];
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    searchApi: () => ({
        get: async ({ query }: { query: { sources?: string } }) => {
            requested.push(query.sources ?? '');
            return { data: { files: [], mail: [] }, error: null, status: 200 };
        },
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const ctx: CommandContext = {
    ownerId: 'owner-1',
    mailEnabled: true,
    selection: { items: [] },
    selectionActions: {},
    docSearch: null,
    docSearchSession: null,
    docCommentSearch: null,
    navigate: () => {},
    openDriveCreate: () => {},
    openMailComposeWith: () => {},
    openPreview: () => {},
    toggleTheme: () => {},
};

// Renders both sources for one typed query under a scope and returns the sources they asked the server for.
async function sourcesRequested(scope: PaletteScope | undefined): Promise<string[]> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { useFileSearchResults } = await import('../../../../core/command-palette/providers/file-search');
    const { useMailSearchResults } = await import('../../../../core/command-palette/providers/mail-search');

    requested.length = 0;
    function Harness() {
        useFileSearchResults(ctx, 'budget', scope);
        useMailSearchResults(ctx, 'budget', scope);
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness, null)));
    });
    await act(() => root.unmount());
    return requested.sort();
}

describe('the palette search sources honor the scope', () => {
    test('unscoped, files and mail are both searched', async () => {
        expect(await sourcesRequested(undefined)).toEqual(['file', 'mail']);
    });

    test('each source searches under its own scope only', async () => {
        expect(await sourcesRequested('file')).toEqual(['file']);
        expect(await sourcesRequested('mail')).toEqual(['mail']);
    });

    test('the help scope searches neither', async () => {
        expect(await sourcesRequested('help')).toEqual([]);
    });
});
