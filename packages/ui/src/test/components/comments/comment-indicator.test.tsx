import { describe, expect, test } from 'bun:test';
import { EIGEN_COLORS_MAP, EIGEN_STICKIES_COLOR_ROW, EIGEN_STICKIES_INDICATOR_ROW } from '@workspace/lib/constants';
import { COMMENT_INDICATOR_SIZE, INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentIndicator } from '../../../components/comments/comment-indicator';

describe('CommentIndicator', () => {
    test('is a corner triangle at the shared mark size', () => {
        const html = renderToStaticMarkup(<CommentIndicator />);
        expect(html).toContain(`border-left:${COMMENT_INDICATOR_SIZE}px solid transparent`);
        expect(html).toContain(`border-top:${COMMENT_INDICATOR_SIZE}px solid ${INDICATOR_RED}`);
        expect(html).toContain('width:0');
    });

    test('paints in the card colour, mapped through the stickies indicator tone', () => {
        const html = renderToStaticMarkup(<CommentIndicator color={EIGEN_COLORS_MAP[1][EIGEN_STICKIES_COLOR_ROW]} />);
        expect(html).toContain(`solid ${EIGEN_COLORS_MAP[1][EIGEN_STICKIES_INDICATOR_ROW]}`);
    });
});
