// Two clients on one event, through the real hooks and dialogs against a server stub that judges etags as the API does.
// A write on a stale etag is refused, says so, and the next try goes through on what was reloaded, with the dialog still
// open. A refetch that changes nothing leaves typed edits alone, and one that changes the event doesn't let a save
// overwrite that change unseen. A save of two writes sends the second with the etag the first answered.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const USER = 'u1';
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
    etag: 'v1',
    data: null,
    createByUserId: USER,
    createdAt: created,
    updatedAt: created,
    occurrenceDate: '2026-10-09',
};

// The one event on the server, and every write that reached it with the etag it carried.
const server = {
    event: dentist,
    revision: 1,
    writes: [] as { write: string; etag: string | undefined }[],
    // Answers the next write of this kind with this status once, for a save that fails halfway.
    failNext: null as { write: string; status: number } | null,
};
const refused = (status: number) => ({ data: null, error: { status, value: 'Refused' }, status });
const answered = <T,>(data: T) => ({ data, error: null, status: 200 });
const nextRevision = () => {
    server.revision += 1;
    return `v${server.revision}`;
};
const changeElsewhere = (title: string) => {
    server.event = { ...server.event, title, etag: nextRevision() };
};
// The list a client reads: a fresh copy each time, as a refetch's JSON is.
const eventList = () => (server.event ? [{ ...server.event, startTime: new Date(server.event.startTime) }] : []);

const writeEvent = (write: string, etag: string | undefined, apply: () => { data: unknown }) => {
    server.writes.push({ write, etag });
    if (server.failNext?.write === write) {
        const { status } = server.failNext;
        server.failNext = null;
        return refused(status);
    }
    if (etag !== server.event.etag) return refused(412);
    return apply();
};

const calendarApi = () => ({
    'event-range': () => () => ({ get: async () => answered(eventList()) }),
    shared: { get: async () => answered([]) },
    calendars: Object.assign(
        () => ({
            events: Object.assign(
                () => ({
                    get: async () => answered(server.event),
                    put: async ({ etag, ...fields }: Partial<CalendarEvent>) =>
                        writeEvent('update', etag, () => {
                            server.event = { ...server.event, ...fields, etag: nextRevision() };
                            return answered(server.event);
                        }),
                    delete: async (_body: unknown, { query }: { query: { etag: string } }) =>
                        writeEvent('delete', query.etag, () => answered(undefined)),
                    move: {
                        put: async ({ targetCalendarId, etag }: { targetCalendarId: string; etag: string }) =>
                            writeEvent('move', etag, () => {
                                server.event = { ...server.event, calendarId: targetCalendarId };
                                return answered(server.event);
                            }),
                    },
                }),
                {
                    post: async ({ etag, parentEventId }: { etag?: string; parentEventId?: string }) =>
                        // Only an override is judged, as on the server; a new series just gets written.
                        writeEvent(
                            parentEventId ? 'override' : 'create',
                            parentEventId ? etag : server.event.etag,
                            () => {
                                server.event = { ...server.event, etag: nextRevision() };
                                return answered(server.event);
                            },
                        ),
                },
            ),
        }),
        { get: async () => answered([work, personal]) },
    ),
});

const session = { user: { id: USER, email: 'me@test.eigen.is', name: 'Me' } };
const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realApi = { ...(await import('@workspace/lib/api')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/api', () => ({ ...realApi, calendarApi }));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/api', () => realApi);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('sonner', () => realSonner);
});

const { useQueryClient } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { invalidateEventList, useEvents } = await import('@workspace/lib/calendar');
const { EventDetailDialog } = await import('../../components/event-detail-dialog');
const { useEventDetailState } = await import('../../components/hooks/use-event-detail-state');

// What a calendar view does around the dialog. The hidden button stands for clicking the event, and the other for the
// stream's refetch after a change elsewhere.
function CalendarPage() {
    const queryClient = useQueryClient();
    const { data: events = [] } = useEvents(USER, 1, 2);
    const { handleEventClick, detailDialogProps } = useEventDetailState({ events, calendars: [work, personal] });
    const first = events[0];
    return createElement(
        'div',
        null,
        first &&
            createElement('button', {
                type: 'button',
                'data-testid': 'event',
                onClick: (e: React.MouseEvent) => handleEventClick(first, e),
            }),
        createElement('button', {
            type: 'button',
            'data-testid': 'refetch',
            onClick: () => invalidateEventList(queryClient, USER),
        }),
        createElement(EventDetailDialog, detailDialogProps),
    );
}

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    server.event = dentist;
    server.revision = 1;
    server.writes = [];
    server.failNext = null;
    toasts.length = 0;
});

