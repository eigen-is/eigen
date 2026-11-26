// The month view draws the visible calendars' events and the shared ones, as many to a day as its row fits with a
// count of the rest. A deep link opens its event, a free/busy block opens nothing, deleting one occurrence of a series
// cancels that day alone, and a click on a day creates an event there. The previous and next buttons are named for
// the view, and a calendar's options button in the sidebar shows on hover only. The URL names the view and its day:
// a computer picks the view in the toolbar and a phone in the sidebar, both keeping the day, an unknown view or day is
// not found, and the start page picks the view for the device. The schedule lists only the days with events, opens an
// event's detail on a click, and says when the days are empty. The time grid draws a column per day under a link to that day, timed events as blocks at their minutes,
// multi-day all-day events as one bar, and the current time only while today is in view. Google's keys switch the
// view on the same day, go to today and open New event, and do nothing while a dialog is open. The sidebar's mini
// month sits under the calendar lists at full width, marks the view's days, browses months on its own, and opens a
// clicked day in the current view.
import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    CreateEventInput,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { expectKeyboardReveal } from '@workspace/ui/test/hover-reveal';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, so the toolbar shows its buttons rather than a kebab. happy-dom lays nothing out, so open() fires
// the observers itself.
const resizeCallbacks: (() => void)[] = [];
const { happyDOM } = installHappyDom({ onResizeObserver: (callback) => resizeCallbacks.push(callback) });
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
    resizeCallbacks.length = 0;
    const rendered = await renderInDocument(createElement(RouterProvider, { router }));
    unmount = rendered.unmount;
    // A month row 116px tall, which holds four lanes of events under its dates.
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 140, 116);
    await act(async () => {
        for (const callback of resizeCallbacks) callback();
    });
    HTMLElement.prototype.getBoundingClientRect = realRect;
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

test('a day holds the events its row fits, all-day first, and gives its last lane to the count of the rest', async () => {
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
    expect(pills(container)).toEqual(['Team sync', 'Holiday', 'Early', 'Noon']);
    expect(container.textContent).toContain('2 more');
});

