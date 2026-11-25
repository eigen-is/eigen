// The month grid: a multi-day event is one bar per week row, a day shows as many events as its row's height fits and
// counts the rest on "N more", which lists the whole day. The date links to that day's view, a click on an empty part
// of a day creates an event there, and while the list is open a click elsewhere only closes it.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// happy-dom lays nothing out, so each test gives every element a height and fires the row's observer itself.
const resizeCallbacks: (() => void)[] = [];
installHappyDom({ onResizeObserver: (callback) => resizeCallbacks.push(callback) });

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
const occurrence = (
    p: Partial<CalendarEventOccurrence> & Pick<CalendarEventOccurrence, 'title' | 'startTime' | 'endTime'>,
): CalendarEventOccurrence => ({
    id: p.title,
    calendarId: 'work',
    uid: `${p.title}@eigen`,
    uri: `${p.title}.ics`,
    description: null,
    location: null,
    allDay: false,
    rrule: null,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: '1',
    data: null,
    createByUserId: 'u1',
    createdAt: created,
    updatedAt: created,
    occurrenceDate: p.startTime.toISOString().slice(0, 10),
    ...p,
});
const allDay = (title: string, from: number, days: number) =>
    occurrence({
        title,
        allDay: true,
        startTime: new Date(Date.UTC(2026, 9, from)),
        endTime: new Date(Date.UTC(2026, 9, from + days)),
    });
const titles = ['Standup', 'Dentist', 'Lunch', 'Review', 'Drinks'];
const busyDay = titles.map((title, i) =>
    occurrence({ title, startTime: new Date(2026, 9, 9, 9 + i, 0), endTime: new Date(2026, 9, 9, 9 + i, 30) }),
);
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// Stable across renders, as React Query's results are, or the dialogs' effects would rerun on every render.
const calendars = { data: [work] };
const sharedCalendars = { data: [] };
const noMaster = { data: undefined };
const idle = { mutate: () => {}, mutateAsync: async () => {}, isPending: false };
const notExporting = { exportCalendar: async () => {}, isExporting: false };
const notFromOthers = () => false;
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
    useDeleteEvent: () => idle,
    useMoveEvent: () => idle,
    useRsvp: () => idle,
    useExportCalendar: () => notExporting,
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

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { MonthView } = await import('../../components/month-view');

const onDayClick = mock((_date: Date) => {});
const onEventClick = mock((_event: CalendarEventOccurrence) => {});
const realRect = HTMLElement.prototype.getBoundingClientRect;
// A week row of 116px holds four lanes under its dates.
let rowHeight = 116;
beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 140, rowHeight);
});
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    onDayClick.mockClear();
    onEventClick.mockClear();
    resizeCallbacks.length = 0;
    rowHeight = 116;
    HTMLElement.prototype.getBoundingClientRect = realRect;
});

async function renderMonth(events: CalendarEventOccurrence[]) {
    const month = () =>
        createElement(MonthView, {
            focus: new Date(2026, 9, 1),
            events,
            calendars: [work],
            sharedCalendars: [],
            onDayClick,
            onEventClick,
            openKey: undefined,
        });
    const router = createRouter({
        routeTree: createRootRoute({ component: month }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    const rendered = await renderInDocument(createElement(RouterProvider, { router }));
    unmount = rendered.unmount;
    await act(async () => {
        for (const callback of resizeCallbacks) callback();
    });
    return rendered.container;
}

const leaf = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('body *')].find(
        (element) => element.childElementCount === 0 && element.textContent === text,
    );
const day = (container: HTMLElement, date: number) =>
    [...container.querySelectorAll('a')].find((link) => link.textContent === String(date))?.parentElement;

// happy-dom has no hit testing, so a click goes where a browser sends it: past a page that takes no pointer events.
const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        const target = document.body.style.pointerEvents === 'none' ? document.documentElement : element;
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

async function openMore() {
    const container = await renderMonth(busyDay);
    await click(leaf('2 more'));
    return container;
}

const popover = () => document.querySelector('[data-slot="popover-content"]');

test('an event over three days is one bar, and two where it crosses into the next week', async () => {
    const container = await renderMonth([allDay('Retreat', 13, 3), allDay('Trip', 17, 3)]);
    const placed = (title: string) =>
        [...container.querySelectorAll(`[title="${title}"]`)].map((bar) => bar.getAttribute('style'));
    expect(placed('Retreat')).toEqual([expect.stringContaining('grid-column: 2 / span 3')]);
    expect(placed('Trip')).toEqual([
        expect.stringContaining('grid-column: 6 / span 2'),
        expect.stringContaining('grid-column: 1 / span 1'),
    ]);
});

test("a day shows as many events as its row's height fits, and gives the last to N more when they overflow", async () => {
    rowHeight = 72;
    const container = await renderMonth([...busyDay.slice(0, 3), allDay('Fair', 14, 1), allDay('Expo', 14, 1)]);
    const shown = [...container.querySelectorAll('[title]')].map((chip) => chip.getAttribute('title'));
    expect(shown).toEqual(['Standup', 'Expo', 'Fair']);
    expect(leaf('2 more')).toBeDefined();
});

test("the date links to that day's view", async () => {
    const container = await renderMonth([]);
    expect(day(container, 9)?.querySelector('a')?.getAttribute('href')).toBe('/view/day/2026-10-09');
});

test('a click on an empty part of a day creates an event there, a click on its date does not', async () => {
    const container = await renderMonth([]);
    await click(day(container, 9)?.querySelector('a'));
    expect(onDayClick).not.toHaveBeenCalled();
    await click(day(container, 9));
    expect(onDayClick).toHaveBeenCalledWith(new Date(2026, 9, 9));
});

test('N more lists all the events of the day and creates no event', async () => {
    await openMore();
    expect(onDayClick).not.toHaveBeenCalled();
    const listed = [...(popover()?.querySelectorAll('[title]') ?? [])].map((chip) => chip.getAttribute('title'));
    expect(listed).toEqual(titles);
});

test('while the list is open, a click on another day only closes it', async () => {
    const container = await openMore();
    await click(day(container, 14));
    expect(popover()).toBeNull();
    expect(onDayClick).not.toHaveBeenCalled();
});

test('an event picked from the list opens its detail and closes the list', async () => {
    await openMore();
    await act(async () => {
        popover()?.querySelector<HTMLElement>('[title="Drinks"]')?.click();
    });
    expect(onDayClick).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    expect(onEventClick.mock.calls.map(([event]) => event.title)).toEqual(['Drinks']);
});
