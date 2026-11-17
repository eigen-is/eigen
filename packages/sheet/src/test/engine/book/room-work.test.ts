import { describe, expect, spyOn, test } from 'bun:test';
import { GRID_COLUMNS } from '@workspace/formula/text';
import { MAX_STYLE_RUNS, MIDWAY } from '@workspace/lib/sheets/limits';
import type { CellContent, CellRecord, InputOp, Op, Placed, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import type { CellLink } from '@workspace/lib/sheets/types';
import { filled } from '../../../engine/book/apply-input';
import { applyOps } from '../../../engine/book/apply-ops';
import { Bands } from '../../../engine/book/bands';
import { Extras } from '../../../engine/book/extras';
import { RunList } from '../../../engine/book/run-list';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { bytes } from './bytes';
import { bookOf, format, formatsOf, LAST_COLUMN, LAST_ROW, refusalOf, sheetOf, striped, WHOLE } from './room-fixtures';

const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const EVERY_COLUMN = Array.from({ length: GRID_COLUMNS }, (_, column) => column);
const ENGINE_WRITES = ['setValue', 'setFormula', 'fillFormula', 'clear', 'editLines', 'moveCells', 'addSheet'] as const;
const EXTRAS_WRITES = ['write', 'fill', 'link', 'move', 'lines'] as const;
const BANDS_WRITES = ['write', 'move', 'lines'] as const;

function input(runs: InputOp['runs'], cells?: InputOp['cells'], sheet = 'S'): InputOp {
    return { kind: 'input', sheet, ...(runs && { runs }), ...(cells && { cells }) };
}

function lines(rows: boolean, insert: boolean, index: number, count: number): Op {
    return { kind: 'lines', sheet: 'S', rows, insert, index, count };
}

function move(from: Rect, toRow: number, toColumn: number, toSheet = 'S'): Op {
    return { kind: 'move', sheet: 'S', from, toSheet, toRow, toColumn };
}

// Spies on every door that writes a cell, an extra or a look, on any sheet the book holds now or is given.
function watched(book: Workbook) {
    return [
        ...ENGINE_WRITES.map((door) => spyOn(book.engine, door)),
        ...EXTRAS_WRITES.map((door) => spyOn(Extras.prototype, door)),
        ...BANDS_WRITES.map((door) => spyOn(Bands.prototype, door)),
    ];
}

// The batch passes the validators, and the workbook refuses it before its first write: no door that writes was
// called, and the weight and the bytes are as they were.
function expectRefusedUnwritten(content: Book, ops: Op[], key: RefusalKey, light = true): void {
    expect(readBatch(JSON.stringify({ g: 1, now: 45_000, seed: 1, ops }))).not.toBeNull();
    const book = new Workbook(content);
    const before = light ? bytes(book) : '';
    const weight = book.weight();
    const writes = watched(book);
    try {
        expect(refusalOf(() => applyOps(book, ops))).toBe(key);
        for (const write of writes) expect(write).not.toHaveBeenCalled();
    } finally {
        for (const write of writes) write.mockRestore();
    }
    expect(book.weight()).toEqual(weight);
    if (light) expect(bytes(book)).toBe(before);
}

// What the lists read and move while `run` runs, counted, whatever the machine: a run read through a list's doors,
// a pair copied by a clone, a splice or a growth, and the runs two lists of one size are compared over.
function workOf(run: (work: { read: number; moved: number }) => void): { read: number; moved: number } {
    const work = { read: 0, moved: 0 };
    const list = RunList.prototype;
    const ints = Int32Array.prototype;
    const { lookOf, runAt, equals } = list;
    const { copyWithin, set, slice } = ints;
    list.lookOf = function (at) {
        work.read += 1;
        return lookOf.call(this, at);
    };
    list.runAt = function (row) {
        work.read += 1;
        return runAt.call(this, row);
    };
    list.equals = function (other) {
        if (this.count === other.count) work.read += this.count;
        return equals.call(this, other);
    };
    ints.copyWithin = function (target, start, end) {
        work.moved += ((end ?? this.length) - start) / 2;
        return copyWithin.call(this, target, start, end);
    };
    ints.set = function (from, offset) {
        work.moved += from.length / 2;
        set.call(this, from, offset);
    };
    ints.slice = function (start, end) {
        work.moved += ((end ?? this.length) - (start ?? 0)) / 2;
        return slice.call(this, start, end);
    };
    try {
        run(work);
    } finally {
        Object.assign(list, { lookOf, runAt, equals });
        Object.assign(ints, { copyWithin, set, slice });
    }
    return work;
}

// The staircase: rectangle k is one row, 2k, from column k to the last column.
function staircase(steps: number): Rect[] {
    return Array.from({ length: steps }, (_, k): Rect => [2 * k, k, 2 * k, LAST_COLUMN]);
}

describe('engine/book/room — the six old attacks: a small batch that would fill the workbook is refused unwritten', () => {
    const rowOfCells = sheetOf('S', { cells: EVERY_COLUMN.map((column) => [0, column, { v: 1 }]) });

    test('an input with a cell on the last row of every column', () => {
        const cells = EVERY_COLUMN.map((column): Placed<CellContent> => [LAST_ROW, column, { v: 1 }]);
        expectRefusedUnwritten(bookOf(sheetOf('S')), [input(undefined, cells)], 'too-many-cells');
    });

    test('an input of one value, one formula or one rich text over the whole grid', () => {
        for (const content of [{ v: 1 }, { f: '=1' }, { s: [{ v: 'a' }] }]) {
            expectRefusedUnwritten(bookOf(sheetOf('S')), [input([[WHOLE, content]])], 'too-many-cells');
        }
    });

    test('an input of a link or a quote mark over full columns', () => {
        for (const content of [{ link: LINK }, { qp: 1 as const }]) {
            expectRefusedUnwritten(bookOf(sheetOf('S')), [input([[WHOLE, content]])], 'too-many-formats');
        }
    });

    test('an insert of every row but one above a cell in every column', () => {
        expectRefusedUnwritten(bookOf(rowOfCells), [lines(true, true, 0, LAST_ROW)], 'too-many-cells');
    });

    test('a move of a row of cells to the last row, on its sheet and to another', () => {
        expectRefusedUnwritten(bookOf(rowOfCells), [move([0, 0, 0, LAST_COLUMN], LAST_ROW, 0)], 'too-many-cells');
        const other = sheetOf('T', { fields: { name: 'T', order: 'a1' } });
        const across = move([0, 0, 0, LAST_COLUMN], LAST_ROW, 0, 'T');
        expectRefusedUnwritten(bookOf(rowOfCells, other), [across], 'too-many-cells');
    });

    test('a sheet added with a cell on the last row of every column', () => {
        const cells = EVERY_COLUMN.map((column): Placed<CellRecord> => [LAST_ROW, column, { v: 1 }]);
        const add = sheetOf('T', { fields: { name: 'T', order: 'a1' }, cells });
        expectRefusedUnwritten(bookOf(sheetOf('S')), [{ kind: 'sheet', add }], 'too-many-cells');
    });

    test('a link formatted over the whole grid', () => {
        expectRefusedUnwritten(bookOf(sheetOf('S')), [format([WHOLE], { link: LINK })], 'too-many-formats');
    });

    test('a cell formatted in each of 8,192 columns of one band of a million stripes is refused after a few', () => {
        const book = new Workbook(bookOf(sheetOf('S', striped(1_000_000))));
        const weight = book.weight();
        const looks = book.sheets.get('S')?.bands.content();
        const ranges = Array.from({ length: 8192 }, (_, k): Rect => [0, 2 * k, 0, 2 * k]);
        const writes = spyOn(Bands.prototype, 'write');
        try {
            expect(refusalOf(() => applyOps(book, [format(ranges, { it: 1 })]))).toBe('too-many-formats');
            // Each rectangle cuts a column out of the band, about a million runs: the eighth passes twice the limit.
            expect(writes.mock.calls.length).toBeLessThan(40);
        } finally {
            writes.mockRestore();
        }
        expect(book.weight()).toEqual(weight);
        expect(book.sheets.get('S')?.bands.content()).toEqual(looks);
    }, 60_000);
});

describe('engine/book/room — the touch budget: a format that reaches more runs than the limit is refused', () => {
    // One band of a million stripes: a whole column reaches a million runs, and a format that changes nothing fits.
    const million = () => bookOf(sheetOf('S', striped(1_000_000)));
    const columns = (count: number) => Array.from({ length: count }, (_, k): Rect => [0, k, LAST_ROW, k]);

    test('rectangles that reach the limit to the run land, and one run more is refused unwritten', () => {
        const stripes = 1_000_000;
        expect(MAX_STYLE_RUNS % stripes).toBe(0);
        const full = columns(MAX_STYLE_RUNS / stripes);
        const book = new Workbook(million());
        expect(applyOps(book, [format(full, undefined, ['fc'])])).toEqual([]);
        const more: Rect[] = [...full, [7, 100, 7, 100]];
        expectRefusedUnwritten(million(), [format(more, undefined, ['fc'])], 'too-many-formats', false);
    }, 60_000);

    test('band-eating: 200 columns each cleared from one row lower would cost 200 million runs, and are refused', () => {
        const ranges = Array.from({ length: 200 }, (_, k): Rect => [k + 1, k, LAST_ROW, k]);
        expectRefusedUnwritten(million(), [format(ranges, undefined, ['bl', 'bg'])], 'too-many-formats', false);
        const all = Array.from({ length: GRID_COLUMNS }, (_, k): Rect => [k + 1, k, LAST_ROW, k]);
        expectRefusedUnwritten(million(), [format(all, undefined, ['bl', 'bg'])], 'too-many-formats', false);
    }, 60_000);

    test('a hundred whole columns sent one by one are refused, and three land', () => {
        expectRefusedUnwritten(million(), [format(columns(100), { fc: '#ff0000' })], 'too-many-formats', false);
        const book = new Workbook(million());
        applyOps(book, [format(columns(3), { fc: '#ff0000' })]);
        expect(book.weight()).toMatchObject({ runs: 2_000_000, bands: 2 });
    }, 60_000);

    test('a format of links only reads no band, so the budget does not count it', () => {
        const book = new Workbook(million());
        applyOps(book, [
            format(
                columns(100).map(([, c]): Rect => [0, c, 9, c]),
                { link: LINK },
            ),
        ]);
        expect(book.weight().extras).toBe(5 * 1000);
    }, 60_000);
});

describe('engine/book/room — work is counted: a format costs what it reaches and what it grows, not rectangles times runs', () => {
    // The work a batch may take: a constant times the runs its rectangles reach, the weight its writes add on the
    // way, and one pass over the sheet's runs for each group of rectangles that changes a look.
    const BOUND = 4;
    const measured = (content: Book, op: Op) => {
        const book = new Workbook(content);
        const bands = book.sheets.get('S')?.bands;
        if (!bands || op.kind !== 'format' || !('ranges' in op)) throw new Error('a cell format on S');
        let reached = 0;
        for (const rect of op.ranges) reached += bands.tiles(rect);
        const start = formatsOf(book.weight());
        let grown = 0;
        let last = start;
        let groups = 0;
        const write = Bands.prototype.write;
        const writes = spyOn(Bands.prototype, 'write').mockImplementation(function (this: Bands, rects, to) {
            const replaced = write.call(this, rects, to);
            const now = formatsOf(book.weight());
            grown += Math.max(0, now - last);
            last = now;
            if (replaced.length > 0) groups += 1;
            return replaced;
        });
        let refused: RefusalKey | undefined;
        let inverse: Op[] = [];
        let work = { read: 0, moved: 0 };
        try {
            work = workOf(() => {
                refused = refusalOf(() => {
                    inverse = applyOps(book, [op]);
                });
            });
        } finally {
            writes.mockRestore();
        }
        const most = BOUND * (reached + grown + groups * book.weight().runs);
        return { book, work, reached, grown, groups, most, refused, inverse, start };
    };

    test('the staircase that changes nothing reads its 4,000 rectangles and moves nothing, plain or tall', () => {
        for (const part of [{}, striped(1_000_000)]) {
            const { work, reached, refused, inverse } = measured(
                bookOf(sheetOf('S', part)),
                format(staircase(4000), undefined, ['fc']),
            );
            expect(refused).toBeUndefined();
            expect(inverse).toEqual([]);
            expect(reached).toBe(4000);
            expect(work.moved).toBe(0);
            expect(work.read).toBeLessThanOrEqual(BOUND * reached);
        }
    }, 60_000);

    test('the staircase that sets a look on a plain sheet is refused once its bands pass twice the limit', () => {
        const { book, work, most, refused, start } = measured(bookOf(sheetOf('S')), format(staircase(4000), { it: 1 }));
        expect(refused).toBe('too-many-formats');
        expect(formatsOf(book.weight())).toBe(start);
        // The way back is counted too: it undoes the steps last to first, each for what the step cost.
        expect(work.read + work.moved).toBeLessThanOrEqual(2 * most);
    }, 120_000);

    test('three whole columns side by side on a band of a million stripes', () => {
        const columns = Array.from({ length: 3 }, (_, k): Rect => [0, k, LAST_ROW, k]);
        const { work, most, refused, reached } = measured(
            bookOf(sheetOf('S', striped(1_000_000))),
            format(columns, { fc: '#ff0000' }),
        );
        expect(refused).toBeUndefined();
        expect(reached).toBe(3_000_000);
        expect(work.read + work.moved).toBeLessThanOrEqual(most);
    }, 60_000);

    test('the splice: 16,000 rows written into one band of a million stripes cost one pass, not 16,000', () => {
        const rows = Array.from({ length: 16_000 }, (_, k): Rect => [2 * k, 0, 2 * k, LAST_COLUMN]);
        const { work, most, refused, groups, reached } = measured(
            bookOf(sheetOf('S', striped(1_000_000, 2))),
            format(rows, { fc: '#ff0000' }),
        );
        expect(refused).toBeUndefined();
        expect([groups, reached]).toEqual([1, 16_000]);
        expect(work.read + work.moved).toBeLessThanOrEqual(most);
        expect(work.moved).toBeLessThan(3_000_000);
    }, 60_000);

    test('two far cells of one column of a million stripes cost the runs they reach, not the runs between', () => {
        const { bands, looks } = striped(1_000_000);
        const column = bookOf(sheetOf('S', { looks, bands: [...bands, 1, 0] }));
        // Not the last stripe: it runs to the grid's end, and a cut there grows the list's array once.
        const far: Rect[] = [
            [0, 0, 0, 0],
            [999_998, 0, 999_998, 0],
        ];
        const { work, refused, reached, grown } = measured(column, format(far, { it: 1 }));
        expect(refused).toBeUndefined();
        expect([reached, grown]).toEqual([2, 0]);
        expect(work.read + work.moved).toBeLessThanOrEqual(BOUND * (reached + grown) + 16);
    }, 60_000);

    test('rows that take turns over two spans of columns are two passes, wherever they stand in the list', () => {
        const rows = Array.from({ length: 16_000 }, (_, k): Rect => [2 * k, k % 2, 2 * k, 9 + (k % 2)]);
        const { work, refused, groups } = measured(
            bookOf(sheetOf('S', striped(400_000, 2))),
            format(rows, { fc: '#ff0000' }),
        );
        expect(refused).toBeUndefined();
        expect(groups).toBe(2);
        // Each pass cuts its columns out of the band, two copies of 400,000 runs, and lays its lists once.
        expect(work.read + work.moved).toBeLessThan(6_000_000);
    }, 60_000);

    test('a batch of 2,000 typed cells on a book of 1,000 sheets walks the sheets once, for their records', () => {
        const sheets = Array.from({ length: 1000 }, (_, at) =>
            sheetOf(`T${at}`, { fields: { name: `T${at}`, order: `a${at}` }, cells: [[0, LAST_COLUMN, { v: 1 }]] }),
        );
        const book = new Workbook(bookOf(...sheets));
        const ops = Array.from({ length: 2000 }, (_, at) => input(undefined, [[1 + (at % 50), 0, { v: at }]], 'T0'));
        const walks = [spyOn(Bands.prototype, 'weight'), spyOn(Extras.prototype, 'weight')];
        const records = [...book.sheets.values()].map((part) => spyOn(part.records, 'weight'));
        const slots = spyOn(book.engine, 'slots');
        try {
            applyOps(book, ops);
            for (const walk of walks) expect(walk).not.toHaveBeenCalled();
            for (const record of records) expect(record).toHaveBeenCalledTimes(1);
            // The engine's count is asked before and after each op, and once at the end.
            expect(slots.mock.calls.length).toBeLessThanOrEqual(2 * ops.length + 1);
        } finally {
            for (const spy of [...walks, ...records, slots]) spy.mockRestore();
        }
        expect(book.weight().slots).toBe(1000 + 51);
    }, 60_000);

    test('an input of 1,000 full-width rows is counted once per column, not once per row and column', () => {
        const rows = Array.from({ length: 1000 }, (_, k): [Rect, CellContent] => [[k, 0, k, LAST_COLUMN], { v: k }]);
        // A link reaches no column; a listed cell lower down reaches past the rows, and one higher up does not.
        const linked: [Rect, CellContent] = [[2000, 3, 2000, 3], { link: LINK }];
        const told = new Map<number, number[]>();
        const units = filled(
            input(
                [...rows, linked],
                [
                    [5000, 7, { v: 1 }],
                    [3, 9, { v: 1 }],
                ],
            ),
            (column, length) => {
                told.set(column, [...(told.get(column) ?? []), length]);
            },
        );
        expect(units).toBe(5);
        expect(told.size).toBe(GRID_COLUMNS);
        for (const [column, lengths] of told) expect(lengths).toEqual([column === 7 ? 5001 : 1000]);
    }, 60_000);

    test('a link cleared over 1,000 full-width rows moves the 10,000 links between them once, not once a row', () => {
        const cells = Array.from({ length: 10_000 }, (_, row): Placed<CellRecord> => [row, 50, { v: 1, link: LINK }]);
        const book = new Workbook(bookOf(sheetOf('S', { cells })));
        const rows = Array.from({ length: 1000 }, (_, k): Rect => [20_000 + k, 0, 20_000 + k, LAST_COLUMN]);
        let moved = 0;
        const { splice } = Array.prototype;
        Array.prototype.splice = function (this: unknown[], start: number, count: number, ...items: unknown[]) {
            moved += count + items.length;
            return splice.call(this, start, count, ...items);
        };
        try {
            expect(applyOps(book, [format(rows, undefined, ['link'])])).toEqual([]);
        } finally {
            Array.prototype.splice = splice;
        }
        expect(moved).toBeLessThanOrEqual(4 * (cells.length + rows.length));
        expect(book.weight().extras).toBe(5 * 10_000);
    }, 60_000);

    test('a clear of full-width rows costs its columns, its rows, its cells and entries, not rows times columns', () => {
        // A linked value on each row, and one cell far right, so the clear empties cells and links alike; or a link in
        // every column above the rows, so each row would search the entries of every column.
        const shapes = [
            (count: number): Placed<CellRecord>[] => [
                ...Array.from({ length: count }, (_, row): Placed<CellRecord> => [row, 3, { v: row, link: LINK }]),
                [count >> 1, 9000, { v: 1 }],
            ],
            (): Placed<CellRecord>[] => EVERY_COLUMN.map((column) => [0, column, { link: LINK }]),
        ];
        for (const [shape, cellsOf] of shapes.entries()) {
            for (const count of [1000, 10_000]) {
                const cells = cellsOf(count);
                const book = new Workbook(bookOf(sheetOf('S', { cells })));
                const before = bytes(book);
                const first = shape === 0 ? 0 : 1;
                const rows = Array.from({ length: count }, (_, k): [Rect, null] => [
                    [first + k, 0, first + k, LAST_COLUMN],
                    null,
                ]);
                // The engine's walks down a column, the searches of the extras, and the items the lists of the read
                // and the extras take, put or shift along behind a splice.
                let work = 0;
                const asked = spyOn(book.engine, 'nextCell');
                const { push, splice } = Array.prototype;
                const search = Reflect.get(Extras.prototype, 'search');
                Reflect.set(Extras.prototype, 'search', function (this: Extras, place: number) {
                    work += 1;
                    return Reflect.apply(search, this, [place]);
                });
                Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
                    work += items.length;
                    return push.apply(this, items);
                };
                Array.prototype.splice = function (this: unknown[], at: number, removed: number, ...items: unknown[]) {
                    work += removed + items.length + (removed === items.length ? 0 : this.length - at - removed);
                    return splice.call(this, at, removed, ...items);
                };
                let inverse: Op[] = [];
                try {
                    inverse = applyOps(book, [input(rows)]);
                } finally {
                    Object.assign(Array.prototype, { push, splice });
                    Reflect.set(Extras.prototype, 'search', search);
                    asked.mockRestore();
                }
                work += asked.mock.calls.length;
                expect(book.weight().extras).toBe(shape === 0 ? 0 : 5 * GRID_COLUMNS);
                expect(work).toBeLessThanOrEqual(4 * GRID_COLUMNS + 40 * (rows.length + cells.length));
                applyOps(book, inverse);
                expect(bytes(book)).toBe(before);
            }
        }
    }, 120_000);
});

