import { describe, expect, test } from 'bun:test';
import { eigenColor } from '@workspace/lib/constants';
import { CELL_INDICATOR_SIZE, INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentIndicator } from '../../../components/comments/comment-indicator';

describe('CommentIndicator', () => {
    test('is a corner triangle at the shared mark size', () => {
        const html = renderToStaticMarkup(<CommentIndicator />);
        expect(html).toContain(`border-left:${CELL_INDICATOR_SIZE}px solid transparent`);
        expect(html).toContain(`border-top:${CELL_INDICATOR_SIZE}px solid ${INDICATOR_RED}`);
        expect(html).toContain('width:0');
    });

    test('paints in the card colour, mapped through the stickies indicator tone', () => {
        const html = renderToStaticMarkup(<CommentIndicator color={eigenColor('orange', 100)} />);
        expect(html).toContain(`solid ${eigenColor('orange', 400)}`);
    });
});
