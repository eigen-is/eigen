import { describe, expect, test } from 'bun:test';
import { clampFrameViewport, FRAME_FIT_PADDING, fitFrameViewport, frameSnapExtras } from '../../vector/viewport';

const FRAME = { width: 1920, height: 1080 };

describe('fitFrameViewport', () => {
    test('letterboxes a wide container: the height is the binding constraint', () => {
        const v = fitFrameViewport({ width: 4000, height: 1000 }, FRAME);
        expect(v.zoom).toBeCloseTo((1000 - FRAME_FIT_PADDING * 2) / 1080, 10);
        // Centred: equal slack on both sides in SCENE units.
        expect(v.scrollX).toBeCloseTo((4000 / v.zoom - FRAME.width) / 2, 6);
        expect(v.scrollY).toBeCloseTo((1000 / v.zoom - FRAME.height) / 2, 6);
    });

    test('letterboxes a tall container: the width is the binding constraint', () => {
        const v = fitFrameViewport({ width: 800, height: 4000 }, FRAME);
        expect(v.zoom).toBeCloseTo((800 - FRAME_FIT_PADDING * 2) / 1920, 10);
    });

    test('honours a padding override: zero padding fills the binding axis exactly', () => {
        expect(fitFrameViewport({ width: 4000, height: 1000 }, FRAME, 0).zoom).toBeCloseTo(1000 / 1080, 10);
    });

    test('a degenerate container never produces a zero or negative zoom', () => {
        expect(fitFrameViewport({ width: 0, height: 0 }, FRAME).zoom).toBeGreaterThan(0);
    });
});

describe('clampFrameViewport', () => {
    test('centres the frame on an axis where it fits entirely', () => {
        const v = clampFrameViewport({ zoom: 0.25, scrollX: 999, scrollY: -999 }, { width: 1000, height: 1000 }, FRAME);
        expect(v.scrollX).toBeCloseTo((1000 / 0.25 - 1920) / 2, 6);
        expect(v.scrollY).toBeCloseTo((1000 / 0.25 - 1080) / 2, 6);
    });

    test('clamps so a zoomed-in frame cannot be panned off the viewport', () => {
        const container = { width: 960, height: 540 };
        // zoom 1 ⇒ half the frame is visible on each axis.
        expect(clampFrameViewport({ zoom: 1, scrollX: 500, scrollY: 0 }, container, FRAME).scrollX).toBe(0);
        expect(clampFrameViewport({ zoom: 1, scrollX: -5000, scrollY: 0 }, container, FRAME).scrollX).toBe(960 - 1920);
        expect(clampFrameViewport({ zoom: 1, scrollX: -100, scrollY: 0 }, container, FRAME).scrollX).toBe(-100);
    });

    test('leaves the zoom alone', () => {
        expect(clampFrameViewport({ zoom: 3, scrollX: 0, scrollY: 0 }, { width: 100, height: 100 }, FRAME).zoom).toBe(
            3,
        );
    });

    test('a fitted viewport is already clamped (clamping is idempotent)', () => {
        const container = { width: 1600, height: 900 };
        const fitted = fitFrameViewport(container, FRAME);
        expect(clampFrameViewport(fitted, container, FRAME)).toEqual(fitted);
    });
});

test('frameSnapExtras seeds the frame edges and centre lines', () => {
    expect(frameSnapExtras(FRAME)).toEqual({ extraV: [0, 960, 1920], extraH: [0, 540, 1080] });
});
