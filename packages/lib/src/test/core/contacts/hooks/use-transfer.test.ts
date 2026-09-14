// What an import run tells the user. Both import paths (a file from the disk, a file from Drive) report
// their three counts through one copy, so the message is pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { ImportContactsResult } from '@workspace/lib/types/contact';

const OWNER = 'a1b2c3d4';

// react-dom needs a DOM to render the hooks into; the globals are removed again in afterAll so later
// test files see the plain bun environment. Recipe: the use-backup test.
const { Window } = await import('happy-dom');
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

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

// The Eden client, stubbed to the one call the drive-import path makes. Recipe: the use-backup test.
let driveImportResult: ImportContactsResult = { imported: 0, skipped: 0, failed: 0 };
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    contactsApi: () => ({
        'import-from-drive': {
            post: async () => ({ data: driveImportResult, error: null, status: 200 }),
        },
    }),
}));

// The import POSTs a file and reads its three counts back as JSON; the from-url path fetches the file's
// bytes through the same stub first, so the calls are recorded in order.
const realFetch = g.fetch;
const fetchCalls: { url: string; body: BodyInit | null | undefined }[] = [];
let fileImportResult: ImportContactsResult = { imported: 0, skipped: 0, failed: 0 };
g.fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body });
    return new Response(JSON.stringify(fileImportResult), { status: 200 });
};

afterAll(() => {
    g.fetch = realFetch;
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('sonner', () => realSonnerModule);
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

// One React root for every hook that has to be rendered to be observed. Recipe: the use-backup test.
async function renderHook<T>(use: () => T, queryClient: QueryClient): Promise<{ latest: T; unmount: () => void }> {
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
    return { latest: seen.latest as T, unmount: () => root.unmount() };
}

async function importFile(result: ImportContactsResult): Promise<string> {
    const { act } = await import('react');
    const { useImportContacts } = await import('../../../../core/contacts/hooks/use-transfer');
    fileImportResult = result;
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { latest, unmount } = await renderHook(() => useImportContacts(), queryClient);

    await act(async () => {
        await latest.mutateAsync(new File(['BEGIN:VCARD\r\nEND:VCARD\r\n'], 'contacts.vcf'));
    });
    await act(() => unmount());
    return toasts.at(-1) ?? '';
}

describe('useImportContacts', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('a clean run reports the count it imported', async () => {
        expect(await importFile({ imported: 3, skipped: 0, failed: 0 })).toBe('success: Imported 3 contacts');
    });

    test('duplicates are named beside the import count, pluralized on their own count', async () => {
        expect(await importFile({ imported: 0, skipped: 3, failed: 0 })).toBe(
            'success: Imported 0 contacts, skipped 3 duplicates',
        );
    });

    test('one of each reads in the singular throughout', async () => {
        expect(await importFile({ imported: 1, skipped: 1, failed: 1 })).toBe(
            'success: Imported 1 contact, skipped 1 duplicate, 1 unreadable',
        );
    });

    test('a file that yielded nothing at all is an error, not a success with zeroes', async () => {
        expect(await importFile({ imported: 0, skipped: 0, failed: 0 })).toBe('error: No contacts found in this file');
    });

    test('a file whose every card was unreadable says so, not that it held no contacts', async () => {
        expect(await importFile({ imported: 0, skipped: 0, failed: 2 })).toBe('error: 2 contacts could not be read');
        expect(await importFile({ imported: 0, skipped: 0, failed: 1 })).toBe('error: 1 contact could not be read');
    });
});

describe('useImportContactsFromDrive', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('a file picked from Drive reports through the same copy as a file picked from the disk', async () => {
        const { act } = await import('react');
        const { useImportContactsFromDrive } = await import('../../../../core/contacts/hooks/use-transfer');
        driveImportResult = { imported: 1, skipped: 1, failed: 1 };
        const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
        const { latest, unmount } = await renderHook(() => useImportContactsFromDrive(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' });
        });
        await act(() => unmount());

        expect(toasts.at(-1)).toBe('success: Imported 1 contact, skipped 1 duplicate, 1 unreadable');
    });
});

describe('useImportContactsFromUrl', () => {
    test('a subject with no Drive path behind it posts the bytes it fetched, named after the subject', async () => {
        const { act } = await import('react');
        const { useImportContactsFromUrl } = await import('../../../../core/contacts/hooks/use-transfer');
        toasts.length = 0;
        fetchCalls.length = 0;
        fileImportResult = { imported: 2, skipped: 0, failed: 0 };
        const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
        const { latest, unmount } = await renderHook(() => useImportContactsFromUrl(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ url: '/mail/owner/message/m1/attachment/0' });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported 2 contacts');
    });
});
