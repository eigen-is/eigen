import { describe, expect, test } from 'bun:test';
import { EIGEN_COLORS_MAP, EIGEN_STICKIES_COLOR_ROW, EIGEN_STICKIES_INDICATOR_ROW } from '../../constants/colors';
import { commentIndicatorColor, INDICATOR_RED } from '../../constants/comment-indicator';

describe('commentIndicatorColor', () => {
    test('a stickies palette colour paints in its stronger indicator tone', () => {
        const sticky = EIGEN_COLORS_MAP[1][EIGEN_STICKIES_COLOR_ROW];
        expect(commentIndicatorColor(sticky)).toBe(EIGEN_COLORS_MAP[1][EIGEN_STICKIES_INDICATOR_ROW]);
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
