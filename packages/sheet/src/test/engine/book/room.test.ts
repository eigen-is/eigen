import { describe, expect, spyOn, test } from 'bun:test';
import { GRID_ROWS } from '@workspace/formula/text';
import { encodeBook } from '@workspace/lib/sheets/book-codec';
import { BAND_WEIGHT, fits, formatsOf, MAX_STYLE_RUNS, MAX_VALUE_SLOTS, MIDWAY } from '@workspace/lib/sheets/limits';
import type { CellRecord, InputOp, Op, Placed, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { CellLink } from '@workspace/lib/sheets/types';
import { applyOps } from '../../../engine/book/apply-ops';
import { Bands } from '../../../engine/book/bands';
import { Extras } from '../../../engine/book/extras';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomAnyOp, randomBookContent } from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { contentOfModel, modelAfter, modelOf } from './model';
import {
    ballast,
    bookOf,
    format,
    LAST_COLUMN,
    LAST_ROW,
    refusalOf,
    sheetOf,
    striped,
    WHOLE,
    walked,
} from './room-fixtures';

const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const ENGINE_WRITES = ['setValue', 'setFormula', 'fillFormula', 'clear', 'editLines', 'moveCells', 'addSheet'] as const;

function input(runs: InputOp['runs'], cells?: InputOp['cells']): InputOp {
    return { kind: 'input', sheet: 'S', ...(runs && { runs }), ...(cells && { cells }) };
}

function lines(rows: boolean, insert: boolean, index: number, count: number, sheet = 'S'): Op {
    return { kind: 'lines', sheet, rows, insert, index, count };
}

function move(from: Rect, toRow: number, toColumn: number): Op {
    return { kind: 'move', sheet: 'S', from, toSheet: 'S', toRow, toColumn };
}

// The batch is refused with the key and no door that writes a cell, an extra or a look was called.
function expectUnwritten(book: Workbook, ops: Op[], key: RefusalKey): void {
    const weight = book.weight();
    const writes = [
        ...ENGINE_WRITES.map((door) => spyOn(book.engine, door)),
        ...(['write', 'fill', 'link', 'move', 'lines'] as const).map((door) => spyOn(Extras.prototype, door)),
        ...(['write', 'move', 'lines'] as const).map((door) => spyOn(Bands.prototype, door)),
    ];
    try {
        expect(refusalOf(() => applyOps(book, ops))).toBe(key);
        for (const write of writes) expect(write).not.toHaveBeenCalled();
    } finally {
        for (const write of writes) write.mockRestore();
    }
    expect(book.weight()).toEqual(weight);
}

describe('engine/book/room — the counts the workbook keeps are what a walk of it counts', () => {
    test('after a load, and whenever a batch asks the weight, over random books and batches', () => {
        let asked = 0;
        let refused = 0;
        const kinds = new Set<string>();
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = randomOf(seed);
            const book = new Workbook(randomBookContent(random));
            expect(book.weight()).toMatchObject(walked(book));
            const over = book.over.bind(book);
            const addSheet = book.addSheet.bind(book);
            // A sheet being added is counted before the book lists it, so a walk does not see it yet.
            let adding = false;
            spyOn(book, 'addSheet').mockImplementation((sheet, checked) => {
                adding = true;
                try {
                    return addSheet(sheet, checked);
                } finally {
                    adding = false;
                }
            });
            spyOn(book, 'over').mockImplementation((more) => {
                asked += 1;
                if (!adding) expect(book.weight()).toMatchObject(walked(book));
                return over(more);
            });
            let model: Model = modelOf(book.content());
            for (let round = 0; round < 6; round += 1) {
                const batch = batchOf(random, model, randomAnyOp);
                for (const op of batch.ops) kinds.add(op.kind);
                try {
                    applyOps(book, batch.ops);
                } catch (error) {
                    if (!(error instanceof Refusal)) throw error;
                    refused += 1;
                }
                expect(book.weight()).toMatchObject(walked(book));
                const next = modelAfter(model, batch);
                if (typeof next !== 'string') model = next;
            }
        }
        expect(kinds.size).toBe(6);
        expect(refused).toBeGreaterThan(50);
        expect(asked).toBeGreaterThan(1000);
    }, 300_000);
});

