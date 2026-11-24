// A month day with more events than fit shows "N more", which opens a list of all of them instead of New event, and an
// event picked from that list opens its detail as a click in the day does.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const created = new Date('2026-10-01T00:00:00Z');
const work: CalendarItem = {
    id: 'work',
    name: 'Work',
    color: '#3b82f6',
    isDefault: true,
    visible: true,
    ctag: 1,
    shares: null,
    createdAt: created,
    updatedAt: created,
};
const titles = ['Standup', 'Dentist', 'Lunch', 'Review', 'Drinks'];
const events: CalendarEventOccurrence[] = titles.map((title, i) => ({
    id: `e${i}`,
    calendarId: 'work',
    uid: `e${i}@eigen`,
    uri: `e${i}.ics`,
    title,
    description: null,
    location: null,
    startTime: new Date(2026, 9, 9, 9 + i, 0),
    endTime: new Date(2026, 9, 9, 9 + i, 30),
    allDay: false,
    rrule: null,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: '1',
    data: null,
    createByUserId: 'u1',
    createdAt: created,
    updatedAt: created,
    occurrenceDate: '2026-10-09',
}));
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// Stable across renders, as React Query's results are, or the dialogs' effects would rerun on every render.
const calendars = { data: [work] };
const sharedCalendars = { data: [] };
const noMaster = { data: undefined };
const idle = { mutate: () => {}, mutateAsync: async () => {}, isPending: false };
const notExporting = { exportCalendar: async () => {}, isExporting: false };
const notFromOthers = () => false;
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useCalendars: () => calendars,
    useSharedCalendars: () => sharedCalendars,
    useUpdateEvent: () => idle,
    useCreateEvent: () => idle,
    useDeleteEvent: () => idle,
    useMoveEvent: () => idle,
    useRsvp: () => idle,
    useExportCalendar: () => notExporting,
    useEvent: () => noMaster,
    useIsInvitationFromOthers: () => notFromOthers,
}));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/calendar', () => realCalendar);
    mock.module('@workspace/lib/contacts', () => realContacts);
});

const { act, createElement } = await import('react');
const { MonthView } = await import('../../components/month-view');

const onDayClick = mock((_date: Date) => {});
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    onDayClick.mockClear();
});

async function openMore() {
    ({ unmount } = await renderInDocument(
        createElement(MonthView, { currentDate: new Date(2026, 9, 1), events, calendars: [work], onDayClick }),
    ));
    await act(async () => {
        const more = [...document.querySelectorAll<HTMLElement>('body *')].find(
            (element) => element.childElementCount === 0 && element.textContent === '1 more',
        );
        if (!more) throw new Error('the day shows no 1 more');
        more.click();
    });
}

const popover = () => document.querySelector('[data-slot="popover-content"]');

test('N more lists all the events of the day and creates no event', async () => {
    await openMore();
    expect(onDayClick).not.toHaveBeenCalled();
    const listed = [...(popover()?.querySelectorAll('[title]') ?? [])].map((chip) => chip.getAttribute('title'));
    expect(listed).toEqual(titles);
});

test('an event picked from the list opens its detail and closes the list', async () => {
    await openMore();
    await act(async () => {
        popover()?.querySelector<HTMLElement>('[title="Drinks"]')?.click();
    });
    expect(onDayClick).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Drinks');
});
