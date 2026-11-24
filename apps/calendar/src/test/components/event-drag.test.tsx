// Dragging an event in the time grid and the month, through the real hooks against a server stub that judges etags as
// the API does. A mouse or pen moves a block across days and minutes, resizes its end and moves a bar or chip by days;
// a press that never travels opens the detail, Escape snaps back, and a finger or an event the viewer may not change
// never drags. A drop of one event saves at once with the list's etag, a series asks which events first, by the
// owner's rule for another day, and an event with guests asks before it mails them. A refused drop reloads and toasts,
// and inside the recurring choice the next OK sends the reloaded etag.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// happy-dom lays nothing out, so open() fires the month row's observer itself.
const resizeCallbacks: (() => void)[] = [];
installHappyDom({ onResizeObserver: (callback) => resizeCallbacks.push(callback) });

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
// A timed event is at a wall-clock hour, so it lands on the same day in any zone the tests run in.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
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
    etag: 'v1',
    data: null,
    createByUserId: USER,
    createdAt: created,
    updatedAt: created,
    occurrenceDate: p.startTime.toISOString().slice(0, 10),
    ...p,
});
const review = event({ title: 'Review', startTime: at(13, 10) });
const standup = event({ title: 'Standup', startTime: at(13, 9), rrule: 'FREQ=DAILY' });
const withGuests = event({
    title: 'Planning',
    startTime: at(13, 10),
    data: {
        organizer: { email: 'me@test.eigen.is' },
        attendees: [{ email: 'ada@else.test', status: 'pending', role: 'required' }],
    },
});
const invitation = event({
    title: 'Offsite',
    startTime: at(13, 10),
    data: {
        organizer: { email: 'boss@else.test' },
        attendees: [{ email: 'me@test.eigen.is', status: 'accepted', role: 'required' }],
    },
});
// What a calendar shared as free/busy shows: a block with no event behind it.
const busyShare: SharedCalendar = {
    id: 'share1',
    ownerUserId: 'u2',
    calendarId: 'their',
    calendarName: 'Theirs',
    calendarColor: '#22c55e',
    permission: 'free-busy',
    color: null,
    visible: true,
    createdAt: created,
    updatedAt: created,
};
const freeBusy = event({ title: 'Busy', id: '', calendarId: 'their', etag: '', startTime: at(13, 14) });

// The events on the server, and every write that reached it with the etag and times it carried.
const server = {
    events: [] as CalendarEventOccurrence[],
    revision: 1,
    writes: [] as { write: string; etag: string | undefined; startTime?: Date; endTime?: Date }[],
    // A write waits for this before it answers, so a test can look while it runs.
    held: Promise.resolve(),
};
const refused = (status: number) => ({ data: null, error: { status, value: 'Refused' }, status });
const answered = <T,>(data: T) => ({ data, error: null, status: 200 });
const changeElsewhere = (id: string) => {
    server.revision += 1;
    const etag = `v${server.revision}`;
    server.events = server.events.map((e) => (e.id === id ? { ...e, title: `${e.title}, changed`, etag } : e));
};
const writeEvent = async (write: string, id: string, etag: string | undefined, fields: Partial<CalendarEvent>) => {
    server.writes.push({ write, etag, startTime: fields.startTime, endTime: fields.endTime });
    await server.held;
    const stored = server.events.find((e) => e.id === id);
    if (!stored || etag !== stored.etag) return refused(412);
    server.revision += 1;
    const saved = { ...stored, ...fields, etag: `v${server.revision}` };
    server.events = server.events.map((e) => (e.id === id ? saved : e));
    return answered(saved);
};
const calendarApi = () => ({
    'event-range': () => () => ({ get: async () => answered(server.events.map((e) => ({ ...e }))) }),
    calendars: () => ({
        events: Object.assign(
            ({ id }: { id: string }) => ({
                get: async () => answered(server.events.find((e) => e.id === id)),
                put: ({ etag, ...fields }: Partial<CalendarEvent>) => writeEvent('update', id, etag, fields),
            }),
            {
                // An override is judged against its series and lands in it; its times stay the stub's own.
                post: ({ etag, parentEventId, startTime, endTime }: Partial<CalendarEvent>) =>
                    writeEvent('override', parentEventId ?? '', etag, { startTime, endTime }),
            },
        ),
    }),
});

