// The month view draws the visible calendars' events and the shared ones, four to a day with a count of the
// rest. A deep link opens its event, a free/busy block opens nothing, deleting one occurrence of a series
// cancels that day alone, and a click on a day creates an event there. The previous and next buttons are named for
// the view, and a calendar's options button in the sidebar shows on hover only. The URL names the view and its day:
// the sidebar's views keep the day, an unknown view or day is not found, and the start page picks the view for the
// device. The schedule lists only the days with events, opens an event's detail on a click, and says when the days are
// empty.
import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    CreateEventInput,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { expectKeyboardReveal } from '@workspace/ui/test/hover-reveal';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, so the toolbar shows its buttons rather than a kebab.
const { happyDOM } = installHappyDom();
happyDOM.setViewport({ width: 1440, height: 900 });

const created = new Date('2026-10-01T00:00:00Z');
const calendar = (id: string, name: string, visible: boolean): CalendarItem => ({
    id,
    name,
    color: '#3b82f6',
    isDefault: id === 'work',
    visible,
    ctag: 1,
    shares: null,
    createdAt: created,
    updatedAt: created,
});
const event = (p: Partial<CalendarEventOccurrence> & { title: string; startTime: Date }): CalendarEventOccurrence => ({
    id: p.title,
    calendarId: 'work',
    uid: `${p.title}@eigen`,
    uri: `${p.title}.ics`,
    description: null,
    location: null,
    endTime: new Date(p.startTime.getTime() + 3600_000),
    allDay: false,
    rrule: null,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'e1',
    data: null,
    createByUserId: 'u1',
    createdAt: created,
    updatedAt: created,
    occurrenceDate: p.startTime.toISOString().slice(0, 10),
    ...p,
});
// A timed event is at a wall-clock hour, so it lands on the same day in any zone the tests run in.
const at = (day: number, hour: number) => new Date(2026, 9, day, hour);

const shared: SharedCalendar = {
    id: 'sc1',
    ownerUserId: 'u2',
    calendarId: 'team-cal',
    calendarName: 'Team',
    calendarColor: '#22c55e',
    permission: 'read',
    color: null,
    visible: true,
    createdAt: created,
    updatedAt: created,
};

// The route's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// Work is the default calendar but not the first, so a new event that lands in it was put there on purpose.
const calendars = {
    data: [calendar('personal', 'Personal', true), calendar('work', 'Work', true), calendar('hidden', 'Hidden', false)],
};
const sharedCalendars = { data: [shared] };
const ownEvents: { data: CalendarEventOccurrence[]; isLoading: boolean } = { data: [], isLoading: false };
const sharedEvents = { data: [event({ title: 'Team sync', calendarId: 'team-cal', startTime: at(14, 9) })] };
const createEvent = { mutateAsync: mock(async (_input: CreateEventInput) => {}), isPending: false };
const createOwners: string[] = [];
const deleteEvent = { mutateAsync: mock(async (_input: { id: string; calendarId: string }) => {}), isPending: false };

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useCalendars: () => calendars,
    useSharedCalendars: () => sharedCalendars,
    useEvents: () => ownEvents,
    useAllSharedCalendarEvents: () => sharedEvents,
    useCreateEvent: (ownerId: string) => {
        createOwners.push(ownerId);
        return createEvent;
    },
    useDeleteEvent: () => deleteEvent,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/calendar', () => realCalendar);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    ownEvents.data = [];
    ownEvents.isLoading = false;
    createEvent.mutateAsync.mockClear();
    deleteEvent.mutateAsync.mockClear();
    createOwners.length = 0;
});

const OCTOBER = '/view/month/2026-10-15';

async function open(url = OCTOBER) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth },
    });
    await router.load();
    const rendered = await renderInDocument(createElement(RouterProvider, { router }));
    unmount = rendered.unmount;
    return {
        container: rendered.container,
        path: () => router.state.location.pathname,
        search: () => router.state.location.search,
    };
}

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

// The grid's event pills by title, in the order the days and their slots draw them.
const pills = (container: HTMLElement) =>
    [...container.querySelectorAll('.grid-cols-7 [title]')].map((pill) => pill.getAttribute('title'));
const pill = (container: HTMLElement, title: string) => container.querySelector(`[title="${title}"]`);
const dialogTitle = () => document.querySelector('[role="dialog"] h2')?.textContent;
const button = (label: string) =>
    [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label);

