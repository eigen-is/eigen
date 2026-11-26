// Every event the calendar draws on a color, and the draft and ghosts a gesture draws, is one square eigen-block, the
// same shape and shadow as a card on a board, with no corner or shadow class of its own. A dot chip, the "N more" and a
// schedule row are square too, as list rows are. Each event button carries its occurrence as a focus key.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
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
const event = (p: Partial<CalendarEventOccurrence>): CalendarEventOccurrence => ({
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
    etag: '1',
    data: null,
    createByUserId: 'u1',
    createdAt: created,
    updatedAt: created,
    occurrenceDate: '2026-10-09',
    ...p,
});
const trip = event({
    allDay: true,
    startTime: new Date(Date.UTC(2026, 9, 9)),
    endTime: new Date(Date.UTC(2026, 9, 12)),
});

const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'u1', email: 'me@test.eigen.is' } }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { EventBar, EventChip, LaneGhost, MORE_BUTTON } = await import('../../components/event-chip');
const { DraftBlock, TimedEventBlock } = await import('../../components/time-grid-block');

const surfaceProps = { calendars: [work], sharedCalendars: [], onClick: () => {} };

async function rootClasses(element: React.ReactElement): Promise<string[]> {
    const { container, unmount } = await renderInDocument(element);
    const classes = container.firstElementChild?.className.split(' ') ?? [];
    await unmount();
    return classes;
}

const ownShape = (classes: string[]) => classes.filter((c) => /^(rounded|shadow)/.test(c));

test('a block, a bar, a draft and a ghost are each one square eigen-block', async () => {
    const drawn = [
        await rootClasses(
            <TimedEventBlock
                block={{ event: event({}), top: 840, bottom: 870, column: 0, columns: 1, span: 1 }}
                {...surfaceProps}
            />,
        ),
        await rootClasses(
            <EventBar
                bar={{ event: trip, lane: 0, start: 0, span: 3, continuesBefore: true, continuesAfter: true }}
                {...surfaceProps}
            />,
        ),
        await rootClasses(<EventChip event={trip} {...surfaceProps} />),
        await rootClasses(<DraftBlock day={new Date(2026, 9, 9)} top={540} bottom={600} color="#3b82f6" />),
        await rootClasses(
            <LaneGhost
                bar={{ event: event({}), lane: 0, start: 1, span: 1, continuesBefore: false, continuesAfter: false }}
                {...surfaceProps}
            />,
        ),
    ];
    for (const classes of drawn) {
        expect(classes).toContain('eigen-block');
        expect(ownShape(classes)).toEqual([]);
    }
});

test('a dot chip and the "N more" are square, with no block of their own', async () => {
    const chip = await rootClasses(<EventChip event={event({})} {...surfaceProps} />);
    expect(chip).not.toContain('eigen-block');
    expect(ownShape(chip)).toEqual([]);
    expect(ownShape(MORE_BUTTON.split(' '))).toEqual([]);
});

// A dialog that closes after a save that moved the event finds the event's new button by this key.
test('a block, a bar and a dot chip carry their occurrence as a focus key, a repeat with its date', async () => {
    const keyOf = async (element: React.ReactElement) => {
        const { container, unmount } = await renderInDocument(element);
        const key = container.querySelector<HTMLElement>('button')?.dataset.focusKey;
        await unmount();
        return key;
    };
    const weekly = event({ id: 'e1-1', parentEventId: 'e1', occurrenceDate: '2026-10-16' });
    expect(
        await keyOf(
            <TimedEventBlock
                block={{ event: event({}), top: 840, bottom: 870, column: 0, columns: 1, span: 1 }}
                {...surfaceProps}
            />,
        ),
    ).toBe('e1');
    expect(
        await keyOf(
            <EventBar
                bar={{ event: trip, lane: 0, start: 0, span: 3, continuesBefore: true, continuesAfter: true }}
                {...surfaceProps}
            />,
        ),
    ).toBe('e1');
    expect(await keyOf(<EventChip event={weekly} {...surfaceProps} />)).toBe('e1@2026-10-16');
});
