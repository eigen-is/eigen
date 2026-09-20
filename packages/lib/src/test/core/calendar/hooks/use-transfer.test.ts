// What an .ics import tells the user, and which caches it revives. Both import paths (bytes the browser
// fetched, a file picked from Drive) land a file of events in one calendar, so the counted copy and the
// invalidation are pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { calendarKeys } from '../../../../core/calendar/hooks/keys';
import { installHappyDom } from '../../../happy-dom';

const OWNER = 'a1b2c3d4';
const CALENDAR = 'cal-1';

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

// The Eden client, stubbed to the one call the drive-import path makes. Recipe: the mail transfer test.
let driveImportResult: ImportCountsResult = { imported: 2, skipped: 1, failed: 0 };
const driveImportBodies: unknown[] = [];
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: () => ({
        'import-from-drive': {
            post: async (body: unknown) => {
                driveImportBodies.push(body);
                return { data: driveImportResult, error: null, status: 200 };
            },
        },
    }),
}));

// The import POSTs the raw file and reads the counts back as JSON; the from-url path fetches the bytes
// through the same stub first, so the calls are recorded in order.
const realFetch = g.fetch;
const fetchCalls: { url: string; body: BodyInit | null | undefined }[] = [];
g.fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body });
    return new Response(JSON.stringify({ imported: 1, skipped: 0, failed: 0 }), { status: 200 });
};

afterAll(() => {
    g.fetch = realFetch;
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('sonner', () => realSonnerModule);
});

// Records every queryKey invalidated, so the test can assert the event ranges refresh.
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

// One React root for every hook that has to be rendered to be observed. Recipe: the mail transfer test.
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

describe('useImportCalendarFromDrive', () => {
    beforeEach(() => {
        toasts.length = 0;
        driveImportBodies.length = 0;
    });

    test('a file picked from Drive names its target calendar and reports the counts', async () => {
        const { act } = await import('react');
        const { useImportCalendarFromDrive } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendarFromDrive(), queryClient);

        await act(async () => {
            await latest.mutateAsync({
                calendarId: CALENDAR,
                sourceOwnerId: OWNER,
                sourceMountId: 'm1',
                sourcePathId: 'p1',
            });
        });
        await act(() => unmount());

        expect(driveImportBodies[0]).toEqual({
            calendarId: CALENDAR,
            sourceOwnerId: OWNER,
            sourceMountId: 'm1',
            sourcePathId: 'p1',
        });
        expect(toasts.at(-1)).toBe('success: Imported 2 events, skipped 1 duplicate');
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
    });

    test('a file that held nothing this calendar could take says so', async () => {
        const { act } = await import('react');
        const { useImportCalendarFromDrive } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendarFromDrive(), queryClient);

        driveImportResult = { imported: 0, skipped: 0, failed: 3 };
        await act(async () => {
            await latest.mutateAsync({
                calendarId: CALENDAR,
                sourceOwnerId: OWNER,
                sourceMountId: 'm1',
                sourcePathId: 'p1',
            });
        });
        await act(() => unmount());
        driveImportResult = { imported: 2, skipped: 1, failed: 0 };

        expect(toasts.at(-1)).toBe('error: 3 events could not be read');
    });
});

describe('useImportCalendarFromUrl', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
    });

    test('a part with no Drive path behind it posts the bytes it fetched to the chosen calendar', async () => {
        const { act } = await import('react');
        const { useImportCalendarFromUrl } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendarFromUrl(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ url: '/mail/owner/message/m1/attachment/0', calendarId: CALENDAR });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.url).toContain(`/calendar/${OWNER}/import?calendarId=${CALENDAR}`);
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported 1 event');
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
    });
});
