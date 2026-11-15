import { describe, expect, test } from 'bun:test';
import { GRID_ROWS } from '@workspace/formula/text';
import { MAX_STYLE_RUNS } from '@workspace/lib/sheets/limits';
import type { Batch, RecordOp, SheetContent } from '@workspace/lib/sheets/ops';
import { readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, LATER, randomBookContent, randomRecordOp } from './batches';
import type { BookContent } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { expectReads, modelAfter, modelOf } from './model';

type RecordBatch = Omit<Batch, 'ops'> & { ops: RecordOp[] };

const LAST_ROW = GRID_ROWS - 1;
// A sheet id as long as an id may be, so a formula bound to it grows.
const B = 'b'.repeat(60);

// A batch as a host lands it: the ops, then the clock of the batch, which a refused batch never reaches.
function land(book: Workbook, batch: RecordBatch): RecordOp[] {
    const inverse = applyOps(book, batch.ops);
    book.setClock(batch.now, batch.seed);
    return inverse;
}

function refusalOf(run: () => unknown): RefusalKey | undefined {
    try {
        run();
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
    return undefined;
}

function batch(...ops: RecordOp[]): RecordBatch {
    return { g: 1, now: 46_000.25, seed: 99, ops };
}

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// Two sheets, the second hidden, with a merge, a filter with a column, a comment, formulas that read the clock, draw,
// read the other sheet and wait for a sheet named N, the last so long that the id of the second sheet does not fit it.
function twoSheets(): BookContent {
    const long = `="${'a'.repeat(131_010)}"&'N'!R1C1`;
    const a = sheetOf('a', {
        cells: [
            [0, 0, { v: 2 }],
            [1, 0, { f: '=NOW()' }],
            [2, 0, { f: '=RAND()' }],
            [3, 0, { f: `=[${B}]!R1C1*2` }],
            [4, 0, { f: long }],
        ],
        looks: [{ bl: 1 }],
        bands: [0, 1, 2, 1],
        rows: [[[1, 2], { size: 30 }]],
        records: {
            merge: { m: { rect: [5, 5, 6, 6] } },
            filter: { f: { rect: [8, 0, 20, 4] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [[9, 10]] } },
            comment: { c: { row: 3, column: 1 } },
        },
    });
    const b = sheetOf(B, { fields: { name: 'Second', order: 'a1', hide: 1 }, cells: [[0, 0, { v: 21 }]] });
    return { g: 3, now: 45_000.5, seed: 7, sheets: [a, b] };
}

// Ops that land on `twoSheets`, each of which changes its bytes, and the later ones what the earlier ones wrote.
const LANDING: readonly RecordOp[] = [
    { kind: 'record', sheet: B, type: 'sheet', id: B, set: { name: 'Renamed', order: 'Zz' } },
    { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 5 } },
    { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9 } },
    { kind: 'record', sheet: 'a', type: 'filter', id: 'f2', set: { rect: [0, 0, 3, 3] }, whole: 1 },
    {
        kind: 'record',
        sheet: 'a',
        type: 'filterColumn',
        id: 'k2',
        set: { filter: 'f2', column: 0, rows: [] },
        whole: 1,
    },
];
const TRAILING: RecordOp = { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { color: '#ff0000' } };
const REFUSED: readonly [RefusalKey, RecordOp][] = [
    ['merge-overlap', { kind: 'record', sheet: 'a', type: 'merge', id: 'm2', set: { rect: [6, 6, 7, 7] }, whole: 1 }],
    ['last-sheet', { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { hide: 1 } }],
    ['key-too-long', { kind: 'record', sheet: B, type: 'sheet', id: B, set: { name: 'N' } }],
];

