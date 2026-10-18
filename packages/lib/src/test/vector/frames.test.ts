import { describe, expect, test } from 'bun:test';
import {
    elementsInFrame,
    FRAME_FIELDS,
    framesFrom,
    nearestFrameId,
    nearestSlideSize,
    pointInFrame,
    SLIDE_SIZES,
    type VectorFrame,
} from '../../vector/frames';
import { SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
import { shape } from './element-factories';

function frames(...ids: string[]): VectorFrame[] {
    return ids.map((id, i) => ({
        id,
        index: `a${i}`,
        name: '',
        ...SLIDE_SIZES['16:9'],
        background: '',
    }));
}

describe('SLIDE_SIZES', () => {
    // Google's sizes: both 10 in wide, so a 4:3 slide is the 16:9 one with 360 px more height and a
    // switch moves nothing off the page.
    test('16:9 is 1920x1080 and 4:3 keeps the width at 1920x1440', () => {
        expect(SLIDE_SIZES).toEqual({ '16:9': { width: 1920, height: 1080 }, '4:3': { width: 1920, height: 1440 } });
    });
});

describe('nearestSlideSize', () => {
    test("PowerPoint's and Google's widescreen sizes, and 16:10, are 16:9", () => {
        expect(nearestSlideSize(12_192_000, 6_858_000)).toBe('16:9');
        expect(nearestSlideSize(9_144_000, 5_143_500)).toBe('16:9');
        expect(nearestSlideSize(1920, 1200)).toBe('16:9');
    });

    test('4:3 and A4 landscape are 4:3', () => {
        expect(nearestSlideSize(9_144_000, 6_858_000)).toBe('4:3');
        expect(nearestSlideSize(10_692_000, 7_560_000)).toBe('4:3');
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

describe('pointInFrame', () => {
    const [page] = frames('f1');

    test('the page and its edges are inside', () => {
        expect(pointInFrame({ x: 0, y: 0 }, page)).toBe(true);
        expect(pointInFrame({ x: 960, y: 540 }, page)).toBe(true);
        expect(pointInFrame({ x: page.width, y: page.height }, page)).toBe(true);
    });

    test('the letterbox backdrop around it is outside', () => {
        expect(pointInFrame({ x: -1, y: 540 }, page)).toBe(false);
        expect(pointInFrame({ x: 960, y: -1 }, page)).toBe(false);
        expect(pointInFrame({ x: page.width + 1, y: 540 }, page)).toBe(false);
        expect(pointInFrame({ x: 960, y: page.height + 1 }, page)).toBe(false);
    });
});

test('FRAME_FIELDS is the stored key allow-list, and excludes the size the deck sets', () => {
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
