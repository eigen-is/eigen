// Overlay pane-region geometry (SHEETS-TODO group 5.2). Pins the contract for
// the body-overlay region viewports that replace the per-element
// fix*StyleOverflowInFreeze clamps: up to four viewport rects derived from the
// freeze config, each translating from the scroll bus on its free axes only
// (fixedLeft/fixedTop = null), while a frozen axis pins to the freeze-time
// scroll. Mirrors the canvas pane draw (drawFrozenBoth & friends).

import { describe, expect, it } from 'bun:test';
import {
    computeColumnHeaderRegions,
    computeOverlayRegions,
    computeRowHeaderRegions,
    overlayRegionForCell,
} from '../../../state/modules/freeze';
import type { Freezen } from '../../../state/types';

const VIEW_W = 900;
const VIEW_H = 500;

function rowsFreeze(pos: number, boundary: number, scroll = 0): Freezen {
    return { horizontal: { freezenhorizontaldata: { pos, boundary, scroll, cumulative: [], edge: 0 } } };
}

function colsFreeze(pos: number, boundary: number, scroll = 0): Freezen {
    return { vertical: { freezenverticaldata: { pos, boundary, scroll, cumulative: [], edge: 0 } } };
}

function bothFreeze(rowPos: number, rowBoundary: number, colPos: number, colBoundary: number): Freezen {
    return {
        ...rowsFreeze(rowPos, rowBoundary),
        ...colsFreeze(colPos, colBoundary),
    };
}

describe('computeOverlayRegions', () => {
    it('no freeze -> exactly one unclipped main region following the bus on both axes', () => {
        const regions = computeOverlayRegions(undefined, VIEW_W, VIEW_H);
        expect(regions).toEqual([
            {
                pane: 'main',
                left: 0,
                top: 0,
                width: VIEW_W,
                height: VIEW_H,
                clip: false,
                fixedLeft: null,
                fixedTop: null,
            },
        ]);
    });

    it('an empty freeze object (no axis data) behaves like no freeze', () => {
        const regions = computeOverlayRegions({}, VIEW_W, VIEW_H);
        expect(regions).toHaveLength(1);
        expect(regions[0].clip).toBe(false);
    });

    it('frozen rows -> clipped main below a full-width top band pinned on y', () => {
        const regions = computeOverlayRegions(rowsFreeze(42, 2), VIEW_W, VIEW_H);
        expect(regions).toEqual([
            {
                pane: 'main',
                left: 0,
                top: 42,
                width: VIEW_W,
                height: VIEW_H - 42,
                clip: true,
                fixedLeft: null,
                fixedTop: null,
            },
            { pane: 'rows', left: 0, top: 0, width: VIEW_W, height: 42, clip: true, fixedLeft: null, fixedTop: 0 },
        ]);
    });

    it('frozen columns -> clipped main right of a full-height left band pinned on x', () => {
        const regions = computeOverlayRegions(colsFreeze(73, 1), VIEW_W, VIEW_H);
        expect(regions).toEqual([
            {
                pane: 'main',
                left: 73,
                top: 0,
                width: VIEW_W - 73,
                height: VIEW_H,
                clip: true,
                fixedLeft: null,
                fixedTop: null,
            },
            { pane: 'cols', left: 0, top: 0, width: 73, height: VIEW_H, clip: true, fixedLeft: 0, fixedTop: null },
        ]);
    });

    it('both axes -> main + rows band + cols band + corner, mirroring the canvas panes', () => {
        const regions = computeOverlayRegions(bothFreeze(42, 2, 73, 1), VIEW_W, VIEW_H);
        expect(regions).toEqual([
            {
                pane: 'main',
                left: 73,
                top: 42,
                width: VIEW_W - 73,
                height: VIEW_H - 42,
                clip: true,
                fixedLeft: null,
                fixedTop: null,
            },
            {
                pane: 'rows',
                left: 73,
                top: 0,
                width: VIEW_W - 73,
                height: 42,
                clip: true,
                fixedLeft: null,
                fixedTop: 0,
            },
            {
                pane: 'cols',
                left: 0,
                top: 42,
                width: 73,
                height: VIEW_H - 42,
                clip: true,
                fixedLeft: 0,
                fixedTop: null,
            },
            { pane: 'corner', left: 0, top: 0, width: 73, height: 42, clip: true, fixedLeft: 0, fixedTop: 0 },
        ]);
    });

    it('a non-zero freeze-time scroll shrinks the band and pins to that scroll', () => {
        // Band shows content [scroll, pos): height = pos - scroll, fixedTop = scroll.
        const regions = computeOverlayRegions(rowsFreeze(52, 2, 10), VIEW_W, VIEW_H);
        expect(regions[0]).toMatchObject({ pane: 'main', top: 42, height: VIEW_H - 42 });
        expect(regions[1]).toMatchObject({ pane: 'rows', height: 42, fixedTop: 10 });
    });
});

