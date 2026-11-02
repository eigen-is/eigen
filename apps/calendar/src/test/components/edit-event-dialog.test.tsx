// Edit event is a form: Save or Enter in the title saves a one-off event and closes it once. While the save runs,
// Cancel and Escape wait, and a save the server refuses keeps the dialog open beside the hook's toast, with no
// unhandled rejection. A series occurrence asks which events the change applies to, and a move to another owner asks
// first, and each closes Edit event once its save is done. A move retried after a failed delete creates its copy once,
// and again only in a newly picked calendar. Copying an invitation's guests saves nothing.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem, UpdateEventInput } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
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
const personal: CalendarItem = { ...work, id: 'personal', name: 'Personal', isDefault: false };
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
// A weekly series, opened on one of its occurrences. It is its own master, and its own row is what useEvent returns.
const standup: CalendarEventOccurrence = {
    ...dentist,
    id: 's1',
    uid: 's1@eigen',
    title: 'Standup',
    rrule: 'FREQ=WEEKLY',
};
const guests = { attendees: [{ email: 'ada@example.org', status: 'pending' as const, role: 'required' as const }] };
// An invitation whose copy sits in a calendar the viewer can no longer pick, so Save would move it to another one.
const invitation: CalendarEventOccurrence = {
    ...dentist,
    id: 'i1',
    calendarId: 'inbox',
    data: { ...guests, organizer: { userId: 'u2', email: 'bob@example.org' } },
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// Stable across renders, as React Query's results are, or the dialog's effects would rerun on every render.
const oneCalendar = { data: [work] };
const twoCalendars = { data: [work, personal] };
let calendars = oneCalendar;
const sharedCalendars = { data: [] };
const noMaster = { data: undefined };
const standupMaster = { data: standup };
let master: { data: CalendarEventOccurrence | undefined } = noMaster;
const idle = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
const notFromOthers = () => false;
const fromOthers = () => true;
let isFromOthers = notFromOthers;
const updateEvent = { mutateAsync: mock(async (_input: UpdateEventInput) => {}), isPending: false };
const deleteEvent = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
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
    useDeleteEvent: () => deleteEvent,
    useMoveEvent: () => idle,
    useEvent: () => master,
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
    idle.mutateAsync.mockReset();
    idle.mutateAsync.mockImplementation(async () => {});
    deleteEvent.mutateAsync.mockReset();
    deleteEvent.mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
    calendars = oneCalendar;
    master = noMaster;
    isFromOthers = notFromOthers;
    unhandled.length = 0;
});

async function open(event = dentist, ownerUserId?: string) {
    ({ unmount } = await renderInDocument(
        createElement(EditEventDialog, { open: true, onOpenChange, event, ownerUserId }),
    ));
}

const dialogText = () => [...document.querySelectorAll('[role="dialog"]')].map((dialog) => dialog.textContent);
const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === label || b.getAttribute('aria-label') === label,
    );
    if (!found) throw new Error(`the dialog has no ${label}`);
    return found;
};
const click = (label: string) => act(async () => button(label).click());
const save = () => click('Save');
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const titleField = () => {
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="Event title"]');
    if (!field) throw new Error('the dialog has no title field');
    return field;
};
// Radix opens its Select and picks an option on the pointer events, not on click.
const pointAt = (element: Element) =>
    act(async () => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
// The picker is found by the calendar it shows, since the repeat picker above it is a combobox too.
const pick = async (from: string, to: string) => {
    const trigger = [...document.querySelectorAll('[role="dialog"] button[role="combobox"]')].find(
        (b) => b.textContent === from,
    );
    if (!trigger) throw new Error(`the dialog has no picker showing ${from}`);
    await pointAt(trigger);
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === to);
    if (!option) throw new Error(`the picker has no ${to}`);
    await pointAt(option);
};
const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

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
    expect(button('Save').disabled).toBe(false);
    expect(unhandled).toEqual([]);
});

test('Enter in the title saves the event and closes the dialog', async () => {
    await open();
    await act(async () => pressEnter(titleField()));
    await settle();
    expect(updateEvent.mutateAsync.mock.calls.map(([input]) => [input.id, input.title])).toEqual([['e1', 'Dentist']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('while a save runs, its buttons are disabled and Cancel and Escape wait for it', async () => {
    let finish = () => {};
    updateEvent.mutateAsync.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await open();
    await save();
    expect([button('Cancel').disabled, button('Save').disabled]).toEqual([true, true]);
    await click('Cancel');
    await pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finish());
    await settle();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Save on a series occurrence asks which events to change, and that answer saves and closes it once', async () => {
    master = standupMaster;
    await open(standup);
    await save();
    expect(updateEvent.mutateAsync).not.toHaveBeenCalled();
    expect(idle.mutateAsync).not.toHaveBeenCalled();
    expect(dialogText().some((text) => text?.includes('Edit recurring event'))).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();

    await click('OK');
    await settle();
    expect(idle.mutateAsync.mock.calls.map(([input]) => input)).toMatchObject([{ parentEventId: 's1' }]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test("a move to another owner's calendar asks first, and Move saves and closes it once", async () => {
    await open({ ...dentist, data: guests }, 'u2');
    await save();
    expect(idle.mutateAsync).not.toHaveBeenCalled();
    expect(dialogText().some((text) => text?.includes('Move to another calendar owner?'))).toBe(true);

    await click('Move');
    await settle();
    // The copy is created in the picked calendar, then the original is deleted.
    expect(idle.mutateAsync).toHaveBeenCalledTimes(1);
    expect(deleteEvent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a move retried after the original failed to delete creates the copy only once', async () => {
    deleteEvent.mutateAsync.mockImplementationOnce(async () => {
        const failure = new Error('Network error');
        onMutationError(failure);
        throw failure;
    });
    await open({ ...dentist, data: guests }, 'u2');
    await save();
    await click('Move');
    await settle();
    await click('Move');
    await settle();
    expect(idle.mutateAsync).toHaveBeenCalledTimes(1);
    expect(deleteEvent.mutateAsync).toHaveBeenCalledTimes(2);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a move retried into another calendar, after the original failed to delete, creates the copy there too', async () => {
    calendars = twoCalendars;
    deleteEvent.mutateAsync.mockImplementationOnce(async () => {
        const failure = new Error('Network error');
        onMutationError(failure);
        throw failure;
    });
    await open({ ...dentist, data: guests }, 'u2');
    await save();
    await click('Move');
    await settle();
    await click('Cancel');
    await pick('Work', 'Personal');
    await save();
    await click('Move');
    await settle();
    expect(idle.mutateAsync.mock.calls.map(([input]) => input)).toMatchObject([
        { calendarId: 'work' },
        { calendarId: 'personal' },
    ]);
    expect(deleteEvent.mutateAsync).toHaveBeenCalledTimes(2);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test("copying an invitation's guests saves nothing", async () => {
    isFromOthers = fromOthers;
    await open(invitation);
    await click('Copy emails');
    await settle();
    expect(updateEvent.mutateAsync).not.toHaveBeenCalled();
    expect(idle.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});