describe('engine/book/room — an op reads its blocks, not the cells and entries between them', () => {
    // The rows the engine walks down a column, the searches of the extras, and the items the lists take, put, filter or
    // sort one by one while `op` lands: a splice's shift of the items behind it is one native move, as in every write.
    const readWork = (book: Workbook, op: Op) => {
        const { engine } = book;
        const cells = engine.cells.bind(engine);
        let work = 0;
        const walks = spyOn(engine, 'cells').mockImplementation(
            (sheet, cell, top = 0, left = 0, bottom = LAST_ROW, right = LAST_COLUMN) => {
                for (let column = left; column <= right; column += 1) {
                    work += Math.max(0, Math.min(bottom + 1, engine.columnLength(sheet, column)) - top);
                }
                cells(sheet, cell, top, left, bottom, right);
            },
        );
        const { push, splice, filter, sort } = Array.prototype;
        for (const [name, door] of [
            ['filter', filter],
            ['sort', sort],
        ] as const) {
            Reflect.set(Array.prototype, name, function (this: unknown[], ...args: unknown[]) {
                work += this.length;
                return Reflect.apply(door, this, args);
            });
        }
        const search = Reflect.get(Extras.prototype, 'search');
        Reflect.set(Extras.prototype, 'search', function (this: Extras, place: number) {
            work += 1;
            return Reflect.apply(search, this, [place]);
        });
        Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
            work += items.length;
            return push.apply(this, items);
        };
        Array.prototype.splice = function (this: unknown[], at: number, removed: number, ...items: unknown[]) {
            work += removed + items.length;
            return splice.call(this, at, removed, ...items);
        };
        let inverse: Op[] = [];
        try {
            inverse = applyOps(book, [op]);
        } finally {
            Object.assign(Array.prototype, { push, splice, filter, sort });
            Reflect.set(Extras.prototype, 'search', search);
            walks.mockRestore();
        }
        return { work, inverse };
    };
    // The work of one op on a fresh book, and its undo back to the bytes before it.
    const measuredRead = (cells: Placed<CellRecord>[], op: Op) => {
        const book = new Workbook(bookOf(sheetOf('S', { cells })));
        const before = bytes(book);
        const { work, inverse } = readWork(book, op);
        console.log('WORK', work);
        applyOps(book, inverse);
        expect(bytes(book)).toBe(before);
        return work;
    };
    const column = (length: number, at: number, content: CellRecord) =>
        Array.from({ length }, (_, row): Placed<CellRecord> => [row, at, content]);

    test('two 2-cell runs at the top and the bottom of a column of 200,000 values read their four cells', () => {
        const op = input([
            [[0, 0, 1, 0], { v: 'a' }],
            [[199_998, 0, 199_999, 0], { v: 'b' }],
        ]);
        // Two blocks over one column, four cells inside.
        expect(measuredRead(column(200_000, 0, { v: 1 }), op)).toBeLessThanOrEqual(40 * (2 + 4));
    }, 60_000);

    test('two full-width rows cleared at the top and the bottom of 30 columns of 40,000 values read the two rows', () => {
        const cells = Array.from({ length: 30 }, (_, at) => column(40_000, at, { v: at })).flat();
        const op = input([
            [[0, 0, 0, LAST_COLUMN], null],
            [[39_999, 0, 39_999, LAST_COLUMN], null],
        ]);
        expect(measuredRead(cells, op)).toBeLessThanOrEqual(8 * (2 * GRID_COLUMNS + 60));
    }, 60_000);

    test('a link set, cleared or input over the top and the bottom of a column of 30,000 links reads those cells', () => {
        const cells = column(30_000, 5, { v: 1, link: LINK });
        const ends: Rect[] = [
            [0, 5, 0, 5],
            [29_999, 5, 29_999, 5],
        ];
        const ops: Op[] = [
            format(ends, { link: { type: 'webpage', address: 'https://eigen.is/other' } }),
            format(ends, undefined, ['link']),
            input([
                [[0, 5, 1, 5], { v: 2, link: LINK }],
                [[29_998, 5, 29_999, 5], { v: 2 }],
            ]),
        ];
        for (const op of ops) expect(measuredRead(cells, op)).toBeLessThanOrEqual(40 * (2 + 4));
    }, 60_000);

    test('a format over 500 full-width rows under a link or a rich text in every column searches each column once', () => {
        const rows = Array.from({ length: 500 }, (_, k): Rect => [k + 1, 0, k + 1, LAST_COLUMN]);
        const cases: [CellRecord, Op][] = [
            [{ link: LINK }, format(rows, undefined, ['link'])],
            [{ s: [{ v: 'a', it: 1 }] }, format(rows, { bl: 1 })],
        ];
        for (const [cell, op] of cases) {
            const cells = EVERY_COLUMN.map((at): Placed<CellRecord> => [0, at, cell]);
            expect(measuredRead(cells, op)).toBeLessThanOrEqual(8 * (GRID_COLUMNS + rows.length));
        }
    }, 60_000);

    // A staircase of 16,000 rows that end at the last column, each one column further right: every edge brings one
    // block and keeps all before it. Its work is a log per edge and per column visited, plus the cells inside.
    const STEPS = 16_000;
    const sweepBound = (inside: number) => 4 * ((2 * STEPS + GRID_COLUMNS) * Math.log2(STEPS) + inside);
    const stairs = (row: (step: number) => number) =>
        Array.from({ length: STEPS }, (_, step): Rect => [row(step), step, row(step), LAST_COLUMN]);

    test('a staircase cleared over empty columns, its steps arriving below or above those before', () => {
        for (const rects of [stairs((step) => step + 1), stairs((step) => STEPS - step)]) {
            const op = input(rects.map((rect): [Rect, null] => [rect, null]));
            expect(measuredRead([[0, 0, { v: 1 }]], op)).toBeLessThanOrEqual(sweepBound(0));
        }
    }, 120_000);

    test('a staircase under a link in every column, its links cleared or its cells cleared', () => {
        const cells = EVERY_COLUMN.map((at): Placed<CellRecord> => [0, at, { link: LINK }]);
        const rects = stairs((step) => step + 1);
        for (const op of [format(rects, undefined, ['link']), input(rects.map((rect): [Rect, null] => [rect, null]))]) {
            expect(measuredRead(cells, op)).toBeLessThanOrEqual(sweepBound(0));
        }
    }, 120_000);

    test('a staircase cleared over a full column of values reads the cell of each step in that column, real work', () => {
        const cells = column(STEPS + 2, LAST_COLUMN, { v: 1 });
        const op = input(stairs((step) => step + 1).map((rect): [Rect, null] => [rect, null]));
        expect(measuredRead(cells, op)).toBeLessThanOrEqual(sweepBound(STEPS));
    }, 120_000);
});

