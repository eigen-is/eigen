// Two clients on one event, through the real hooks and dialogs against a server stub that judges etags as the API does.
// A write on a stale etag is refused, says so, and the next try goes through on what was reloaded, with the dialog still
// open. Edit event keeps what was typed and follows the rest: a refetch moves only the fields nobody touched, and typed
// edits can't overwrite a change unseen. So a guest's reply costs a form nothing, and a second Save doesn't revert it. A
// save of two writes sends the second with the etag the first answered, and a cross-home redo copies all of the form.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
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
const teamCalendar: SharedCalendar = {
    id: 'share1',
    calendarId: 'team',
    calendarName: 'Team',
    calendarColor: '#000000',
    color: null,
    ownerUserId: 'u2',
    permission: 'write',
    visible: true,
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
    shared: [] as SharedCalendar[],
    writes: [] as { write: string; etag: string | undefined }[],
    // What the last new series or cross-home copy was created with.
    created: null as Partial<CalendarEvent> | null,
    // Answers the next write of this kind with this status once, for a save that fails halfway.
    failNext: null as { write: string; status: number } | null,
};
const refused = (status: number) => ({ data: null, error: { status, value: 'Refused' }, status });
const answered = <T,>(data: T) => ({ data, error: null, status: 200 });
const nextRevision = () => {
    server.revision += 1;
    return `v${server.revision}`;
};
const changeFieldsElsewhere = (fields: Partial<CalendarEvent>) => {
    server.event = { ...server.event, ...fields, etag: nextRevision() };
};
const changeElsewhere = (title: string) => changeFieldsElsewhere({ title });
const invited = (...attendees: [email: string, status: Attendee['status']][]) => ({
    attendees: attendees.map(([email, status]) => ({ email, status, role: 'required' as const })),
});
// The list a client reads: a fresh copy each time, as a refetch's JSON is. A truncated series no longer has this
// occurrence.
const eventList = () =>
    server.event.rrule?.includes('UNTIL') ? [] : [{ ...server.event, startTime: new Date(server.event.startTime) }];

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
    shared: { get: async () => answered(server.shared) },
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
                    post: async ({ etag, parentEventId, ...fields }: Partial<CalendarEvent>) =>
                        // Only an override is judged and lands in this resource, as on the server; a new series or a
                        // cross-home copy is a resource of its own.
                        writeEvent(
                            parentEventId ? 'override' : 'create',
                            parentEventId ? etag : server.event.etag,
                            () => {
                                if (parentEventId) server.event = { ...server.event, etag: nextRevision() };
                                else server.created = fields;
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
    server.shared = [];
    server.created = null;
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
const descriptionField = () => {
    const field = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[placeholder="Description"]');
    if (!field) throw new Error('no dialog has a description field');
    return field;
};
const startDateField = () => {
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="date"]');
    if (!field) throw new Error('no dialog has a date field');
    return field;
};
const typeInto = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
        const prototype =
            field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const typeTitle = (value: string) => typeInto(titleField(), value);
const typeDescription = (value: string) => typeInto(descriptionField(), value);
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

const pickRecurringAction = async (id: string) => {
    await act(async () => document.querySelector<HTMLElement>(`[role="dialog"] label[for="recurring-${id}"]`)?.click());
};

const STALE_TOAST = 'This event changed elsewhere. Anything you typed is kept. Check it and try again.';

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

test('a refusal keeps what was typed and follows the rest, and the next Save sends the new etag', async () => {
    await openEdit();
    await typeTitle('Dentist at noon');
    changeFieldsElsewhere({ location: 'New practice' });

    await click('Save');
    expect(toasts).toEqual([STALE_TOAST]);
    expect(titleField().value).toBe('Dentist at noon');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="Location"]')?.value).toBe(
        'New practice',
    );

    await click('Save');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'update', etag: 'v2' },
    ]);
    expect(server.event.title).toBe('Dentist at noon');
    expect(server.event.location).toBe('New practice');
    expect(dialogTitles()).toEqual([]);
});

test('typing after a refusal answers to what was reloaded, so a change after it is refused again', async () => {
    await openEdit();
    await typeTitle('Dentist at noon');
    changeElsewhere('First change');
    await click('Save');

    await typeTitle('Dentist at one');
    changeElsewhere('Second change');
    await refetch();
    expect(titleField().value).toBe('Dentist at one');

    await click('Save');
    expect(server.writes.map(({ etag }) => etag)).toEqual(['v1', 'v2']);
    expect(server.event.title).toBe('Second change');
    expect(toasts).toEqual([STALE_TOAST, STALE_TOAST]);
});

test('a clean form follows the event, and its Save answers to what it shows', async () => {
    await openEdit();
    changeElsewhere('Dentist, moved by a colleague');
    await refetch();
    expect(titleField().value).toBe('Dentist, moved by a colleague');

    await click('Save');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v2' }]);
    expect(toasts).toEqual([]);
    expect(dialogTitles()).toEqual([]);
});

test("a guest's reply costs a typed description nothing, and the second Save doesn't revert it", async () => {
    server.event = { ...dentist, data: invited(['ada@example.org', 'pending']) };
    await openEdit();
    await typeDescription('Bring the x-rays');
    changeFieldsElsewhere({ data: invited(['ada@example.org', 'accepted']) });

    await click('Save');
    expect(toasts).toEqual([STALE_TOAST]);
    expect(descriptionField().value).toBe('Bring the x-rays');

    await click('Save');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'update', etag: 'v2' },
    ]);
    expect(server.event.description).toBe('Bring the x-rays');
    expect(server.event.data).toEqual(invited(['ada@example.org', 'accepted']));
    expect(dialogTitles()).toEqual([]);
});

