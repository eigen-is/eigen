import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Placed, Rect } from '@workspace/lib/sheets/ops';
import { meets } from '@workspace/lib/sheets/rect';
import type { Extra } from '../../../engine/book/extras';
import { Extras, textOf } from '../../../engine/book/extras';
import type { Random } from './book-fixtures';
import { below, linesOp, moveOp, randomOf } from './book-fixtures';

const LINK: Extra = { link: { type: 'webpage', address: 'https://eigen.is' } };
const QUOTED: Extra = { qp: 1 };
const RICH: Extra = { s: [{ v: 'a', bl: 1 }, { v: 'b' }], link: { type: 'sheet', address: 's1' } };
const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;

// The weight of entries counted the slow way: an entry two units, its link three more, each run of its text one.
function weightOf(cells: readonly Placed<Extra>[]): number {
    return cells.reduce((sum, [, , { s, link }]) => sum + 2 + (link ? 3 : 0) + (s?.length ?? 0), 0);
}

function extrasOf(cells: readonly Placed<Extra>[]): Extras {
    const extras = new Extras({ extras: 0 });
    for (const [row, column, extra] of cells) extras.write(row, column, extra);
    return extras;
}

describe('engine/book/extras — Extras', () => {
    test('the text of a rich cell is its runs joined', () => {
        expect(textOf([{ v: 'a', bl: 1 }, { v: '' }, { v: 'bc' }])).toBe('abc');
    });

    test('a cell reads what was put, and the walk is in column order however the cells were written', () => {
        const extras = extrasOf([
            [5, 1, LINK],
            [LAST_ROW, LAST_COLUMN, QUOTED],
            [0, 1, RICH],
            [7, 0, QUOTED],
            [LAST_ROW, 0, LINK],
        ]);
        expect(extras.at(5, 1)).toEqual(LINK);
        expect(extras.at(5, 2)).toBeUndefined();
        expect(extras.at(LAST_ROW, LAST_COLUMN)).toEqual(QUOTED);
        expect(extras.content()).toEqual([
            [7, 0, QUOTED],
            [LAST_ROW, 0, LINK],
            [0, 1, RICH],
            [5, 1, LINK],
            [LAST_ROW, LAST_COLUMN, QUOTED],
        ]);
    });

    test('a walk of a block reports its cells only', () => {
        const extras = extrasOf([
            [0, 0, LINK],
            [3, 0, LINK],
            [9, 0, LINK],
            [2, 1, QUOTED],
            [3, 2, RICH],
            [4, 2, RICH],
            [3, 5, LINK],
        ]);
        expect([...extras.cells([3, 0, 4, 2])]).toEqual([
            [3, 0, LINK],
            [3, 2, RICH],
            [4, 2, RICH],
        ]);
        expect([...extras.cells([10, 3, 20, 4])]).toEqual([]);
    });

    test('a put returns the old entry, keeps only the keys given, and with none deletes', () => {
        const extras = new Extras({ extras: 0 });
        expect(extras.write(1, 1, { s: undefined, link: LINK.link, qp: undefined })).toBeUndefined();
        expect(Object.keys(extras.at(1, 1) ?? {})).toEqual(['link']);
        expect(extras.write(1, 1, RICH)).toEqual(LINK);
        expect(Object.keys(extras.at(1, 1) ?? {})).toEqual(['s', 'link']);
        expect(extras.write(1, 1, {})).toEqual(RICH);
        expect(extras.write(1, 1, {})).toBeUndefined();
        expect(extras.content()).toEqual([]);
    });

    test('an entry weighs two units, its link three more and each run of its text one', () => {
        expect(extrasOf([[0, 0, QUOTED]]).weight()).toBe(2);
        expect(extrasOf([[0, 0, LINK]]).weight()).toBe(5);
        expect(extrasOf([[0, 0, { link: LINK.link, qp: 1 }]]).weight()).toBe(5);
        expect(extrasOf([[0, 0, { s: [{ v: 'only' }] }]]).weight()).toBe(3);
        expect(extrasOf([[0, 0, RICH]]).weight()).toBe(7);
        const thousand = Array.from({ length: 1000 }, () => ({ v: 'r' }));
        expect(extrasOf([[0, 0, { s: thousand }]]).weight()).toBe(1002);
        expect(new Extras({ extras: 0 }).weight()).toBe(0);
    });

    test('the weight follows a write that adds, replaces and clears an entry', () => {
        const extras = extrasOf([[4, 4, QUOTED]]);
        extras.write(1, 1, LINK);
        expect(extras.weight()).toBe(2 + 5);
        extras.write(1, 1, RICH);
        expect(extras.weight()).toBe(2 + 7);
        extras.write(1, 1, {});
        expect(extras.weight()).toBe(2);
        extras.write(1, 1, {});
        expect(extras.weight()).toBe(2);
    });

    test('a fill puts one entry in every cell of a block over what they held, and with none empties it', () => {
        const extras = extrasOf([
            [1, 0, QUOTED],
            [0, 1, RICH],
            [2, 1, QUOTED],
            [5, 1, LINK],
            [1, 2, LINK],
            [0, 3, QUOTED],
        ]);
        extras.fill([[[1, 1, 2, 2], { s: undefined, link: LINK.link, qp: undefined }]]);
        expect(extras.content()).toEqual([
            [1, 0, QUOTED],
            [0, 1, RICH],
            [1, 1, LINK],
            [2, 1, LINK],
            [5, 1, LINK],
            [1, 2, LINK],
            [2, 2, LINK],
            [0, 3, QUOTED],
        ]);
        expect(Object.keys(extras.at(1, 1) ?? {})).toEqual(['link']);
        expect(extras.weight()).toBe(2 + 7 + 4 * 5 + 5 + 2);
        extras.fill([[[0, 1, 5, 1], {}]]);
        expect(extras.content()).toEqual([
            [1, 0, QUOTED],
            [1, 2, LINK],
            [2, 2, LINK],
            [0, 3, QUOTED],
        ]);
        expect(extras.weight()).toBe(2 + 2 * 5 + 2);
        extras.fill([[[0, 0, LAST_ROW, LAST_COLUMN], {}]]);
        expect(extras.content()).toEqual([]);
        expect(extras.weight()).toBe(0);
    });

    test('a fill of 150,000 cells over entries and among 150,000 right of it and below is one pass', () => {
        const extras = new Extras({ extras: 0 });
        extras.fill([[[0, 1, 74_999, 1], QUOTED]]);
        extras.fill([[[200_000, 0, 274_999, 0], QUOTED]]);
        extras.fill([[[100_000, 0, 100_009, 0], QUOTED]]);
        const started = performance.now();
        extras.fill([[[0, 0, 149_999, 0], LINK]]);
        expect(performance.now() - started).toBeLessThan(500);
        expect(extras.weight()).toBe(150_000 * 5 + 150_000 * 2);
        expect([extras.at(74_999, 1), extras.at(75_000, 1)]).toEqual([QUOTED, undefined]);
        const filled = [...extras.cells([0, 0, 149_999, 0])];
        expect(filled.length).toBe(150_000);
        expect(filled.every(([row, , extra], at) => row === at && extra.link === LINK.link)).toBe(true);
        expect([...extras.cells([149_999, 0, 200_000, 0])]).toEqual([
            [149_999, 0, LINK],
            [200_000, 0, QUOTED],
        ]);
    });

    test('a link over a block sets every cell’s link, keeping its runs and mark, and a clear keeps the rest', () => {
        const other = { type: 'cellrange', address: 'A1' } as const;
        const extras = extrasOf([
            [1, 0, QUOTED],
            [0, 1, RICH],
            [1, 1, { qp: 1, link: other }],
            [5, 1, LINK],
            [0, 2, QUOTED],
        ]);
        extras.link([[0, 1, 2, 1]], other);
        expect(extras.content()).toEqual([
            [1, 0, QUOTED],
            [0, 1, { s: RICH.s, link: other }],
            [1, 1, { qp: 1, link: other }],
            [2, 1, { link: other }],
            [5, 1, LINK],
            [0, 2, QUOTED],
        ]);
        expect(extras.weight()).toBe(2 + 7 + 5 + 5 + 5 + 2);
        extras.link([[0, 0, 5, 2]], undefined);
        expect(extras.content()).toEqual([
            [1, 0, QUOTED],
            [0, 1, { s: RICH.s }],
            [1, 1, QUOTED],
            [0, 2, QUOTED],
        ]);
        expect(Object.keys(extras.at(0, 1) ?? {})).toEqual(['s']);
        expect(extras.weight()).toBe(2 + 4 + 2 + 2);
    });

    test('a link over 150,000 cells among 1,000 rich ones and 150,000 entries beside them is one pass', () => {
        const extras = new Extras({ extras: 0 });
        for (let row = 0; row < 150_000; row += 150) extras.write(row, 0, { s: RICH.s });
        extras.fill([[[0, 1, 149_999, 1], QUOTED]]);
        const started = performance.now();
        extras.link([[0, 0, 149_999, 0]], LINK.link);
        expect(performance.now() - started).toBeLessThan(500);
        expect(extras.weight()).toBe(1_000 * 7 + 149_000 * 5 + 150_000 * 2);
        expect(extras.at(150, 0)).toEqual({ s: RICH.s, link: LINK.link });
        expect(extras.at(151, 0)).toEqual(LINK);
        expect(extras.at(151, 1)).toEqual(QUOTED);
        expect([...extras.cells([0, 0, 149_999, 0])].length).toBe(150_000);
    });

    test('inserted lines hold nothing and push the entries after them', () => {
        const extras = extrasOf([
            [2, 0, LINK],
            [3, 0, QUOTED],
            [3, 4, RICH],
        ]);
        extras.lines(linesOp(true, true, 3, 2));
        expect(extras.content()).toEqual([
            [2, 0, LINK],
            [5, 0, QUOTED],
            [5, 4, RICH],
        ]);
        extras.lines(linesOp(false, true, 0, 1));
        extras.lines(linesOp(false, true, 5, 3));
        expect(extras.content()).toEqual([
            [2, 1, LINK],
            [5, 1, QUOTED],
            [5, 8, RICH],
        ]);
    });

    test('a delete returns the entries of its lines where they were', () => {
        const extras = extrasOf([
            [2, 0, LINK],
            [3, 0, QUOTED],
            [4, 0, LINK],
            [3, 4, RICH],
            [9, 4, QUOTED],
        ]);
        expect(extras.lines(linesOp(true, false, 3, 2))).toEqual([
            [3, 0, QUOTED],
            [4, 0, LINK],
            [3, 4, RICH],
        ]);
        expect(extras.content()).toEqual([
            [2, 0, LINK],
            [7, 4, QUOTED],
        ]);
        expect(extras.lines(linesOp(false, false, 0, 4))).toEqual([[2, 0, LINK]]);
        expect(extras.content()).toEqual([[7, 0, QUOTED]]);
        expect(extras.lines(linesOp(false, true, 0, 4))).toEqual([]);
    });

    test('an insert would push a cell off the grid only when an entry is on a pushed line', () => {
        const extras = extrasOf([
            [LAST_ROW - 2, 3, LINK],
            [0, LAST_COLUMN - 2, QUOTED],
        ]);
        expect(extras.wouldPush(linesOp(true, true, 0, 2))).toBe(false);
        expect(extras.wouldPush(linesOp(true, true, 0, 3))).toBe(true);
        expect(extras.wouldPush(linesOp(false, true, 0, 2))).toBe(false);
        expect(extras.wouldPush(linesOp(false, true, 0, 3))).toBe(true);
        expect(new Extras({ extras: 0 }).wouldPush(linesOp(false, true, 0, GRID_COLUMNS))).toBe(false);
    });

    test('a block moved over itself keeps its own entries and returns what it landed on as it was', () => {
        const extras = extrasOf([
            [0, 0, LINK],
            [1, 0, QUOTED],
            [2, 0, RICH],
            [3, 0, LINK],
            [5, 0, QUOTED],
        ]);
        expect(extras.move(moveOp([0, 0, 2, 0], 1, 0), extras)).toEqual([
            [1, 0, QUOTED],
            [2, 0, RICH],
            [3, 0, LINK],
        ]);
        expect(extras.content()).toEqual([
            [1, 0, LINK],
            [2, 0, QUOTED],
            [3, 0, RICH],
            [5, 0, QUOTED],
        ]);
    });

    test('a block moved to another sheet leaves its cells and lands among the entries there', () => {
        const from = extrasOf([
            [0, 0, LINK],
            [1, 1, RICH],
            [5, 5, QUOTED],
        ]);
        const to = extrasOf([
            [0, 2, QUOTED],
            [11, 3, LINK],
            [10, 4, LINK],
            [0, 9, QUOTED],
        ]);
        expect(to.move(moveOp([0, 0, 1, 1], 10, 3, 'T'), from)).toEqual([
            [11, 3, LINK],
            [10, 4, LINK],
        ]);
        expect(from.content()).toEqual([[5, 5, QUOTED]]);
        expect(to.content()).toEqual([
            [0, 2, QUOTED],
            [10, 3, LINK],
            [11, 4, RICH],
            [0, 9, QUOTED],
        ]);
    });
});