describe('engine/book/apply-ops — LAW 1: a refused batch leaves the bytes as they were', () => {
    for (const [key, refused] of REFUSED) {
        for (let k = 0; k <= LANDING.length; k += 1) {
            test(`${key} at op ${k}, after ${k} ops landed`, () => {
                const content = twoSheets();
                const book = new Workbook(content);
                const before = bytes(book);
                expect(refusalOf(() => land(book, batch(...LANDING.slice(0, k), refused, TRAILING)))).toBe(key);
                expect(bytes(book)).toBe(before);
                expectReads(book, modelOf(content));
                // The same ops without the refused one do land, so the refusal took something back.
                const other = new Workbook(content);
                land(other, batch(...LANDING.slice(0, k), TRAILING));
                expect(bytes(other)).not.toBe(before);
            });
        }
    }

    for (let k = 0; k <= LANDING.length; k += 1) {
        test(`too-many-cells at the weigh, after ${k} ops landed`, () => {
            const book = new Workbook(twoSheets());
            // Past the limit without an op, as no kind that writes cells is built yet.
            for (let column = 1; column <= 4; column += 1) book.engine.setValue('a', LAST_ROW, column, 1);
            const before = bytes(book);
            expect(refusalOf(() => land(book, batch(...LANDING.slice(0, k))))).toBe('too-many-cells');
            expect(bytes(book)).toBe(before);
        });
    }

    test('too-many-formats at the weigh', () => {
        // Four bands of runs, no two neighbours alike, weigh the limit to the run with the other sheet's one band.
        const runs = (MAX_STYLE_RUNS - 5 * 32) / 4;
        const bands = Array.from({ length: 4 }, (_, band) => [
            band,
            runs,
            ...Array.from({ length: runs }, (_, row) => [row, 1 + ((row + band) % 2)]).flat(),
        ]).flat();
        const content = twoSheets();
        content.sheets[0] = { ...content.sheets[0], looks: [{ bl: 1 }, { it: 1 }], bands };
        const book = new Workbook(content);
        const state = () => JSON.stringify(book.content().sheets.map(({ fields, records }) => [fields, records]));
        // A book at the limit takes a batch, and one band more takes none.
        expect(refusalOf(() => land(book, batch(LANDING[0])))).toBeUndefined();
        book.sheets.get('a')?.bands.format([0, 9, 0, 9], () => 0);
        const before = state();
        expect(refusalOf(() => land(book, batch(...LANDING.slice(1))))).toBe('too-many-formats');
        expect(state()).toBe(before);
    });

    test('a refused batch leaves the clock, which a landed one moves', () => {
        const book = new Workbook(twoSheets());
        bytes(book);
        const drawn = book.engine.valueOf('a', 2, 0);
        expect(refusalOf(() => land(book, batch(LANDING[1], REFUSED[0][1])))).toBe('merge-overlap');
        bytes(book);
        expect(book.content()).toMatchObject({ now: 45_000.5, seed: 7 });
        expect(book.engine.valueOf('a', 1, 0)).toBe(45_000.5);
        expect(book.engine.valueOf('a', 2, 0)).toBe(drawn);

        land(book, batch(LANDING[1]));
        bytes(book);
        expect(book.content()).toMatchObject({ now: 46_000.25, seed: 99 });
        expect(book.engine.valueOf('a', 1, 0)).toBe(46_000.25);
        expect(book.engine.valueOf('a', 2, 0)).not.toBe(drawn);
    });

    test('a clock the engine does not take leaves the book’s clock as it was', () => {
        const book = new Workbook(twoSheets());
        expect(() => book.setClock(Number.NaN, 1)).toThrow(RangeError);
        expect(() => book.setClock(1, 0.5)).toThrow(RangeError);
        expect(book.content()).toMatchObject({ now: 45_000.5, seed: 7 });
    });
});

