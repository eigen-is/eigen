// What an .ics import tells the user, and which caches it revives. One mutation takes both identities (a
// Drive path the server copies, bytes the browser fetched) and lands a file of events in one calendar, so
// the counted copy and the invalidation are pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { calendarKeys } from '../../../../core/calendar/hooks/keys';
import {
    fetchCalls,
    hasKey,
    installTransferHarness,
    OWNER,
    renderHook,
    served,
    toasts,
    trackingClient,
} from '../../../transfer-harness';

installTransferHarness();

const CALENDAR = 'cal-1';

// The Eden client, stubbed to the one call the drive-import path makes.
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

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

describe('useImportCalendar', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
        driveImportBodies.length = 0;
        served.importResponse = { imported: 1, skipped: 0, failed: 0 };
    });

    test('a file picked from Drive names its target calendar and reports the counts', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

        await act(async () => {
            await latest.mutateAsync({
                calendarId: CALENDAR,
                drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' },
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
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

        driveImportResult = { imported: 0, skipped: 0, failed: 3 };
        await act(async () => {
            await latest.mutateAsync({
                calendarId: CALENDAR,
                drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' },
            });
        });
        await act(() => unmount());
        driveImportResult = { imported: 2, skipped: 1, failed: 0 };

        expect(toasts.at(-1)).toBe('error: 3 events could not be read');
    });

    test('a part with no Drive path behind it posts the bytes it fetched to the chosen calendar', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

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
