import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { CellContent, Placed, RecordOp, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import { covers, meets } from '@workspace/lib/sheets/rect';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { textOf } from '../../../engine/book/extras';
import type { Sheet } from '../../../engine/book/handle';
import { cellsOf } from '../../../engine/book/handle';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomBookContent, randomRecordOp } from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import type { Model, ModelSheet } from './model';
import { contentOfModel, modelAfter, modelOf } from './model';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
// A formula into another workbook, which this build cannot evaluate: its value is given with it.
const KEPT = "='[b.xlsx]S'!R1C1";

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000.5, seed: 7, sheets };
}

function only(book: Workbook, id = 'a'): Sheet {
    const sheet = cellsOf(book).sheet(id);
    if (!sheet) throw new Error(`No sheet ${id}`);
    return sheet;
}

function record(...ops: RecordOp[]): RecordOp[] {
    return ops;
}

describe('engine/book/handle — identity', () => {
    const content = bookOf(
        sheetOf('a', {
            looks: [{ bl: 1 }],
            bands: [0, 1, 0, 1],
            records: {
                merge: { m1: { rect: [0, 0, 1, 1] }, m2: { rect: [5, 5, 6, 6] } },
                comment: { c1: { row: 2, column: 2 } },
            },
        }),
        sheetOf('b'),
    );

    test('a sheet’s fields keep their reference while unchanged and change with a record op', () => {
        const book = new Workbook(content);
        const a = only(book).fields;
        const b = only(book, 'b').fields;
        expect(only(book).fields).toBe(a);
        applyOps(book, record({ kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { color: '#123456' } }));
        expect(only(book).fields).not.toBe(a);
        expect(only(book).fields).toEqual({ ...a, color: '#123456' });
        expect(only(book, 'b').fields).toBe(b);
    });

    test('an unchanged record keeps its reference and a changed one is new', () => {
        const book = new Workbook(content);
        const merges = only(book).records('merge');
        const m1 = merges.get('m1');
        const m2 = merges.get('m2');
        const comment = only(book).records('comment').get('c1');
        applyOps(book, record({ kind: 'record', sheet: 'a', type: 'merge', id: 'm2', set: { rect: [8, 8, 9, 9] } }));
        expect(only(book).records('merge').get('m1')).toBe(m1);
        expect(only(book).records('merge').get('m2')).not.toBe(m2);
        expect(only(book).records('merge').get('m2')).toEqual({ rect: [8, 8, 9, 9] });
        expect(only(book).records('comment').get('c1')).toBe(comment);
    });

    test('a look is the interned entry: one reference for one look, a new one after a fresh load', () => {
        const book = new Workbook(content);
        const sheet = only(book);
        expect(sheet.look(0, 0)).toEqual({ bl: 1 });
        expect(sheet.look(9, 40)).toBe(sheet.look(0, 0));
        expect(only(book, 'b').look(3, 3)).toBe(only(book, 'b').look(0, 0));
        expect(only(book).look(0, 0)).toBe(sheet.look(0, 0));
        applyOps(
            book,
            record({ kind: 'record', sheet: 'a', type: 'comment', id: 'c2', set: { row: 0, column: 0 }, whole: 1 }),
        );
        expect(only(book).look(0, 0)).toBe(sheet.look(0, 0));
        // A load keeps the objects it is given, so a fresh load is of a decoded copy, as the codec hands over.
        const fresh = only(new Workbook(structuredClone(content)));
        expect(fresh.look(0, 0)).toEqual(sheet.look(0, 0));
        expect(fresh.look(0, 0)).not.toBe(sheet.look(0, 0));
        expect(fresh.fields).not.toBe(sheet.fields);
        expect(fresh.records('merge').get('m1')).not.toBe(sheet.records('merge').get('m1'));
    });

    test('a line’s keys are the stored run’s', () => {
        const book = new Workbook(bookOf(sheetOf('a', { rows: [[[2, 5], { size: 30 }]] })));
        expect(only(book).row(2)).toBe(only(book).row(5));
        expect(only(book).row(2)).toEqual({ size: 30 });
        expect(only(book).row(6)).toEqual({});
        expect(only(book).row(6)).toBe(only(book).column(0));
    });

    test('a book makes its sheets once: sheet(id) is the sheet sheets() lists, and a new book makes new ones', () => {
        const book = new Workbook(content);
        const handle = cellsOf(book);
        expect(handle.sheets()).toBe(handle.sheets());
        expect(handle.sheet('a')).toBe(handle.sheets()[0]);
        expect(handle.sheet('b')).toBe(handle.sheets()[1]);
        expect(handle.sheet('none')).toBeUndefined();
        expect(cellsOf(book).sheet('a')).not.toBe(handle.sheet('a'));
    });
});

