// What an .ics transfer tells the user, and which caches it revives. One mutation takes both identities (a
// Drive path the server copies, bytes the browser fetched) and lands a file of events in one calendar of one
// home, so the counted copy, the home it names and the invalidation are pinned here rather than in each
// caller. The export half is pinned by the body it posts, which is what decides how much of a home leaves it.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { calendarKeys } from '../../../../core/calendar/hooks/keys';
import { renderHook } from '../../../render-hook';
import {
    fetchCalls,
    hasKey,
    installTransferHarness,
    OWNER,
    served,
    toasts,
    trackingClient,
} from '../../../transfer-harness';

installTransferHarness();

const CALENDAR = 'cal-1';
// Homes are parsed, so a team id reads like the real thing: a 32-character id behind `team_`.
const TEAM = `team_${'t1'.padEnd(32, '0')}`;

// The Eden client, stubbed to the one call the drive-import path makes.
let driveImportResult: ImportCountsResult = { imported: 2, skipped: 1, failed: 0 };
const driveImportBodies: unknown[] = [];
const driveImportOwners: string[] = [];
// The calendars a picker makes and unmakes on its way to the import.
const created: { ownerId: string; name: string }[] = [];
const deleted: string[] = [];
let failNextDriveImport = false;
let failNextDelete = false;

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
                    if (failNextDelete) {
                        failNextDelete = false;
                        return { data: null, error: { value: 'delete failed' }, status: 500 };
                    }
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
        await unmount();

        expect(driveImportOwners).toEqual([OWNER]);
        expect(driveImportBodies[0]).toEqual({
            calendarId: CALENDAR,
            sourceOwnerId: OWNER,
            sourceMountId: 'm1',
            sourcePathId: 'p1',
        });
        expect(toasts.at(-1)).toBe('success: Imported 2 events. 1 was already in your calendars.');
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
    });

    // A UID any calendar of the home holds is skipped, so the toast says where the skipped events already are.
    test('the skipped events are named as already in the home’s calendars, after the other counts', async () => {
        const { act } = await import('react');
        const { useImportCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportCalendar(), queryClient);
        const importInto = (ownerId: string) =>
            act(async () => {
                await latest.mutateAsync({
                    ownerId,
                    calendarId: CALENDAR,
                    drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' },
                });
            });

        driveImportResult = { imported: 0, skipped: 2, failed: 0 };
        await importInto(OWNER);
        expect(toasts.at(-1)).toBe('success: Imported 0 events. 2 were already in your calendars.');

        await importInto(TEAM);
        expect(toasts.at(-1)).toBe('success: Imported 0 events. 2 were already in this team’s calendars.');

        driveImportResult = { imported: 3, skipped: 1, failed: 1 };
        await importInto(OWNER);
        await unmount();
        driveImportResult = { imported: 2, skipped: 1, failed: 0 };

        expect(toasts.at(-1)).toBe('success: Imported 3 events, 1 unreadable. 1 was already in your calendars.');
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
        await unmount();

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
        await unmount();
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
        await unmount();

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
        await unmount();

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
        await unmount();

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
        await unmount();

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(deleted).toEqual(['cal-1']);
    });

    test('a new calendar whose import fails goes again, so a retry under another name makes that one', async () => {
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
        expect(deleted).toEqual(['cal-1']);

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Market season', color: '#34a853' });
        });
        await unmount();

        expect(created).toEqual([
            { ownerId: OWNER, name: 'Autumn market' },
            { ownerId: OWNER, name: 'Market season' },
        ]);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: 'cal-2' })]);
        expect(deleted).toEqual(['cal-1']);
    });

    test('a retry into a calendar that exists after a failed new one imports there and makes nothing', async () => {
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
        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: OWNER, calendarId: CALENDAR });
        });
        await unmount();

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(deleted).toEqual(['cal-1']);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: CALENDAR })]);
    });

    test('when the failed import’s calendar will not go either, the caller gets the import’s error and a retry fills it', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);

        failNextDriveImport = true;
        failNextDelete = true;
        await act(async () => {
            await expect(
                latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' }),
            ).rejects.toThrow('import failed');
        });
        expect(failNextDelete).toBe(false);
        expect(deleted).toEqual([]);

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' });
        });
        await unmount();

        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: 'cal-1' })]);
        expect(deleted).toEqual([]);
    });

    // An import that failed into a new calendar whose delete failed too, which leaves that calendar behind as cal-1.
    const HOLIDAY = { kind: 'new', name: 'Holiday', color: '#34a853' } as const;
    // CALENDAR is the id the stub hands the first calendar it makes, so a calendar that exists needs another.
    const EXISTING = 'cal-work';
    async function leaveACalendarBehind() {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const rendered = await renderHook(() => useImportToCalendar(OWNER), queryClient);
        failNextDriveImport = true;
        failNextDelete = true;
        await act(async () => {
            await expect(rendered.latest.importToCalendar(DRIVE_SOURCE, HOLIDAY)).rejects.toThrow('import failed');
        });
        expect(deleted).toEqual([]);
        return { act, ...rendered };
    }

    test('a retry under another name deletes the calendar left behind and makes the one it asks for', async () => {
        const { act, latest, unmount } = await leaveACalendarBehind();

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Work', color: '#34a853' });
        });
        await unmount();

        expect(deleted).toEqual(['cal-1']);
        expect(created.map((calendar) => calendar.name)).toEqual(['Holiday', 'Work']);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: 'cal-2' })]);
    });

    test('a retry under the same name in another color does not fill the calendar left behind', async () => {
        const { act, latest, unmount } = await leaveACalendarBehind();

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { ...HOLIDAY, color: '#4285f4' });
        });
        await unmount();

        expect(deleted).toEqual(['cal-1']);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: 'cal-2' })]);
    });

    test('a retry into a calendar that exists deletes the calendar left behind', async () => {
        const { act, latest, unmount } = await leaveACalendarBehind();

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: OWNER, calendarId: EXISTING });
        });
        await unmount();

        expect(deleted).toEqual(['cal-1']);
        expect(created.map((calendar) => calendar.name)).toEqual(['Holiday']);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: EXISTING })]);
    });

    // The calendar left behind shows in the picker's list like any other.
    test('a retry that picks the calendar left behind as an existing one keeps it and imports there', async () => {
        const { act, latest, unmount } = await leaveACalendarBehind();

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: OWNER, calendarId: 'cal-1' });
        });
        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: OWNER, calendarId: EXISTING });
        });
        await unmount();

        expect(deleted).toEqual([]);
        expect(driveImportBodies).toEqual([
            expect.objectContaining({ calendarId: 'cal-1' }),
            expect.objectContaining({ calendarId: EXISTING }),
        ]);
    });

    test('when the calendar left behind will not go on a retry either, the import goes on and the next try deletes it', async () => {
        const { act, latest, unmount } = await leaveACalendarBehind();

        failNextDelete = true;
        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Work', color: '#34a853' });
        });
        expect(deleted).toEqual([]);
        expect(driveImportBodies).toEqual([expect.objectContaining({ calendarId: 'cal-2' })]);

        await act(async () => {
            await latest.importToCalendar(DRIVE_SOURCE, { kind: 'existing', ownerId: OWNER, calendarId: EXISTING });
        });
        await unmount();

        expect(deleted).toEqual(['cal-1']);
        expect(driveImportBodies.at(-1)).toMatchObject({ calendarId: EXISTING });
    });

    test('when a new calendar nothing landed in will not go, a retry fills it, and once it goes the next makes one', async () => {
        const { act } = await import('react');
        const { useImportToCalendar } = await import('../../../../core/calendar/hooks/use-transfer');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportToCalendar(OWNER), queryClient);
        const tryNew = () =>
            act(async () => {
                await latest
                    .importToCalendar(DRIVE_SOURCE, { kind: 'new', name: 'Autumn market', color: '#34a853' })
                    .catch(() => {});
            });

        driveImportResult = { imported: 0, skipped: 4, failed: 0 };
        failNextDelete = true;
        await tryNew();
        expect(deleted).toEqual([]);

        await tryNew();
        expect(created).toEqual([{ ownerId: OWNER, name: 'Autumn market' }]);
        expect(deleted).toEqual(['cal-1']);

        await tryNew();
        await unmount();
        expect(created.map((calendar) => calendar.name)).toEqual(['Autumn market', 'Autumn market']);
        expect(driveImportBodies).toEqual([
            expect.objectContaining({ calendarId: 'cal-1' }),
            expect.objectContaining({ calendarId: 'cal-1' }),
            expect.objectContaining({ calendarId: 'cal-2' }),
        ]);
    });
});

describe('isTransferableCalendarHome', () => {
    const MATE = 'ada'.padEnd(32, '0');

    test('the viewer’s own home and a team’s take a file; another user’s shared calendar does not', async () => {
        const { isTransferableCalendarHome } = await import('../../../../core/calendar/hooks/use-transfer');
        expect(isTransferableCalendarHome(OWNER, OWNER)).toBe(true);
        expect(isTransferableCalendarHome(TEAM, OWNER)).toBe(true);
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
        await unmount();

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
        await unmount();

        expect(fetchCalls[0]!.url).toEndWith(`/calendar/${TEAM}/export`);
        expect(JSON.parse(String(fetchCalls[0]!.body))).toEqual({ calendarId: CALENDAR, ids: ['event-1'] });
    });
});
