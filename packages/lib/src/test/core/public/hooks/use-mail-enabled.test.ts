// The one read of the server's hosted-mail flag. Every Mail entry point hangs off it, so the
// optimistic default (mail is on until the config lands) is pinned here.
import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { publicKeys } from '../../../../core/public/hooks/keys';
import { useMailEnabled } from '../../../../core/public/hooks/use-public';

// react-dom needs a DOM to render the hook into; the globals are removed again in afterAll so later
// test files see the plain bun environment. Recipe: the use-backup test.
const { Window } = await import('happy-dom');
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe('useMailEnabled', () => {
    test('assumes mail is on until the server config lands', async () => {
        const { latest, unmount } = await renderHook(() => useMailEnabled(), new QueryClient());
        expect(latest).toBe(true);
        await unmount();
    });

    test('follows the mailEnabled flag the server reports', async () => {
        for (const mailEnabled of [true, false]) {
            const queryClient = new QueryClient();
            queryClient.setQueryData(publicKeys.config, { mailEnabled });
            const { latest, unmount } = await renderHook(() => useMailEnabled(), queryClient);
            expect(latest).toBe(mailEnabled);
            await unmount();
        }
    });
});

// One React root for every hook that has to be rendered to be observed.
async function renderHook<T>(
    use: () => T,
    queryClient: QueryClient,
): Promise<{ latest: T; unmount: () => Promise<void> }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const container = window.document.createElement('div');
    const root = createRoot(container as unknown as Element);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    // Unmount inside act too: React's scheduler would otherwise run the teardown after the test,
    // when the DOM globals are already gone.
    const unmount = async () => {
        await act(async () => {
            root.unmount();
        });
    };
    return { latest: seen.latest as T, unmount };
}