describe('engine/book/handle — tab order', () => {
    test('sheets come by order, and sheets of one order by id', () => {
        const order = (id: string, at: string) => sheetOf(id, { fields: { name: `N${id}`, order: at } });
        const book = new Workbook(bookOf(order('c', 'a1'), order('b', 'a0'), order('z', 'a0'), order('a', 'a1')));
        expect(
            cellsOf(book)
                .sheets()
                .map(({ id }) => id),
        ).toEqual(['b', 'z', 'a', 'c']);
    });

    test('a record op that moves a tab onto the order of another puts the two by id', () => {
        const book = new Workbook(bookOf(sheetOf('z'), sheetOf('b', { fields: { name: 'b', order: 'a1' } })));
        expect(
            cellsOf(book)
                .sheets()
                .map(({ id }) => id),
        ).toEqual(['z', 'b']);
        applyOps(book, record({ kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { order: 'a0' } }));
        expect(
            cellsOf(book)
                .sheets()
                .map(({ id }) => id),
        ).toEqual(['b', 'z']);
    });
});

describe('engine/book/handle — a cell', () => {
    const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
    const cells: Placed<CellContent>[] = [
        [0, 0, { v: 1.5 }],
        [1, 0, { v: '#DIV/0!', e: 1 }],
        [2, 0, { v: true }],
        [3, 0, { v: 'text' }],
        [4, 0, { v: 5, f: KEPT }],
        [5, 0, { v: 3, f: '=1+2' }],
        [6, 0, { v: '#REF!', e: 1, f: KEPT }],
        [7, 0, { s: [{ v: 'a', bl: 1 }, { v: 'b' }], link: LINK }],
        [8, 0, { v: 'typed', qp: 1 }],
        [9, 0, { link: LINK }],
        [10, 0, { v: 2.5 }],
        [11, 0, { v: false }],
        [12, 0, { v: true }],
        [13, 0, { v: 'ab' }],
        [14, 0, { v: '#N/A', e: 1 }],
    ];
    const book = new Workbook(
        bookOf(
            sheetOf('a', {
                cells,
                looks: [{ fa: '0.00' }, { fa: '@" pcs"' }],
                bands: [0, 4, 0, 1, 10, 0, 11, 1, 12, 2],
            }),
        ),
    );
    const sheet = only(book);

    test('content shows a value beside a formula only when the formula’s value is given', () => {
        expect(sheet.content(4, 0)).toEqual({ v: 5, f: KEPT });
        expect(sheet.content(5, 0)).toEqual({ f: '=1+2' });
        expect(sheet.content(6, 0)).toEqual({ v: '#REF!', e: 1, f: KEPT });
    });

    test('content is the op form of every kind of cell', () => {
        expect(sheet.content(0, 0)).toEqual({ v: 1.5 });
        expect(sheet.content(1, 0)).toEqual({ v: '#DIV/0!', e: 1 });
        expect(sheet.content(2, 0)).toEqual({ v: true });
        expect(sheet.content(7, 0)).toEqual({ s: [{ v: 'a', bl: 1 }, { v: 'b' }], link: LINK });
        expect(sheet.content(8, 0)).toEqual({ v: 'typed', qp: 1 });
        expect(sheet.content(9, 0)).toEqual({ link: LINK });
        expect(sheet.content(15, 0)).toBeNull();
        expect(sheet.content(0, 1)).toBeNull();
    });

    test('value and hasFormula', () => {
        expect(sheet.value(0, 0)).toBe(1.5);
        expect(sheet.value(1, 0)).toEqual(expect.objectContaining({ text: '#DIV/0!' }));
        expect(sheet.value(4, 0)).toBe(5);
        expect(sheet.value(7, 0)).toBe('ab');
        expect(sheet.value(9, 0)).toBeNull();
        expect(sheet.hasFormula(4, 0)).toBe(true);
        expect(sheet.hasFormula(5, 0)).toBe(true);
        expect(sheet.hasFormula(0, 0)).toBe(false);
        expect(sheet.hasFormula(0, 9)).toBe(false);
    });

    test('display: a number in its look’s format, an error as its text, an empty cell as no text', () => {
        expect(sheet.display(0, 0)).toBe('1.50');
        expect(sheet.display(10, 0)).toBe('2.5');
        expect(sheet.display(1, 0)).toBe('#DIV/0!');
        expect(sheet.display(6, 0)).toBe('#REF!');
        expect(sheet.display(2, 0)).toBe('TRUE');
        expect(sheet.display(11, 0)).toBe('FALSE');
        expect(sheet.display(3, 0)).toBe('text');
        expect(sheet.display(7, 0)).toBe('ab');
        expect(sheet.display(9, 0)).toBe('');
        expect(sheet.display(40, 40)).toBe('');
    });

    test('display: a boolean, a text and an error ignore a format’s text section', () => {
        expect(sheet.display(12, 0)).toBe('TRUE');
        expect(sheet.display(13, 0)).toBe('ab');
        expect(sheet.display(14, 0)).toBe('#N/A');
    });

    test('values walk the cells that hold a value or a formula, in column order', () => {
        expect([...sheet.values()].map(({ r, c }) => [r, c])).toEqual(
            cells.filter(([r]) => r !== 9).map(([r, c]) => [r, c]),
        );
        expect([...sheet.values([2, 0, 4, 0])]).toEqual([
            { r: 2, c: 0 },
            { r: 3, c: 0 },
            { r: 4, c: 0 },
        ]);
    });

    test('lookSpans tile a rectangle with the interned looks', () => {
        expect([...sheet.lookSpans([9, 0, 12, 1])]).toEqual([
            { c0: 0, c1: 1, r0: 9, r1: 9, look: { fa: '0.00' } },
            { c0: 0, c1: 1, r0: 10, r1: 10, look: {} },
            { c0: 0, c1: 1, r0: 11, r1: 11, look: { fa: '0.00' } },
            { c0: 0, c1: 1, r0: 12, r1: 12, look: { fa: '@" pcs"' } },
        ]);
        const [first] = sheet.lookSpans([0, 0, 0, 0]);
        expect(first.look).toBe(sheet.look(0, 0));
    });
});

