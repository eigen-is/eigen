// The dialog gets the clicked occurrence as the current list has it, so a refetch reaches what it shows and the etag it
// writes with. A series occurrence stays itself through a new override, a lone event through a move to another day, and
// one no longer in the list stays on screen as clicked.
import { afterEach, expect, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { useEventDetailState } = await import('../../components/hooks/use-event-detail-state');

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
const nextWeek = { ...weekly, occurrenceDate: '2026-10-16' };

let selected: CalendarEventOccurrence | null = null;
let setEvents = (_events: CalendarEventOccurrence[]) => {};
function Harness({ initial, clicked }: { initial: CalendarEventOccurrence[]; clicked: CalendarEventOccurrence }) {
    const [events, set] = useState(initial);
    const { handleEventClick, detailDialogProps } = useEventDetailState({ events, calendars });
    selected = detailDialogProps.event;
    setEvents = set;
    return createElement('button', { type: 'button', onClick: (e: React.MouseEvent) => handleEventClick(clicked, e) });
}

let unmount = async () => {};
afterEach(() => unmount());

async function clickIn(events: CalendarEventOccurrence[], clicked: CalendarEventOccurrence) {
    ({ unmount } = await renderInDocument(createElement(Harness, { initial: events, clicked })));
    await act(async () => document.querySelector('button')?.click());
}
const refetchTo = (events: CalendarEventOccurrence[]) => act(async () => setEvents(events));

test('a refetch reaches the selected event', async () => {
    await clickIn([dentist], dentist);
    await refetchTo([{ ...dentist, title: 'Dentist, renamed', etag: 'v2' }]);
    expect(selected).toMatchObject({ title: 'Dentist, renamed', etag: 'v2' });
});

test('a lone event moved to another day is still the selected event', async () => {
    await clickIn([dentist], dentist);
    await refetchTo([{ ...dentist, occurrenceDate: '2026-10-20', etag: 'v2' }]);
    expect(selected?.etag).toBe('v2');
});

test('a series occurrence is told from the others of its series by its date', async () => {
    await clickIn([weekly, nextWeek], nextWeek);
    await refetchTo([
        { ...weekly, etag: 'v2' },
        { ...nextWeek, title: 'Later', etag: 'v2' },
    ]);
    expect(selected).toMatchObject({ occurrenceDate: '2026-10-16', title: 'Later', etag: 'v2' });
});

test('an override that replaces the occurrence is the selected event from then on', async () => {
    await clickIn([weekly, nextWeek], nextWeek);
    const override = { ...nextWeek, id: 'o1', rrule: null, parentEventId: 's1', recurrenceDate: '2026-10-16' };
    await refetchTo([
        { ...weekly, etag: 'v2' },
        { ...override, etag: 'v2' },
    ]);
    expect(selected).toMatchObject({ id: 'o1', etag: 'v2' });
});

test('a series whose rule was removed elsewhere is still the selected event', async () => {
    await clickIn([weekly, nextWeek], nextWeek);
    await refetchTo([{ ...weekly, rrule: null, etag: 'v2' }]);
    expect(selected).toMatchObject({ id: 's1', etag: 'v2' });
});

test('an event gone from the list stays selected as it was clicked', async () => {
    await clickIn([dentist], dentist);
    await refetchTo([]);
    expect(selected).toMatchObject({ id: 'e1', etag: 'v1' });
});