const ROWS = 12;
const COLUMNS = 7;
const ENTRIES = [LINK, QUOTED, RICH, { s: [{ v: 'only' }] }, { link: LINK.link, qp: 1 }] satisfies Extra[];

// One entry per cell under its place as text: what the lists must say, worked out the slow way.
class CellsModel {
    public cells = new Map<string, Placed<Extra>>();

    public put(row: number, column: number, extra: Extra | undefined): void {
        if (extra) this.cells.set(`${row},${column}`, [row, column, extra]);
        else this.cells.delete(`${row},${column}`);
    }

    public within([top, left, bottom, right]: Rect): Placed<Extra>[] {
        return [...this.cells.values()]
            .filter(([row, column]) => row >= top && row <= bottom && column >= left && column <= right)
            .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    }

    public shift(rows: boolean, index: number, count: number): void {
        const held = [...this.cells.values()];
        this.cells = new Map();
        for (const [row, column, extra] of held) {
            const line = rows ? row : column;
            if (line >= index && line < index - count) continue;
            const moved = line < index ? line : line + count;
            this.put(rows ? moved : row, rows ? column : moved, extra);
        }
    }

    public move(from: Rect, to: CellsModel, toRow: number, toColumn: number): void {
        const block = this.within(from);
        for (const [row, column] of block) this.put(row, column, undefined);
        const target: Rect = [toRow, toColumn, toRow + from[2] - from[0], toColumn + from[3] - from[1]];
        for (const [row, column] of to.within(target)) to.put(row, column, undefined);
        for (const [row, column, extra] of block) to.put(row - from[0] + toRow, column - from[1] + toColumn, extra);
    }
}