const settle = () =>
    act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
const clickTestId = async (id: string) => {
    await act(async () => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click());
    await settle();
};
const refetch = () => clickTestId('refetch');
const dialogButton = (name: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === name || button.getAttribute('aria-label') === name,
    );
    if (!found) throw new Error(`no dialog has a button named ${name}`);
    return found;
};
const click = async (name: string) => {
    await act(async () => dialogButton(name).click());
    await settle();
};
const titleField = () => {
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="Event title"]');
    if (!field) throw new Error('no dialog has a title field');
    return field;
};
const typeTitle = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(titleField(), value);
        titleField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const dialogTitles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);
// Radix opens its Select and picks an option on the pointer events, not on click.
const pointAt = (element: Element) =>
    act(async () => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const pickCalendar = async (from: string, to: string) => {
    const trigger = [...document.querySelectorAll('[role="dialog"] button[role="combobox"]')].find(
        (button) => button.textContent === from,
    );
    if (!trigger) throw new Error(`no picker shows ${from}`);
    await pointAt(trigger);
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === to);
    if (!option) throw new Error(`the picker has no ${to}`);
    await pointAt(option);
    await settle();
};

const STALE_TOAST = 'This event changed elsewhere. It has been reloaded — please redo your edit.';

async function openPanel() {
    ({ unmount } = await renderInDocument(createElement(CalendarPage)));
    await settle();
    await clickTestId('event');
}
async function openEdit() {
    await openPanel();
    await click('Edit event');
}

test('a delete refused on a stale etag says so, and the same open dialog then deletes what was reloaded', async () => {
    await openPanel();
    await click('Delete event');
    changeElsewhere('Dentist, moved by a colleague');

    await click('Delete');
    expect(server.writes).toEqual([{ write: 'delete', etag: 'v1' }]);
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Delete event']);

    await click('Delete');
    expect(server.writes).toEqual([
        { write: 'delete', etag: 'v1' },
        { write: 'delete', etag: 'v2' },
    ]);
    expect(dialogTitles()).toEqual([]);
});

test('the panel shows and deletes the event as the latest refetch has it', async () => {
    await openPanel();
    changeElsewhere('Dentist, moved by a colleague');
    await refetch();
    expect(dialogTitles()).toEqual(['Dentist, moved by a colleague']);

    await click('Delete event');
    await click('Delete');
    expect(server.writes).toEqual([{ write: 'delete', etag: 'v2' }]);
    expect(toasts).toEqual([]);
});

test('a refetch that changes nothing keeps typed edits, and Save sends them', async () => {
    await openEdit();
    await typeTitle('Dentist at noon');
    await refetch();
    expect(titleField().value).toBe('Dentist at noon');

    await click('Save');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1' }]);
    expect(server.event.title).toBe('Dentist at noon');
    expect(dialogTitles()).toEqual([]);
});

test('a change elsewhere keeps typed edits on screen, but saving them over it is refused', async () => {
    await openEdit();
    await typeTitle('Dentist at noon');
    changeElsewhere('Dentist, moved by a colleague');
    await refetch();
    expect(titleField().value).toBe('Dentist at noon');

    await click('Save');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1' }]);
    expect(server.event.title).toBe('Dentist, moved by a colleague');
    expect(toasts).toEqual([STALE_TOAST]);
});

test('after a refusal the open form holds the current event, and Save then goes through', async () => {
    await openEdit();
    await typeTitle('Dentist at noon');
    changeElsewhere('Dentist, moved by a colleague');

    await click('Save');
    expect(toasts).toEqual([STALE_TOAST]);
    expect(titleField().value).toBe('Dentist, moved by a colleague');

    await typeTitle('Dentist, moved, at noon');
    await click('Save');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'update', etag: 'v2' },
    ]);
    expect(server.event.title).toBe('Dentist, moved, at noon');
    expect(dialogTitles()).toEqual([]);
});

