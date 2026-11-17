import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Rect } from '@workspace/lib/sheets/ops';
import type { LookSpan } from '../../../engine/book/bands';
import { Bands } from '../../../engine/book/bands';
import { linesOp, moveOp } from './book-fixtures';
import { LooksGrid } from './looks-grid';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
// The look ids the random ops write, as the looks a flat form lists: index i names id i.
const IDS = [1, 2, 3, 4];
const KINDS = [
    'cell',
    'rect',
    'column',
    'row',
    'columns',
    'set',
    'clear',
    'stripes',
    'insertRows',
    'deleteRows',
    'insertColumns',
    'deleteColumns',
    'move',
    'moveAcross',
] as const;

export type FuzzCounts = {
    ops: Record<string, number>;
    undone: number;
    refused: number;
    mostBands: number;
    mostRuns: number;
};

// The bands' flat form with look ids in place of look indices: the arrays themselves, as far as a caller sees them.
export function rawBands(bands: Bands): number[] {
    const { looks, bands: flat } = bands.content();
    const ids = [0, ...looks];
    for (let at = 0; at < flat.length; at += 2 + 2 * flat[at + 1]) {
        for (let i = at + 3; i < at + 2 + 2 * flat[at + 1]; i += 2) flat[i] = ids[flat[i]];
    }
    return flat;
}

// The spans a write, a delete or a move handed back, written back as the inverse ops of an applier would.
export function writeBack(bands: Bands, spans: readonly LookSpan[]): void {
    for (const { r0, c0, r1, c1, look } of spans) bands.write([[r0, c0, r1, c1]], () => look);
}

function same(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((n, i) => n === b[i]);
}