describe('engine/book/handle — extent', () => {
    test('joins the styled part with the cells', () => {
        const styled = { looks: [{ bl: 1 }], bands: [0, 0, 3, 1, 9, 1, 4, 0] } satisfies Partial<SheetContent>;
        const cells: Placed<CellContent>[] = [[20, 1, { v: 1 }]];
        expect(only(new Workbook(bookOf(sheetOf('a', styled)))).extent()).toEqual({ lastRow: 9, lastColumn: 3 });
        expect(only(new Workbook(bookOf(sheetOf('a', { cells })))).extent()).toEqual({ lastRow: 20, lastColumn: 1 });
        expect(only(new Workbook(bookOf(sheetOf('a', { ...styled, cells })))).extent()).toEqual({
            lastRow: 20,
            lastColumn: 3,
        });
        const far: Placed<CellContent>[] = [[2, 7, { v: 1 }]];
        expect(only(new Workbook(bookOf(sheetOf('a', { ...styled, cells: far })))).extent()).toEqual({
            lastRow: 9,
            lastColumn: 7,
        });
        expect(only(new Workbook(bookOf(sheetOf('a')))).extent()).toEqual({ lastRow: -1, lastColumn: -1 });
    });
});

// The places a random book's reads are checked at: a corner of the grid, every cell and record of the model, and
// the grid's last lines.
function placesOf(sheet: ModelSheet): [number, number][] {
    const places: [number, number][] = [];
    for (let row = 0; row < 16; row += 1) for (let column = 0; column < 10; column += 1) places.push([row, column]);
    for (const place of sheet.cells.keys()) {
        const [row, column] = place.split(',').map(Number);
        places.push([row, column]);
    }
    for (const { rect } of sheet.records.merge.values()) places.push([rect[0], rect[1]], [rect[2], rect[3]]);
    places.push([LAST_ROW, 0], [0, LAST_COLUMN], [LAST_ROW, LAST_COLUMN], [100_000, 3]);
    return places;
}

// A value the model holds for a cell with no formula, as the engine reads it.
function modelValue(cell: CellContent | undefined): ReturnType<Sheet['value']> {
    if (!cell) return null;
    if (cell.s) return textOf(cell.s);
    if (cell.e) return expect.objectContaining({ text: cell.v });
    return cell.v ?? null;
}