// The floors of the rule: a write lands when it leaves the book at twice a limit to the slot or to the run, counted
// without what its op frees, and one more is refused before the first write; the batch then ends within the limit.
describe('engine/book/room — a write may leave the book at twice a limit inside a batch, and not one past it', () => {
    const TWICE = MIDWAY * MAX_VALUE_SLOTS;
    // Four cells that add `slots` slots to four empty columns: three full columns and the rest.
    const reaching = (slots: number, content: Placed<CellRecord>[2] | null): Placed<CellRecord | null>[] => [
        [LAST_ROW, 10, content],
        [LAST_ROW, 11, content],
        [LAST_ROW, 12, content],
        [slots - 3 * GRID_ROWS - 1, 13, content],
    ];
    const full = (part: Partial<SheetContent> = {}, less = 0) =>
        new Workbook(bookOf(sheetOf('S', part), ...ballast(MAX_VALUE_SLOTS - less, 0)));

    test('an input of listed cells', () => {
        const book = full();
        // At twice the limit, a write over the cells already there adds nothing.
        applyOps(book, [
            input(undefined, reaching(MAX_VALUE_SLOTS, { v: 1 })),
            input(undefined, reaching(MAX_VALUE_SLOTS, { v: 2 })),
            input(undefined, reaching(MAX_VALUE_SLOTS, null)),
        ]);
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        const more = [
            input(undefined, reaching(MAX_VALUE_SLOTS + 1, { v: 1 })),
            input(undefined, reaching(MAX_VALUE_SLOTS + 1, null)),
        ];
        expectUnwritten(full(), more, 'too-many-cells');
    }, 60_000);

    test('an input of rectangles, two in one column counted once', () => {
        const runs = (last: number): InputOp['runs'] => [
            [[0, 10, 99, 12], { v: 1 }],
            [[100, 10, LAST_ROW, 12], { f: '=1' }],
            [[0, 13, last, 13], { v: 2 }],
        ];
        const last = MAX_VALUE_SLOTS - 3 * GRID_ROWS - 1;
        const book = full();
        applyOps(book, [input(runs(last)), input([[[0, 10, LAST_ROW, 13], null]])]);
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        expectUnwritten(full(), [input(runs(last + 1)), input([[[0, 10, LAST_ROW, 13], null]])], 'too-many-cells');
    }, 120_000);

    test('an input is counted without what it frees', () => {
        // The op empties a full column of its sheet and fills one slot more than the room there was before it.
        const held: Partial<SheetContent> = { cells: [[LAST_ROW, 0, { v: 1 }]] };
        const cells = (slots: number): Placed<CellRecord | null>[] => [
            [LAST_ROW, 0, null],
            ...reaching(slots, { v: 1 }),
        ];
        const undo = input([[WHOLE, null]]);
        expectUnwritten(full(held, GRID_ROWS), [input(undefined, cells(MAX_VALUE_SLOTS + 1)), undo], 'too-many-cells');
        // Nor is a cell written inside a full column room for cells elsewhere.
        const inside: Placed<CellRecord | null>[] = [[0, 0, { v: 2 }], ...reaching(MAX_VALUE_SLOTS + 1, { v: 1 })];
        expectUnwritten(full(held, GRID_ROWS), [input(undefined, inside), undo], 'too-many-cells');
        const book = full(held, GRID_ROWS);
        expect(refusalOf(() => applyOps(book, [input(undefined, cells(MAX_VALUE_SLOTS)), undo]))).toBeUndefined();
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS - GRID_ROWS);
    }, 60_000);

    test('an input of a link or a mark is no slot, and its units are weighed with the looks', () => {
        const heavy = () => new Workbook(bookOf(sheetOf('S'), ...ballast(0, MAX_STYLE_RUNS - 32)));
        expect(formatsOf(heavy().weight())).toBe(MAX_STYLE_RUNS);
        // A mark weighs two units of five runs, a link five units.
        for (const [content, cells] of [
            [{ qp: 1 as const, v: 'a' }, MAX_STYLE_RUNS / 10],
            [{ link: LINK }, MAX_STYLE_RUNS / 25],
        ] as const) {
            const fill = (count: number) => [
                input([[[0, 0, count - 1, 0], content]]),
                input([[[0, 0, count - 1, 0], null]]),
            ];
            const book = heavy();
            applyOps(book, fill(cells));
            expect(formatsOf(book.weight())).toBe(MAX_STYLE_RUNS);
            const refused = heavy();
            const key = content.qp ? 'too-many-cells' : 'too-many-formats';
            if (!content.qp) expectUnwritten(refused, fill(cells + 1), key);
        }
        const link = (count: number) => [
            format([[0, 0, count - 1, 0]], { link: LINK }),
            format([[0, 0, count - 1, 0]], undefined, ['link']),
        ];
        const book = heavy();
        applyOps(book, link(MAX_STYLE_RUNS / 25));
        expect(formatsOf(book.weight())).toBe(MAX_STYLE_RUNS);
        expectUnwritten(heavy(), link(MAX_STYLE_RUNS / 25 + 1), 'too-many-formats');
    }, 120_000);

    test('an insert of rows pushes each column that holds a cell at or below it', () => {
        // Cells on row 0 of four columns and one above the insert, which does not move.
        const held: Partial<SheetContent> = { cells: [10, 11, 12, 13].map((column) => [5, column, { v: 1 }]) };
        const above: Placed<CellRecord> = [3, 20, { v: 1 }];
        const part = { cells: [...(held.cells ?? []), above] };
        const count = (TWICE - MAX_VALUE_SLOTS) / 4;
        const book = full(part, 4 * 6 + 4);
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        applyOps(book, [lines(true, true, 4, count), lines(true, false, 4, count)]);
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        expectUnwritten(
            full(part, 4 * 6 + 4),
            [lines(true, true, 4, count + 1), lines(true, false, 4, count + 1)],
            'too-many-cells',
        );
    }, 60_000);

    test('a move counts each column up to the last cell the block brings', () => {
        // Each column of the block holds a cell on row 2 and none below: it lands a million rows down.
        const part: Partial<SheetContent> = { cells: [10, 11, 12, 13].map((column) => [2, column, { v: 1 }]) };
        const down = (TWICE - MAX_VALUE_SLOTS) / 4;
        const there = (rows: number) => [move([0, 10, 9, 13], rows, 10), move([rows, 10, rows + 9, 13], 0, 10)];
        const book = full(part, 12);
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        applyOps(book, there(down));
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        expectUnwritten(full(part, 12), there(down + 1), 'too-many-cells');
    }, 60_000);

    test('a move is refused unwritten when its bands, cut out of a tall band where it lands, could pass the limit', () => {
        // Ten columns, each a band of its own, onto one band of a million stripes: ten cuts of a million runs.
        const bands: number[] = [];
        for (let column = 0; column < 10; column += 1) bands.push(column, 1, 0, 1 + (column % 2));
        bands.push(10, 0);
        const source = sheetOf('S', { looks: [{ bl: 1 }, { it: 1 }], bands });
        const tall = sheetOf('T', { fields: { name: 'T', order: 'a1' }, ...striped(1_000_000) });
        const op: Op = { kind: 'move', sheet: 'S', from: [0, 0, 9, 9], toSheet: 'T', toRow: 0, toColumn: 0 };
        expectUnwritten(new Workbook(bookOf(source, tall)), [op], 'too-many-formats');
    }, 60_000);

    test('a move counts the runs its block brings, on a book a batch has brought near twice the limit', () => {
        // A column of a million stripes moves onto a plain sheet, after four sheets added bring the book near twice.
        const plain = sheetOf('P', { fields: { name: 'P', order: 'a1' } });
        const content = bookOf(sheetOf('S', striped(1_000_000)), plain, ...ballast(0, MAX_STYLE_RUNS - 1_000_064));
        const added = (id: string, runs: number): Op => {
            const sheet = sheetOf(id, { fields: { name: id, order: `b${id}` }, ...striped(runs) });
            return { kind: 'sheet', add: sheet };
        };
        const adds = [added('A', 1_000_000), added('B', 1_000_000), added('C', 1_000_000), added('D', 990_000)];
        const block: Op = { kind: 'move', sheet: 'S', from: [0, 0, LAST_ROW, 0], toSheet: 'P', toRow: 0, toColumn: 0 };
        const book = new Workbook(content);
        expect(formatsOf(book.weight())).toBe(MAX_STYLE_RUNS);
        const moves = spyOn(book.engine, 'moveCells');
        expect(refusalOf(() => applyOps(book, [...adds, block]))).toBe('too-many-formats');
        expect(moves).not.toHaveBeenCalled();
        expect(formatsOf(book.weight())).toBe(MAX_STYLE_RUNS);
    }, 120_000);

    test('a move weighs the bands its landing cuts: at twice the limit midway it lands, one run past it is refused', () => {
        // A look on column 5 lands on column 10 of plain columns, cutting their band at 10 and 11: weighed as two bands,
        // the three runs a write adds to the band between the cuts and the one span it reads.
        const source = sheetOf('S', { looks: [{ bl: 1 }], bands: [5, 1, 0, 1, 6, 0] });
        const op = move([0, 5, 0, 5], 0, 10);
        const weighed = 2 * BAND_WEIGHT + 3 + 1;
        const twin = new Workbook(bookOf(source));
        const start = formatsOf(twin.weight());
        applyOps(twin, [op]);
        const grown = formatsOf(twin.weight()) - start;
        // The book ends the batch at the limit. The sheets the batch adds before the move, and deletes after it, bring
        // it to twice the limit with the move weighed and `past` runs more.
        const batch = (past: number): Op[] => {
            const added = ballast(0, MAX_STYLE_RUNS + grown - weighed + past).map((sheet, at) => ({
                ...sheet,
                id: `added${at}`,
                fields: { ...sheet.fields, name: `Added ${at}` },
            }));
            return [
                ...added.map((add): Op => ({ kind: 'sheet', add })),
                op,
                ...added.map(({ id }): Op => ({ kind: 'sheet', delete: id })),
            ];
        };
        const near = () => new Workbook(bookOf(source, ...ballast(0, MAX_STYLE_RUNS - grown - start)));
        const landed = near();
        applyOps(landed, batch(0));
        expect(formatsOf(landed.weight())).toBe(MAX_STYLE_RUNS);
        const book = near();
        const moves = spyOn(book.engine, 'moveCells');
        expect(refusalOf(() => applyOps(book, batch(1)))).toBe('too-many-formats');
        expect(moves).not.toHaveBeenCalled();
        expect(formatsOf(book.weight())).toBe(MAX_STYLE_RUNS - grown);
    }, 120_000);

    test('a sheet added is weighed with its cells and its parts before the engine takes it', () => {
        const cells = reaching(MAX_VALUE_SLOTS, { v: 1 }).map(
            ([row, column]): Placed<CellRecord> => [row, column, { v: 1 }],
        );
        const add = (more: number): Op[] => {
            const last: Placed<CellRecord> = [cells[3][0] + more, 13, { v: 1 }];
            const sheet = sheetOf('T', { fields: { name: 'T', order: 'a1' }, cells: [...cells.slice(0, 3), last] });
            return [
                { kind: 'sheet', add: sheet },
                { kind: 'sheet', delete: 'T' },
            ];
        };
        const book = full();
        applyOps(book, add(0));
        expect(book.weight().slots).toBe(MAX_VALUE_SLOTS);
        expectUnwritten(full(), add(1), 'too-many-cells');
        // Its formats: a sheet of one band of runs that brings the book to twice the limit, and one run more.
        const heavy = (runs: number): Op[] => {
            const bands = [0, runs];
            for (let row = 0; row < runs; row += 1) bands.push(row, 1 + (row % 2));
            const sheet = sheetOf('T', { fields: { name: 'T', order: 'a1' }, looks: [{ bl: 1 }, { it: 1 }], bands });
            return [
                { kind: 'sheet', add: sheet },
                { kind: 'sheet', delete: 'T' },
            ];
        };
        const light = () => new Workbook(bookOf(sheetOf('S'), ...ballast(0, MAX_STYLE_RUNS - 32)));
        const room = MIDWAY * MAX_STYLE_RUNS - MAX_STYLE_RUNS - 32;
        expect(room).toBeLessThanOrEqual(GRID_ROWS * 4);
        const landed = light();
        // A list holds a run a row at most, so the sheet is refused at the door of the limit, not of the grid.
        expect(refusalOf(() => applyOps(landed, heavy(GRID_ROWS)))).toBeUndefined();
        expect(formatsOf(landed.weight())).toBe(MAX_STYLE_RUNS);
    }, 120_000);

    test('a batch that ends one run or one slot over a limit is refused and leaves the bytes; at the limit it lands', () => {
        const edit = [format([[3, 3, 5, 4]], { bl: 1 }), input(undefined, [[7, 2, { v: 1 }]])];
        const twin = new Workbook(bookOf(sheetOf('S')));
        applyOps(twin, edit);
        const end = twin.weight();
        const near = (slots: number, formats: number) =>
            new Workbook(
                bookOf(
                    sheetOf('S'),
                    ...ballast(MAX_VALUE_SLOTS - end.slots + slots, MAX_STYLE_RUNS - formatsOf(end) + formats),
                ),
            );
        const book = near(0, 0);
        applyOps(book, edit);
        expect([book.weight().slots, formatsOf(book.weight())]).toEqual([MAX_VALUE_SLOTS, MAX_STYLE_RUNS]);
        for (const [slots, formats, key] of [
            [1, 0, 'too-many-cells'],
            [0, 1, 'too-many-formats'],
        ] as const) {
            const over = near(slots, formats);
            const before = JSON.stringify(over.sheets.get('S')?.bands.content());
            expect(refusalOf(() => applyOps(over, edit))).toBe(key);
            const after = JSON.stringify(over.sheets.get('S')?.bands.content());
            expect(after).toBe(before);
        }
    }, 120_000);
});

