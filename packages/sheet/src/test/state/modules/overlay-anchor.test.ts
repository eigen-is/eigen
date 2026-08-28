// Anchor geometry for the cell-range picker: a dialog portaled to document.body is
// position:fixed, so the sheet-content anchor an overlay child would have used has to
// be converted to viewport coordinates by hand — including the freeze pinning that
// OverlayRegion's transform does for real overlay children.

import { describe, expect, it } from 'bun:test';
import { overlayAnchorToViewport } from '../../../state/modules/overlay-anchor';

// A cell at content (300, 120), a cell area starting 44px right and 96px down the
// viewport (row header + column header + the app chrome above the grid).
const toViewport = (fixedLeft: number | null, fixedTop: number | null, scrollLeft: number, scrollTop: number) =>
    overlayAnchorToViewport(300, 120, 44, 96, fixedLeft, fixedTop, scrollLeft, scrollTop);

describe('overlayAnchorToViewport', () => {
    it('unscrolled: content offset from the cell area origin', () => {
        expect(toViewport(null, null, 0, 0)).toEqual({ left: 344, top: 216 });
    });

    it('a scrolled pane moves the anchor by the scroll on both axes', () => {
        expect(toViewport(null, null, 100, 40)).toEqual({ left: 244, top: 176 });
    });

    it('a frozen axis pins to its freeze-time scroll and ignores the bus', () => {
        expect(toViewport(0, null, 100, 40)).toEqual({ left: 344, top: 176 });
    });

    it('both axes frozen: the anchor does not move with the scroll at all', () => {
        expect(toViewport(0, 0, 100, 40)).toEqual({ left: 344, top: 216 });
    });

    it('a frozen band scrolled at freeze time offsets by that pinned scroll', () => {
        expect(toViewport(null, 50, 0, 400)).toEqual({ left: 344, top: 166 });
    });
});
