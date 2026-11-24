import { describe, expect, test } from 'bun:test';
import {
    EIGEN_ACCENT_COLORS,
    EIGEN_STICKIES_COLORS,
    eigenColor,
    indicatorColor,
    lightenColor,
    readableTextColor,
} from '@workspace/lib/constants/colors';
import { COLOR_SURFACE_TINT, colorSurface } from '../../lib/color-surface';

describe('colorSurface', () => {
    test("light mode fills with the color's pale tone lightened by the one tint, and text that reads on it", () => {
        const { className, style } = colorSurface(eigenColor('blue', 800));
        expect(className.split(' ')).toEqual(expect.arrayContaining(['bg-(--surface-bg)', 'text-(--surface-fg)']));
        expect(style['--surface-bg']).toBe(lightenColor(eigenColor('blue', 100), COLOR_SURFACE_TINT));
        expect(style['--surface-fg']).toBe('#000');
    });

    test("a calendar's accent fills like a card of its family, and keeps its own strong stripe", () => {
        for (const name of ['yellow', 'sky', 'pink'] as const) {
            const event = colorSurface(eigenColor(name, 500)).style;
            const card = colorSurface(eigenColor(name, 100)).style;
            expect(event['--surface-bg']).toBe(card['--surface-bg']);
            expect(event['--surface-fg']).toBe(card['--surface-fg']);
            expect(event['--surface-indicator']).toBe(eigenColor(name, 500));
        }
        for (const { value } of EIGEN_ACCENT_COLORS) {
            expect(colorSurface(value).style['--surface-indicator']).toBe(value);
        }
    });

    test('every stickies color keeps the surface it had before pale tones', () => {
        for (const { value } of EIGEN_STICKIES_COLORS.flat()) {
            const fill = lightenColor(value, COLOR_SURFACE_TINT);
            expect(colorSurface(value).style).toEqual({
                '--surface-bg': fill,
                '--surface-fg': readableTextColor(fill),
                '--surface-indicator': indicatorColor(value),
                '--surface-soft': 'color-mix(in oklab, var(--surface-indicator) 14%, var(--background))',
            });
        }
    });

    test('dark mode is a 14% wash of the indicator over the background, with a 2px stripe in it', () => {
        const { className, style } = colorSurface(eigenColor('orange', 100));
        expect(className.split(' ')).toEqual(
            expect.arrayContaining([
                'dark:bg-(--surface-soft)',
                'dark:text-card-foreground',
                'dark:shadow-[inset_2px_0_0_0_var(--surface-indicator)]',
            ]),
        );
        expect(style['--surface-indicator']).toBe(eigenColor('orange', 400));
        expect(style['--surface-soft']).toBe('color-mix(in oklab, var(--surface-indicator) 14%, var(--background))');
    });

    test("a user's own hex is its own stripe, and a dashed edge a caller adds takes the same color", () => {
        const { className, style } = colorSurface('#123456');
        expect(style['--surface-indicator']).toBe('#123456');
        expect(className.split(' ')).toContain('border-(--surface-indicator)');
    });
});