describe('engine/book/room — the rule over random books at the limits: a batch lands exactly when no write passes twice a limit and its end fits', () => {
    test('batches of every kind, each then undone', () => {
        const tally = { landed: 0, end: 0, other: 0, asked: 0, undone: 0 };
        for (let seed = 1; seed <= 60; seed += 1) {
            const random = randomOf(seed);
            const content = randomBookContent(random);
            const own = new Workbook(content).weight();
            // Ballast brings the book within a few slots and runs of each limit.
            const weights = ballast(
                MAX_VALUE_SLOTS - own.slots - Math.floor(random() * 30),
                MAX_STYLE_RUNS - formatsOf(own) - Math.floor(random() * 80),
            );
            const book = new Workbook({ ...content, sheets: [...content.sheets, ...weights] });
            const heavy = new Workbook(bookOf(...weights)).weight();
            let model: Model = modelOf(content);
            // The sheets that are no ballast, as content: what the book holds, and what a walk of them weighs with
            // the ballast as it was loaded.
            const lightOf = (of: Workbook): Book => {
                while (of.engine.recalc(Number.MAX_SAFE_INTEGER).stopped);
                const sheets = [...of.sheets].filter(([id]) => !id.startsWith('zz'));
                return { ...content, computed: true, sheets: sheets.map(([id, part]) => of.sheetContent(id, part)) };
            };
            const held = (of: Workbook) => encodeBook(lightOf(of));
            const weighed = (of: Workbook) => {
                const w = walked(new Workbook(lightOf(of)));
                return {
                    slots: w.slots + heavy.slots,
                    runs: w.runs + heavy.runs,
                    bands: w.bands + heavy.bands,
                    extras: w.extras,
                };
            };
            for (let round = 0; round < 4; round += 1) {
                const batch = batchOf(random, model, randomAnyOp, 3);
                const next = modelAfter(model, batch);
                const before = held(book);
                let inverse: Op[] | undefined;
                const key = refusalOf(() => {
                    inverse = applyOps(book, batch.ops);
                });
                const now = book.weight();
                expect(now).toMatchObject(weighed(book));
                if (key !== undefined) {
                    expect(held(book)).toBe(before);
                    if (typeof next !== 'string') {
                        // The model lands the batch: the book refuses it only for a limit, which its end is then over.
                        const end = new Workbook(contentOfModel(next)).weight();
                        const total = {
                            ...end,
                            slots: end.slots + heavy.slots,
                            runs: end.runs + heavy.runs,
                            bands: end.bands + heavy.bands,
                            sheets: 1,
                        };
                        expect(fits(total)).toBe(key);
                        tally.end += 1;
                    } else tally.other += 1;
                    continue;
                }
                expect(typeof next).not.toBe('string');
                if (typeof next === 'string') continue;
                expect(fits({ ...now, sheets: 1 })).toBeNull();
                tally.landed += 1;
                // The undo of a batch that landed is a batch that lands: it ends where the book fitted.
                if (inverse && round % 2 === 0) {
                    const landed = held(book);
                    const redo = applyOps(book, inverse);
                    expect(held(book)).toBe(before);
                    applyOps(book, redo);
                    expect(held(book)).toBe(landed);
                    tally.undone += 1;
                }
                model = next;
            }
        }
        expect(tally.landed).toBeGreaterThan(40);
        expect(tally.end).toBeGreaterThan(15);
        expect(tally.undone).toBeGreaterThan(20);
    }, 600_000);
});