test("an all-day pill's title is black on the pale fill, for a deep color too", async () => {
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
        expect.stringMatching(/(^|; )--surface-fg: #000;/),
        expect.stringMatching(/(^|; )--surface-fg: #000;/),
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

// Clicks a day of the grid and creates the event the New event dialog it opens names "Dentist".
async function createOnDay(container: HTMLElement, date: string, beforeSave = async () => {}) {
    const day = [...container.querySelectorAll('.grid-cols-7 > div.cursor-pointer')].find(
        (cell) => cell.firstElementChild?.textContent === date,
    );
    await click(day);
    expect(dialogTitle()).toBe('New event');

    const title = document.querySelector<HTMLInputElement>('input[placeholder="Add title"]');
    if (!title) throw new Error('the dialog has no title field');
    await type(title, '  Dentist  ');
    await beforeSave();
    await click(button('Create'));
    return createEvent.mutateAsync.mock.calls[0]?.[0];
}

// The default start is the next quarter hour of the wall clock, so each test pins the clock.
afterEach(() => setSystemTime());

test('a click on a day opens New event there, and Create makes it in the default calendar', async () => {
    setSystemTime(new Date(2026, 9, 27, 10, 7));
    const { container } = await open();
    const input = await createOnDay(container, '9');

    expect(createOwners.at(-1)).toBe('u1');
    expect(input).toMatchObject({
        calendarId: 'work',
        title: 'Dentist',
        allDay: false,
        description: null,
        location: null,
        rrule: null,
        timezone: realCalendar.viewerTimeZone(),
        data: undefined,
    });
    // toMatchObject would pass any Date against any other, so the times are compared on their own.
    expect({ startTime: input?.startTime, endTime: input?.endTime }).toEqual({
        startTime: new Date(2026, 9, 9, 10, 15),
        endTime: new Date(2026, 9, 9, 11, 15),
    });
    expect(dialogTitle()).toBeUndefined();
});

test('a new event made in the last hour of the day ends after midnight, on the next day', async () => {
    setSystemTime(new Date(2026, 9, 27, 23, 35));
    const { container } = await open();
    const input = await createOnDay(container, '9');

    expect(input?.startTime).toEqual(new Date(2026, 9, 9, 23, 45));
    expect(input?.endTime).toEqual(new Date(2026, 9, 10, 0, 45));
});

test('turning all day off late in the evening gives an hour that ends on the next day', async () => {
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
    expect(input?.endTime).toEqual(new Date(2026, 9, 10, 0, 45));
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
const VIEW_LABELS = ['Day', '3 days', 'Week', 'Month', 'Schedule'];

async function onPhone(run: () => Promise<void>) {
    happyDOM.setViewport({ width: 390, height: 844 });
    try {
        await run();
    } finally {
        happyDOM.setViewport({ width: 1440, height: 900 });
    }
}

test("on a computer the toolbar's select switches the view and keeps the day, and the sidebar has no view links", async () => {
    const { container, path } = await open('/view/month/2026-11-04');
    expect(VIEW_LABELS.filter((label) => viewLink(label))).toEqual([]);

    await click(document.querySelector('[data-slot="select-trigger"]'));
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(VIEW_LABELS);

    await click(options.find((option) => option.textContent === 'Week'));
    expect(path()).toBe('/view/week/2026-11-04');
    expect(container.textContent).toContain('2 – 8 Nov 2026');
});

test("on a phone the sidebar's views keep the focused day and mark the view, and the menu holds Today alone", () =>
    onPhone(async () => {
        const { path } = await open('/view/month/2026-11-04');
        expect(VIEW_LABELS.map((label) => viewLink(label)?.getAttribute('href'))).toEqual([
            '/view/day/2026-11-04',
            '/view/3day/2026-11-04',
            '/view/week/2026-11-04',
            '/view/month/2026-11-04',
            '/view/schedule/2026-11-04',
        ]);
        expect(viewLink('Month')?.getAttribute('data-status')).toBe('active');

        await click(document.querySelector('button[aria-label="View options"]'));
        expect(
            [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => item.textContent),
        ).toEqual(['Today']);
        expect(document.querySelector('[data-slot="select-trigger"]')).toBeNull();

        await click(viewLink('Week'));
        expect(path()).toBe('/view/week/2026-11-04');
        expect(viewLink('Week')?.getAttribute('data-status')).toBe('active');
        expect(viewLink('Month')?.getAttribute('data-status')).toBeNull();
    }));

// The sidebar's mini month: its caption, and its day cells by day key.
const miniCaption = () => document.querySelector('.rdp-caption_label')?.textContent;
const miniDays = () => [...document.querySelectorAll<HTMLElement>('td[data-day]')];
const miniDay = (key: string) => document.querySelector(`td[data-day="${key}"] button`);

test('the mini month shows the focused month from Monday, with today in the app color', async () => {
    setSystemTime(new Date(2026, 10, 24, 10));
    await open('/view/week/2026-11-04');
    expect(miniCaption()).toBe('November 2026');
    expect([...document.querySelectorAll('.rdp-weekday')].map((day) => day.textContent)).toEqual([
        'M',
        'T',
        'W',
        'T',
        'F',
        'S',
        'S',
    ]);
    expect(miniDays()[0]?.dataset.day).toBe('2026-10-26');
    expect(document.querySelector('td[data-today]')?.className).toContain('[&>button]:bg-(--app-current-color)');
});

test('a click on a day of the mini month opens that day in the current view', async () => {
    const { path } = await open('/view/3day/2026-11-04');
    await click(miniDay('2026-11-19'));
    expect(path()).toBe('/view/3day/2026-11-19');
});

test("the mini month's arrows show another month and leave the view where it is", async () => {
    const { path } = await open('/view/week/2026-11-04');
    await click(document.querySelector('button[aria-label="Show next month"]'));
    expect(miniCaption()).toBe('December 2026');
    await click(document.querySelector('button[aria-label="Show previous month"]'));
    await click(document.querySelector('button[aria-label="Show previous month"]'));
    expect(miniCaption()).toBe('October 2026');
    expect(path()).toBe('/view/week/2026-11-04');

    await click(document.querySelector('button[aria-label="Next week"]'));
    expect(path()).toBe('/view/week/2026-11-11');
    expect(miniCaption()).toBe('November 2026');
});

test('the mini month marks the week a week view shows', async () => {
    await open('/view/week/2026-11-04');
    expect(
        miniDays()
            .filter((cell) => cell.classList.contains('bg-muted'))
            .map((cell) => cell.dataset.day),
    ).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
});

test('the sidebar has no Recent files row, and the mini month sits under the calendar lists at full width', async () => {
    const { container } = await open('/view/week/2026-11-04');
    expect(container.textContent).not.toContain('Recent files');
    const lists = [...document.querySelectorAll('h3')].find((heading) => heading.textContent === 'My calendars');
    const month = document.querySelector('.rdp-root');
    if (!lists || !month) throw new Error('the sidebar has no calendar list or mini month');
    expect(lists.compareDocumentPosition(month) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(month.classList.contains('w-full')).toBe(true);
    expect(document.querySelector('.rdp-month_grid')?.classList.contains('w-full')).toBe(true);
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
    await onPhone(async () => {
        const { path } = await open('/');
        expect(path()).toBe('/view/3day/2026-11-24');
    });
});

// The time grid's date links, one per day column, in order.
const dayLinks = (container: HTMLElement) =>
    [...container.querySelectorAll('a[href^="/view/day/"]')].map((a) => [a.getAttribute('href'), a.textContent]);

test('a week is seven day columns, each date linking to its day view', async () => {
    const { container } = await open('/view/week/2026-10-14');
    expect(dayLinks(container)).toEqual([
        ['/view/day/2026-10-12', 'MON12'],
        ['/view/day/2026-10-13', 'TUE13'],
        ['/view/day/2026-10-14', 'WED14'],
        ['/view/day/2026-10-15', 'THU15'],
        ['/view/day/2026-10-16', 'FRI16'],
        ['/view/day/2026-10-17', 'SAT17'],
        ['/view/day/2026-10-18', 'SUN18'],
    ]);
});

test('a day is one column and 3 days are three', async () => {
    const day = await open('/view/day/2026-10-13');
    expect(dayLinks(day.container).map(([href]) => href)).toEqual(['/view/day/2026-10-13']);
    await unmount();
    const three = await open('/view/3day/2026-10-13');
    expect(dayLinks(three.container).map(([href]) => href)).toEqual([
        '/view/day/2026-10-13',
        '/view/day/2026-10-14',
        '/view/day/2026-10-15',
    ]);
});

test('a timed event is a block at its minutes, with its title, time and place', async () => {
    ownEvents.data = [
        event({
            title: 'Planning',
            startTime: at(13, 9),
            endTime: new Date(2026, 9, 13, 10, 30),
            location: 'Room 4',
        }),
    ];
    const { container } = await open('/view/day/2026-10-13');
    const block = pill(container, 'Planning');
    expect(block?.textContent).toBe('Planning09:00 – 10:30Room 4');
    expect(block?.getAttribute('style')).toContain('top: 432px; height: 71px;');
});

test('a short block puts its title and start on one line', async () => {
    ownEvents.data = [event({ title: 'Call', startTime: at(13, 9), endTime: new Date(2026, 9, 13, 9, 30) })];
    const { container } = await open('/view/day/2026-10-13');
    expect(pill(container, 'Call')?.textContent).toBe('Call, 09:00');
});

test('an all-day event over three days is one bar across them', async () => {
    ownEvents.data = [
        event({
            title: 'Retreat',
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 13)),
            endTime: new Date(Date.UTC(2026, 9, 16)),
        }),
    ];
    const { container } = await open('/view/week/2026-10-14');
    const bars = container.querySelectorAll('[title="Retreat"]');
    expect(bars.length).toBe(1);
    expect(bars[0]?.getAttribute('style')).toContain('grid-column: 2 / span 3');
});

test('the all-day lane shows three rows and counts the rest, until "N more" opens them all', async () => {
    ownEvents.data = ['Ada', 'Bo', 'Cy', 'Di'].map((title) =>
        event({
            title,
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 13)),
            endTime: new Date(Date.UTC(2026, 9, 14)),
        }),
    );
    const { container } = await open('/view/day/2026-10-13');
    expect(pill(container, 'Di')).toBeNull();
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === '2 more'));
    expect(pill(container, 'Di')).not.toBeNull();
});

test("a click on a block opens the event's detail", async () => {
    ownEvents.data = [event({ title: 'Review', startTime: at(13, 14) })];
    const { container } = await open('/view/day/2026-10-13');
    await click(pill(container, 'Review'));
    expect(dialogTitle()).toBe('Review');
});

test('a declined invitation is struck through', async () => {
    ownEvents.data = [
        event({
            title: 'Offsite',
            startTime: at(13, 11),
            data: {
                organizer: { email: 'boss@test.eigen.is' },
                attendees: [{ email: 'me@test.eigen.is', status: 'declined', role: 'required' }],
            },
        }),
    ];
    const { container } = await open('/view/day/2026-10-13');
    expect(pill(container, 'Offsite')?.classList.contains('line-through')).toBe(true);
});

test('the current time shows only while today is in view', async () => {
    setSystemTime(new Date(2026, 9, 14, 14, 19));
    const thisWeek = await open('/view/week/2026-10-13');
    expect(thisWeek.container.textContent).toContain('14:19');
    await unmount();
    const nextWeek = await open('/view/week/2026-10-20');
    expect(nextWeek.container.textContent).not.toContain('14:19');
});

// A day column of the grid's hours. happy-dom has no layout, so a column's top is at 0 and clientY is its pixel.
const HOUR = 48;
const dayColumn = (container: HTMLElement, index = 0) => {
    const column = container.querySelectorAll('.overflow-y-auto .border-l')[index];
    if (!column) throw new Error(`the grid has no column ${index}`);
    return column;
};
const pointer = (target: EventTarget, type: string, clientY: number, pointerType = 'mouse') =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientY, pointerType, pointerId: 1 }));
// A press at `from` released at `to`, with the click the browser sends after it; `between` runs once React drew the move.
async function press(column: Element, from: number, to: number, pointerType = 'mouse', between = () => {}) {
    await act(async () => {
        pointer(column, 'pointerdown', from, pointerType);
        if (to !== from) pointer(document, 'pointermove', to, pointerType);
    });
    await act(async () => between());
    await act(async () => {
        pointer(column, 'pointerup', to, pointerType);
        column.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: to }));
    });
}

