// Anchor geometry for the cell-range picker: a dialog portaled to document.body is
// position:fixed, so the sheet-content anchor an overlay child would have used has to
// be converted to viewport coordinates by hand — including the freeze pinning that
// OverlayRegion's transform does for real overlay children — and clamped on screen.

import { describe, expect, it } from 'bun:test';
import {
    clampToViewport,
    type OverlayAnchor,
    overlayAnchorToViewport,
    VIEWPORT_MARGIN,
} from '../../../state/modules/overlay-anchor';

// A cell at content (300, 120), a cell area starting 44px right and 96px down the
// viewport (row header + column header + the app chrome above the grid).
const anchor: OverlayAnchor = {
    contentLeft: 300,
    contentTop: 120,
    areaLeft: 44,
    areaTop: 96,
    fixedLeft: null,
    fixedTop: null,
    scrollLeft: 0,
    scrollTop: 0,
};

const VIEWPORT = { width: 1200, height: 800 };
const SIZE = { width: 380, height: 200 };

describe('overlayAnchorToViewport', () => {
    it('unscrolled: content offset from the cell area origin', () => {
        expect(overlayAnchorToViewport(anchor)).toEqual({ left: 344, top: 216 });
    });

    it('a scrolled pane moves the anchor by the scroll on both axes', () => {
        expect(overlayAnchorToViewport({ ...anchor, scrollLeft: 100, scrollTop: 40 })).toEqual({
            left: 244,
            top: 176,
        });
    });

    it('a frozen axis pins to its freeze-time scroll and ignores the bus', () => {
        expect(overlayAnchorToViewport({ ...anchor, fixedLeft: 0, scrollLeft: 100, scrollTop: 40 })).toEqual({
            left: 344,
            top: 176,
        });
    });

    it('both axes frozen: the anchor does not move with the scroll at all', () => {
        expect(
            overlayAnchorToViewport({
                ...anchor,
                fixedLeft: 0,
                fixedTop: 0,
                scrollLeft: 100,
                scrollTop: 40,
            }),
        ).toEqual({ left: 344, top: 216 });
    });

    it('a frozen band scrolled at freeze time offsets by that pinned scroll', () => {
        expect(overlayAnchorToViewport({ ...anchor, fixedTop: 50, scrollTop: 400 })).toEqual({
            left: 344,
            top: 166,
        });
    });
});

describe('clampToViewport', () => {
    it('leaves a point that fits where it is', () => {
        expect(clampToViewport({ left: 344, top: 216 }, SIZE, VIEWPORT)).toEqual({ left: 344, top: 216 });
    });

    it('shifts back from the right edge', () => {
        expect(clampToViewport({ left: 1100, top: 216 }, SIZE, VIEWPORT)).toEqual({
            left: VIEWPORT.width - SIZE.width - VIEWPORT_MARGIN,
            top: 216,
        });
    });

    it('shifts up from the bottom edge', () => {
        expect(clampToViewport({ left: 344, top: 700 }, SIZE, VIEWPORT)).toEqual({
            left: 344,
            top: VIEWPORT.height - SIZE.height - VIEWPORT_MARGIN,
        });
    });

    it('keeps the margin on the near edges when the anchor is off-screen', () => {
        expect(clampToViewport({ left: -200, top: -50 }, SIZE, VIEWPORT)).toEqual({
            left: VIEWPORT_MARGIN,
            top: VIEWPORT_MARGIN,
        });
    });

    it('a dialog taller than the viewport pins to the top-left margin, not off the far edge', () => {
        expect(clampToViewport({ left: 344, top: 216 }, { width: 380, height: 900 }, VIEWPORT)).toEqual({
            left: 344,
            top: VIEWPORT_MARGIN,
        });
    });
});
