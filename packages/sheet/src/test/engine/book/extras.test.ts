import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Placed, Rect } from '@workspace/lib/sheets/ops';
import type { Extra } from '../../../engine/book/extras';
import { Extras, textOf } from '../../../engine/book/extras';
import type { Random } from './book-fixtures';
import { below, linesOp, moveOp, randomOf } from './book-fixtures';

const LINK: Extra = { link: { type: 'webpage', address: 'https://eigen.is' } };
const QUOTED: Extra = { qp: 1 };
const RICH: Extra = { s: [{ v: 'a', bl: 1 }, { v: 'b' }], link: { type: 'sheet', address: 's1' } };
const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;

function extrasOf(cells: readonly Placed<Extra>[]): Extras {
    const extras = new Extras();
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
        const extras = new Extras();
        expect(extras.write(1, 1, { s: undefined, link: LINK.link, qp: undefined })).toBeUndefined();
        expect(Object.keys(extras.at(1, 1) ?? {})).toEqual(['link']);
        expect(extras.write(1, 1, RICH)).toEqual(LINK);
        expect(Object.keys(extras.at(1, 1) ?? {})).toEqual(['s', 'link']);
        expect(extras.write(1, 1, {})).toEqual(RICH);
        expect(extras.write(1, 1, {})).toBeUndefined();
        expect(extras.content()).toEqual([]);
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
        expect(new Extras().wouldPush(linesOp(false, true, 0, GRID_COLUMNS))).toBe(false);
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
        test(`random writes, shifts and moves with their inverses, seed ${seed}`, () => {
            const random = randomOf(seed);
            const sheets = [0, 1].map(() => ({ extras: new Extras(), model: new CellsModel() }));
            const counts = { put: 0, insert: 0, remove: 0, moveOver: 0, moveAcross: 0, carried: 0, covered: 0 };
            for (let step = 0; step < 4000; step += 1) {
                const { extras, model } = sheets[below(random, 2)];
                const before = sheets.map((sheet) => [...sheet.extras.content()]);
                const kind = below(random, 10);
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