describe('engine/book/room — an honest undo and redo land in a book of tall shared bands, at any fill', () => {
    // Sheets of one band of a million stripes up to a share of the limit on formats: a delete and a clear of a
    // column and of a row of the first, each then undone and redone.
    const filled = (share: number): SheetContent[] => {
        const sheets: SheetContent[] = [];
        for (let left = Math.round(share * MAX_STYLE_RUNS); left > 64; ) {
            const runs = Math.min(left - 32, 1_000_000);
            const id = sheets.length === 0 ? 'S' : `P${sheets.length}`;
            sheets.push(sheetOf(id, { fields: { name: id, order: `a${sheets.length}` }, ...striped(runs) }));
            left -= runs + 32;
        }
        return sheets;
    };
    const EDITS: readonly [string, Op][] = [
        ['delete a column', lines(false, false, 5, 1)],
        ['clear a column', format([[0, 5, LAST_ROW, 5]], undefined, [...LOOK_KEYS])],
        ['delete a row', lines(true, false, 500, 1)],
        ['clear a row', format([[500, 0, 500, LAST_COLUMN]], undefined, [...LOOK_KEYS])],
    ];
    for (const share of [0.25, 0.5, 0.75, 0.95]) {
        test(`at ${100 * share}% of the limit`, () => {
            for (const [what, edit] of EDITS) {
                const book = new Workbook(bookOf(...filled(share)));
                const weight = book.weight();
                expect(formatsOf(weight) / MAX_STYLE_RUNS).toBeCloseTo(share, 2);
                const looks = () => JSON.stringify(book.sheets.get('S')?.bands.content());
                const before = looks();
                // A column cleared out of a band of a million stripes leaves the band twice, a million runs more:
                // from 75% the book would end over the limit, and the clear itself is refused.
                if (what === 'clear a column' && share >= 0.75) {
                    expect(refusalOf(() => applyOps(book, [edit]))).toBe('too-many-formats');
                    expect([looks() === before, book.weight()]).toEqual([true, weight]);
                    continue;
                }
                const undo = applyOps(book, [edit]);
                const after = looks();
                // A column deleted inside one band leaves the band as it was: its undo must still land.
                expect([what, after === before]).toEqual([what, what === 'delete a column']);
                const redo = applyOps(book, undo);
                expect([what, looks() === before, book.weight()]).toEqual([what, true, weight]);
                applyOps(book, redo);
                expect([what, looks() === after]).toEqual([what, true]);
            }
        }, 300_000);
    }
});