const session = { user: { id: USER, email: 'me@test.eigen.is', name: 'Me' } };
const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realApi = { ...(await import('@workspace/lib/api')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/api', () => ({ ...realApi, calendarApi }));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/api', () => realApi);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('sonner', () => realSonner);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { useEvents, viewDays } = await import('@workspace/lib/calendar');
const { MonthView } = await import('../../components/month-view');
const { TimeGrid } = await import('../../components/time-grid');

const WEEK = viewDays('week', at(14, 0));
const OCTOBER = at(1, 0);
// The list as a view gets it, with a free/busy block a shared calendar adds.
function Page({ month }: { month: boolean }) {
    const { data = [] } = useEvents(USER, 1, 2);
    const events = [...data, freeBusy];
    const props = { events, calendars: [work], sharedCalendars: [busyShare] };
    return month
        ? createElement(MonthView, { focus: OCTOBER, ...props, onDayClick: () => {} })
        : createElement(TimeGrid, { days: WEEK, ...props, onCreateEvent: () => {} });
}

// happy-dom lays nothing out, so every box sits at 0,0: the grid's seven columns are 100px wide and clientY is its
// pixel at 48px an hour, and the month's five week rows are 120px tall.
const HOUR = 48;
const realRect = HTMLElement.prototype.getBoundingClientRect;
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    HTMLElement.prototype.getBoundingClientRect = realRect;
});
beforeEach(() => {
    server.events = [];
    server.revision = 1;
    server.writes = [];
    server.held = Promise.resolve();
    toasts.length = 0;
});

const settle = () =>
    act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
async function open(events: CalendarEventOccurrence[], month = false) {
    server.events = events;
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 700, month ? 600 : 24 * HOUR);
    const router = createRouter({
        routeTree: createRootRoute({ component: () => createElement(Page, { month }) }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    resizeCallbacks.length = 0;
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await settle();
    await act(async () => {
        for (const callback of resizeCallbacks) callback();
    });
}

const shown = (title: string) => [...document.querySelectorAll<HTMLElement>(`[title="${title}"]`)];
const block = (title: string) => {
    const found = shown(title)[0];
    if (!found) throw new Error(`nothing shows ${title}`);
    return found;
};
const topOf = (title: string) => block(title).style.top;
const pointer = (target: EventTarget, type: string, [x, y]: Point, pointerType: string) =>
    target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerType, pointerId: 1 }),
    );
type Point = [x: number, y: number];
// A press at `from` released at `to`, with the click the browser sends after it; `between` runs once React drew the move.
async function drag(target: Element, from: Point, to: Point, pointerType = 'mouse', between = () => {}) {
    await act(async () => {
        pointer(target, 'pointerdown', from, pointerType);
        if (to !== from) pointer(document, 'pointermove', to, pointerType);
    });
    await act(async () => between());
    await act(async () => {
        pointer(target, 'pointerup', to, pointerType);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: to[0], clientY: to[1] }));
    });
    await settle();
}
// Tuesday 13 October is the week's second column.
const tuesday = (hour: number): Point => [150, hour * HOUR];

const dialogTitles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);
const scopeOptions = () => [...document.querySelectorAll('[role="dialog"] label')].map((label) => label.textContent);
const dialogButton = (name: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === name,
    );
    if (!found) throw new Error(`no dialog has a button named ${name}`);
    return found;
};
const click = async (name: string) => {
    await act(async () => dialogButton(name).click());
    await settle();
};
const STALE_TOAST = 'This event changed elsewhere. Check it and try again.';

test('moving an event an hour later saves its new times with the etag the list has', async () => {
    await open([review]);
    let ghost: string[] = [];
    await drag(block('Review'), tuesday(10.2), tuesday(11.2), 'mouse', () => {
        ghost = shown('Review').map((shownBlock) => shownBlock.textContent ?? '');
    });
    expect(ghost).toContain('Review11:00 – 12:00');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(13, 11), endTime: at(13, 12) }]);
    expect(topOf('Review')).toBe(`${11 * HOUR}px`);
    expect(dialogTitles()).toEqual([]);
});

