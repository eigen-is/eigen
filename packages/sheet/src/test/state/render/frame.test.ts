// After a scroll alone, the frame copies each pane's pixels to their new place and repaints the rest. A
// device pixel is copied once at most: at a fractional pixel ratio two panes that meet share a pixel, and
// copying it once per pane moved it at twice the scroll's speed.

import { describe, expect, test } from 'bun:test';
import type { Box } from '../../../state/render/frame';
import { planScroll } from '../../../state/render/frame';
import type { Freezen, FreezenAxisData } from '../../../state/types';
import { workbookContextFactory } from '../factories/context';

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const frozenAt = (pos: number): FreezenAxisData => ({ pos, boundary: 1, scroll: 0, cumulative: [], edge: 0 });

const FREEZES: [string, Freezen | undefined][] = [
    ['no freeze', undefined],
    ['frozen rows', { horizontal: { freezenhorizontaldata: frozenAt(61) } }],
    ['frozen columns', { vertical: { freezenverticaldata: frozenAt(201) } }],
    [
        'frozen rows and columns',
        { horizontal: { freezenhorizontaldata: frozenAt(61) }, vertical: { freezenverticaldata: frozenAt(201) } },
    ],
];

const STEPS = [
    [0, 40],
    [0, -40],
    [40, 0],
    [20, 20],
];

describe('state/render/frame — planScroll', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
        test(`copies each device pixel once at most and repaints each box once, at a pixel ratio of ${dpr}`, () => {
            const ctx = workbookContextFactory({
                devicePixelRatio: dpr,
                rowHeaderWidth: 46,
                columnHeaderHeight: 20,
                tableContentSize: [1000, 600],
            });
            for (const [name, freeze] of FREEZES) {
                for (const [dx, dy] of STEPS) {
                    const plan = planScroll(
                        ctx,
                        freeze,
                        { scrollLeft: 100, scrollTop: 100 },
                        { scrollLeft: 100 + dx, scrollTop: 100 + dy },
                        Math.ceil(1000 * dpr),
                        Math.ceil(600 * dpr),
                    );
                    expect(plan, `${name}, ${dx},${dy}`).toBeDefined();
                    const copies = plan?.copies ?? [];
                    for (const [i, a] of copies.entries()) {
                        for (const b of copies.slice(i + 1)) {
                            expect(overlaps(a.box, b.box), `${name}, ${dx},${dy}`).toBe(false);
                        }
                    }
                    const stale = (plan?.stale ?? []).map((box) => JSON.stringify(box));
                    expect(new Set(stale).size, `${name}, ${dx},${dy}: a box repainted twice`).toBe(stale.length);
                }
            }
        });
    }

    test('draws the frame whole for a step of part of a device pixel or more than half the canvas', () => {
        const ctx = workbookContextFactory({
            devicePixelRatio: 2,
            rowHeaderWidth: 46,
            columnHeaderHeight: 20,
            tableContentSize: [1000, 600],
        });
        const from = { scrollLeft: 0, scrollTop: 0 };
        expect(planScroll(ctx, undefined, from, { scrollLeft: 0, scrollTop: 0.3 }, 2000, 1200)).toBeUndefined();
        expect(planScroll(ctx, undefined, from, { scrollLeft: 0, scrollTop: 400 }, 2000, 1200)).toBeUndefined();
    });
});