test('a second change elsewhere after a refusal keeps what is typed again', async () => {
    await openEdit();
    changeElsewhere('First change');
    await click('Save');
    expect(titleField().value).toBe('First change');

    await typeTitle('Typed after the reload');
    changeElsewhere('Second change');
    await refetch();
    expect(titleField().value).toBe('Typed after the reload');
});

test('a refusal behind the recurring choice brings back the form, on the current event', async () => {
    const standup = { ...dentist, rrule: 'FREQ=WEEKLY' };
    server.event = standup;
    await openEdit();
    await click('Save');
    expect(dialogTitles()).toEqual(['Edit recurring event']);
    changeElsewhere('Standup, renamed');

    await click('OK');
    expect(server.writes).toEqual([{ write: 'override', etag: 'v1' }]);
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit event']);
    expect(titleField().value).toBe('Standup, renamed');
});

test('a move to another of your calendars sends the etag the update before it answered', async () => {
    await openEdit();
    await pickCalendar('Work', 'Personal');
    await click('Save');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'move', etag: 'v2' },
    ]);
    expect(server.event.calendarId).toBe('personal');
    expect(toasts).toEqual([]);
});

test("a retry after a move failed keeps the edits and isn't refused over the save's own update", async () => {
    server.failNext = { write: 'move', status: 409 };
    await openEdit();
    await typeTitle('Dentist at noon');
    await pickCalendar('Work', 'Personal');
    await click('Save');
    expect(dialogTitles()).toEqual(['Edit event']);
    expect(titleField().value).toBe('Dentist at noon');

    await click('Save');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'move', etag: 'v2' },
        { write: 'update', etag: 'v2' },
        { write: 'move', etag: 'v3' },
    ]);
    expect(toasts.filter((toast) => toast === STALE_TOAST)).toEqual([]);
    expect(server.event.calendarId).toBe('personal');
});

test('a move over a change elsewhere is refused at its update, and nothing moves', async () => {
    await openEdit();
    await pickCalendar('Work', 'Personal');
    changeElsewhere('Dentist, moved by a colleague');
    await refetch();

    await click('Save');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1' }]);
    expect(server.event.calendarId).toBe('work');
    expect(toasts).toEqual([STALE_TOAST]);
});

const pickRecurringAction = async (id: string) => {
    await act(async () => document.querySelector<HTMLElement>(`[role="dialog"] label[for="recurring-${id}"]`)?.click());
};

test('this and following truncates on the loaded etag, and its retry goes on from what the truncation answered', async () => {
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY' };
    server.failNext = { write: 'create', status: 500 };
    await openEdit();
    await click('Save');
    await pickRecurringAction('this-and-following');
    await click('OK');
    expect(dialogTitles()).toEqual(['Edit recurring event']);

    await pickRecurringAction('this-and-following');
    await click('OK');
    expect(server.writes.map(({ write, etag }) => [write, etag])).toEqual([
        ['update', 'v1'],
        ['create', 'v2'],
        ['update', 'v2'],
        ['create', 'v3'],
    ]);
    expect(toasts.filter((toast) => toast === STALE_TOAST)).toEqual([]);
    expect(dialogTitles()).toEqual([]);
});

test('this and following over a change elsewhere is refused before it writes anything', async () => {
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY' };
    await openEdit();
    await click('Save');
    changeElsewhere('Standup, renamed');
    await refetch();
    await pickRecurringAction('this-and-following');
    await click('OK');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1' }]);
    expect(server.event.title).toBe('Standup, renamed');
    expect(toasts).toEqual([STALE_TOAST]);
});

test('cancelling one occurrence of a series sends the etag of the file it writes into', async () => {
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY' };
    await openPanel();
    await click('Delete event');
    await click('OK');
    expect(server.writes).toEqual([{ write: 'override', etag: 'v1' }]);
});

test('reopening Edit event loads the event as it is now, not as the last opening left it', async () => {
    await openEdit();
    await typeTitle('Typed and abandoned');
    await click('Cancel');
    expect(dialogTitles()).toEqual([]);
    changeElsewhere('Dentist, moved by a colleague');
    await refetch();

    await clickTestId('event');
    await click('Edit event');
    expect(titleField().value).toBe('Dentist, moved by a colleague');
    await click('Save');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v2' }]);
});
