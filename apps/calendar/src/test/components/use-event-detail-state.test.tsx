// The detail column gets the occurrence its URL names as the current list has it, so a refetch reaches what it shows
// and the etag it writes with. A series occurrence stays itself through a new override, a lone event through a move to
// another day, and one no longer in the list stays on screen as last found. A link with no date opens the occurrence
// nearest the view's day, and a link may name the event by its uid or its organizer's id.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement, useState } = await import('react');
const { eventKey, useEventDetailState } = await import('../../components/hooks/use-event-detail-state');
type EventKey = ReturnType<typeof eventKey>;

const created = new Date('2026-10-01T00:00:00Z');
const calendars: CalendarItem[] = [];
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
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'v1',
    data: null,
    createByUserId: 'u1',
    createdAt: created,
    updatedAt: created,
    occurrenceDate: '2026-10-09',
};
const weekly = { ...dentist, id: 's1', uid: 's1@eigen', rrule: 'FREQ=WEEKLY' };
const nextWeek = {
    ...weekly,
    startTime: new Date(2026, 9, 16, 14, 0),
    endTime: new Date(2026, 9, 16, 14, 30),
    occurrenceDate: '2026-10-16',
};
const FOCUS = new Date(2026, 9, 15);

let selected: CalendarEventOccurrence | null = null;
let setEvents = (_events: CalendarEventOccurrence[]) => {};
let setOpen = (_open: EventKey) => {};
function Harness({ initial, opened }: { initial: CalendarEventOccurrence[]; opened: EventKey }) {
    const [events, set] = useState(initial);
    const [open, setOpenState] = useState(opened);
    selected = useEventDetailState({ events, calendars, open, focus: FOCUS }).event;
    setEvents = set;
    setOpen = setOpenState;
    return null;
}

let unmount = async () => {};
afterEach(() => unmount());

async function openIn(events: CalendarEventOccurrence[], opened: EventKey | CalendarEventOccurrence) {
    const key = 'id' in opened ? eventKey(opened) : opened;
    ({ unmount } = await renderInDocument(createElement(Harness, { initial: events, opened: key })));
}
const refetchTo = (events: CalendarEventOccurrence[]) => act(async () => setEvents(events));

test('a click names a series occurrence by its series and date, and a lone event by its id alone', () => {
    const override = { ...nextWeek, id: 'o1', rrule: null, parentEventId: 's1', recurrenceDate: '2026-10-16' };
    expect([eventKey(dentist), eventKey(nextWeek), eventKey(override)]).toEqual([
        { eventId: 'e1', occurrence: undefined },
        { eventId: 's1', occurrence: '2026-10-16' },
        { eventId: 's1', occurrence: '2026-10-16' },
    ]);
});

test('a refetch reaches the open event', async () => {
    await openIn([dentist], dentist);
    await refetchTo([{ ...dentist, title: 'Dentist, renamed', etag: 'v2' }]);
    expect(selected).toMatchObject({ title: 'Dentist, renamed', etag: 'v2' });
});

test('a lone event moved to another day is still the open event', async () => {
    await openIn([dentist], dentist);
    await refetchTo([{ ...dentist, occurrenceDate: '2026-10-20', etag: 'v2' }]);
    expect(selected?.etag).toBe('v2');
});

test('a series occurrence is told from the others of its series by its date', async () => {
    await openIn([weekly, nextWeek], nextWeek);
    await refetchTo([
        { ...weekly, etag: 'v2' },
        { ...nextWeek, title: 'Later', etag: 'v2' },
    ]);
    expect(selected).toMatchObject({ occurrenceDate: '2026-10-16', title: 'Later', etag: 'v2' });
});

test('an override that replaces the occurrence is the open event from then on', async () => {
    await openIn([weekly, nextWeek], nextWeek);
    const override = { ...nextWeek, id: 'o1', rrule: null, parentEventId: 's1', recurrenceDate: '2026-10-16' };
    await refetchTo([
        { ...weekly, etag: 'v2' },
        { ...override, etag: 'v2' },
    ]);
    expect(selected).toMatchObject({ id: 'o1', etag: 'v2' });
});

test('a series whose rule was removed elsewhere is still the open event', async () => {
    await openIn([weekly, nextWeek], nextWeek);
    await refetchTo([{ ...weekly, rrule: null, etag: 'v2' }]);
    expect(selected).toMatchObject({ id: 's1', etag: 'v2' });
});

test('an event gone from the list stays open as it was last found', async () => {
    await openIn([dentist], dentist);
    await refetchTo([{ ...dentist, etag: 'v2' }]);
    await refetchTo([]);
    expect(selected).toMatchObject({ id: 'e1', etag: 'v2' });
});

test('the last copy shows only while the URL names it', async () => {
    await openIn([dentist], dentist);
    await refetchTo([]);
    await act(async () => setOpen({ eventId: 'gone' }));
    expect(selected).toBeNull();
});

test('a link with no date opens the occurrence of the series nearest the view day', async () => {
    await openIn([weekly, nextWeek], { eventId: 's1' });
    expect(selected?.occurrenceDate).toBe('2026-10-16');
});

test("a link may name the event by its uid or its organizer's id", async () => {
    const invite = { ...dentist, data: { organizerEventId: 'organizer-1' } };
    await openIn([invite], { eventId: 'e1@eigen' });
    expect(selected?.id).toBe('e1');
    await act(async () => setOpen({ eventId: 'organizer-1' }));
    expect(selected?.id).toBe('e1');
});

test('a free/busy block is never the open event', async () => {
    await openIn([{ ...dentist, id: '', title: 'Busy' }], { eventId: 'e1@eigen' });
    expect(selected).toBeNull();
});
