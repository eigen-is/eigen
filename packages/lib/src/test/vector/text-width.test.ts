import { describe, expect, test } from 'bun:test';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { measureLabel } from '../../vector/text-width';
import { DEFAULT_FONT_FAMILY } from '../../vector/types';

const BASIC_LATIN = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));

describe('measureLabel', () => {
    test('a monospace face gives every Basic Latin character one width', () => {
        for (const bold of [false, true]) {
            const widths = new Set(BASIC_LATIN.map((char) => measureLabel(char, 'JetBrains Mono', 10, bold)));
            expect(widths.size).toBe(1);
        }
        expect(measureLabel('M', 'JetBrains Mono', 10, false)).toBeCloseTo(6, 0);
    });

    test('wide glyphs measure wider than narrow ones', () => {
        expect(measureLabel('WWW', 'Inter', 16, false)).toBeGreaterThan(2 * measureLabel('iii', 'Inter', 16, false));
    });

    test('bold is never narrower than regular, and Excalifont has no bold face', () => {
        const text = 'Points scored 2026';
        for (const family of EIGEN_FONT_NAMES) {
            expect(measureLabel(text, family, 14, true)).toBeGreaterThanOrEqual(measureLabel(text, family, 14, false));
        }
        expect(measureLabel(text, 'Excalifont', 14, true)).toBe(measureLabel(text, 'Excalifont', 14, false));
    });

    test('width scales with the font size and sums the characters', () => {
        expect(measureLabel('Team 1', 'Inter', 20, false)).toBeCloseTo(2 * measureLabel('Team 1', 'Inter', 10, false));
        expect(measureLabel('ab', 'Inter', 12, false)).toBeCloseTo(
            measureLabel('a', 'Inter', 12, false) + measureLabel('b', 'Inter', 12, false),
        );
        expect(measureLabel('', 'Inter', 12, false)).toBe(0);
    });

    test('Latin-1 is in the table; other code points take the fallback, astral ones counted once', () => {
        expect(measureLabel('é', 'Inter', 10, false)).toBeCloseTo(measureLabel('e', 'Inter', 10, false), 0);
        const fallback = measureLabel('中', 'Inter', 10, false);
        expect(fallback).toBeGreaterThan(measureLabel('n', 'Inter', 10, false));
        expect(measureLabel('😀', 'Inter', 10, false)).toBe(fallback);
    });

    test('an unknown family reads the default font', () => {
        expect(measureLabel('Team 1', 'Comic Sans', 12, false)).toBe(
            measureLabel('Team 1', DEFAULT_FONT_FAMILY, 12, false),
        );
    });
});