// The header projections drop the irrelevant axis of the body regions and pin
// the header's cross axis to 0 (headers never translate on their fixed axis).
describe('computeColumnHeaderRegions', () => {
    const HEADER_H = 19;

    it('no freeze -> one unclipped region following the bus on x, pinned on y', () => {
        expect(computeColumnHeaderRegions(undefined, VIEW_W, HEADER_H)).toEqual([
            {
                pane: 'main',
                left: 0,
                top: 0,
                width: VIEW_W,
                height: HEADER_H,
                clip: false,
                fixedLeft: null,
                fixedTop: 0,
            },
        ]);
    });

    it('frozen rows only -> nothing to split horizontally, still one unclipped region', () => {
        const regions = computeColumnHeaderRegions(rowsFreeze(42, 2), VIEW_W, HEADER_H);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({ pane: 'main', clip: false, fixedLeft: null, fixedTop: 0 });
    });

    it('frozen columns -> pinned band + clipped main, matching the body cols band on x', () => {
        expect(computeColumnHeaderRegions(bothFreeze(42, 2, 73, 1), VIEW_W, HEADER_H)).toEqual([
            {
                pane: 'main',
                left: 73,
                top: 0,
                width: VIEW_W - 73,
                height: HEADER_H,
                clip: true,
                fixedLeft: null,
                fixedTop: 0,
            },
            { pane: 'cols', left: 0, top: 0, width: 73, height: HEADER_H, clip: true, fixedLeft: 0, fixedTop: 0 },
        ]);
    });

    it('a non-zero freeze-time scroll shrinks the band and pins to that scroll', () => {
        const regions = computeColumnHeaderRegions(colsFreeze(83, 1, 10), VIEW_W, HEADER_H);
        expect(regions[0]).toMatchObject({ pane: 'main', left: 73, width: VIEW_W - 73 });
        expect(regions[1]).toMatchObject({ pane: 'cols', width: 73, fixedLeft: 10, fixedTop: 0 });
    });
});

describe('computeRowHeaderRegions', () => {
    const HEADER_W = 45;

    it('no freeze -> one unclipped region following the bus on y, pinned on x', () => {
        expect(computeRowHeaderRegions(undefined, HEADER_W, VIEW_H)).toEqual([
            {
                pane: 'main',
                left: 0,
                top: 0,
                width: HEADER_W,
                height: VIEW_H,
                clip: false,
                fixedLeft: 0,
                fixedTop: null,
            },
        ]);
    });

    it('frozen columns only -> nothing to split vertically, still one unclipped region', () => {
        const regions = computeRowHeaderRegions(colsFreeze(73, 1), HEADER_W, VIEW_H);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({ pane: 'main', clip: false, fixedLeft: 0, fixedTop: null });
    });

    it('frozen rows -> pinned band + clipped main, matching the body rows band on y', () => {
        expect(computeRowHeaderRegions(bothFreeze(42, 2, 73, 1), HEADER_W, VIEW_H)).toEqual([
            {
                pane: 'main',
                left: 0,
                top: 42,
                width: HEADER_W,
                height: VIEW_H - 42,
                clip: true,
                fixedLeft: 0,
                fixedTop: null,
            },
            { pane: 'rows', left: 0, top: 0, width: HEADER_W, height: 42, clip: true, fixedLeft: 0, fixedTop: 0 },
        ]);
    });

    it('a non-zero freeze-time scroll shrinks the band and pins to that scroll', () => {
        const regions = computeRowHeaderRegions(rowsFreeze(52, 2, 10), HEADER_W, VIEW_H);
        expect(regions[0]).toMatchObject({ pane: 'main', top: 42, height: VIEW_H - 42 });
        expect(regions[1]).toMatchObject({ pane: 'rows', height: 42, fixedLeft: 0, fixedTop: 10 });
    });
});

describe('overlayRegionForCell', () => {
    const freeze = bothFreeze(42, 2, 73, 1);
    const regions = computeOverlayRegions(freeze, VIEW_W, VIEW_H);

    it('routes a cell frozen on both axes to the corner', () => {
        expect(overlayRegionForCell(regions, freeze, 0, 0).pane).toBe('corner');
    });

    it('routes a frozen-row cell right of the frozen columns to the rows band', () => {
        expect(overlayRegionForCell(regions, freeze, 1, 3).pane).toBe('rows');
    });

    it('routes a frozen-column cell below the frozen rows to the cols band', () => {
        expect(overlayRegionForCell(regions, freeze, 5, 0).pane).toBe('cols');
    });

    it('routes an unfrozen cell to main', () => {
        expect(overlayRegionForCell(regions, freeze, 5, 5).pane).toBe('main');
    });

    it('boundary indexes are the first NON-frozen row/col (match the clamp semantics)', () => {
        // boundary = 2 -> rows 0..1 frozen, row 2 is main.
        expect(overlayRegionForCell(regions, freeze, 2, 5).pane).toBe('main');
    });

    it('no freeze -> always main', () => {
        const noFreeze = computeOverlayRegions(undefined, VIEW_W, VIEW_H);
        expect(overlayRegionForCell(noFreeze, undefined, 0, 0).pane).toBe('main');
    });
});
