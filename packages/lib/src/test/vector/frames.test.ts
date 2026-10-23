import { describe, expect, test } from 'bun:test';
import {
    canvasPtToPx,
    canvasPxToPt,
    elementsInFrame,
    FRAME_FIELDS,
    framesFrom,
    MAX_SLIDE_WIDTH,
    MIN_SLIDE_WIDTH,
    nearestFrameId,
    nearestSlideSize,
    pointInFrame,
    SLIDE_SIZES,
    slideFontSize,
    slidePtToPx,
    slidePxToPt,
    snapSlideFontSize,
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

describe('canvasPxToPt', () => {
    // A drawing prints at CSS's 96 dpi, so that is the pt a canvas px crosses the clipboard as.
    test('a canvas px is 3/4 pt, and back', () => {
        expect(canvasPxToPt(20)).toBe(15);
        expect(canvasPtToPx(15)).toBe(20);
        expect(canvasPtToPx(canvasPxToPt(48))).toBe(48);
    });
});

describe("a deck's pt", () => {
    // Google's 10 in deck is 8/3 px a pt; PowerPoint's 13.33 in widescreen 2.
    test('converts at the deck width, both ways', () => {
        expect(slidePtToPx(44, 960)).toBe(88);
        expect(slidePxToPt(88, 960)).toBe(44);
        expect(slidePxToPt(slidePtToPx(44, 720), 720)).toBe(44);
        expect(slidePxToPt(48, 720)).toBe(18);
    });

    // What the pptx reader computes for Google's 44 pt title: 44 × 12,700 EMU at 1920 / 9,144,000 px an EMU.
    test('shows a stored px on the half-point grid, in fonts.ts range', () => {
        expect(slideFontSize(117.33333333333334, 720)).toBe(44);
        expect(slideFontSize(117.4, 720)).toBe(44);
        expect(slideFontSize(29, 720)).toBe(11);
        expect(slideFontSize(28.1, 720)).toBe(10.5);
        expect(slideFontSize(0.01, 720)).toBe(1);
        expect(slideFontSize(1e6, 720)).toBe(400);
    });

    // ST_SlideSizeCoordinate's 1 to 56 in holds both sides of every slide size; a 16:9 height is the short side.
    test("every deck's p:sldSz is within PowerPoint's 1 to 56 in", () => {
        for (const { width, height } of Object.values(SLIDE_SIZES)) {
            expect(slidePxToPt(height, MIN_SLIDE_WIDTH)).toBeGreaterThanOrEqual(72);
            expect(slidePxToPt(width, MAX_SLIDE_WIDTH)).toBeLessThanOrEqual(4032);
        }
        expect(slidePxToPt(SLIDE_SIZES['16:9'].height, MIN_SLIDE_WIDTH)).toBe(72);
    });

    test("snaps an imported size to the deck's half points", () => {
        expect(snapSlideFontSize(117.33333333333334, 720)).toBe(slidePtToPx(44, 720));
        expect(snapSlideFontSize(88.4, 960)).toBe(88);
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
