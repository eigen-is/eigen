// Both calendar dialogs lock an invitation's details through useIsInvitationFromOthers, so what it answers
// while the owner's address is still on its way is pinned here. So is the occurrence date the read hooks hand out, from
// a real response through the real reviving treaty.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CalendarEventOccurrence, EventData, SharedCalendar } from '@workspace/lib/types/calendar';
import { publicUserKeys } from '../../../../core/public/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

// react-dom needs a DOM to render the hook into.
installHappyDom();

const VIEWER = 'v1ewer0000000000000000000000000a';
const OWNER = '0wner00000000000000000000000000b';

// No provider here: the viewer comes from a stub, and an owner's address never arrives unless a test seeds it.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
const realUserBatcherModule = await import('../../../../core/public/user-batcher');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: VIEWER, email: 'viewer@eigen.test' } }),
}));
mock.module('../../../../core/public/user-batcher', () => ({ fetchPublicUser: () => new Promise(() => {}) }));

afterAll(() => {
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('../../../../core/public/user-batcher', () => realUserBatcherModule);
});

const { act } = await import('react');
const { useAllSharedCalendarEvents, useEvents, useIsInvitationFromOthers } = await import(
    '../../../../core/calendar/hooks/use-calendar'
);

const organizedBy = (email: string): { data: EventData } => ({ data: { organizer: { email } } });

describe('useIsInvitationFromOthers', () => {
    test("a shared calendar's event counts as an invitation until its owner's address arrives", async () => {
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(OWNER), new QueryClient());
        expect(latest(organizedBy('owner@eigen.test'))).toBe(true);
        await unmount();
    });

    test("the owner's address tells their own event from an invitation", async () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(publicUserKeys.detail(OWNER), { email: 'owner@eigen.test' });
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(OWNER), queryClient);
        expect(latest(organizedBy('Owner@eigen.test'))).toBe(false);
        expect(latest(organizedBy('someone@else.test'))).toBe(true);
        await unmount();
    });

    test("the viewer's own calendar compares with the viewer's address", async () => {
        const { latest, unmount } = await renderHook(() => useIsInvitationFromOthers(VIEWER), new QueryClient());
        expect(latest(organizedBy('viewer@eigen.test'))).toBe(false);
        expect(latest(organizedBy('someone@else.test'))).toBe(true);
        await unmount();
    });
});

// A zone behind UTC, where a day read off a revived UTC midnight with local getters comes out one early.
describe('the occurrence date a read hook hands out', () => {
    const originalTz = process.env.TZ;
    beforeEach(() => {
        process.env.TZ = 'America/Los_Angeles';
    });
    afterEach(() => {
        process.env.TZ = originalTz ?? 'UTC';
        mock.restore();
    });

    const shared: SharedCalendar = {
        id: 'share1',
        ownerUserId: OWNER,
        calendarId: 'team',
        calendarName: 'Team',
        calendarColor: '#000000',
        permission: 'read',
        color: null,
        visible: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };

    async function firstOccurrence(
        day: string,
        use: () => { data?: readonly CalendarEventOccurrence[] },
    ): Promise<CalendarEventOccurrence | undefined> {
        spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json([{ id: 's1', etag: 'v1', startTime: '2026-10-09T14:00:00.000Z', occurrenceDate: day }]),
        );
        let first: CalendarEventOccurrence | undefined;
        const { unmount } = await renderHook(() => {
            first = use().data?.[0];
        }, new QueryClient());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
        await unmount();
        return first;
    }

    // The reviver takes a year of 19xx or 20xx and leaves any other as it came, so the hooks answer both alike.
    for (const day of ['2026-10-09', '2100-01-01', '0500-03-07']) {
        test(`the owner's own range keeps ${day} as written`, async () => {
            const event = await firstOccurrence(day, () => useEvents(OWNER, 1, 2));
            expect(event?.occurrenceDate).toBe(day);
        });

        test(`a shared calendar's range keeps ${day} as written`, async () => {
            const event = await firstOccurrence(day, () => useAllSharedCalendarEvents([shared], 1, 2));
            expect(event?.occurrenceDate).toBe(day);
        });
    }

    test('the rest of the occurrence stays revived', async () => {
        const event = await firstOccurrence('2026-10-09', () => useEvents(OWNER, 1, 2));
        expect(event?.startTime).toEqual(new Date('2026-10-09T14:00:00.000Z'));
    });
});