// The times New event saves. toMatchObject would pass any Date against any other, so they are compared whole.
async function savedTimes() {
    expect(dialogTitle()).toBe('New event');
    const title = document.querySelector<HTMLInputElement>('input[placeholder="Add title"]');
    if (!title) throw new Error('the dialog has no title field');
    await type(title, 'Focus');
    await click(button('Create'));
    const input = createEvent.mutateAsync.mock.calls[0]?.[0];
    return { startTime: input?.startTime, endTime: input?.endTime, allDay: input?.allDay };
}

test('a click on an empty slot opens New event at its quarter hour, an hour long', async () => {
    const { container } = await open('/view/day/2026-10-13');
    await press(dayColumn(container), 10 * HOUR + 10, 10 * HOUR + 10);
    expect(await savedTimes()).toEqual({ startTime: at(13, 10), endTime: at(13, 11), allDay: false });
});

test('a drag over a day column draws the range and opens New event with it', async () => {
    const { container } = await open('/view/week/2026-10-14');
    const column = dayColumn(container, 2);
    let drawn = '';
    await press(column, 10 * HOUR, 11.5 * HOUR, 'mouse', () => {
        drawn = column.textContent ?? '';
    });
    expect(drawn).toContain('(No title)10:00 – 11:30');
    expect(column.textContent).not.toContain('(No title)');
    expect(await savedTimes()).toEqual({
        startTime: at(14, 10),
        endTime: new Date(2026, 9, 14, 11, 30),
        allDay: false,
    });
});

