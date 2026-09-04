import { describe, expect, test } from 'bun:test';
import {
    elementsInFrame,
    FRAME_ASPECT_RATIO,
    FRAME_FIELDS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    framesFrom,
    nearestFrameId,
    type VectorFrame,
} from '../../vector/frames';
import { SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
import { shape } from './element-factories';

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

describe('frames', () => {
    // The one fact a test can hold that the declarations don't: every frame in this programme is 16:9
    // at 1920x1080, and the size is a constant rather than a stored field.
    test('every frame is 16:9 at 1920x1080', () => {
        expect([FRAME_WIDTH, FRAME_HEIGHT]).toEqual([1920, 1080]);
        expect(FRAME_ASPECT_RATIO).toBeCloseTo(16 / 9);
    });
});

describe('elementsInFrame', () => {
    test('selects exactly the elements homed to that frame', () => {
        const els = [
            shape({ id: 'a', type: 'rectangle', frameId: 'f1' }),
            shape({ id: 'b', type: 'rectangle', frameId: 'f2' }),
            shape({ id: 'c', type: 'rectangle' }),
        ];
        expect(elementsInFrame(els, 'f1').map((e) => e.id)).toEqual(['a']);
        expect(elementsInFrame(els, '').map((e) => e.id)).toEqual(['c']);
    });
});

test('FRAME_FIELDS is the stored key allow-list, and excludes the constant size', () => {
    expect(FRAME_FIELDS).toEqual(['id', 'index', 'name', 'background']);
});

describe('nearestFrameId', () => {
    test('keeps the active frame when it is still there', () => {
        expect(nearestFrameId(frames('a', 'b', 'c'), 'b', 1)).toBe('b');
    });

    test('a deleted frame hands over to the one that took its position', () => {
        // 'b' was at position 1; after its delete the deck is [a, c] and position 1 is 'c'.
        expect(nearestFrameId(frames('a', 'c'), 'b', 1)).toBe('c');
    });

    test('deleting the last frame steps BACK, not off the end', () => {
        expect(nearestFrameId(frames('a', 'b'), 'c', 2)).toBe('b');
    });

    test('an empty deck has no active frame', () => {
        expect(nearestFrameId([], 'a', 0)).toBe('');
    });

    test('no active frame yet activates the first', () => {
        expect(nearestFrameId(frames('a', 'b'), '', 0)).toBe('a');
    });
});

describe('framesFrom', () => {
    test('is the frame and everything after it, in order', () => {
        expect(framesFrom(frames('a', 'b', 'c'), 'b').map((f) => f.id)).toEqual(['b', 'c']);
    });

    test('an unknown frame selects nothing', () => {
        expect(framesFrom(frames('a', 'b'), 'zz')).toEqual([]);
    });
});

describe('style tables', () => {
    test('slides draws flat and solid in Inter; vector draws rough and hatched', () => {
        expect(SLIDES_STYLE_DEFAULTS.roughness).toBe(0);
        expect(SLIDES_STYLE_DEFAULTS.fontFamily).toBe('Inter');
        expect(VECTOR_STYLE_DEFAULTS.roughness).toBe(1);
        expect(VECTOR_STYLE_DEFAULTS.fontFamily).toBe('Excalifont');
    });

    test('both tables answer every StyleDefaults key', () => {
        expect(Object.keys(SLIDES_STYLE_DEFAULTS).sort()).toEqual(Object.keys(VECTOR_STYLE_DEFAULTS).sort());
    });
});