test('a move across columns changes the day and keeps the time', async () => {
    await open([review]);
    await drag(block('Review'), tuesday(10.2), [350, 10.2 * HOUR]);
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(15, 10), endTime: at(15, 11) }]);
});

test('the block stays where it was dropped until the save has settled', async () => {
    await open([review]);
    let answer = () => {};
    server.held = new Promise((resolve) => {
        answer = resolve;
    });
    await drag(block('Review'), tuesday(10.2), tuesday(12.2));
    expect(topOf('Review')).toBe(`${12 * HOUR}px`);
    await act(async () => answer());
    await settle();
    expect(topOf('Review')).toBe(`${12 * HOUR}px`);
});

test("a block's lines stack from its top, as Google draws them", async () => {
    await open([review]);
    expect(block('Review').className).toContain('flex-col');
    expect(block('Review').className).toContain('justify-start');
});

test('a press that never travels opens the detail and saves nothing', async () => {
    await open([review]);
    await drag(block('Review'), tuesday(10.2), tuesday(10.2));
    expect(dialogTitles()).toEqual(['Review']);
    expect(server.writes).toEqual([]);
});

test('Escape snaps the block back and saves nothing', async () => {
    await open([review]);
    await drag(block('Review'), tuesday(10.2), tuesday(12.2), 'mouse', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(shown('Review').length).toBe(1);
    expect(topOf('Review')).toBe(`${10 * HOUR}px`);
    expect(server.writes).toEqual([]);
    expect(dialogTitles()).toEqual([]);
});

test('the bottom edge resizes the end, never to less than 15 minutes', async () => {
    await open([review]);
    const edge = block('Review').querySelector('.cursor-ns-resize');
    if (!edge) throw new Error('the block has no resize edge');
    await drag(edge, tuesday(11), tuesday(12.5));
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(13, 10), endTime: at(13, 12, 30) }]);
    await drag(block('Review').querySelector('.cursor-ns-resize') ?? edge, tuesday(12.5), tuesday(8));
    expect(server.writes[1]).toEqual({ write: 'update', etag: 'v2', startTime: at(13, 10), endTime: at(13, 10, 15) });
});

test('an all-day bar in the grid moves by days', async () => {
    const holiday = event({
        title: 'Holiday',
        allDay: true,
        startTime: new Date(Date.UTC(2026, 9, 13)),
        endTime: new Date(Date.UTC(2026, 9, 14)),
    });
    await open([holiday]);
    await drag(block('Holiday'), [150, 10], [450, 10]);
    expect(server.writes).toEqual([
        {
            write: 'update',
            etag: 'v1',
            startTime: new Date(Date.UTC(2026, 9, 16)),
            endTime: new Date(Date.UTC(2026, 9, 17)),
        },
    ]);
});

test('a series occurrence moved to another day offers only this event', async () => {
    await open([standup]);
    await drag(block('Standup'), tuesday(9.2), [250, 9.2 * HOUR]);
    expect(dialogTitles()).toEqual(['Edit recurring event']);
    expect(scopeOptions()).toEqual(['This event']);
    expect(server.writes).toEqual([]);
});

test('a series occurrence moved within its day offers what its occurrence allows, and Cancel snaps back', async () => {
    await open([standup]);
    await drag(block('Standup'), tuesday(9.2), tuesday(10.2));
    expect(scopeOptions()).toEqual(['This event', 'This and following events', 'All events in series']);
    expect(topOf('Standup')).toBe(`${10 * HOUR}px`);
    await click('Cancel');
    expect(dialogTitles()).toEqual([]);
    expect(topOf('Standup')).toBe(`${9 * HOUR}px`);
    expect(server.writes).toEqual([]);
});