test("a guest's reply on a series reaches its master's list too, and the second Save keeps it", async () => {
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY', data: invited(['ada@example.org', 'pending']) };
    await openEdit();
    await typeDescription('Bring the x-rays');
    await click('Save');
    changeFieldsElsewhere({ data: invited(['ada@example.org', 'accepted']) });
    await pickRecurringAction('all');

    await click('OK');
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit event']);
    expect(descriptionField().value).toBe('Bring the x-rays');

    await click('Save');
    await pickRecurringAction('all');
    await click('OK');
    expect(server.writes).toEqual([
        { write: 'update', etag: 'v1' },
        { write: 'update', etag: 'v2' },
    ]);
    expect(server.event.description).toBe('Bring the x-rays');
    expect(server.event.data).toEqual(invited(['ada@example.org', 'accepted']));
});

test('a guest list the user edited says who is on it, and each guest answers as the server says', async () => {
    server.event = { ...dentist, data: invited(['ada@example.org', 'pending'], ['bob@example.org', 'pending']) };
    await openEdit();
    await click('Remove bob@example.org');
    changeFieldsElsewhere({ data: invited(['ada@example.org', 'accepted'], ['bob@example.org', 'pending']) });

    await click('Save');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('bob@example.org');

    await click('Save');
    expect(server.event.data).toEqual(invited(['ada@example.org', 'accepted']));
});

test('a date, its times and the repeat stay together: one typed holds them all against a change elsewhere', async () => {
    const saveToAll = async () => {
        await click('Save');
        await pickRecurringAction('all');
        await click('OK');
    };
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY' };
    await openEdit();
    await typeInto(startDateField(), '2026-10-20');
    changeFieldsElsewhere({
        title: 'Standup, renamed',
        startTime: new Date(2026, 9, 9, 16, 0),
        endTime: new Date(2026, 9, 9, 17, 0),
        rrule: 'FREQ=DAILY',
    });
    await saveToAll();
    expect(toasts).toEqual([STALE_TOAST]);
    expect(titleField().value).toBe('Standup, renamed');

    await saveToAll();
    expect(server.event.startTime).toEqual(new Date(2026, 9, 20, 14, 0));
    expect(server.event.endTime).toEqual(new Date(2026, 9, 20, 14, 30));
    expect(server.event.rrule).toBe('FREQ=WEEKLY');
    expect(server.event.title).toBe('Standup, renamed');
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

test('a cross-home move refused at its delete leaves both, and the redo copies everything', async () => {
    server.shared = [teamCalendar];
    server.event = { ...dentist, data: invited(['ada@example.org', 'pending']) };
    await openEdit();
    await typeTitle('Dentist at noon');
    await pickCalendar('Work', 'Team');
    await click('Save');
    expect(dialogTitles()).toEqual(['Move to another calendar owner?']);
    changeFieldsElsewhere({ location: 'New practice' });

    await click('Move');
    expect(server.writes).toEqual([
        { write: 'create', etag: 'v2' },
        { write: 'delete', etag: 'v1' },
    ]);
    expect(server.created).toMatchObject({ title: 'Dentist at noon', location: null });
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit event']);
    expect(titleField().value).toBe('Dentist at noon');

    await typeDescription('Bring the x-rays');
    await click('Save');
    await click('Move');
    expect(server.writes).toEqual([
        { write: 'create', etag: 'v2' },
        { write: 'delete', etag: 'v1' },
        { write: 'create', etag: 'v2' },
        { write: 'delete', etag: 'v2' },
    ]);
    expect(server.created).toMatchObject({
        title: 'Dentist at noon',
        location: 'New practice',
        description: 'Bring the x-rays',
    });
    expect(dialogTitles()).toEqual([]);
});

test('a cross-home move over a change the form has seen is refused like a 412, and writes nothing', async () => {
    server.shared = [teamCalendar];
    await openEdit();
    await typeTitle('Dentist at noon');
    await pickCalendar('Work', 'Team');
    changeFieldsElsewhere({ location: 'New practice' });
    await refetch();

    await click('Save');
    expect(server.writes).toEqual([]);
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit event']);
    expect(titleField().value).toBe('Dentist at noon');

    await click('Save');
    expect(server.writes).toEqual([
        { write: 'create', etag: 'v2' },
        { write: 'delete', etag: 'v2' },
    ]);
    expect(server.created).toMatchObject({ title: 'Dentist at noon', location: 'New practice' });
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual([]);
});

test('a refusal behind the move warning writes nothing and brings back the form', async () => {
    server.shared = [teamCalendar];
    server.event = { ...dentist, data: invited(['ada@example.org', 'pending']) };
    await openEdit();
    await typeTitle('Dentist at noon');
    await pickCalendar('Work', 'Team');
    await click('Save');
    changeFieldsElsewhere({ location: 'New practice' });
    await refetch();

    await click('Move');
    expect(server.writes).toEqual([]);
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit event']);
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
    // The truncation took this occurrence out of the list, and the dialog kept the rule it opened with.
    expect(server.created?.rrule).toBe('FREQ=WEEKLY');
});

test('this and following with typed edits over a change elsewhere is refused before it writes anything', async () => {
    server.event = { ...dentist, rrule: 'FREQ=WEEKLY' };
    await openEdit();
    await typeDescription('Bring the x-rays');
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
