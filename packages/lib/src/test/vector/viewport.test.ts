import { describe, expect, test } from 'bun:test';
import {
    chromeTransform,
    clampFrameViewport,
    FRAME_CARD_BORDER,
    FRAME_CARD_RADIUS,
    FRAME_FIT_PADDING,
    fitFrameViewport,
    frameCardChrome,
    groupTransform,
    sceneTransform,
} from '../../vector/viewport';

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

describe('re-fitting on a container resize', () => {
    // The deck canvas holds no zoom of its own: every resize re-fits, so the page is always the
    // largest one the new container can show with padding, and always centred in it.
    const fitsExactly = (container: { width: number; height: number }) => {
        const v = fitFrameViewport(container, FRAME);
        const shown = { width: FRAME.width * v.zoom, height: FRAME.height * v.zoom };
        expect(shown.width).toBeLessThanOrEqual(container.width - FRAME_FIT_PADDING * 2 + 1e-9);
        expect(shown.height).toBeLessThanOrEqual(container.height - FRAME_FIT_PADDING * 2 + 1e-9);
        // One axis is binding: the page touches the padding on it.
        const slackX = container.width - FRAME_FIT_PADDING * 2 - shown.width;
        const slackY = container.height - FRAME_FIT_PADDING * 2 - shown.height;
        expect(Math.min(slackX, slackY)).toBeCloseTo(0, 9);
        // Centred on both axes.
        expect((v.scrollX + FRAME.width / 2) * v.zoom).toBeCloseTo(container.width / 2, 6);
        expect((v.scrollY + FRAME.height / 2) * v.zoom).toBeCloseTo(container.height / 2, 6);
        return v;
    };

    test('a shrunk container re-fits to a smaller zoom, still centred', () => {
        const big = fitsExactly({ width: 1600, height: 1000 });
        const small = fitsExactly({ width: 1200, height: 700 });
        expect(small.zoom).toBeLessThan(big.zoom);
    });

    test('the fit depends only on the container, not on the viewport it replaces', () => {
        expect(fitFrameViewport({ width: 1200, height: 700 }, FRAME)).toEqual(
            fitFrameViewport({ width: 1200, height: 700 }, FRAME),
        );
    });
});

describe('frameCardChrome', () => {
    test('holds the card border and radius at a constant SCREEN size', () => {
        const c = frameCardChrome(0.5);
        expect(c.borderWidth * 0.5).toBeCloseTo(FRAME_CARD_BORDER, 9);
        expect(c.borderRadius * 0.5).toBeCloseTo(FRAME_CARD_RADIUS, 9);
    });

    test('is the plain screen size at zoom 1', () => {
        expect(frameCardChrome(1)).toEqual({ borderWidth: FRAME_CARD_BORDER, borderRadius: FRAME_CARD_RADIUS });
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

describe('sceneTransform / groupTransform', () => {
    test('map a scene point the same way in both syntaxes', () => {
        const v = { zoom: 2, scrollX: 30, scrollY: -10 };
        expect(sceneTransform(v)).toBe('translate(60px, -20px) scale(2)');
        expect(groupTransform(v)).toBe('translate(60 -20) scale(2)');
    });
});

describe('chromeTransform', () => {
    const rendered = { zoom: 2, scrollX: 30, scrollY: -10 };
    // Where boxToStyle puts a scene box: (scene + scroll) * zoom.
    const px = (v: typeof rendered, x: number) => (x + v.scrollX) * v.zoom;
    // What the correction does to that px position: translate(d) scale(s) about origin 0 0.
    const applied = (t: string, left: number) => {
        const [, dx, s] = t.match(/translate\((-?[\d.]+)px, (?:-?[\d.]+)px\) scale\((-?[\d.]+)\)/) ?? [];
        return Number(s) * left + Number(dx);
    };

    test('is empty while the live viewport still matches the rendered one', () => {
        expect(chromeTransform(rendered, { ...rendered })).toBe('');
    });

    test('a pan lands the rendered chrome on the live position, at scale 1', () => {
        const live = { ...rendered, scrollX: 55, scrollY: 4 };
        const t = chromeTransform(rendered, live);
        expect(t).toContain('scale(1)');
        expect(applied(t, px(rendered, 100))).toBeCloseTo(px(live, 100), 9);
    });

    test('a zoom lands it too, scaling the chrome with the scene', () => {
        const live = { zoom: 3.5, scrollX: 12, scrollY: 40 };
        const t = chromeTransform(rendered, live);
        expect(applied(t, px(rendered, 100))).toBeCloseTo(px(live, 100), 9);
        expect(applied(t, px(rendered, -250))).toBeCloseTo(px(live, -250), 9);
    });
});