test('Escape during a drag drops the range and opens nothing', async () => {
    const { container } = await open('/view/day/2026-10-13');
    const column = dayColumn(container);
    await press(column, 10 * HOUR, 12 * HOUR, 'mouse', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(column.textContent).not.toContain('(No title)');
    expect(dialogTitle()).toBeUndefined();
});

test('a right-button press draws no range', async () => {
    const { container } = await open('/view/day/2026-10-13');
    const column = dayColumn(container);
    await act(async () => {
        column.dispatchEvent(
            new PointerEvent('pointerdown', {
                bubbles: true,
                button: 2,
                clientY: 9 * HOUR,
                pointerType: 'mouse',
                pointerId: 1,
            }),
        );
        pointer(document, 'pointermove', 12 * HOUR);
    });
    expect(column.textContent).not.toContain('(No title)');
});

test('a finger does not drag: its tap opens the slot it pressed', async () => {
    const { container } = await open('/view/day/2026-10-13');
    const column = dayColumn(container);
    await act(async () => {
        pointer(column, 'pointerdown', 9 * HOUR, 'touch');
        pointer(document, 'pointermove', 12 * HOUR, 'touch');
    });
    const drawn = column.textContent;
    await act(async () => {
        pointer(column, 'pointerup', 9 * HOUR, 'touch');
        column.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 9 * HOUR }));
    });
    expect(drawn).not.toContain('(No title)');
    expect(await savedTimes()).toEqual({ startTime: at(13, 9), endTime: at(13, 10), allDay: false });
});

