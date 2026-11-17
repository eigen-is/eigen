// The law of an op's blocks: inputs over random sets of disjoint rectangles, many down one column, full-width rows,
// far cells and rows under a link in every column, against the per-cell model; the stores' counts against a walk
// after every write; the inverse to the exact prior bytes; and inputOfBlocks against the model. Mixed with moves and
// line edits, which read blocks too, and the general op mix.
import { afterAll, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { CellContent, InputOp, Op, Rect } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { inputOfBlocks } from '../../../engine/book/apply-input';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { randomAnyOp, randomBookContent, randomLinesOp, randomMoveOp } from './batches';
import { below, randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { expectReads, modelAfter, modelOf } from './model';

const SEEDS = Number(process.env['BLOCKS_LAW_SEEDS'] ?? 8);
const STEPS = 20;
const FROM = Number(process.env['BLOCKS_LAW_FROM'] ?? 0);
const LINK = { type: 'webpage' as const, address: 'https://eigen.is' };
const RICH = [{ v: 'ab', bl: 1 as const }, { v: 'c' }];
const shapes: Record<string, number> = {};
const stat: Record<string, number> = {};
const bump = (o: Record<string, number>, k: string) => {
    o[k] = (o[k] ?? 0) + 1;
};

function walk(book: Workbook) {
    let slots = 0;
    let runs = 0;
    let bands = 0;
    let extras = 0;
    for (const [id, part] of book.sheets) {
        for (let c = book.engine.lastColumn(id); c >= 0; c -= 1) slots += book.engine.columnLength(id, c);
        const w = part.bands.weight();
        runs += w.runs;
        bands += w.bands;
        extras += part.extras.weight();
    }
    return { slots, runs, bands, extras };
}
const CUR: { op: unknown } = { op: null };
function checkCount(book: Workbook, where: string) {
    const w = walk(book);
    const held = book.weight();
    const ok = w.runs === held.runs && w.bands === held.bands && w.extras === held.extras && w.slots === held.slots;
    if (!ok)
        throw new Error(
            `count ${where} op ${JSON.stringify(CUR.op).slice(0, 600)}: walk ${JSON.stringify(w)} held ${JSON.stringify(held)} slots ${book.engine.slots()}`,
        );
    bump(stat, 'count checks');
}
// After every write inside a batch: every `over` call is a point between writes.
const realOver = Workbook.prototype.over;
Workbook.prototype.over = function (this: Workbook, slots = 0, formats = 0) {
    // A sheet add weighs its new part before it is listed (the reviewer's ADDING case).
    if ((CUR.op as { kind?: string } | null)?.kind !== 'sheet') checkCount(this, 'over');
    return realOver.call(this, slots, formats);
};
afterAll(() => {
    Workbook.prototype.over = realOver;
});

const meets = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function drawRect(random: () => number, kind: string, row0: number): Rect {
    const t = below(random, 40);
    const l = below(random, 30);
    switch (kind) {
        case 'cell':
            return [t, l, t, l];
        case 'farcell':
            return [GRID_ROWS - 1 - below(random, 3), l, GRID_ROWS - 1, l];
        case 'fullrow':
            return [t, 0, t, GRID_COLUMNS - 1];
        case 'fullcol':
            return [0, l, GRID_ROWS - 1, l];
        case 'onerow':
            return [t, l, t, l + below(random, 20)];
        case 'underlinks': {
            const top = row0 + 1 + below(random, 3);
            return [top, l, top + below(random, 4), GRID_COLUMNS - 1 - below(random, 2)];
        }
        case 'farcol':
            return [t, GRID_COLUMNS - 1 - below(random, 3), t + below(random, 5), GRID_COLUMNS - 1];
        default:
            return [t, l, t + below(random, 6), l + below(random, 5)];
    }
}
const KINDS = [
    'cell',
    'cell',
    'farcell',
    'fullrow',
    'fullcol',
    'onerow',
    'onerow',
    'underlinks',
    'farcol',
    'block',
    'block',
];

function contentFor(random: () => number, rect: Rect): CellContent | null {
    const area = (rect[2] - rect[0] + 1) * (rect[3] - rect[1] + 1);
    if (area > 200_000) return null;
    if (area > 5_000) return random() < 0.5 ? null : random() < 0.5 ? { link: LINK } : { v: 3 };
    const all: (CellContent | null)[] = [
        null,
        { v: 7 },
        { v: 'x', link: LINK },
        { link: LINK },
        { qp: 1 },
        { s: RICH },
        { f: '=R[-1]C+1' },
        { v: 'typed', qp: 1 },
        { f: '=SUM(R1C1:R3C3)', link: LINK },
    ];
    return all[below(random, all.length)];
}

function rectSet(random: () => number, row0: number): Rect[] {
    const rects: Rect[] = [];
    const n = 1 + below(random, random() < 0.2 ? 40 : 6);
    for (let i = 0; i < n * 3 && rects.length < n; i += 1) {
        const kind = KINDS[below(random, KINDS.length)];
        let rect = drawRect(random, kind, row0);
        // Touch at an edge: put the next one just right of or below the last.
        if (rects.length > 0 && random() < 0.25) {
            const [t, , b, r] = rects[rects.length - 1];
            if (r < GRID_COLUMNS - 1) rect = [t, r + 1, b, Math.min(GRID_COLUMNS - 1, r + 1 + below(random, 3))];
        }
        if (rects.some((other) => meets(other, rect))) continue;
        bump(shapes, kind);
        rects.push(rect);
    }
    // Many one-row runs stacked.
    if (random() < 0.1) {
        const l = below(random, 20);
        const r = random() < 0.5 ? GRID_COLUMNS - 1 : l + below(random, 30);
        for (let row = 200; row < 200 + 300; row += 1) {
            const rect: Rect = [row, l, row, r];
            if (!rects.some((other) => meets(other, rect))) rects.push(rect);
        }
        bump(shapes, 'stack300');
    }
    return rects;
}

function inputOp(random: () => number, sheet: string, row0: number): InputOp {
    const rects = rectSet(random, row0);
    const op: InputOp = { kind: 'input', sheet, runs: rects.map((rect) => [rect, contentFor(random, rect)]) };
    for (const [r] of op.runs ?? []) if (r[0] > r[2] || r[1] > r[3]) throw new Error(`bad rect ${r}`);
    if (random() < 0.3) {
        const cell: [number, number] = [rects[0][0], rects[0][1]];
        op.cells = [[cell[0], cell[1], { v: 'win' }]];
        bump(stat, 'listed in run');
    }
    return op;
}

function cellsOf(model: Model, sheet: string, rects: readonly Rect[]): Map<string, CellContent> {
    const out = new Map<string, CellContent>();
    const s = model.sheets.get(sheet);
    for (const [key, content] of s?.cells ?? []) {
        const [row, column] = key.split(',').map(Number);
        if (rects.some((r) => row >= r[0] && row <= r[2] && column >= r[1] && column <= r[3])) out.set(key, content);
    }
    return out;
}

function land(book: Workbook, model: Model, op: Op, now: number): [Model, Op[] | null] {
    const next = modelAfter(model, { now, seed: model.seed, ops: [op] });
    let inverse: Op[] | null = null;
    CUR.op = op;
    try {
        inverse = applyOps(book, [op]);
    } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        bump(stat, `refused ${op.kind} ${error.key} model ${typeof next === 'string' ? next : 'lands'}`);
        if (error.key === 'too-many-cells' && typeof next !== 'string') {
            let slots = 0;
            for (const s of next.sheets.values()) {
                const len = new Map<number, number>();
                for (const k of s.cells.keys()) {
                    const [r, c] = k.split(',').map(Number);
                    len.set(c, Math.max(len.get(c) ?? 0, r + 1));
                }
                for (const l of len.values()) slots += l;
            }
            bump(stat, slots > 4_000_000 ? 'cells refusal true (model slots over 4M)' : `FALSE cells refusal ${slots}`);
        }
    }
    if (inverse === null) {
        bump(stat, 'refused');
        return [model, null];
    }
    book.setClock(now, model.seed);
    if (typeof next === 'string') throw new Error(`model refused ${next}, book landed`);
    return [next, inverse];
}

test('engine/book — the law of blocks: inputs over disjoint rectangle sets land as the model says', () => {
    for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
        const random = randomOf(seed * 7919 + 13);
        const content = randomBookContent(random);
        const first = content.sheets[0];
        const row0 = 60 + below(random, 10);
        if (random() < 0.5) {
            const links = Array.from({ length: GRID_COLUMNS }, (_, c): [number, number, CellContent] => [
                row0,
                c,
                { link: LINK },
            ]);
            const cells = [...first.cells.filter(([r]) => r !== row0), ...links].sort(
                (a, b) => a[1] - b[1] || a[0] - b[0],
            );
            content.sheets[0] = { ...first, cells };
            bump(stat, 'books with a link row');
        }
        const book = new Workbook(content);
        let model = modelOf(content);
        expectReads(book, model);
        for (let step = 0; step < STEPS; step += 1) {
            const now = model.now;
            const draw = random();
            let op: Op;
            if (draw < 0.6) op = inputOp(random, first.id, row0);
            else if (draw < 0.72) op = randomMoveOp(random, model);
            else if (draw < 0.82) op = randomLinesOp(random, model);
            else op = randomAnyOp(random, model);
            bump(stat, `op ${op.kind}`);
            const before = bytes(book);
            const [next, inverse] = land(book, model, op, now);
            checkCount(book, 'after op');
            if (!inverse) {
                expect(bytes(book)).toBe(before);
                continue;
            }
            expectReads(book, next);
            const after = bytes(book);
            applyOps(book, inverse);
            checkCount(book, 'after undo');
            expect(bytes(book)).toBe(before);
            bump(stat, 'undo bytes');
            applyOps(book, [op]);
            expect(bytes(book)).toBe(after);
            model = next;
            // inputOfBlocks against the model, and as the inverse of a clear.
            if (random() < 0.5) {
                const rects = rectSet(random, row0);
                const held = inputOfBlocks(book, first.id, rects);
                const expected = cellsOf(model, first.id, rects);
                const got = new Map<string, CellContent>();
                for (const [[t, l, b, r], c] of held?.runs ?? []) {
                    for (let row = t; row <= b; row += 1)
                        for (let col = l; col <= r; col += 1) if (c) got.set(`${row},${col}`, c);
                }
                for (const [row, col, c] of held?.cells ?? []) if (c) got.set(`${row},${col}`, c);
                expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
                const clear: InputOp = { kind: 'input', sheet: first.id, runs: rects.map((rect) => [rect, null]) };
                const b0 = bytes(book);
                const undo = applyOps(book, [clear]);
                if (held) applyOps(book, [held]);
                expect(bytes(book)).toBe(b0);
                applyOps(book, [clear]);
                applyOps(book, undo);
                expect(bytes(book)).toBe(b0);
                bump(stat, 'inputOfBlocks checks');
            }
        }
    }
    if (process.env['BLOCKS_LAW_SEEDS']) console.log(JSON.stringify({ shapes, stat }));
}, 3_600_000);
