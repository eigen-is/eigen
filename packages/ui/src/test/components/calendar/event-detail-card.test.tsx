// The read-only body of an event, drawn from data alone. What is pinned here is the all-day reading:
// the calendar domain stores midnight UTC with an EXCLUSIVE end, so a one-day event spans two stored
// dates and must still show one day.
import { expect, test } from 'bun:test';
import type { EventDetailCardProps } from '../../../components/calendar/event-detail-card';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EventDetailCard } = await import('../../../components/calendar/event-detail-card');

async function render(props: EventDetailCardProps): Promise<string> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(EventDetailCard, props));
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
    expect(text).toContain('every week on Sunday');
    expect(text).toContain('Grote Markt');
    expect(text).toContain('Bring a bag.');
    expect(text).not.toContain('guest');
});