describe('engine/book/room — the inverse of a delete restores only what differs from the line beside it', () => {
    const inverseOf = (part: Partial<SheetContent>, op: Op) => applyOps(new Workbook(bookOf(sheetOf('S', part))), [op]);

    test('a column or a row deleted beside an equal neighbour gives no format op, at the grid start too', () => {
        const tall = striped(1000);
        for (const index of [0, 5, LAST_COLUMN]) {
            const inverse = inverseOf(tall, lines(false, false, index, 1));
            expect(inverse).toEqual([{ ...lines(false, true, index, 1), like: Math.max(0, index - 1) } as Op]);
            expect(JSON.stringify(inverse).length).toBeLessThan(1000);
        }
        // Rows 10 to 19 wear one look across the sheet: a row deleted inside them, and the first of the sheet.
        const wide: Partial<SheetContent> = { looks: [{ bl: 1 }], bands: [0, 3, 0, 1, 10, 1, 20, 0] };
        expect(inverseOf(wide, lines(true, false, 12, 3))).toEqual([{ ...lines(true, true, 12, 3), like: 11 } as Op]);
        expect(inverseOf(wide, lines(true, false, 0, 2))).toEqual([{ ...lines(true, true, 0, 2), like: 0 } as Op]);
    });

    test('a span that differs is written back whole, a plain one beside a look included', () => {
        // Column 3 is bold from row 0 to 9 and plain below; column 4 is plain; column 5 is bold whole.
        const part: Partial<SheetContent> = { looks: [{ bl: 1 }], bands: [3, 2, 0, 1, 10, 0, 4, 0, 5, 1, 0, 1, 6, 0] };
        // Column 4 goes: beside column 3 its rows 0 to 9 differ, being plain.
        expect(inverseOf(part, lines(false, false, 4, 1))).toEqual([
            { ...lines(false, true, 4, 1), like: 3 } as Op,
            format([[0, 4, 9, 4]], {}, [...LOOK_KEYS]),
        ]);
        // Column 5 goes: beside the plain column 4 all of it differs.
        expect(inverseOf(part, lines(false, false, 5, 1))).toEqual([
            { ...lines(false, true, 5, 1), like: 4 } as Op,
            format(
                [[0, 5, LAST_ROW, 5]],
                { bl: 1 },
                LOOK_KEYS.filter((key) => key !== 'bl'),
            ),
        ]);
    });

    test('the undo restores the bands and the redo deletes again, over a striped row and a striped column', () => {
        for (const op of [
            lines(true, false, 500, 1),
            lines(true, false, 0, 3),
            lines(false, false, 0, 2),
            lines(false, false, 7, 1),
        ]) {
            const stripes = striped(1000);
            const bands = [...stripes.bands, 8, 1, 0, 2, 9, 0];
            const book = new Workbook(bookOf(sheetOf('S', { ...stripes, bands })));
            const before = bytes(book);
            const undo = applyOps(book, [op]);
            const after = bytes(book);
            const redo = applyOps(book, undo);
            expect(bytes(book)).toBe(before);
            applyOps(book, redo);
            expect(bytes(book)).toBe(after);
        }
    });
});