test("the month shows the visible calendars' events and the shared ones, never a hidden calendar's", async () => {
    ownEvents.data = [
        event({ title: 'Standup', startTime: at(13, 9) }),
        event({ title: 'Secret', calendarId: 'hidden', startTime: at(13, 10) }),
    ];
    const { container } = await open();
    expect(pills(container)).toEqual(['Standup', 'Team sync']);
});

test('a day holds four events, all-day first, and counts the rest', async () => {
    ownEvents.data = [
        event({ title: 'Late', startTime: at(20, 16) }),
        event({ title: 'Early', startTime: at(20, 8) }),
        event({ title: 'Noon', startTime: at(20, 12) }),
        event({ title: 'Evening', startTime: at(20, 18) }),
        event({
            title: 'Holiday',
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 20)),
            endTime: new Date(Date.UTC(2026, 9, 21)),
        }),
    ];
    const { container } = await open();
    expect(pills(container)).toEqual(['Team sync', 'Holiday', 'Early', 'Noon', 'Late']);
    expect(container.textContent).toContain('1 more');
});

test("an all-day pill's title is black on a light color and white on a dark one", async () => {
    const allDay = (title: string, color: string) =>
        event({
            title,
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 20)),
            endTime: new Date(Date.UTC(2026, 9, 21)),
            data: { color },
        });
    ownEvents.data = [allDay('Pale', '#fef9c2'), allDay('Deep', '#193cb8')];
    const { container } = await open();
    expect([pill(container, 'Pale'), pill(container, 'Deep')].map((p) => p?.getAttribute('style'))).toEqual([
        expect.stringMatching(/(^|; )color: #000;/),
        expect.stringMatching(/(^|; )color: #fff;/),
    ]);
});

test('while the events load the grid waits', async () => {
    ownEvents.isLoading = true;
    const { container } = await open();
    expect(container.textContent).not.toContain('MON');
});

test('the previous and next buttons are named for the view', async () => {
    const { container } = await open();
    const named = (name: string) => container.querySelector(`button[aria-label="${name}"]`);
    expect([named('Previous month'), named('Next month')]).toEqual([
        expect.any(HTMLButtonElement),
        expect.any(HTMLButtonElement),
    ]);
});

test('the next button moves to the same day of the next month', async () => {
    const { container, path } = await open();
    await click(container.querySelector('button[aria-label="Next month"]'));
    expect(path()).toBe('/view/month/2026-11-15');
});

test("a deep link opens the event it names, by its organizer's id too", async () => {
    ownEvents.data = [
        event({ title: 'Review', startTime: at(22, 14), data: { organizerEventId: 'organizer-event-1' } }),
    ];
    await open(`${OCTOBER}?eventId=organizer-event-1`);
    expect(dialogTitle()).toBe('Review');
});

test('a free/busy block opens no detail', async () => {
    ownEvents.data = [event({ id: '', title: 'Busy until 10:00', startTime: at(22, 9) })];
    const { container } = await open();
    await click(pill(container, 'Busy until 10:00'));
    expect(dialogTitle()).toBeUndefined();
});

test('deleting one occurrence of a series cancels that day and keeps the series', async () => {
    ownEvents.data = [
        event({ title: 'Weekly', startTime: at(22, 9), rrule: 'FREQ=WEEKLY', occurrenceDate: '2026-10-22' }),
    ];
    const { container } = await open();
    await click(pill(container, 'Weekly'));
    await click(document.querySelector('[role="dialog"] .lucide-trash-2')?.closest('button'));
    expect(dialogTitle()).toBe('Delete recurring event');
    await click(button('OK'));

    expect(deleteEvent.mutateAsync).not.toHaveBeenCalled();
    expect(createEvent.mutateAsync).toHaveBeenCalledWith({
        calendarId: 'work',
        title: 'Weekly',
        startTime: at(22, 9),
        endTime: at(22, 10),
        allDay: false,
        parentEventId: 'Weekly',
        recurrenceDate: '2026-10-22',
        status: 'cancelled',
        etag: 'e1',
    });
});

