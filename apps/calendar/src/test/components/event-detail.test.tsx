// The event's detail column has its actions in its bar, each named so a screen reader finds them, and another owner's
// read-only event has none. Edit and Delete open their dialogs, and a save or a reply keeps the column open while a
// delete closes it. Its body is the event's title and time with no block, the calendar under them, then the event's
// sections.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { dialogTitles } from '../dialog-titles';

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
const readOnly: SharedCalendar = {
    id: 'sc1',
    ownerUserId: 'u2',
    calendarId: 'team',
    calendarName: 'Team',
    calendarColor: '#22c55e',
    permission: 'read',
    color: null,
    visible: true,
    createdAt: created,
    updatedAt: created,
};
const noMaster = { data: undefined };
const idle = {
    mutate: mock((_input: unknown) => {}),
    mutateAsync: mock(async (_input: unknown) => {}),
    isPending: false,
};
const notExporting = { exportCalendar: mock(async () => {}), isExporting: false };
const notFromOthers = () => false;
let isFromOthers: (event: CalendarEventOccurrence) => boolean = notFromOthers;
const rsvp = {
    mutate: mock((_input: unknown) => {}),
    mutateAsync: mock(async (_input: unknown) => {}),
    isPending: false,
};
const deleteEvent = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
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
    useDeleteEvent: () => deleteEvent,
    useMoveEvent: () => idle,
    useRsvp: () => rsvp,
    useExportCalendar: () => notExporting,
    useEvent: () => noMaster,
    useIsInvitationFromOthers: () => isFromOthers,
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
const { EventDetail } = await import('../../components/event-detail');

const onClose = mock(() => {});
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    isFromOthers = notFromOthers;
    rsvp.mutateAsync.mockClear();
    deleteEvent.mutateAsync.mockClear();
    onClose.mockClear();
});

async function open(event: CalendarEventOccurrence = dentist, sharedCalendar: SharedCalendar | null = null) {
    ({ unmount } = await renderInDocument(
        createElement(EventDetail, {
            event,
            calendar: sharedCalendar ? null : work,
            sharedCalendar,
            ownerId: sharedCalendar ? sharedCalendar.ownerUserId : 'u1',
            onClose,
            onSaved: () => {},
        }),
    ));
}

const column = () => document.querySelector('[data-slot="detail-column"]');
const barButtons = () =>
    [...(column()?.querySelectorAll('button[aria-label]') ?? [])].map((b) => b.getAttribute('aria-label'));
const press = (element: HTMLElement | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to press');
        element.focus();
        element.click();
    });
// Radix gives the focus back a tick after the dialog is gone.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const button = (label: string) =>
    [
        ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button, [data-slot="detail-column"] button'),
    ].find((b) => b.lastChild?.textContent === label || b.getAttribute('aria-label') === label);
const click = (name: string) => press(button(name));

test("the bar holds the event's actions and then X, and another owner's read-only event has none", async () => {
    await open();
    expect(barButtons()).toEqual(['Edit event', 'Delete event', 'Export event', 'Close']);
    await unmount();
    await open({ ...dentist, calendarId: 'team' }, readOnly);
    expect(barButtons()).toEqual(['Close']);
});

test('closing Edit event gives the focus back to its button, and the column stays open', async () => {
    for (const close of ['Cancel', 'Save']) {
        await open();
        await click('Edit event');
        await settle();
        await click(close);
        await settle();
        expect([close, document.querySelectorAll('[role="dialog"]').length]).toEqual([close, 0]);
        expect([close, document.activeElement?.getAttribute('aria-label')]).toEqual([close, 'Edit event']);
        expect([close, onClose.mock.calls.length]).toEqual([close, 0]);
        await unmount();
    }
});

test('a reply to an invitation keeps its button busy until the write ends, and the column open after it', async () => {
    isFromOthers = () => true;
    let finish = () => {};
    rsvp.mutateAsync.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(undefined))));
    await open({
        ...dentist,
        data: { attendees: [{ email: session.user.email, status: 'pending', role: 'required' }] },
    });
    await click('Accept');
    expect(button('Accept')?.getAttribute('aria-busy')).toBe('true');
    await click('Decline');
    expect(rsvp.mutateAsync.mock.calls.map(([input]) => input)).toEqual([
        { calendarId: 'work', eventId: 'e1', status: 'accepted' },
    ]);

    await act(async () => finish());
    expect(button('Accept')?.getAttribute('aria-busy')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
});

test('an event with no title heads its column (No title)', async () => {
    await open({ ...dentist, title: '' });
    expect(column()?.querySelector('h2')?.textContent).toBe('(No title)');
});

test('the button named Edit event opens Edit event', async () => {
    await open();
    await click('Edit event');
    expect(dialogTitles()).toEqual(['Edit event']);
});

test('the button named Delete event asks to delete it, and the delete closes the column', async () => {
    await open();
    await click('Delete event');
    expect(dialogTitles()).toEqual(['Delete event']);
    await click('Delete');
    expect(deleteEvent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('deleting this and following occurrences of an invitation declines them and keeps the series', async () => {
    isFromOthers = () => true;
    await open({ ...dentist, rrule: 'FREQ=WEEKLY' });
    await click('Delete event');
    await act(async () => {
        document.querySelector<HTMLElement>('[role="dialog"] label[for="recurring-this-and-following"]')?.click();
    });
    await click('OK');
    expect(rsvp.mutateAsync).toHaveBeenCalledTimes(1);
    expect(rsvp.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
        status: 'declined',
        scope: 'this-and-following',
        remove: true,
    });
    expect(deleteEvent.mutateAsync).not.toHaveBeenCalled();
});

test("deleting a changed occurrence of an invitation offers this and following, which declines the series' rest", async () => {
    isFromOthers = () => true;
    await open({ ...dentist, id: 'e1-override', parentEventId: 'e1', recurrenceDate: '2026-10-09' });
    await click('Delete event');
    const options = [...document.querySelectorAll('[role="dialog"] [role="radio"]')].map((radio) => radio.id);
    expect(options).toEqual(['recurring-this', 'recurring-this-and-following', 'recurring-all']);
});

test('deleting a changed occurrence offers no this and following, as it has no rule to cut', async () => {
    await open({ ...dentist, id: 'e1-override', parentEventId: 'e1', recurrenceDate: '2026-10-09' });
    await click('Delete event');
    expect(dialogTitles()).toEqual(['Delete recurring event']);
    const options = [...document.querySelectorAll('[role="dialog"] [role="radio"]')].map((radio) => radio.id);
    expect(options).toEqual(['recurring-this', 'recurring-all']);
});

test("the event has no block, in its calendar's color or not, and the calendar is in the line under it", async () => {
    await open({ ...dentist, location: 'Grote Markt' });
    expect(column()?.querySelector('.eigen-block')).toBeNull();
    const title = column()?.querySelector<HTMLElement>('h2');
    expect(title?.textContent).toBe('Dentist');
    expect(title?.nextElementSibling?.nextElementSibling?.textContent).toBe('Work');
    expect(title?.parentElement?.querySelector('section h3')?.textContent).toBe('Location');
});
