// The read-only body of an event, drawn from data alone. What is pinned here is the all-day reading —
// the calendar domain stores midnight UTC with an EXCLUSIVE end, so a one-day event spans two stored
// dates and must still show one day — plus the two things a file's event carries that a stored one does
// not always: a cancellation, and guests the payload did not list.
import { expect, mock, test } from 'bun:test';
import type { EventDetailCardProps } from '../../../components/calendar/event-detail-card';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const session = { user: { id: 'owner-1' } };
mock.module('@workspace/lib/auth', () => ({ useAuth: () => session, useIsGuest: () => false }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EventDetailCard } = await import('../../../components/calendar/event-detail-card');

async function render(props: EventDetailCardProps): Promise<string> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(QueryClientProvider, { client: new QueryClient() }, createElement(EventDetailCard, props)),
        );
    });
    const text = container.textContent ?? '';
    await act(async () => root.unmount());
    container.remove();
    return text;
}

test('a one-day all-day event reads as one day, whatever zone the viewer is in', async () => {
    const text = await render({
        title: 'Autumn market',
        start: new Date('2026-09-20'),
        end: new Date('2026-09-21'),
        allDay: true,
    });

    expect(text).toContain('Autumn market');
    expect(text).toContain('Sunday, 20 Sep 2026');
    expect(text).not.toContain('21 Sep');
});

test('a multi-day all-day event names its last day, not the exclusive bound', async () => {
    const text = await render({
        title: 'Festival',
        start: new Date('2026-09-20'),
        end: new Date('2026-09-23'),
        allDay: true,
    });

    expect(text).toContain('Sunday, 20 Sep 2026');
    expect(text).toContain('Tuesday, 22 Sep 2026');
});

test('a canceled event says so, whether or not the surface draws the title', async () => {
    const withTitle = await render({
        title: 'Autumn market',
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        status: 'cancelled',
    });
    expect(withTitle).toContain('Canceled');

    const titleless = await render({
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        status: 'cancelled',
    });
    expect(titleless).toContain('Canceled');
});

// A payload lists only the first ICS_PREVIEW_MAX_ATTENDEES guests, so the card says how many it is not showing.
test('the guests an event holds beyond the ones listed are counted', async () => {
    const text = await render({
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        attendees: [{ email: 'ada@example.com', name: 'Ada', status: 'accepted', role: 'required' }],
        remainingAttendees: 150,
    });

    // The header counts every guest the event has, not the ones the payload happened to carry.
    expect(text).toContain('151 guests');
    expect(text).toContain('and 150 more guests');
});

test('a truncated guest list says nothing about how the event replied', async () => {
    const text = await render({
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        attendees: [
            { email: 'ada@example.com', name: 'Ada', status: 'accepted', role: 'required' },
            { email: 'bob@example.com', name: 'Bob', status: 'declined', role: 'required' },
        ],
        remainingAttendees: 149,
    });

    expect(text).toContain('151 guests');
    expect(text).toContain('and 149 more guests');
    expect(text).not.toContain('accepted');
    expect(text).not.toContain('declined');
});

test('a guest list the payload carried whole keeps its breakdown', async () => {
    const text = await render({
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        attendees: [
            { email: 'ada@example.com', name: 'Ada', status: 'accepted', role: 'required' },
            { email: 'bob@example.com', name: 'Bob', status: 'declined', role: 'required' },
        ],
    });

    expect(text).toContain('1 accepted, 1 declined');
});

test('what the event does not carry draws nothing', async () => {
    const text = await render({
        start: new Date('2026-09-20T09:00:00Z'),
        end: new Date('2026-09-20T10:00:00Z'),
        allDay: false,
        timezone: 'Europe/Amsterdam',
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        location: 'Grote Markt',
        description: 'Bring a bag.',
    });

    expect(text).toContain('Amsterdam time zone');
    expect(text).toContain('Every week on Sunday');
    expect(text).toContain('Grote Markt');
    expect(text).toContain('Bring a bag.');
    expect(text).not.toContain('guest');
});
