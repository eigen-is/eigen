// An all-day event is stored as midnight UTC with an exclusive end, and a pill reads its state the same way in
// the month and week views: free/busy can't be opened, a pending invite is an outline, a declined one fades.
import { describe, expect, test } from 'bun:test';
import { buildEventTimes, eventPillStateClasses } from '../../components/calendar-utils';

describe('buildEventTimes', () => {
    test('a one-day all-day event runs from its midnight UTC to the next', () => {
        const { start, end } = buildEventTimes(true, '2026-10-27', '2026-10-27', '09:00', '09:30');
        expect(start.toISOString()).toBe('2026-10-27T00:00:00.000Z');
        expect(end.toISOString()).toBe('2026-10-28T00:00:00.000Z');
    });

    test('a multi-day all-day event ends the midnight after its last day, across a month end', () => {
        const { start, end } = buildEventTimes(true, '2026-10-30', '2026-10-31', '09:00', '09:30');
        expect(start.toISOString()).toBe('2026-10-30T00:00:00.000Z');
        expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    });

    test('a timed event keeps its dates and times as the viewer picked them', () => {
        const { start, end } = buildEventTimes(false, '2026-10-27', '2026-10-28', '23:30', '00:15');
        expect(start).toEqual(new Date(2026, 9, 27, 23, 30));
        expect(end).toEqual(new Date(2026, 9, 28, 0, 15));
    });
});

describe('eventPillStateClasses', () => {
    const classes = (...args: Parameters<typeof eventPillStateClasses>) => eventPillStateClasses(...args).split(' ');

    test('a free/busy block shows no pointer, in either variant', () => {
        expect(classes('block', true, null)).toContain('cursor-default');
        expect(classes('dot', true, null)).toContain('cursor-default');
        expect(classes('block', false, null)).toContain('cursor-pointer');
    });

    test('a pending invite is a dashed outline as a block, and a plain row as a dot', () => {
        expect(classes('block', false, 'pending')).toContain('border-dashed');
        expect(classes('dot', false, 'pending')).not.toContain('border-dashed');
    });

    test('a declined invite fades in both variants', () => {
        expect(classes('block', false, 'declined')).toContain('opacity-40');
        expect(classes('dot', false, 'declined')).toContain('opacity-40');
        expect(classes('dot', false, null)).not.toContain('opacity-40');
    });
});