test('a click on an empty spot of the all-day lane opens an all-day New event on that day', async () => {
    ownEvents.data = [
        event({
            title: 'Holiday',
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 12)),
            endTime: new Date(Date.UTC(2026, 9, 13)),
        }),
    ];
    const { container } = await open('/view/week/2026-10-14');
    const lane = container.querySelectorAll('.border-b > .grid')[1];
    if (!lane) throw new Error('the grid has no all-day lane');
    lane.getBoundingClientRect = () => new DOMRect(0, 0, 700, 24);
    await act(async () => {
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 250 }));
    });
    expect(await savedTimes()).toEqual({
        startTime: new Date(Date.UTC(2026, 9, 14)),
        endTime: new Date(Date.UTC(2026, 9, 15)),
        allDay: true,
    });
});

test('a 15-minute block is tall enough for its line of text', async () => {
    ownEvents.data = [event({ title: 'Standup', startTime: at(13, 9), endTime: new Date(2026, 9, 13, 9, 15) })];
    const { container } = await open('/view/day/2026-10-13');
    const block = pill(container, 'Standup');
    if (!(block instanceof HTMLElement)) throw new Error('the grid has no Standup block');
    // One 16px line inside 2px of padding above and below.
    expect(Number.parseFloat(block.style.height)).toBeGreaterThanOrEqual(20);
});

test('an empty week still has an all-day lane, and a click there opens an all-day New event', async () => {
    const { container } = await open('/view/week/2026-10-14');
    const lane = container.querySelectorAll('.border-b > .grid')[1];
    if (!lane) throw new Error('the grid has no all-day lane');
    lane.getBoundingClientRect = () => new DOMRect(0, 0, 700, 24);
    await act(async () => {
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }));
    });
    expect(await savedTimes()).toEqual({
        startTime: new Date(Date.UTC(2026, 9, 12)),
        endTime: new Date(Date.UTC(2026, 9, 13)),
        allDay: true,
    });
});

test('in dark mode a block, a bar and a drawn range leave room after their color stripe', async () => {
    ownEvents.data = [
        event({ title: 'Review', startTime: at(14, 14) }),
        event({
            title: 'Retreat',
            allDay: true,
            startTime: new Date(Date.UTC(2026, 9, 13)),
            endTime: new Date(Date.UTC(2026, 9, 16)),
        }),
    ];
    const { container } = await open('/view/week/2026-10-14');
    expect(pill(container, 'Review')?.classList).toContain('dark:pl-2');
    expect(pill(container, 'Retreat')?.classList).toContain('dark:pl-2');
    const column = dayColumn(container, 2);
    let draftClasses = '';
    await press(column, 10 * HOUR, 11 * HOUR, 'mouse', () => {
        draftClasses = column.querySelector('.pointer-events-none')?.className ?? '';
    });
    expect(draftClasses.split(' ')).toContain('dark:pl-2');
});

const typeKey = (key: string) =>
    act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });

test('m goes to the month of the same day, and t to today', async () => {
    setSystemTime(new Date(2026, 10, 24, 9));
    const { path } = await open('/view/week/2026-10-14');
    await typeKey('m');
    expect(path()).toBe('/view/month/2026-10-14');
    await typeKey('t');
    expect(path()).toBe('/view/month/2026-11-24');
});

test('c opens New event at the next quarter hour of today, an hour long', async () => {
    setSystemTime(new Date(2026, 9, 27, 10, 7));
    await open('/view/week/2026-10-14');
    await typeKey('c');
    expect(await savedTimes()).toEqual({
        startTime: new Date(2026, 9, 27, 10, 15),
        endTime: new Date(2026, 9, 27, 11, 15),
        allDay: false,
    });
});

test('while a dialog is open the keys do nothing', async () => {
    const { path } = await open('/view/week/2026-10-14');
    await typeKey('c');
    expect(dialogTitle()).toBe('New event');
    for (const key of ['m', 'j', 'ArrowRight', 't']) await typeKey(key);
    expect(path()).toBe('/view/week/2026-10-14');
});

test('while a menu or the view select is open the keys do nothing', async () => {
    for (const trigger of ['[aria-label="Calendar options"]', '[data-slot="select-trigger"]']) {
        const { path } = await open('/view/week/2026-10-14');
        await click(document.querySelector(trigger));
        expect(document.querySelector('[role="menu"], [role="listbox"]')).not.toBeNull();
        for (const key of ['d', 'ArrowRight']) await typeKey(key);
        expect(path()).toBe('/view/week/2026-10-14');
        await unmount();
    }
});
