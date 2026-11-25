// New event keeps the dialog contract, says Create, and with no title says "Add a title" under the field. Enter in the
// guest field adds the guest and Enter in a time field sets the time, and neither saves. A guest typed but not added
// goes out with the event, and one the field refuses keeps the dialog open with the reason. The guest row's buttons are
// named and save nothing. A save the server refuses keeps the dialog open with no unhandled rejection, every opening
// starts empty, and there is no form until the calendars have loaded.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Attendee, CalendarItem, CreateEventInput } from '@workspace/lib/types/calendar';
import { expectFormContract } from '@workspace/ui/test/form-contract';
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
// Stable across renders, as React Query's results are.
const loaded = { data: [work] };
const loading = { data: undefined };
let calendars: { data: CalendarItem[] | undefined } = loaded;
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
    calendars = loaded;
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
// A pending button's spinner comes before its label.
const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.lastChild?.textContent === label,
    );
const create = () => act(async () => button('Create')?.click());

// An icon-only button, found by the name a screen reader reads out.
const named = (label: string) => {
    const found = document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`);
    if (!found) throw new Error(`the dialog has no button named ${label}`);
    return found;
};

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const type = (field: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const enter = (field: HTMLInputElement) => act(async () => pressEnter(field));
const guests = () => [...(dialog()?.querySelectorAll('.group') ?? [])].map((row) => row.textContent);
const errorText = () => dialog()?.querySelector('[data-slot="field-error"]')?.textContent;
const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent);
const ada: Attendee = { email: 'ada@example.org', name: undefined, status: 'pending', role: 'required' };

test('New event keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Harness),
        submitLabel: 'Create',
        firstField: 'Title',
        onSubmit: createEvent.mutateAsync,
        makeChanged: () => type(titleField(), 'Dentist'),
        makeInvalid: () => type(titleField(), '   '),
        invalidField: 'Title',
        modEnterFields: ['Guests', 'Start time', 'Description'],
    });
});

test('a title of only spaces says "Add a title" under the field and saves nothing', async () => {
    await open();
    await type(titleField(), '   ');
    await create();
    expect(errorText()).toBe('Add a title');
    expect(createEvent.mutateAsync).not.toHaveBeenCalled();
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

    await create();
    expect(createEvent.mutateAsync.mock.calls[0]?.[0].data).toEqual({ attendees: [ada] });
});

test('a guest typed but not added goes out with the event', async () => {
    await open();
    await type(titleField(), 'Dentist');
    await type(guestField(), 'ada@example.org');
    await create();
    expect(createEvent.mutateAsync.mock.calls[0]?.[0].data).toEqual({ attendees: [ada] });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a typed guest the field refuses keeps the dialog open, with the reason under the field', async () => {
    await open();
    await type(titleField(), 'Dentist');
    await type(guestField(), 'me@test.eigen.is');
    await create();
    expect(createEvent.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(errorText()).toBe('You cannot invite yourself');
    expect(document.activeElement).toBe(guestField());
});

test('a typed guest is a change, so Esc asks before it drops it', async () => {
    await open();
    await type(guestField(), 'ada@');
    await act(async () => {
        guestField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(titles()).toContain('Discard changes?');
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

    await create();
    expect(createEvent.mutateAsync.mock.calls[0]?.[0].startTime).toEqual(new Date(2026, 9, 9, 14, 0));
});

test('a save the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    createEvent.mutateAsync.mockImplementation(async () => {
        throw toasted('Calendar is read-only');
    });
    await open();
    await type(titleField(), 'Dentist');
    await create();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createEvent.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Create')?.getAttribute('aria-busy')).toBeNull();
    expect(unhandled).toEqual([]);
});

test('times the caller gives fill the start and end, and all day', async () => {
    const save = async (initial: { start: Date; end: Date; allDay: boolean }) => {
        createEvent.mutateAsync.mockClear();
        ({ unmount } = await renderInDocument(createElement(CreateEventDialog, { open: true, onOpenChange, initial })));
        await type(titleField(), 'Focus');
        await create();
        await unmount();
        const input = createEvent.mutateAsync.mock.calls[0]?.[0];
        // toMatchObject would pass any Date against any other.
        return { startTime: input?.startTime, endTime: input?.endTime, allDay: input?.allDay };
    };
    expect(
        await save({ start: new Date(2026, 9, 9, 10, 0), end: new Date(2026, 9, 9, 11, 30), allDay: false }),
    ).toEqual({ startTime: new Date(2026, 9, 9, 10, 0), endTime: new Date(2026, 9, 9, 11, 30), allDay: false });
    expect(await save({ start: new Date(2026, 9, 9), end: new Date(2026, 9, 9), allDay: true })).toEqual({
        startTime: new Date(Date.UTC(2026, 9, 9)),
        endTime: new Date(Date.UTC(2026, 9, 10)),
        allDay: true,
    });
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

test('there is no form until the calendars have loaded', async () => {
    calendars = loading;
    await open();
    expect(dialog()?.querySelector('input')).toBeNull();
    expect(button('Create')).toBeUndefined();
});