test('a refused save inside the recurring choice keeps it open, and the next OK sends the reloaded etag', async () => {
    await open([standup]);
    await drag(block('Standup'), tuesday(9.2), tuesday(10.2));
    changeElsewhere('Standup');
    await click('OK');
    expect(toasts).toEqual([STALE_TOAST]);
    expect(dialogTitles()).toEqual(['Edit recurring event']);
    await click('OK');
    expect(server.writes).toEqual([
        { write: 'override', etag: 'v1', startTime: at(13, 10), endTime: at(13, 11) },
        { write: 'override', etag: 'v2', startTime: at(13, 10), endTime: at(13, 11) },
    ]);
    expect(dialogTitles()).toEqual([]);
});

test('an event with guests asks before it mails them, and Cancel snaps back and saves nothing', async () => {
    await open([withGuests]);
    await drag(block('Planning'), tuesday(10.2), tuesday(11.2));
    expect(dialogTitles()).toEqual(['Send update emails to guests?']);
    await click('Cancel');
    expect(server.writes).toEqual([]);
    expect(topOf('Planning')).toBe(`${10 * HOUR}px`);
});

test('an event whose only guest is the one moving it saves at once, as nobody else is told', async () => {
    await open([
        {
            ...withGuests,
            data: {
                ...withGuests.data,
                attendees: [{ email: 'Me@test.eigen.is', status: 'accepted', role: 'required' }],
            },
        },
    ]);
    await drag(block('Planning'), tuesday(10.2), tuesday(11.2));
    expect(dialogTitles()).toEqual([]);
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(13, 11), endTime: at(13, 12) }]);
});

test('a series with guests asks which events first, then whether to tell the guests', async () => {
    await open([{ ...standup, data: withGuests.data }]);
    await drag(block('Standup'), tuesday(9.2), tuesday(10.2));
    await click('OK');
    expect(dialogTitles()).toEqual(['Send update emails to guests?']);
    expect(server.writes).toEqual([]);
    await click('Send');
    expect(server.writes).toEqual([{ write: 'override', etag: 'v1', startTime: at(13, 10), endTime: at(13, 11) }]);
    expect(dialogTitles()).toEqual([]);
});

test('Send saves the move of an event with guests', async () => {
    await open([withGuests]);
    await drag(block('Planning'), tuesday(10.2), tuesday(11.2));
    await click('Send');
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(13, 11), endTime: at(13, 12) }]);
    expect(dialogTitles()).toEqual([]);
});

test('a refused direct drop toasts and snaps back to the reloaded event', async () => {
    await open([review]);
    changeElsewhere('Review');
    await drag(block('Review'), tuesday(10.2), tuesday(12.2));
    expect(toasts).toEqual([STALE_TOAST]);
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(13, 12), endTime: at(13, 13) }]);
    expect(topOf('Review, changed')).toBe(`${10 * HOUR}px`);
    expect(dialogTitles()).toEqual([]);
});

test("a free/busy block and someone else's invitation don't drag, and the invitation still opens", async () => {
    await open([invitation]);
    await drag(block('Busy'), tuesday(14.2), tuesday(16.2));
    await drag(block('Offsite'), tuesday(10.2), tuesday(12.2));
    expect(shown('Offsite').length).toBe(1);
    expect(server.writes).toEqual([]);
    expect(dialogTitles()).toEqual(['Offsite']);
});

test("a finger doesn't drag: its tap opens the detail", async () => {
    await open([review]);
    let blocks = 0;
    await drag(block('Review'), tuesday(10.2), tuesday(12.2), 'touch', () => {
        blocks = shown('Review').length;
    });
    expect(blocks).toBe(1);
    expect(server.writes).toEqual([]);
    expect(dialogTitles()).toEqual(['Review']);
});

// The month starts on Monday 28 September, so 13 October is the third row's second day.
test('a month chip moves by days', async () => {
    await open([review], true);
    let chips = 0;
    await drag(block('Review'), [150, 250], [450, 370], 'mouse', () => {
        chips = shown('Review').length;
    });
    expect(chips).toBe(2);
    expect(server.writes).toEqual([{ write: 'update', etag: 'v1', startTime: at(23, 10), endTime: at(23, 11) }]);
    expect(dialogTitles()).toEqual([]);
});