// Clicks a day of the grid and saves the New event dialog it opens as "Dentist".
async function createOnDay(container: HTMLElement, date: string, beforeSave = async () => {}) {
    const day = [...container.querySelectorAll('.grid-cols-7 > div.cursor-pointer')].find(
        (cell) => cell.firstElementChild?.textContent === date,
    );
    await click(day);
    expect(dialogTitle()).toBe('New event');
    expect(button('Save')?.hasAttribute('disabled')).toBe(true);

    const title = document.querySelector<HTMLInputElement>('input[placeholder="Add title"]');
    if (!title) throw new Error('the dialog has no title field');
    await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setValue?.call(title, '  Dentist  ');
        title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await beforeSave();
    await click(button('Save'));
    return createEvent.mutateAsync.mock.calls[0]?.[0];
}

// The default start is the next quarter hour of the wall clock, so each test pins the clock.
afterEach(() => setSystemTime());

test('a click on a day opens New event there, and Save creates it in the default calendar', async () => {
    setSystemTime(new Date(2026, 9, 27, 10, 7));
    const { container } = await open();
    const input = await createOnDay(container, '9');

    expect(createOwners.at(-1)).toBe('u1');
    expect(input).toMatchObject({
        calendarId: 'work',
        title: 'Dentist',
        startTime: new Date(2026, 9, 9, 10, 15),
        endTime: new Date(2026, 9, 9, 10, 45),
        allDay: false,
        description: null,
        location: null,
        rrule: null,
        timezone: realCalendar.viewerTimeZone(),
        data: undefined,
    });
    expect(dialogTitle()).toBeUndefined();
});

test('a new event made in the last half hour of the day ends after midnight, on the next day', async () => {
    setSystemTime(new Date(2026, 9, 27, 23, 35));
    const { container } = await open();
    const input = await createOnDay(container, '9');

    expect(input?.startTime).toEqual(new Date(2026, 9, 9, 23, 45));
    expect(input?.endTime).toEqual(new Date(2026, 9, 10, 0, 15));
});

test('turning all day off late in the evening gives a half hour that ends on the next day', async () => {
    setSystemTime(new Date(2026, 9, 27, 10, 7));
    const { container } = await open();
    const allDay = () => document.querySelector('[role="dialog"] [role="checkbox"]');
    const input = await createOnDay(container, '9', async () => {
        await click(allDay());
        setSystemTime(new Date(2026, 9, 27, 23, 35));
        await click(allDay());
    });

    expect(input?.allDay).toBe(false);
    expect(input?.startTime).toEqual(new Date(2026, 9, 9, 23, 45));
    expect(input?.endTime).toEqual(new Date(2026, 9, 10, 0, 15));
});

test("a calendar's options button shows on the row's hover only, and Tab reaches and shows it", async () => {
    await open();
    const kebab = document.querySelector('button[aria-label="Calendar options"]');
    if (!kebab) throw new Error('the calendar row has no options button');
    expectKeyboardReveal(kebab);
});

// The sidebar's link to a view, by its label.
const viewLink = (label: string) =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/view/"]')].find((a) => a.textContent === label);

test('switching month to week from the sidebar keeps the focused day, and marks the view it is on', async () => {
    const { container, path } = await open('/view/month/2026-11-04');
    expect(
        ['Day', '3 days', 'Week', 'Month', 'Schedule'].map((label) => viewLink(label)?.getAttribute('href')),
    ).toEqual([
        '/view/day/2026-11-04',
        '/view/3day/2026-11-04',
        '/view/week/2026-11-04',
        '/view/month/2026-11-04',
        '/view/schedule/2026-11-04',
    ]);
    expect(viewLink('Month')?.getAttribute('data-status')).toBe('active');

    await click(viewLink('Week'));
    expect(path()).toBe('/view/week/2026-11-04');
    expect(container.textContent).toContain('2 – 8 Nov 2026');
    expect(viewLink('Week')?.getAttribute('data-status')).toBe('active');
    expect(viewLink('Month')?.getAttribute('data-status')).toBeNull();
});