// Random ops on two sheets, each against its plain grid. After every op the bands are the grid's bands entry for
// entry and read the same in every cell, and the count they share is what both weigh; a write hands back the spans
// whose look it changed, and one of several rectangles is the grid's after each; `wouldPush` answers as the grid
// does; and every third op is undone by its
// inverse (what a write or a move covered written back; a delete for an insert; an insert and a write back for a
// delete), which must give the arrays back. Throws on the first difference.
export function fuzzBands(seed: number, steps: number): FuzzCounts {
    let state = seed;
    const rnd = (n: number): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const held = { runs: 0, bands: 0 };
    const sheets = [0, 1].map(() => ({ bands: new Bands([], [], held), grid: new LooksGrid() }));
    const counts: FuzzCounts = { ops: {}, undone: 0, refused: 0, mostBands: 0, mostRuns: 0 };

    // A real line, or the grid's end: near a line where the looks change, and now and then anywhere.
    const point = (grid: LooksGrid, rows: boolean): number => {
        const total = rows ? GRID_ROWS : GRID_COLUMNS;
        const starts = grid.starts(rows);
        const base = starts[rnd(starts.length)];
        if (starts.length > (rows ? 24 : 10)) return base;
        return rnd(4) === 0 ? rnd(total + 1) : Math.min(total, Math.max(0, base + rnd(7) - 3));
    };
    const span = (grid: LooksGrid, rows: boolean): [number, number] => {
        const a = point(grid, rows);
        const b = point(grid, rows);
        const first = Math.min(a, b, (rows ? GRID_ROWS : GRID_COLUMNS) - 1);
        return [first, Math.max(first, Math.max(a, b) - 1)];
    };

    for (let step = 0; step < steps; step += 1) {
        const a = sheets[rnd(2)];
        const crowded = a.grid.heights.length > 48 || a.grid.widths.length > 20;
        const picked = KINDS[rnd(KINDS.length)];
        const kind = crowded && (picked === 'move' || picked === 'moveAcross') ? 'clear' : picked;
        const where = `seed ${seed} step ${step} ${kind}`;
        counts.ops[kind] = (counts.ops[kind] ?? 0) + 1;
        const before = sheets.map((sheet) => ({ raw: rawBands(sheet.bands), grid: sheet.grid.clone() }));
        let undo: () => void;

        if (kind === 'insertRows' || kind === 'insertColumns') {
            const rows = kind === 'insertRows';
            const total = rows ? GRID_ROWS : GRID_COLUMNS;
            const index = Math.min(point(a.grid, rows), total - 1);
            const count = Math.min(total - index, rnd(4) === 0 ? 1 + rnd(total) : 1 + rnd(3));
            const like = [index - 1, index, -1][rnd(3)];
            const op = linesOp(rows, true, index, count, like);
            const pushes = a.bands.wouldPush(op);
            if (pushes !== a.grid.wouldPush(rows, count)) throw new Error(`${where}: wouldPush(${count}) is ${pushes}`);
            if (pushes) {
                counts.refused += 1;
                a.grid.tidy();
                continue;
            }
            if (a.bands.lines(op).length > 0) throw new Error(`${where}: an insert removed spans`);
            a.grid.insert(rows, index, count, like);
            undo = () => a.bands.lines(linesOp(rows, false, index, count));
        } else if (kind === 'deleteRows' || kind === 'deleteColumns') {
            const rows = kind === 'deleteRows';
            const [index, far] = span(a.grid, rows);
            const count = rnd(3) === 0 ? far - index + 1 : Math.min(far - index + 1, 1 + rnd(3));
            const lost = a.bands.lines(linesOp(rows, false, index, count));
            a.grid.delete(rows, index, count);
            if (a.bands.wouldPush(linesOp(rows, true, index, count))) {
                throw new Error(`${where}: the inverse of a delete would be refused`);
            }
            undo = () => {
                a.bands.lines(linesOp(rows, true, index, count));
                writeBack(a.bands, lost);
            };
        } else if (kind === 'move' || kind === 'moveAcross') {
            const b = kind === 'move' ? a : sheets[a === sheets[0] ? 1 : 0];
            const [top, bottom] = span(a.grid, true);
            const [left, right] = span(a.grid, false);
            const rect: Rect = [top, left, bottom, right];
            const toRow = Math.min(point(b.grid, true), LAST_ROW - (bottom - top));
            const toColumn = Math.min(point(b.grid, false), LAST_COLUMN - (right - left));
            const target: Rect = [toRow, toColumn, toRow + bottom - top, toColumn + right - left];
            const wanted = [...b.bands.spans(target)];
            const covered = b.bands.move(moveOp(rect, toRow, toColumn), a.bands);
            if (JSON.stringify(covered) !== JSON.stringify(wanted)) throw new Error(`${where}: covered`);
            const source = a.grid.clone();
            a.grid.format(rect, () => 0);
            b.grid.paste(source, rect, toRow, toColumn);
            undo = () => {
                a.bands.move(moveOp(target, top, left), b.bands);
                writeBack(b.bands, covered);
            };
        } else {
            const [top, bottom] = kind === 'column' || kind === 'columns' ? [0, LAST_ROW] : span(a.grid, true);
            const [left, right] = kind === 'row' ? [0, LAST_COLUMN] : span(a.grid, false);
            const rect: Rect =
                kind === 'cell'
                    ? [top, left, top, left]
                    : kind === 'column'
                      ? [top, left, bottom, left]
                      : [top, left, bottom, right];
            // Stripes: rectangles over the same columns, down the rows, that share no row.
            const rects: Rect[] = [rect];
            for (let row = bottom + 1 + rnd(3); kind === 'stripes' && rects.length < 5 && row <= LAST_ROW; ) {
                const end = Math.min(LAST_ROW, row + rnd(4) * rnd(4));
                rects.push([row, left, end, right]);
                row = end + 1 + rnd(3);
            }
            const id = rnd(5);
            const add = 1 + rnd(4);
            const to =
                kind === 'cell' || kind === 'set'
                    ? () => id
                    : kind === 'clear'
                      ? () => 0
                      : (look: number) => (look + add) % 5;
            const areaOf = ({ r0, r1, c0, c1 }: LookSpan) => (r1 - r0 + 1) * (c1 - c0 + 1);
            // The cells whose look the write leaves as it is: the spans handed back are all the others.
            let cells = 0;
            for (const one of rects) {
                for (const span of a.bands.spans(one)) if (to(span.look) === span.look) cells += areaOf(span);
            }
            const spans = a.bands.write(rects, to);
            for (const span of spans) {
                const { r0, r1, c0, c1, look } = span;
                cells += areaOf(span);
                if (look !== a.grid.look(r0, c0) || look !== a.grid.look(r1, c1) || to(look) === look)
                    throw new Error(`${where}: replaced`);
            }
            if (cells !== rects.reduce((sum, [t, l, b, r]) => sum + (b - t + 1) * (r - l + 1), 0))
                throw new Error(`${where}: replaced cells`);
            for (const one of rects) a.grid.format(one, to);
            undo = () => writeBack(a.bands, spans);
        }

        const [one, other] = sheets.map(({ bands }) => bands.weight());
        if (held.runs !== one.runs + other.runs || held.bands !== one.bands + other.bands) {
            throw new Error(`${where}: the count holds ${JSON.stringify(held)}`);
        }
        for (const { bands, grid } of sheets) {
            const raw = rawBands(bands);
            if (!same(raw, grid.flat(true))) {
                throw new Error(
                    `${where}: bands ${JSON.stringify(raw)}, the grid's ${JSON.stringify(grid.flat(true))}`,
                );
            }
            const rowStarts = grid.starts(true);
            const columnStarts = grid.starts(false);
            for (let r = 0; r < grid.heights.length; r += 1) {
                for (let c = 0; c < grid.widths.length; c += 1) {
                    for (const row of [rowStarts[r], rowStarts[r + 1] - 1]) {
                        for (const column of [columnStarts[c], columnStarts[c + 1] - 1]) {
                            if (bands.look(row, column) === grid.cells[r][c]) continue;
                            throw new Error(`${where}: cell ${row},${column} reads ${bands.look(row, column)}`);
                        }
                    }
                }
            }
            if (step % 8 === 0) {
                // A build from the flat form, said the short way and the long way, and what the form weighs and spans.
                if (!same(rawBands(new Bands(grid.flat(true), IDS, { runs: 0, bands: 0 })), raw))
                    throw new Error(`${where}: build`);
                if (!same(rawBands(new Bands(grid.flat(false), IDS, { runs: 0, bands: 0 })), raw))
                    throw new Error(`${where}: long build`);
                const again = bands.content();
                if (!same(rawBands(new Bands(again.bands, again.looks, { runs: 0, bands: 0 })), raw))
                    throw new Error(`${where}: round trip`);
                let runs = 0;
                const firsts: number[] = [];
                for (let at = 0; at < raw.length; at += 2 + 2 * raw[at + 1]) {
                    firsts.push(raw[at]);
                    runs += raw[at + 1];
                }
                const weight = bands.weight();
                if (weight.runs !== runs || weight.bands !== firsts.length) throw new Error(`${where}: weight`);
                const extent = bands.extent();
                const wanted = grid.extent();
                if (extent.lastRow !== wanted.lastRow || extent.lastColumn !== wanted.lastColumn) {
                    throw new Error(`${where}: extent ${JSON.stringify(extent)}, the grid's ${JSON.stringify(wanted)}`);
                }
                counts.mostBands = Math.max(counts.mostBands, weight.bands);
                counts.mostRuns = Math.max(counts.mostRuns, weight.runs);
            }
        }

        if (step % 3 === 0) {
            undo();
            for (const [i, sheet] of sheets.entries()) {
                if (!same(rawBands(sheet.bands), before[i].raw))
                    throw new Error(`${where}: the inverse gave other arrays`);
                sheet.grid = before[i].grid;
            }
            counts.undone += 1;
        }
        for (const { grid } of sheets) grid.tidy();
    }
    return counts;
}
