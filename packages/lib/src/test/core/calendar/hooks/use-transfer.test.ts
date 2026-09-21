// What an .ics transfer tells the user, and which caches it revives. One mutation takes both identities (a
// Drive path the server copies, bytes the browser fetched) and lands a file of events in one calendar of one
// home, so the counted copy, the home it names and the invalidation are pinned here rather than in each
// caller. The export half is pinned by the body it posts, which is what decides how much of a home leaves it.
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
const TEAM = 'team_t1';

// The Eden client, stubbed to the one call the drive-import path makes.
let driveImportResult: ImportCountsResult = { imported: 2, skipped: 1, failed: 0 };
const driveImportBodies: unknown[] = [];
const driveImportOwners: string[] = [];
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: ({ ownerId }: { ownerId: string }) => ({
        'import-from-drive': {
            post: async (body: unknown) => {
                driveImportOwners.push(ownerId);
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
        driveImportOwners.length = 0;
        served.importResponse = { imported: 1, skipped: 0, failed: 0 };
    });

    test('a file picked from Drive names its target calendar and reports the counts', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

        await act(async () => {
            await latest.mutateAsync({
                ownerId: OWNER,
                calendarId: CALENDAR,
                drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' },
            });
        });
        await act(() => unmount());

        expect(driveImportOwners).toEqual([OWNER]);
        expect(driveImportBodies[0]).toEqual({
            calendarId: CALENDAR,
            sourceOwnerId: OWNER,
            sourceMountId: 'm1',
            sourcePathId: 'p1',
        });
        expect(toasts.at(-1)).toBe('success: Imported 2 events, skipped 1 duplicate');
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
    });

    test('a team calendar takes the file into the team home, and that is the home that goes stale', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

        await act(async () => {
            await latest.mutateAsync({
                ownerId: TEAM,
                calendarId: CALENDAR,
                drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' },
            });
        });
        await act(() => unmount());

        expect(driveImportOwners).toEqual([TEAM]);
        expect(hasKey(invalidated, calendarKeys.events(TEAM))).toBe(true);
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(false);
    });

    test('a file that held nothing this calendar could take says so', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);

        driveImportResult = { imported: 0, skipped: 0, failed: 3 };
        await act(async () => {
            await latest.mutateAsync({
                ownerId: OWNER,
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
            await latest.mutateAsync({
                ownerId: OWNER,
                url: '/mail/owner/message/m1/attachment/0',
                calendarId: CALENDAR,
            });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.url).toContain(`/calendar/${OWNER}/import?calendarId=${CALENDAR}`);
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported 1 event');
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
    });
});

describe('useExportCalendar', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
    });

    test('a whole calendar is asked for by name, with no selection beside it', async () => {
        const { act } = await import('react');
        const { useExportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useExportCalendar(), queryClient);

        await act(async () => {
            await latest.exportCalendar(OWNER, CALENDAR);
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toEndWith(`/calendar/${OWNER}/export`);
        expect(JSON.parse(String(fetchCalls[0]!.body))).toEqual({ calendarId: CALENDAR });
        expect(toasts).toEqual([]);
    });

    test('one event rides as a selection inside its calendar, and a team home is asked as itself', async () => {
        const { act } = await import('react');
        const { useExportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useExportCalendar(), queryClient);

        await act(async () => {
            await latest.exportCalendar(TEAM, CALENDAR, ['event-1']);
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toEndWith(`/calendar/${TEAM}/export`);
        expect(JSON.parse(String(fetchCalls[0]!.body))).toEqual({ calendarId: CALENDAR, ids: ['event-1'] });
    });
});