function expectSheetReads(sheet: Sheet, model: Model, modelSheet: ModelSheet): void {
    const content = contentOfModel(model).sheets.find(({ id }) => id === modelSheet.id);
    expect(sheet.fields).toEqual(modelSheet.fields);
    expect(sheet.lines('rows')).toEqual(content?.rows ?? []);
    expect(sheet.lines('columns')).toEqual(content?.columns ?? []);
    const { merge, validation, comment } = modelSheet.records;
    for (const type of ['merge', 'filter', 'comment', 'validation', 'image', 'chart'] as const) {
        expect(Object.fromEntries(sheet.records(type))).toEqual(Object.fromEntries(modelSheet.records[type]));
    }
    for (const [row, column] of placesOf(modelSheet)) {
        const held = modelSheet.cells.get(`${row},${column}`);
        const read = sheet.content(row, column);
        // The model holds a formula without its value: the engine says whether one is given.
        const { v: _, e: __, ...formula } = read ?? {};
        expect(read && read.f !== undefined ? formula : read).toEqual(held ?? null);
        expect(sheet.hasFormula(row, column)).toBe(held?.f !== undefined);
        if (held?.f === undefined) expect(sheet.value(row, column)).toEqual(modelValue(held));
        expect(sheet.look(row, column)).toEqual(model.looks[modelSheet.looks.look(row, column)]);
        expect(sheet.row(row)).toEqual(modelSheet.rows.get(row) ?? {});
        expect(sheet.column(column)).toEqual(modelSheet.columns.get(column) ?? {});
        const covering = [...merge.values()].find(({ rect }) => covers(rect, row, column));
        expect(sheet.merge(row, column)).toEqual(covering?.rect);
        const rules = [...validation].filter(([, { ranges }]) => ranges.some((range) => covers(range, row, column)));
        const last = rules.sort(([a, x], [b, y]) => compareRules(x.order, a, y.order, b)).at(-1);
        expect(sheet.validation(row, column)).toEqual(last?.[1]);
        const ids = [...comment].filter(([, at]) => at.row === row && at.column === column).map(([id]) => id);
        expect(sheet.comments(row, column)).toEqual(ids.sort());
    }
    for (const rect of [
        [0, 0, 3, 3],
        [4, 4, 12, 9],
        [0, 0, LAST_ROW, LAST_COLUMN],
    ] satisfies Rect[]) {
        const meeting = [...merge.values()].map(({ rect: at }) => at).filter((at) => meets(at, rect));
        expect(sheet.touchesMerge(rect)).toBe(meeting.length > 0);
        expect(sheet.mergesIn(rect)).toEqual(meeting.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    }
}

// The cells of a rectangle the engine holds, the model's way: one with a value, a formula or a rich text.
function modelValues(sheet: ModelSheet, [top, left, bottom, right]: Rect): { r: number; c: number }[] {
    const found: { r: number; c: number }[] = [];
    for (const [place, cell] of sheet.cells) {
        const [r, c] = place.split(',').map(Number);
        if (r < top || r > bottom || c < left || c > right) continue;
        if (cell.v !== undefined || cell.f !== undefined || cell.s !== undefined) found.push({ r, c });
    }
    return found.sort((a, b) => a.c - b.c || a.r - b.r);
}

// What the extent must say, worked out from the model: the styled part, joined with the last cell's row and column.
function modelExtent(sheet: ModelSheet): { lastRow: number; lastColumn: number } {
    const styled = sheet.looks.extent();
    let { lastRow, lastColumn } = styled;
    for (const { r, c } of modelValues(sheet, [0, 0, LAST_ROW, LAST_COLUMN])) {
        lastRow = Math.max(lastRow, r);
        lastColumn = Math.max(lastColumn, c);
    }
    return { lastRow, lastColumn };
}

describe('engine/book/handle — reads against the model', () => {
    test('every place of random books reads as the model says, after random record batches', () => {
        for (let seed = 1; seed <= 60; seed += 1) {
            const random = randomOf(seed);
            const content = randomBookContent(random);
            const book = new Workbook(content);
            let model = modelOf(content);
            for (let round = 0; round < 4; round += 1) {
                const handle = cellsOf(book);
                const tabs = [...model.sheets.values()].sort((a, b) =>
                    compareRules(a.fields.order, a.id, b.fields.order, b.id),
                );
                expect(handle.sheets().map(({ id }) => id)).toEqual(tabs.map(({ id }) => id));
                for (const modelSheet of tabs) {
                    const sheet = handle.sheet(modelSheet.id);
                    if (!sheet) throw new Error(`No sheet ${modelSheet.id}`);
                    expectSheetReads(sheet, model, modelSheet);
                    for (const rect of [
                        [0, 0, 5, 3],
                        [2, 1, 70, 40],
                        [0, 0, LAST_ROW, LAST_COLUMN],
                    ] satisfies Rect[]) {
                        expect([...sheet.values(rect)]).toEqual(modelValues(modelSheet, rect));
                    }
                    expect([...sheet.values()]).toEqual(modelValues(modelSheet, [0, 0, LAST_ROW, LAST_COLUMN]));
                    expect(sheet.extent()).toEqual(modelExtent(modelSheet));
                }
                const ops = batchOf(random, model, randomRecordOp);
                const expected = modelAfter(model, ops);
                try {
                    applyOps(book, ops.ops);
                    book.setClock(ops.now, ops.seed);
                } catch (error) {
                    if (!(error instanceof Refusal)) throw error;
                }
                // A refused batch that bound formulas before its refusal leaves them bound, so the model reads anew.
                model = typeof expected === 'string' ? modelOf(book.content()) : expected;
            }
        }
    });
});
