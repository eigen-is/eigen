// An all-day event is stored as midnight UTC with an exclusive end, and an event reads its state the same way in
// every view: a past one dims, free/busy can't be opened, a pending invite is an outline, a declined one fades.
import { describe, expect, test } from 'bun:test';
import { eigenColor } from '@workspace/lib/constants/colors';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import { buildEventTimes, eventSurfaceClasses } from '../../components/calendar-utils';

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

describe('eventSurfaceClasses', () => {
    const plain = { past: false, freeBusy: false, inviteStatus: null };
    const classes = (...args: Parameters<typeof eventSurfaceClasses>) => eventSurfaceClasses(...args).split(' ');
    // A block lays its state over the calendar's color surface, as EventChip does.
    const onSurface = (state: Parameters<typeof eventSurfaceClasses>[1]) =>
        cn(colorSurface(eigenColor('pink', 500)).className, eventSurfaceClasses('block', state)).split(' ');

    test('a past event dims, and an upcoming one does not', () => {
        expect(classes('block', { ...plain, past: true })).toContain('opacity-60');
        expect(classes('dot', { ...plain, past: true })).toContain('opacity-60');
        expect(classes('block', plain).some((c) => c.startsWith('opacity-'))).toBe(false);
    });

    test('a free/busy block fades and shows no pointer, in either variant', () => {
        expect(classes('block', { ...plain, freeBusy: true })).toEqual(
            expect.arrayContaining(['opacity-50', 'cursor-default']),
        );
        expect(classes('dot', { ...plain, freeBusy: true })).toContain('cursor-default');
        expect(classes('block', plain)).toContain('cursor-pointer');
    });

    test('a pending invite is a dashed outline on the background instead of the fill, as a block', () => {
        const pending = onSurface({ ...plain, inviteStatus: 'pending' });
        expect(pending).toEqual(
            expect.arrayContaining(['border', 'border-dashed', 'border-(--surface-indicator)', 'bg-background']),
        );
        expect(pending).not.toContain('bg-(--surface-bg)');
        expect(pending).not.toContain('dark:bg-(--surface-soft)');
        expect(pending).not.toContain('dark:shadow-[inset_2px_0_0_0_var(--surface-indicator)]');
        expect(classes('dot', { ...plain, inviteStatus: 'pending' })).not.toContain('border-dashed');
    });

    test('a declined invite fades and is struck through, in both variants', () => {
        for (const variant of ['block', 'dot'] as const) {
            expect(classes(variant, { ...plain, inviteStatus: 'declined' })).toEqual(
                expect.arrayContaining(['opacity-40', 'line-through']),
            );
        }
        expect(classes('dot', plain)).not.toContain('line-through');
    });

    test('the past dims first, so a declined or free/busy fade wins over it', () => {
        const declined = classes('block', { ...plain, past: true, inviteStatus: 'declined' });
        expect(declined).toContain('opacity-40');
        expect(declined).not.toContain('opacity-60');
        const freeBusy = classes('block', { ...plain, past: true, freeBusy: true });
        expect(freeBusy).toContain('opacity-50');
        expect(freeBusy).not.toContain('opacity-60');
    });
});