describe('engine/book/room — a format refused midway leaves the book as it was', () => {
    test('the bytes, the weight and the looks, after rectangles that landed are taken back', () => {
        // Each rectangle cuts a column out of a band of 300,000 stripes: the batch passes twice the limit on the way.
        // A rich cell in the first rectangle holds a run that is italic already, which the way back must not strip.
        const rich: Placed<CellRecord> = [0, 0, { s: [{ v: 'ri', it: 1 }, { v: 'ch' }] }];
        const content: Book = bookOf(sheetOf('S', { ...striped(300_000), cells: [rich] }));
        const book = new Workbook(content);
        const before = bytes(book);
        const weight = book.weight();
        const ranges = Array.from({ length: 100 }, (_, k): Rect => [k, 2 * k, k, 2 * k]);
        const links = spyOn(Extras.prototype, 'link');
        try {
            expect(refusalOf(() => applyOps(book, [format(ranges, { it: 1, link: LINK })]))).toBe('too-many-formats');
            // The format stopped at its looks: no link was written.
            expect(links).not.toHaveBeenCalled();
        } finally {
            links.mockRestore();
        }
        expect(book.weight()).toEqual(weight);
        expect(bytes(book)).toBe(before);
    }, 120_000);

    test('a batch whose later op would bring the book back under the limit is still refused', () => {
        // The format stops once it passes twice the limit, half written: a delete of the columns it cut would leave
        // a book that fits.
        const book = new Workbook(bookOf(sheetOf('S', striped(300_000))));
        const looks = JSON.stringify(book.sheets.get('S')?.bands.content());
        const ranges = Array.from({ length: 100 }, (_, k): Rect => [k, 2 * k, k, 2 * k]);
        const batch = [format(ranges, { it: 1 }), lines(false, false, 0, 300)];
        expect(refusalOf(() => applyOps(book, batch))).toBe('too-many-formats');
        expect(JSON.stringify(book.sheets.get('S')?.bands.content())).toBe(looks);
    }, 120_000);
});