test('3 days show the focused day and the two after it, and step by three', async () => {
    ownEvents.data = [
        event({ title: 'Before', startTime: at(12, 9) }),
        event({ title: 'First', startTime: at(13, 9) }),
        event({ title: 'Last', startTime: at(15, 9) }),
        event({ title: 'After', startTime: at(16, 9) }),
    ];
    const { container, path } = await open('/view/3day/2026-10-13');
    expect(container.textContent).toContain('13 – 15 Oct 2026');
    expect(['Before', 'First', 'Last', 'After'].map((name) => !!pill(container, name))).toEqual([
        false,
        true,
        true,
        false,
    ]);
    await click(container.querySelector('button[aria-label="Next 3 days"]'));
    expect(path()).toBe('/view/3day/2026-10-16');
});

test('a day shows that day alone', async () => {
    ownEvents.data = [
        event({ title: 'Today', startTime: at(13, 9) }),
        event({ title: 'Tomorrow', startTime: at(14, 9) }),
    ];
    const { container } = await open('/view/day/2026-10-13');
    expect(container.textContent).toContain('Tuesday, 13 Oct 2026');
    expect([!!pill(container, 'Today'), !!pill(container, 'Tomorrow')]).toEqual([true, false]);
});

// The schedule's day headings and the titles of its rows, in the order they draw.
const scheduleDays = (container: HTMLElement) =>
    [...container.querySelectorAll('section h3')].map((h) => h.textContent);
const scheduleRow = (title: string) =>
    [...document.querySelectorAll('li button')].find((row) => row.textContent?.includes(title));

test('a schedule lists only the days with events, all-day first, and a multi-day event on each of its days', async () => {
    ownEvents.data = [
        event({ title: 'Before', startTime: at(12, 9) }),
        event({ title: 'Late', startTime: at(20, 16), location: 'Room 4' }),
        event({ title: 'Early', startTime: at(20, 8) }),
        event({
            title: 'Retreat',
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 20)),
            endTime: new Date(Date.UTC(2026, 9, 22)),
        }),
    ];
    const { container } = await open('/view/schedule/2026-10-13');
    expect(container.textContent).toContain('13 Oct – 9 Nov 2026');
    expect(scheduleDays(container)).toEqual(['14Oct, Wed', '20Oct, Tue', '21Oct, Wed']);
    expect(scheduleRow('Retreat')?.textContent).toBe('All dayRetreat');
    expect(scheduleRow('Late')?.textContent).toBe('16:00 – 17:00LateRoom 4');
    expect([...container.querySelectorAll('li button')].map((row) => row.textContent)).toEqual([
        '09:00 – 10:00Team sync',
        'All dayRetreat',
        '08:00 – 09:00Early',
        '16:00 – 17:00LateRoom 4',
        'All dayRetreat',
    ]);
});

test("a click on a schedule row opens the event's detail", async () => {
    ownEvents.data = [event({ title: 'Review', startTime: at(22, 14) })];
    await open('/view/schedule/2026-10-13');
    await click(scheduleRow('Review'));
    expect(dialogTitle()).toBe('Review');
});

test('a schedule with no events in its 28 days says nothing is planned', async () => {
    const { container } = await open('/view/schedule/2026-11-20');
    expect(scheduleDays(container)).toEqual([]);
    expect(container.textContent).toContain('Nothing planned');
});

test.each([
    ['an unknown mode', '/view/year/2026-11-24'],
    ['an impossible day', '/view/week/2026-02-30'],
    ['an old timestamp range', '/view/month/1793487600/1797116399'],
])('%s is the not-found page', async (_, url) => {
    const { container } = await open(url);
    expect(container.textContent).toContain('Not Found');
    expect(container.querySelector('button[aria-label^="Next"]')).toBeNull();
});

test('the start page opens a week on the linked day, and the event it names', async () => {
    ownEvents.data = [
        event({ title: 'Review', startTime: at(22, 14), data: { organizerEventId: 'organizer-event-1' } }),
    ];
    const { path, search } = await open('/?date=2026-10-22&eventId=organizer-event-1');
    expect(path()).toBe('/view/week/2026-10-22');
    expect(search()).toEqual({ eventId: 'organizer-event-1' });
    expect(dialogTitle()).toBe('Review');
});

test('the start page opens today without a date, and on a phone 3 days', async () => {
    setSystemTime(new Date(2026, 10, 24, 9));
    happyDOM.setViewport({ width: 390, height: 844 });
    try {
        const { path } = await open('/');
        expect(path()).toBe('/view/3day/2026-11-24');
    } finally {
        happyDOM.setViewport({ width: 1440, height: 900 });
    }
});
