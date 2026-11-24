// A drag moves an event only where its save would go through as the organizer's: not a free/busy block, not a
// calendar the viewer can only read, and not somebody else's invitation, judged against the address of the event's own
// calendar owner. A shared calendar's owner is judged once their address arrives, and a team's by Eigen's stamp.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CalendarEventOccurrence, CalendarItem, EventData, SharedCalendar } from '@workspace/lib/types/calendar';
import { publicUserKeys } from '../../../../core/public/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const VIEWER = 'v1ewer0000000000000000000000000a';
const OWNER = '0wner00000000000000000000000000b';
const TEAM = 'team_7eam000000000000000000000000000c';

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

const { useCanReschedule } = await import('../../../../core/calendar/hooks/use-can-reschedule');

const at = new Date(0);
const own: CalendarItem = {
    id: 'mine',
    name: 'Mine',
    color: '#3b82f6',
    isDefault: true,
    visible: true,
    ctag: 1,
    shares: null,
    createdAt: at,
    updatedAt: at,
};
const sharedCalendar = (calendarId: string, ownerUserId: string, permission: SharedCalendar['permission']) => ({
    id: `share-${calendarId}`,
    ownerUserId,
    calendarId,
    calendarName: calendarId,
    calendarColor: '#000000',
    permission,
    color: null,
    visible: true,
    createdAt: at,
    updatedAt: at,
});
const shared: SharedCalendar[] = [
    sharedCalendar('their', OWNER, 'write'),
    sharedCalendar('readable', OWNER, 'read'),
    sharedCalendar('busy', OWNER, 'free-busy'),
    sharedCalendar('team', TEAM, 'write'),
];
const event = (calendarId: string, data: EventData | null = null, id = 'e1'): CalendarEventOccurrence => ({
    id,
    calendarId,
    uid: `${id}@eigen`,
    uri: `${id}.ics`,
    title: 'Review',
    description: null,
    location: null,
    startTime: new Date('2026-10-13T14:00:00Z'),
    endTime: new Date('2026-10-13T15:00:00Z'),
    allDay: false,
    rrule: null,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'v1',
    data,
    createByUserId: VIEWER,
    createdAt: at,
    updatedAt: at,
    occurrenceDate: '2026-10-13',
});
const organizedBy = (email: string, organizerEventId?: string): EventData => ({
    organizer: { email },
    attendees: [{ email: 'guest@else.test', status: 'pending', role: 'required' }],
    organizerEventId,
});

async function canReschedule(queryClient = new QueryClient()) {
    const { latest, unmount } = await renderHook(() => useCanReschedule([own], shared), queryClient);
    await unmount();
    return latest;
}

describe('useCanReschedule', () => {
    test("the viewer's own event moves, and an invitation from someone else does not", async () => {
        const can = await canReschedule();
        expect(can(event('mine'))).toBe(true);
        expect(can(event('mine', organizedBy('Viewer@eigen.test')))).toBe(true);
        expect(can(event('mine', organizedBy('boss@else.test')))).toBe(false);
    });

    test('a free/busy block and a calendar the viewer can only read do not move', async () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(publicUserKeys.detail(OWNER), { email: 'owner@eigen.test' });
        const can = await canReschedule(queryClient);
        expect(can(event('busy', null, ''))).toBe(false);
        expect(can(event('readable'))).toBe(false);
        expect(can(event('unknown'))).toBe(false);
    });

    test("a shared calendar's event waits for its owner's address, which tells their own event from an invitation", async () => {
        expect((await canReschedule())(event('their', organizedBy('owner@eigen.test')))).toBe(false);
        const queryClient = new QueryClient();
        queryClient.setQueryData(publicUserKeys.detail(OWNER), { email: 'owner@eigen.test' });
        const can = await canReschedule(queryClient);
        expect(can(event('their'))).toBe(true);
        expect(can(event('their', organizedBy('Owner@eigen.test')))).toBe(true);
        expect(can(event('their', organizedBy('viewer@eigen.test')))).toBe(false);
    });

    test("a team calendar's event is an invitation only when Eigen's organizer stamp says so", async () => {
        const can = await canReschedule();
        expect(can(event('team', organizedBy('member@eigen.test')))).toBe(true);
        expect(can(event('team', organizedBy('member@else.test', 'org-event')))).toBe(false);
    });
});
