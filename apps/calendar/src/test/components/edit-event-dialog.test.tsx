// Edit event saves a one-off event straight from Save and closes. A save the server refuses keeps the dialog open
// beside the hook's toast, with no unhandled rejection.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem, UpdateEventInput } from '@workspace/lib/types/calendar';
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
// Stable across renders, as React Query's results are, or the dialog's effects would rerun on every render.
const calendars = { data: [work] };
const sharedCalendars = { data: [] };
const noMaster = { data: undefined };
const idle = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
const notFromOthers = () => false;
const updateEvent = { mutateAsync: mock(async (_input: UpdateEventInput) => {}), isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useCalendars: () => calendars,
    useSharedCalendars: () => sharedCalendars,
    useUpdateEvent: () => updateEvent,
    useCreateEvent: () => idle,
    useDeleteEvent: () => idle,
    useMoveEvent: () => idle,
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

// A rejected save the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { EditEventDialog } = await import('../../components/edit-event-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    updateEvent.mutateAsync.mockReset();
    updateEvent.mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
    unhandled.length = 0;
});

async function open() {
    ({ unmount } = await renderInDocument(
        createElement(EditEventDialog, { open: true, onOpenChange, event: dentist }),
    ));
}

const save = () =>
    act(async () => {
        const target = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
            (b) => b.textContent === 'Save',
        );
        if (!target) throw new Error('the dialog has no Save');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('Save updates the event and closes the dialog', async () => {
    await open();
    await save();
    await settle();
    expect(updateEvent.mutateAsync.mock.calls.map(([input]) => [input.id, input.title])).toEqual([['e1', 'Dentist']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a save the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    updateEvent.mutateAsync.mockImplementation(async () => {
        const failure = new Error('Calendar is read-only');
        // The mutation hook toasts its failure before the dialog sees it.
        onMutationError(failure);
        throw failure;
    });
    await open();
    await save();
    await settle();
    expect(updateEvent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
});
