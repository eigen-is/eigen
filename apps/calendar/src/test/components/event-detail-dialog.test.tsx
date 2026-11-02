// The event detail panel's icon buttons carry their names, so a screen reader can find Edit event and Delete event,
// and each opens its dialog.
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
const dentist: CalendarEventOccurrence = {
    id: 'e1',
    calendarId: 'work',
    uid: 'e1@eigen',
    uri: 'e1.ics',
    title: 'Dentist',
    description: null,
    location: null,
    startTime: new Date(2026, 9, 9, 14, 0),
    endTime: new Date(2026, 9, 9, 14, 30),
    allDay: false,
    rrule: null,
    timezone: 'Europe/Amsterdam',
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
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// Stable across renders, as React Query's results are, or the dialogs' effects would rerun on every render.
const calendars = { data: [work] };
const sharedCalendars = { data: [] };
const noMaster = { data: undefined };
const idle = {
    mutate: mock((_input: unknown) => {}),
    mutateAsync: mock(async (_input: unknown) => {}),
    isPending: false,
};
const notExporting = { exportCalendar: mock(async () => {}), isExporting: false };
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
const { EventDetailDialog } = await import('../../components/event-detail-dialog');

let unmount = async () => {};
afterEach(() => unmount());

async function open() {
    ({ unmount } = await renderInDocument(
        createElement(EventDetailDialog, { open: true, onOpenChange: () => {}, event: dentist, calendar: work }),
    ));
}

const dialogTitles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);
const click = (name: string) =>
    act(async () => {
        const found = document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${name}"]`);
        if (!found) throw new Error(`the panel has no button named ${name}`);
        found.click();
    });

test('the button named Edit event opens Edit event', async () => {
    await open();
    await click('Edit event');
    expect(dialogTitles()).toEqual(['Edit event']);
});

test('the button named Delete event asks to delete it', async () => {
    await open();
    await click('Delete event');
    expect(dialogTitles()).toEqual(['Delete event']);
});
