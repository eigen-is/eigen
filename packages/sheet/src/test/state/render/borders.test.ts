// A shared edge two neighbours both declare (A1.r vs B1.l) must paint deterministically: the
// higher-index neighbour's facing side wins, regardless of the order drawCellBorders happens to
// walk the map in. Without the rule the last stroke wins and the winner flips with the viewport
// (forEachInRect's walk mode), so the edge changes color on zoom.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/index';
import { drawCellBorders } from '../../../state/render/borders';
import type { RenderPass } from '../../../state/render/types';
import { contextFactory } from '../factories/context';

const RED = { style: 1, color: '#f00' };
const BLUE = { style: 1, color: '#00f' };

type Stroke = { color: string; from: [number, number]; to: [number, number] };

function recordingPass(ctx: Context): { pass: RenderPass; strokes: Stroke[] } {
    const strokes: Stroke[] = [];
    let strokeStyle = '';
    let move: [number, number] = [0, 0];
    let line: [number, number] = [0, 0];
    const renderCtx = {
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        stroke() {
            strokes.push({ color: strokeStyle, from: move, to: line });
        },
        setLineDash() {},
        moveTo(x: number, y: number) {
            move = [x, y];
        },
        lineTo(x: number, y: number) {
            line = [x, y];
        },
        set strokeStyle(v: string) {
            strokeStyle = v;
        },
        set lineWidth(_v: number) {},
    };
    const pass = {
        sheetCtx: ctx,
        renderCtx: renderCtx as unknown as CanvasRenderingContext2D,
        offsetLeft: 0,
        offsetTop: 0,
        scrollWidth: 0,
        scrollHeight: 0,
        rowStart: 0,
        rowEnd: 3,
        colStart: 0,
        colEnd: 3,
        cellOverflowMap: {},
    } as unknown as RenderPass;
    return { pass, strokes };
}

const verticals = (s: Stroke[]) => s.filter((k) => k.from[0] === k.to[0]);
const horizontals = (s: Stroke[]) => s.filter((k) => k.from[1] === k.to[1]);

describe('drawCellBorders shared-edge determinism', () => {
    test('the right neighbour left side wins the vertical edge over this cell right side', () => {
        const ctx = contextFactory({ config: { borderInfo: { '0_0': { r: RED }, '0_1': { l: BLUE } } } }) as Context;
        const { pass, strokes } = recordingPass(ctx);
        drawCellBorders(pass);
        // A1.r is skipped, B1.l wins: no red vertical stroke, the blue one is present.
        expect(verticals(strokes).some((k) => k.color === '#f00')).toBe(false);
        expect(verticals(strokes).some((k) => k.color === '#00f')).toBe(true);
    });

    test('the lower neighbour top side wins the horizontal edge over this cell bottom side', () => {
        const ctx = contextFactory({ config: { borderInfo: { '0_1': { b: RED }, '1_1': { t: BLUE } } } }) as Context;
        const { pass, strokes } = recordingPass(ctx);
        drawCellBorders(pass);
        // B1.b is skipped, B2.t wins.
        expect(horizontals(strokes).some((k) => k.color === '#f00')).toBe(false);
        expect(horizontals(strokes).some((k) => k.color === '#00f')).toBe(true);
    });

    test('a lone right side with no facing neighbour still draws', () => {
        const ctx = contextFactory({ config: { borderInfo: { '0_0': { r: RED } } } }) as Context;
        const { pass, strokes } = recordingPass(ctx);
        drawCellBorders(pass);
        expect(verticals(strokes).some((k) => k.color === '#f00')).toBe(true);
    });
});
