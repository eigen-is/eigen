import { describe, expect, test } from 'bun:test';
import {
    EIGEN_ACCENT_COLORS,
    EIGEN_STICKIES_COLORS,
    eigenColor,
    indicatorColor,
    lightenColor,
    readableTextColor,
} from '@workspace/lib/constants/colors';
import { colorSurface } from '../../lib/color-surface';

describe('colorSurface', () => {
    test("light mode fills with the color's pale tone lightened by the tone's tint, and text that reads on it", () => {
        const { className, style } = colorSurface(eigenColor('blue', 800), 'tile');
        expect(className.split(' ')).toEqual(expect.arrayContaining(['bg-(--surface-bg)', 'text-(--surface-fg)']));
        expect(style['--surface-bg']).toBe(lightenColor(eigenColor('blue', 100), 0.25));
        expect(style['--surface-fg']).toBe('#000');
        expect(colorSurface(eigenColor('blue', 800), 'panel').style['--surface-bg']).toBe(
            lightenColor(eigenColor('blue', 100), 0.5),
        );
    });

    test('a panel is paler than a tile and differs from it in the light fill only', () => {
        const tile = colorSurface(eigenColor('orange', 100), 'tile');
        const panel = colorSurface(eigenColor('orange', 100), 'panel');
        expect(panel.style['--surface-bg']).not.toBe(tile.style['--surface-bg']);
        expect({ ...panel.style, '--surface-bg': '', '--surface-fg': '' }).toEqual({
            ...tile.style,
            '--surface-bg': '',
            '--surface-fg': '',
        });
        expect(panel.className).toBe(tile.className);
    });

    test("a calendar's accent fills like a card of its family, and keeps its own strong stripe", () => {
        for (const name of ['yellow', 'sky', 'pink'] as const) {
            const event = colorSurface(eigenColor(name, 500), 'tile').style;
            const card = colorSurface(eigenColor(name, 100), 'tile').style;
            expect(event['--surface-bg']).toBe(card['--surface-bg']);
            expect(event['--surface-fg']).toBe(card['--surface-fg']);
            expect(event['--surface-indicator']).toBe(eigenColor(name, 500));
        }
        for (const { value } of EIGEN_ACCENT_COLORS) {
            expect(colorSurface(value, 'tile').style['--surface-indicator']).toBe(value);
        }
    });

    test('every stickies color keeps the surface it had before pale tones', () => {
        for (const { value } of EIGEN_STICKIES_COLORS.flat()) {
            const fill = lightenColor(value, 0.25);
            expect(colorSurface(value, 'tile').style).toEqual({
                '--surface-bg': fill,
                '--surface-fg': readableTextColor(fill),
                '--surface-indicator': indicatorColor(value),
                '--surface-soft': 'color-mix(in oklab, var(--surface-indicator) 14%, var(--background))',
            });
        }
    });

    test('dark mode is a 14% wash of the indicator over the background, with a 2px stripe in it', () => {
        const { className, style } = colorSurface(eigenColor('orange', 100), 'tile');
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
        const { className, style } = colorSurface('#123456', 'tile');
        expect(style['--surface-indicator']).toBe('#123456');
        expect(className.split(' ')).toContain('border-(--surface-indicator)');
    });
});
