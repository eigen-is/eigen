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
// The calendars a picker makes and unmakes on its way to the import.
const created: { ownerId: string; name: string }[] = [];
const deleted: string[] = [];
let failNextDriveImport = false;

const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: ({ ownerId }: { ownerId: string }) => ({
        'import-from-drive': {
            post: async (body: unknown) => {
                if (failNextDriveImport) {
                    failNextDriveImport = false;
                    return { data: null, error: { value: 'import failed' }, status: 500 };
                }
                driveImportOwners.push(ownerId);
                driveImportBodies.push(body);
                return { data: driveImportResult, error: null, status: 200 };
            },
        },
        calendars: Object.assign(
            ({ calId }: { calId: string }) => ({
                delete: async () => {
                    deleted.push(calId);
                    return { data: { success: true }, error: null, status: 200 };
                },
            }),
            {
                post: async ({ name }: { name: string }) => {
                    created.push({ ownerId, name });
                    return { data: { id: `cal-${created.length}` }, error: null, status: 200 };
                },
            },
        ),
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

describe('useImportToCalendar', () => {
    const DRIVE_SOURCE = { drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' } };

    beforeEach(() => {
        toasts.length = 0;
        created.length = 0;
        deleted.length = 0;
        driveImportBodies.length = 0;
        driveImportOwners.length = 0;
        driveImportResult = { imported: 2, skipped: 1, failed: 0 };
    });

    test('a calendar that exists takes the file in its own home, and nothing is made or unmade', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: TEAM, calendarId: CALENDAR });
        });
        await act(() => unmount());

        expect(created).toEqual([]);
        expect(deleted).toEqual([]);
        expect(driveImportOwners).toEqual([TEAM]);
    });

    test('a new calendar is made in the viewer’s own home before the file lands in it', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' });
        });
        await act(() => unmount());

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(driveImportOwners).toEqual([OWNER]);
        expect(driveImportBodies[0]).toMatchObject({ calendarId: 'cal-1' });
        expect(deleted).toEqual([]);
    });

    test('a new calendar nothing landed in goes again', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);

        driveImportResult = { imported: 0, skipped: 4, failed: 0 };
        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' });
        });
        await act(() => unmount());

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(deleted).toEqual(['cal-1']);
    });

    test('a retry after a failed import reuses the calendar the first attempt made', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);

        failNextDriveImport = true;
        await act(async () => {
            await expect(
                latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' }),
            ).rejects.toThrow('import failed');
        });

        driveImportResult = { imported: 2, skipped: 0, failed: 0 };
        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' });
        });
        await act(() => unmount());

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(driveImportBodies.map((body) => (body as { calendarId: string }).calendarId)).toEqual(['cal-1']);
        expect(deleted).toEqual([]);
    });
});

describe('isTransferableCalendarHome', () => {
    // Homes are parsed, so these read like the real thing: a 32-character id, a team one behind `team_`.
    const REAL_TEAM = `team_${'t1'.padEnd(32, '0')}`;
    const MATE = 'ada'.padEnd(32, '0');

    test('the viewer’s own home and a team’s take a file; another user’s shared calendar does not', async () => {
        const { isTransferableCalendarHome } = await import('../../../../core/calendar/hooks/use-transfer');
        expect(isTransferableCalendarHome(OWNER, OWNER)).toBe(true);
        expect(isTransferableCalendarHome(REAL_TEAM, OWNER)).toBe(true);
        expect(isTransferableCalendarHome(MATE, OWNER)).toBe(false);
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
