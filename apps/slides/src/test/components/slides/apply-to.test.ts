import { describe, expect, test } from 'bun:test';
import { FRAME_HEIGHT, FRAME_WIDTH, type VectorFrame } from '@workspace/lib/vector';
import { targetFrameIds } from '../../../components/slides/apply-to';

function frames(...ids: string[]): VectorFrame[] {
    return ids.map((id, i) => ({
        id,
        index: `a${i}`,
        name: '',
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        background: '',
    }));
}

describe('targetFrameIds', () => {
    const deck = frames('a', 'b', 'c');

    test('this slide is just the one', () => {
        expect(targetFrameIds(deck, 'b', 'this')).toEqual(['b']);
    });

    test('this and following runs to the end of the deck', () => {
        expect(targetFrameIds(deck, 'b', 'this-and-following')).toEqual(['b', 'c']);
    });

    test('all slides is the whole deck, in order', () => {
        expect(targetFrameIds(deck, 'b', 'all')).toEqual(['a', 'b', 'c']);
    });

    test('a stale slide id applies to nothing rather than to everything', () => {
        expect(targetFrameIds(deck, 'gone', 'this')).toEqual([]);
        expect(targetFrameIds(deck, 'gone', 'this-and-following')).toEqual([]);
    });
});