describe('engine/book/room — a refused batch is taken back within four limits, for at most three times its work', () => {
    const refusedLater: Op = { kind: 'sheet', delete: 'S' };
    // The way back of the columns eaten out of a band is a staircase over tall lists: each of its steps moves the
    // runs after the row it writes, in every band it crosses. It is held to eight times, not three: the law is open.
    const cases: [string, () => SheetContent, Op, number?][] = [
        ['a staircase of 2,000 on a plain sheet', () => sheetOf('S'), format(staircase(2000), { it: 1 })],
        [
            'OPEN, at eight times: forty columns eaten out of a band of 100,000 stripes',
            () => sheetOf('S', striped(100_000)),
            format(
                Array.from({ length: 39 }, (_, k): Rect => [k + 1, k, LAST_ROW, k]),
                undefined,
                ['bl', 'bg'],
            ),
            8,
        ],
        [
            'a clear of every look on a band of a million stripes',
            () => sheetOf('S', striped(1_000_000)),
            format([WHOLE], undefined, [...LOOK_KEYS]),
        ],
        [
            'a column deleted from a band of a million stripes',
            () => sheetOf('S', striped(1_000_000)),
            lines(false, false, 5, 1),
        ],
    ];
    for (const [what, make, op, times = 3] of cases) {
        test(what, () => {
            const book = new Workbook(bookOf(make()));
            const start = book.weight();
            const looks = book.sheets.get('S')?.bands.content();
            // The work up to the refusal, which the frame throws once it has asked the weight a last time.
            let forward = 0;
            let peak = 0;
            let total = { read: 0, moved: 0 };
            const over = book.over.bind(book);
            const asked = spyOn(book, 'over').mockImplementation((slots, formats) => over(slots, formats));
            const doors = BANDS_WRITES.map((door) => {
                const real = Bands.prototype[door];
                return spyOn(Bands.prototype, door).mockImplementation(function (this: Bands, ...args: never[]) {
                    const result = Reflect.apply(real, this, args);
                    peak = Math.max(peak, formatsOf(book.weight()));
                    return result;
                });
            });
            try {
                total = workOf((work) => {
                    asked.mockImplementation((slots, formats) => {
                        forward = work.read + work.moved;
                        return over(slots, formats);
                    });
                    // The only sheet shown cannot be deleted: the batch is refused after its first op landed.
                    expect(refusalOf(() => applyOps(book, [op, refusedLater]))).toBe('last-sheet');
                });
            } finally {
                for (const spy of [asked, ...doors]) spy.mockRestore();
            }
            expect(book.weight()).toEqual(start);
            expect(book.sheets.get('S')?.bands.content()).toEqual(looks);
            expect(peak).toBeLessThanOrEqual(2 * MIDWAY * MAX_STYLE_RUNS);
            expect(forward).toBeGreaterThan(0);
            expect(total.read + total.moved - forward).toBeLessThanOrEqual(times * forward);
        }, 120_000);
    }
});
