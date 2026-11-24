import { describe, expect, test } from 'bun:test';
import { eigenColor, lightenColor } from '@workspace/lib/constants/colors';
import { COLOR_SURFACE_TINT, colorSurface } from '../../lib/color-surface';

describe('colorSurface', () => {
    test('light mode fills with the color lightened by the one tint, and text that reads on it', () => {
        const { className, style } = colorSurface(eigenColor('blue', 800));
        expect(className.split(' ')).toEqual(expect.arrayContaining(['bg-(--surface-bg)', 'text-(--surface-fg)']));
        expect(style['--surface-bg']).toBe(lightenColor(eigenColor('blue', 800), COLOR_SURFACE_TINT));
        expect(style['--surface-fg']).toBe('#fff');
        expect(colorSurface(eigenColor('yellow', 100)).style['--surface-fg']).toBe('#000');
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
