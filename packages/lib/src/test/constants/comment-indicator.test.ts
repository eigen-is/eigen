import { describe, expect, test } from 'bun:test';
import { eigenColor } from '../../constants/colors';
import { commentIndicatorColor, INDICATOR_RED } from '../../constants/comment-indicator';

describe('commentIndicatorColor', () => {
    test('a stickies palette colour paints in its stronger indicator tone', () => {
        expect(commentIndicatorColor(eigenColor('orange', 100))).toBe(eigenColor('orange', 400));
    });

    test('any other colour paints as given', () => {
        expect(commentIndicatorColor('#123456')).toBe('#123456');
    });

    test('a colourless card falls back to the attention red', () => {
        expect(commentIndicatorColor(undefined)).toBe(INDICATOR_RED);
        expect(commentIndicatorColor(null)).toBe(INDICATOR_RED);
        expect(commentIndicatorColor('')).toBe(INDICATOR_RED);
    });
});