const WHOLE: Rect = [0, 0, LAST_ROW, LAST_COLUMN];

function randomBlock(random: Random): Rect {
    const top = below(random, ROWS);
    const left = below(random, COLUMNS);
    return [top, left, Math.min(ROWS - 1, top + below(random, 4)), Math.min(COLUMNS - 1, left + below(random, 3))];
}

describe('engine/book/extras — the entries are the per-cell model’s entries', () => {
    for (const seed of [5, 23, 2026]) {
        test(`random writes, fills, shifts and moves with their inverses, seed ${seed}`, () => {
            const random = randomOf(seed);
            const sheets = [0, 1].map(() => ({ extras: new Extras({ extras: 0 }), model: new CellsModel() }));
            const counts = {
                ...{ put: 0, fill: 0, filled: 0, cleared: 0, replaced: 0, insert: 0, remove: 0 },
                ...{ moveOver: 0, moveAcross: 0, carried: 0, covered: 0, linked: 0, unlinked: 0 },
            };
            for (let step = 0; step < 6000; step += 1) {
                const { extras, model } = sheets[below(random, 2)];
                const before = sheets.map((sheet) => [...sheet.extras.content()]);
                const kind = below(random, 14);
                const rows = random() < 0.5;
                // Index 0, inside, on the last line that holds an entry and past it.
                const lines = rows ? ROWS : COLUMNS;
                const index = [0, below(random, lines), lines - 1, lines + 3][below(random, 4)];
                const count = 1 + below(random, 3);
                let undo: () => void;
                if (kind < 5) {
                    counts.put += 1;
                    // Now and then a cell on the grid's last row or column, where a place is largest.
                    const row = random() < 0.05 ? LAST_ROW : below(random, ROWS);
                    const column = random() < 0.05 ? LAST_COLUMN : below(random, COLUMNS);
                    const extra = random() < 0.25 ? undefined : ENTRIES[below(random, ENTRIES.length)];
                    const old = extras.write(row, column, extra ?? {});
                    expect(old).toEqual(model.cells.get(`${row},${column}`)?.[2]);
                    model.put(row, column, extra);
                    undo = () => extras.write(row, column, old ?? {});
                } else if (kind === 5) {
                    counts.insert += 1;
                    // The far cells would leave the grid, which the caller of an insert refuses.
                    for (const [row, column] of model.within(WHOLE)) {
                        if (row === LAST_ROW || column === LAST_COLUMN) {
                            extras.write(row, column, {});
                            model.put(row, column, undefined);
                        }
                    }
                    before.splice(0, 2, ...sheets.map((sheet) => [...sheet.extras.content()]));
                    extras.lines(linesOp(rows, true, index, count));
                    model.shift(rows, index, count);
                    undo = () => expect(extras.lines(linesOp(rows, false, index, count))).toEqual([]);
                } else if (kind === 6) {
                    counts.remove += 1;
                    const band: Rect = rows
                        ? [index, 0, index + count - 1, LAST_COLUMN]
                        : [0, index, LAST_ROW, index + count - 1];
                    const expected = model.within(band);
                    const removed = extras.lines(linesOp(rows, false, index, count));
                    expect(removed).toEqual(expected);
                    model.shift(rows, index, -count);
                    undo = () => {
                        extras.lines(linesOp(rows, true, index, count));
                        for (const [row, column, extra] of removed) extras.write(row, column, extra);
                    };
                } else if (kind >= 12) {
                    // Up to three blocks that share no cell, in any order, linked in one call.
                    const blocks: Rect[] = [];
                    for (let at = 0; at < 3; at += 1) {
                        const block = randomBlock(random);
                        if (!blocks.some((other) => meets(other, block))) blocks.push(block);
                    }
                    const link = random() < 0.5 ? undefined : ENTRIES[below(random, 2) * 4].link;
                    const covered = blocks.map((block) => model.within(block));
                    counts[link ? 'linked' : 'unlinked'] += 1;
                    extras.link(blocks, link);
                    for (const block of blocks) {
                        for (let row = block[0]; row <= block[2]; row += 1) {
                            for (let column = block[1]; column <= block[3]; column += 1) {
                                const old = model.cells.get(`${row},${column}`)?.[2];
                                const { s, qp } = old ?? {};
                                const kept = { ...(s && { s }), ...(link && { link }), ...(qp && { qp }) };
                                model.put(row, column, Object.keys(kept).length > 0 ? kept : undefined);
                            }
                        }
                    }
                    undo = () => {
                        for (const [at, block] of blocks.entries()) {
                            extras.fill([[block, {}]]);
                            for (const [row, column, old] of covered[at]) extras.write(row, column, old);
                        }
                    };
                } else if (kind >= 10) {
                    counts.fill += 1;
                    const block = randomBlock(random);
                    const extra = random() < 0.5 ? undefined : ENTRIES[below(random, ENTRIES.length)];
                    const covered = model.within(block);
                    counts[extra ? 'filled' : 'cleared'] += 1;
                    counts.replaced += covered.length;
                    extras.fill([[block, extra ?? {}]]);
                    for (let row = block[0]; row <= block[2]; row += 1) {
                        for (let column = block[1]; column <= block[3]; column += 1) model.put(row, column, extra);
                    }
                    undo = () => {
                        extras.fill([[block, {}]]);
                        for (const [row, column, old] of covered) extras.write(row, column, old);
                    };
                } else {
                    const across = kind > 7;
                    const to = across ? sheets[sheets[0].extras === extras ? 1 : 0] : { extras, model };
                    const from = randomBlock(random);
                    // Half the moves on one sheet land on a part of the block itself.
                    const near = !across && random() < 0.5;
                    const toRow = near ? Math.max(0, from[0] + below(random, 3) - 1) : below(random, ROWS);
                    const toColumn = near ? Math.max(0, from[1] + below(random, 3) - 1) : below(random, COLUMNS);
                    const target: Rect = [toRow, toColumn, toRow + from[2] - from[0], toColumn + from[3] - from[1]];
                    counts.carried += model.within(from).length;
                    const covered = to.extras.move(moveOp(from, toRow, toColumn), extras);
                    expect(covered).toEqual(to.model.within(target));
                    model.move(from, to.model, toRow, toColumn);
                    counts[across ? 'moveAcross' : 'moveOver'] += 1;
                    counts.covered += covered.length;
                    undo = () => {
                        expect(extras.move(moveOp(target, from[0], from[1]), to.extras)).toEqual(model.within(from));
                        for (const [row, column, extra] of covered) to.extras.write(row, column, extra);
                    };
                }
                for (const sheet of sheets) {
                    expect([...sheet.extras.content()]).toEqual(sheet.model.within(WHOLE));
                    expect(sheet.extras.weight()).toBe(weightOf(sheet.model.within(WHOLE)));
                    const block = randomBlock(random);
                    expect([...sheet.extras.cells(block)]).toEqual(sheet.model.within(block));
                    expect(sheet.extras.at(block[0], block[1])).toEqual(
                        sheet.model.cells.get(`${block[0]},${block[1]}`)?.[2],
                    );
                }
                if (step % 3 === 0) {
                    undo();
                    for (const [at, sheet] of sheets.entries()) {
                        expect([...sheet.extras.content()]).toEqual(before[at]);
                        expect(sheet.extras.weight()).toBe(weightOf(before[at]));
                        sheet.model.cells = new Map(before[at].map((cell) => [`${cell[0]},${cell[1]}`, cell]));
                    }
                }
                // The entries stay near the start: what an insert pushed away is deleted again.
                for (const sheet of sheets) {
                    for (const [row, column] of sheet.model.within(WHOLE)) {
                        if ((row >= ROWS && row < LAST_ROW) || (column >= COLUMNS && column < LAST_COLUMN)) {
                            sheet.extras.write(row, column, {});
                            sheet.model.put(row, column, undefined);
                        }
                    }
                }
            }
            for (const count of Object.values(counts)) expect(count).toBeGreaterThan(300);
        });
    }
});
