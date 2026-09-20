// What an .eml import tells the user, and which caches it revives. Both import paths (bytes the browser
// fetched, a file picked from Drive) land one message in the inbox, so the copy and the invalidation are
// pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { ImportMailResult } from '@workspace/lib/types/mail';
import { emailKeys, mailboxKeys } from '../../../../core/mail/hooks/keys';
import { installHappyDom } from '../../../happy-dom';

const OWNER = 'a1b2c3d4';

// react-dom needs a DOM to render the hooks into.
installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The hooks read the signed-in user from the auth context; there is no provider here.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: OWNER } }),
}));

// The toasts are this file's subject, so sonner is swapped for a recorder. Restored in afterAll.
const toasts: string[] = [];
const realSonnerModule = await import('sonner');
mock.module('sonner', () => ({
    toast: {
        success: (message: string) => toasts.push(`success: ${message}`),
        error: (message: string) => toasts.push(`error: ${message}`),
    },
}));

// The Eden client, stubbed to the one call the drive-import path makes. Recipe: the contacts transfer test.
const driveImportResult: ImportMailResult = { id: 'imported-1' };
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    mailApi: () => ({
        'import-from-drive': {
            post: async () => ({ data: driveImportResult, error: null, status: 200 }),
        },
    }),
}));

// The import POSTs the raw message and reads its id back as JSON; the from-url path fetches the bytes
// through the same stub first, so the calls are recorded in order.
const realFetch = g.fetch;
const fetchCalls: { url: string; body: BodyInit | null | undefined }[] = [];
g.fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body });
    return new Response(JSON.stringify({ id: 'imported-2' }), { status: 200 });
};

afterAll(() => {
    g.fetch = realFetch;
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('sonner', () => realSonnerModule);
});

// Records every queryKey invalidated, so the test can assert the inbox list and the counts both refresh.
function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    }) as typeof queryClient.invalidateQueries;
    return { queryClient, invalidated };
}

function hasKey(keys: readonly unknown[][], expected: readonly unknown[]): boolean {
    return keys.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

// One React root for every hook that has to be rendered to be observed. Recipe: the contacts transfer test.
async function renderHook<T>(use: () => T, queryClient: QueryClient): Promise<{ latest: T; unmount: () => void }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    return { latest: seen.latest as T, unmount: () => root.unmount() };
}

describe('useImportMailFromDrive', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('a file picked from Drive lands in the inbox and refreshes the list and the counts', async () => {
        const { act } = await import('react');
        const { useImportMailFromDrive } = await import('../../../../core/mail/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportMailFromDrive(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' });
        });
        await act(() => unmount());

        expect(toasts.at(-1)).toBe('success: Imported to your inbox');
        expect(hasKey(invalidated, emailKeys.list(OWNER, ''))).toBe(true);
        expect(hasKey(invalidated, mailboxKeys.lists(OWNER))).toBe(true);
    });
});

describe('useImportMailFromUrl', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
    });

    test('a part with no Drive path behind it posts the bytes it fetched', async () => {
        const { act } = await import('react');
        const { useImportMailFromUrl } = await import('../../../../core/mail/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportMailFromUrl(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ url: '/mail/owner/message/m1/attachment/0' });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported to your inbox');
        expect(hasKey(invalidated, emailKeys.list(OWNER, ''))).toBe(true);
    });
});