describe('engine/book/apply-ops — the inverse batch', () => {
    test('it holds the inverse of every op, the newest first, in one list', () => {
        const book = new Workbook(twoSheets());
        expect(applyOps(book, LANDING.slice(1, 4))).toEqual([
            { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [8, 0, 20, 4] }, whole: 1 },
            {
                kind: 'record',
                sheet: 'a',
                type: 'filterColumn',
                id: 'k',
                set: { filter: 'f', column: 1, rows: [[9, 10]] },
                whole: 1,
            },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 5 } },
            { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 3 } },
        ]);
    });

    test('a batch of no op and a batch of skipped ops have no inverse', () => {
        const book = new Workbook(twoSheets());
        const before = bytes(book);
        expect(applyOps(book, [])).toEqual([]);
        expect(applyOps(book, [{ kind: 'record', sheet: 'gone', type: 'comment', id: 'c' }])).toEqual([]);
        expect(applyOps(book, [{ kind: 'record', sheet: 'a', type: 'comment', id: 'gone', set: { row: 1 } }])).toEqual(
            [],
        );
        expect(bytes(book)).toBe(before);
    });

    test('LAW 2 on the ops that land: the inverse restores the bytes, and its inverse the bytes after', () => {
        const content = twoSheets();
        const book = new Workbook(content);
        const before = bytes(book);
        const inverse = land(book, batch(...LANDING, TRAILING));
        const after = bytes(book);
        expect(after).not.toBe(before);
        const again = applyOps(book, inverse);
        book.setClock(content.now, content.seed);
        expect(bytes(book)).toBe(before);
        land(book, batch(...again));
        expect(bytes(book)).toBe(after);
    });
});

describe('engine/book/apply-ops — the look sweep', () => {
    const wearUnused = (book: Workbook) => {
        for (let i = 0; i < 100; i += 1) book.looks.intern({ fs: 100 + i });
    };

    test('a batch that lands ends with a sweep', () => {
        const book = new Workbook(twoSheets());
        wearUnused(book);
        applyOps(book, [LANDING[1]]);
        expect(book.looks.size).toBe(2);
    });

    test('a batch that is refused ends with a sweep', () => {
        const book = new Workbook(twoSheets());
        wearUnused(book);
        expect(refusalOf(() => applyOps(book, [LANDING[1], REFUSED[0][1]]))).toBe('merge-overlap');
        expect(book.looks.size).toBe(2);
    });
});

// A rename to the name a formula was typed with rewrites that formula, which the inverse must put back with an
// `input` op: until that kind is built, such a batch is held to the model only.
function binds(ops: readonly RecordOp[]): boolean {
    return ops.some((op) => op.type === 'sheet' && op.set.name === LATER);
}

describe('engine/book/apply-ops — the laws over random books and random batches of records', () => {
    test('LAW 1, LAW 2 and law 8', () => {
        const refusedAt = new Map<string, number>();
        let landed = 0;
        let undone = 0;
        for (let seed = 1; seed <= 400; seed += 1) {
            const random = randomOf(seed);
            const content = randomBookContent(random);
            const book = new Workbook(content);
            let model: Model = modelOf(content);
            for (let round = 0; round < 8; round += 1) {
                const ops = batchOf(random, model, randomRecordOp);
                const before = bytes(book);
                const clock = model;
                const expected = modelAfter(model, ops);
                if (typeof expected === 'string') {
                    // The first op the model refuses, with every op before it landed.
                    const at = ops.ops.findIndex(
                        (_, k) => typeof modelAfter(model, { ...ops, ops: ops.ops.slice(0, k + 1) }) === 'string',
                    );
                    refusedAt.set(`${expected} ${at}`, (refusedAt.get(`${expected} ${at}`) ?? 0) + 1);
                    expect(refusalOf(() => land(book, ops))).toBe(expected);
                    if (!binds(ops.ops.slice(0, at))) expect(bytes(book)).toBe(before);
                    else model = modelOf(book.content());
                    expectReads(book, model);
                    continue;
                }
                const inverse = land(book, ops);
                landed += 1;
                expectReads(book, expected);
                model = expected;
                if (binds(ops.ops)) continue;
                const after = bytes(book);
                const text = JSON.stringify({ ...ops, ops: inverse });
                expect(readBatch(text)).toEqual(JSON.parse(text));
                const again = applyOps(book, inverse);
                book.setClock(clock.now, clock.seed);
                expect(bytes(book)).toBe(before);
                land(book, { ...ops, ops: again });
                expect(bytes(book)).toBe(after);
                undone += 1;
            }
        }
        expect(landed).toBeGreaterThan(1500);
        expect(undone).toBeGreaterThan(1400);
        for (const key of ['merge-overlap', 'last-sheet']) {
            for (let k = 0; k < 4; k += 1) expect(refusedAt.get(`${key} ${k}`) ?? 0).toBeGreaterThan(0);
        }
    });
});
