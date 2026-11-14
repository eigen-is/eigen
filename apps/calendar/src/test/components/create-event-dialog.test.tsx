// New event is a form: Enter in the title saves the event, while Enter in the guest field adds a guest and Enter in a
// time field sets the time, and neither saves. The guest row's buttons are named, the remove button after its guest,
// and save nothing either. A save the
// server refuses keeps the dialog open beside the hook's toast, with no unhandled rejection, and every opening starts
// empty.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CalendarItem, CreateEventInput } from '@workspace/lib/types/calendar';
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
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const calendars = { data: [work] };
const sharedCalendars = { data: [] };
const createEvent = { mutateAsync: mock(async (_input: CreateEventInput) => {}), isPending: false };
const noSuggestions = { suggestions: [], isLoading: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useCalendars: () => calendars,
    useSharedCalendars: () => sharedCalendars,
    useCreateEvent: () => createEvent,
}));
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useContactSuggestions: () => noSuggestions }));
// A guest row names the guest by address, without looking up who it is.
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email }: { email?: string }) => ({
        displayName: email ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/calendar', () => realCalendar);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/public', () => realPublic);
});

// A rejected save the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};
const { CreateEventDialog } = await import('../../components/create-event-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    createEvent.mutateAsync.mockReset();
    createEvent.mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
    unhandled.length = 0;
});

// The dialog under a parent that owns `open`, as the calendar route does, so a test can close and reopen it.
let setOpen = (_open: boolean) => {};
function Harness() {
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    return createElement(CreateEventDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpenState(next);
        },
        defaultDate: new Date(2026, 9, 9),
        defaultCalendarId: 'work',
    });
}

async function open() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

const dialog = () => document.querySelector('[role="dialog"]');
const input = (selector: string) => {
    const field = document.querySelector<HTMLInputElement>(`[role="dialog"] ${selector}`);
    if (!field) throw new Error(`the dialog has no ${selector}`);
    return field;
};
const titleField = () => input('input[placeholder="Add title"]');
const guestField = () => input('#attendee-input');
const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label);

// An icon-only button, found by the name a screen reader reads out.
const named = (label: string) => {
    const found = document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`);
    if (!found) throw new Error(`the dialog has no button named ${label}`);
    return found;
};

const type = (field: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const enter = (field: HTMLInputElement) => act(async () => pressEnter(field));
const guests = () => [...(dialog()?.querySelectorAll('.group') ?? [])].map((row) => row.textContent);

test('Enter in the title saves the event, and the dialog closes', async () => {
    await open();
    await type(titleField(), 'Dentist');
    await enter(titleField());
    expect(createEvent.mutateAsync.mock.calls.map(([event]) => [event.calendarId, event.title])).toEqual([
        ['work', 'Dentist'],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Enter in the guest field adds the guest and saves nothing, and the guest goes out with the event', async () => {
    await open();
    await type(titleField(), 'Dentist');
    await type(guestField(), 'ada@example.org');
    await enter(guestField());
    expect(guests()).toEqual(['ada@example.orgPending']);
    expect(guestField().value).toBe('');
    expect(createEvent.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => button('Save')?.click());
    expect(createEvent.mutateAsync.mock.calls[0]?.[0].data).toEqual({
        attendees: [{ email: 'ada@example.org', name: undefined, status: 'pending', role: 'required' }],
    });
});

test("the guest row's add and remove buttons are named and save nothing", async () => {
    await open();
    await type(titleField(), 'Dentist');
    await type(guestField(), 'ada@example.org');
    await act(async () => named('Add').click());
    expect(guests()).toEqual(['ada@example.orgPending']);
    await type(guestField(), 'bob@example.org');
    await act(async () => named('Add').click());
    await act(async () => named('Remove ada@example.org').click());
    expect(guests()).toEqual(['bob@example.orgPending']);
    await act(async () => named('Remove bob@example.org').click());
    expect(guests()).toEqual([]);
    expect(createEvent.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Enter in a time field sets the time and saves nothing', async () => {
    await open();
    await type(titleField(), 'Dentist');
    const startTime = input('input.tabular-nums');
    await type(startTime, '14:00');
    await enter(startTime);
    expect(createEvent.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => button('Save')?.click());
    expect(createEvent.mutateAsync.mock.calls[0]?.[0].startTime).toEqual(new Date(2026, 9, 9, 14, 0));
});

test('Save waits for a title with more than spaces, and keeps its label', async () => {
    await open();
    expect(button('Save')?.disabled).toBe(true);
    await type(titleField(), '   ');
    expect(button('Save')?.disabled).toBe(true);
    await type(titleField(), 'Dentist');
    expect(button('Save')?.disabled).toBe(false);
});

test('a save the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    createEvent.mutateAsync.mockImplementation(async () => {
        throw toasted('Calendar is read-only');
    });
    await open();
    await type(titleField(), 'Dentist');
    await act(async () => button('Save')?.click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createEvent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Save')?.disabled).toBe(false);
    expect(unhandled).toEqual([]);
});

test('closing and reopening starts empty', async () => {
    await open();
    await type(titleField(), 'Dentist');
    await type(guestField(), 'ada@example.org');
    await enter(guestField());
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(titleField().value).toBe('');
    expect(guests()).toEqual([]);
});
