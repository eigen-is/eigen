import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import {
    BAND_WEIGHT,
    EXTRA_WEIGHT,
    MAX_RECORDS_PER_TYPE,
    MAX_STYLE_RUNS,
    MAX_VALUE_SLOTS,
} from '@workspace/lib/sheets/limits';
import type { Batch, FormatOp, InputOp, Op, RecordOp, Rect, Run, SheetContent } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { commutes, weightBound } from '../../../engine/book/commutes';
import { Workbook } from '../../../engine/book/workbook';
import {
    batchOf,
    randomBookContent,
    randomFormatOp,
    randomInputOp,
    randomLineReaderOp,
    randomRecordOp,
} from './batches';
import type { Book, Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { modelAfter, modelOf } from './model';

const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;
const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
const RICH: Run[] = [{ v: 'bold ', bl: 1 }, { v: 'plain' }];

function sheetOf(id: string, order: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// Two sheets; the first holds a linked cell at (4, 4), a rich cell at (5, 5), a filter with a column, a merge and a comment.
function twoSheets(part: Partial<SheetContent> = {}): Book {
    const a = sheetOf('a', 'a0', {
        cells: [
            [0, 0, { v: 1 }],
            [4, 4, { v: 'linked', link: LINK }],
            [5, 5, { s: RICH }],
        ],
        records: {
            merge: { m: { rect: [20, 0, 21, 1] } },
            filter: { f: { rect: [30, 0, 40, 3] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [] } },
            comment: { c: { row: 3, column: 1 } },
        },
        ...part,
    });
    return { g: 1, now: 45_000, seed: 3, computed: false, sheets: [a, sheetOf('b', 'a1')] };
}

function landed(book: Workbook, ops: readonly Op[]): Op[] | string {
    try {
        return applyOps(book, ops);
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
}

// Whether two answers of one batch apply alike: the same refusal, or inverses that give the same bytes, each applied
// to a copy of `book`. Their rectangles may differ, as they follow the band layout; equal ones apply alike.
function alike(book: Workbook, a: Op[] | string, b: Op[] | string): boolean {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
    const [x, y] = [a, b].map((ops) => {
        const copy = new Workbook(book.content());
        landed(copy, ops);
        return bytes(copy);
    });
    return x === y;
}

// The verdict for `late` against `applied` on a book that holds `applied`, and whether the two orders differ in
// their bytes, their refusals or what their inverses do.
function verdict(content: Book, late: readonly Op[], applied: readonly Op[]): { commutes: boolean; differ: boolean } {
    const tab = new Workbook(structuredClone(content));
    const inverse = landed(tab, applied);
    if (typeof inverse === 'string') throw new Error(`the applied batch was refused: ${inverse}`);
    const says = commutes(tab, late, applied, inverse);
    const onTop = landed(tab, late);
    const log = new Workbook(structuredClone(content));
    const first = landed(log, late);
    const second = landed(log, applied);
    const differ = bytes(tab) !== bytes(log) || !alike(log, first, onTop) || !alike(log, second, inverse);
    return { commutes: says, differ };
}

const input = (cells: InputOp['cells'], sheet = 'a'): InputOp => ({ kind: 'input', sheet, cells });
const format = (ranges: Rect[], set: Extract<FormatOp, { ranges: unknown }>['set'], sheet = 'a'): FormatOp => ({
    kind: 'format',
    sheet,
    ranges,
    set,
});
const clear = (ranges: Rect[], keys: Extract<FormatOp, { ranges: unknown }>['clear'], sheet = 'a'): FormatOp => ({
    kind: 'format',
    sheet,
    ranges,
    clear: keys,
});
const lineFormat = (lines: 'rows' | 'columns', first: number, last: number, set: object): FormatOp => ({
    kind: 'format',
    sheet: 'a',
    lines,
    spans: [[first, last]],
    set,
});
const merge = (id: string, rect: Rect, sheet = 'a'): RecordOp => ({
    kind: 'record',
    sheet,
    type: 'merge',
    id,
    set: { rect },
    whole: 1,
});
const comment = (id: string, row: number, column: number): RecordOp => ({
    kind: 'record',
    sheet: 'a',
    type: 'comment',
    id,
    set: { row, column },
    whole: 1,
});
const fields = (sheet: string, set: Extract<RecordOp, { type: 'sheet' }>['set']): RecordOp => ({
    kind: 'record',
    sheet,
    type: 'sheet',
    id: sheet,
    set,
});

describe('engine/book/commutes — commutes', () => {
    describe('the pairs that do not commute, each beside one that does', () => {
        // [name, late, applied, a late op beside it that does commute]
        const pairs: [string, Op, Op, Op][] = [
            ['two inputs on one cell', input([[2, 2, { v: 1 }]]), input([[2, 2, { v: 2 }]]), input([[3, 2, { v: 1 }]])],
            [
                'an input in the rectangle of another',
                input([[2, 2, { v: 1 }]]),
                { kind: 'input', sheet: 'a', runs: [[[1, 1, 4, 4], null]] },
                input([[5, 2, { v: 1 }]]),
            ],
            [
                'two input rectangles that meet',
                { kind: 'input', sheet: 'a', runs: [[[1, 1, 4, 4], { v: 3 }]] },
                { kind: 'input', sheet: 'a', runs: [[[4, 4, 6, 6], { v: 4 }]] },
                { kind: 'input', sheet: 'a', runs: [[[1, 1, 3, 4], { v: 3 }]] },
            ],
            [
                'rich text typed into a cell a format restyles',
                input([[2, 2, { s: RICH }]]),
                format([[0, 0, 9, 9]], { it: 1 }),
                input([[2, 2, { v: 'plain' }]]),
            ],
            [
                'a format that restyles a rich cell an input replaces',
                format([[0, 0, 9, 9]], { it: 1 }),
                input([[5, 5, { v: 'plain' }]]),
                format([[0, 0, 9, 9]], { bg: '#ff0000' }),
            ],
            [
                'an input on a cell whose link a format sets',
                input([[2, 2, { v: 1 }]]),
                format([[0, 0, 9, 9]], { link: LINK }),
                input([[2, 12, { v: 1 }]]),
            ],
            [
                'an input rectangle over a cell whose link a format clears',
                { kind: 'input', sheet: 'a', runs: [[[1, 1, 4, 4], { v: 3 }]] },
                clear([[4, 4, 4, 4]], ['link']),
                { kind: 'input', sheet: 'a', runs: [[[1, 1, 3, 4], { v: 3 }]] },
            ],
            [
                'two cell formats that share a cell and a key',
                format([[0, 0, 0, 1]], { bg: '#00ff00' }),
                format([[0, 1, 0, 2]], { bg: '#ff0000' }),
                format([[0, 0, 0, 0]], { bg: '#00ff00' }),
            ],
            [
                'a format that clears the key another sets',
                clear([[0, 0, 0, 1]], ['bl', 'bg', 'it']),
                format([[0, 1, 0, 1]], { bg: '#ff0000' }),
                clear([[0, 0, 0, 1]], ['bl', 'it']),
            ],
            [
                'two formats with run-style keys over one rich cell',
                format([[5, 5, 5, 5]], { bl: 1 }),
                format([[0, 0, 9, 9]], { it: 1 }),
                format([[4, 5, 4, 5]], { bl: 1 }),
            ],
            [
                'a link and a run-style key over one rich cell',
                format([[5, 5, 5, 5]], { link: LINK }),
                format([[0, 0, 9, 9]], { bl: 1 }),
                format([[4, 5, 4, 5]], { link: LINK }),
            ],
            [
                'two line formats that share a line and a key',
                lineFormat('rows', 2, 5, { size: 30 }),
                lineFormat('rows', 5, 8, { size: 40 }),
                lineFormat('columns', 2, 5, { size: 30 }),
            ],
            [
                'two record ops on one id',
                comment('c', 4, 4),
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9 } },
                comment('d', 4, 4),
            ],
            [
                'two merges on one sheet',
                merge('x', [0, 0, 2, 2]),
                merge('y', [1, 1, 3, 3]),
                merge('x', [0, 0, 2, 2], 'b'),
            ],
            [
                'two writes of a sheet name',
                fields('a', { name: 'New' }),
                fields('b', { name: 'new' }),
                fields('a', { color: '#123456' }),
            ],
            [
                'a new filter and a column of the live one',
                { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 3] }, whole: 1 },
                {
                    kind: 'record',
                    sheet: 'a',
                    type: 'filterColumn',
                    id: 'k2',
                    set: { filter: 'f', column: 2, rows: [] },
                    whole: 1,
                },
                {
                    kind: 'record',
                    sheet: 'a',
                    type: 'filterColumn',
                    id: 'k3',
                    set: { filter: 'f', column: 3, rows: [] },
                    whole: 1,
                },
            ],
            [
                'two filters on one sheet',
                { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 3] }, whole: 1 },
                { kind: 'record', sheet: 'a', type: 'filter', id: 'h', set: { rect: [0, 0, 5, 3] }, whole: 1 },
                { kind: 'record', sheet: 'b', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 3] }, whole: 1 },
            ],
            [
                'a sheet hidden while another is',
                fields('a', { hide: 1 }),
                fields('b', { hide: 1 }),
                fields('a', { color: '#1' }),
            ],
            [
                'a name written while a formula is typed',
                fields('b', { name: 'Later' }),
                input([[8, 8, { f: "='Later'!R1C1+1" }]]),
                fields('b', { order: 'a5' }),
            ],
        ];
        for (const [name, late, applied, beside] of pairs) {
            test(name, () => {
                expect(verdict(twoSheets(), [late], [applied]).commutes).toBe(false);
                expect(verdict(twoSheets(), [applied], [late]).commutes).toBe(false);
                expect(verdict(twoSheets(), [beside], [applied])).toEqual({ commutes: true, differ: false });
            });
        }

        test('the order of each such pair shows, in the bytes, a refusal or an inverse', () => {
            // A sheet hidden while another is refuses the applied batch itself in the log's order, which the door
            // never asks of a batch that landed; two input rectangles that meet show wherever they differ.
            const shown = pairs.filter(([name]) => name !== 'a sheet hidden while another is');
            for (const [name, late, applied] of shown) {
                const forward = verdict(twoSheets(), [late], [applied]).differ;
                const backward = verdict(twoSheets(), [applied], [late]).differ;
                expect(forward || backward, name).toBe(true);
            }
            // Either sheet may be hidden, never both: the second hide is refused, whichever it is.
            const book = new Workbook(twoSheets());
            expect(landed(book, [fields('a', { hide: 1 })])).not.toBe('last-sheet');
            expect(landed(book, [fields('b', { hide: 1 })])).toBe('last-sheet');
        });

        test.each<[string, Op]>([
            ['lines', { kind: 'lines', sheet: 'b', rows: true, insert: true, index: 0, count: 1 }],
            ['move', { kind: 'move', sheet: 'b', from: [0, 0, 1, 1], toSheet: 'b', toRow: 4, toColumn: 4 }],
            ['sheet', { kind: 'sheet', add: sheetOf('n', 'a7') }],
        ])('a %s op on either side, against anything', (_, op) => {
            const book = new Workbook(twoSheets());
            const other = input([[50, 50, { v: 1 }]]);
            expect(commutes(book, [op], [other], [])).toBe(false);
            expect(commutes(book, [other], [op], [])).toBe(false);
            expect(commutes(book, [other], [], [op])).toBe(false);
            expect(commutes(book, [op], [], [])).toBe(false);
            expect(commutes(book, [other], [], [])).toBe(true);
        });

        test('a cell that was rich when the applied format landed, and one an applied input made plain', () => {
            // The format restyled the runs, so the late input's inverse holds them restyled.
            expect(
                verdict(twoSheets(), [input([[5, 5, { v: 1 }]])], [format([[5, 5, 5, 5]], { it: 1 })]).commutes,
            ).toBe(false);
            // The applied input took the runs away: its inverse holds them, and the late format would restyle them.
            const tab = new Workbook(twoSheets());
            const applied = [input([[5, 5, { v: 1 }]])];
            const inverse = applyOps(tab, applied);
            expect(commutes(tab, [format([[5, 5, 5, 5]], { it: 1 })], applied, inverse)).toBe(false);
            expect(commutes(tab, [format([[5, 5, 5, 5]], { it: 1 })], applied, [])).toBe(true);
        });
    });

    describe('pairs that commute', () => {
        test.each<[string, Op, Op]>([
            [
                'overlapping formats with different keys',
                format([[0, 0, 2, 2]], { bl: 1 }),
                format([[1, 1, 3, 3]], { bg: '#ff0000' }),
            ],
            [
                'hidden rows and the rows of a filter column',
                lineFormat('rows', 2, 5, { hidden: 1 }),
                { kind: 'record', sheet: 'a', type: 'filterColumn', id: 'k', set: { rows: [[4, 8]] } },
            ],
            ['two comments on one cell', comment('x', 4, 4), comment('y', 4, 4)],
            [
                'an input and a look over it',
                input([[2, 2, { v: 1 }]]),
                format([[0, 0, 9, 9]], { bl: 1, bg: '#ff0000' }),
            ],
            [
                'plain typing where a format restyles runs elsewhere',
                input([[2, 2, { v: 1 }]]),
                format([[0, 0, 9, 9]], { it: 1 }),
            ],
            [
                'a row size and a column size',
                lineFormat('rows', 2, 5, { size: 30 }),
                lineFormat('columns', 2, 5, { size: 30 }),
            ],
            [
                'a row size and a hidden row',
                lineFormat('rows', 2, 5, { size: 30 }),
                lineFormat('rows', 2, 5, { hidden: 1 }),
            ],
            ['the tab order of two sheets', fields('a', { order: 'a8' }), fields('b', { order: 'a9' })],
            ['one sheet hidden and another recolored', fields('a', { hide: 1 }), fields('b', { color: '#123456' })],
            ['inputs on two sheets', input([[2, 2, { v: 1 }]]), input([[2, 2, { v: 2 }]], 'b')],
            ['a merge and an input in it', merge('x', [0, 0, 2, 2]), input([[1, 1, { v: 2 }]])],
        ])('%s', (_, late, applied) => {
            expect(verdict(twoSheets(), [late], [applied])).toEqual({ commutes: true, differ: false });
            expect(verdict(twoSheets(), [applied], [late])).toEqual({ commutes: true, differ: false });
        });
    });

    describe('the limits', () => {
        const tall = (rows: number): SheetContent['cells'] => [[rows - 1, 0, { v: 1 }]];

        test('a late input that may pass the cell limit does not commute, at the exact slot', () => {
            // Three full columns and one that is `room` short of the limit.
            const full: SheetContent['cells'] = [1, 2, 3].map((column) => [LAST_ROW, column, { v: 1 }]);
            const short = MAX_VALUE_SLOTS - 3 * GRID_ROWS - 10;
            const book = new Workbook(twoSheets({ cells: [...tall(short), ...full] }));
            expect(book.weight().slots).toBe(MAX_VALUE_SLOTS - 10);
            expect(commutes(book, [input([[short + 9, 0, { v: 1 }]])], [], [])).toBe(true);
            expect(commutes(book, [input([[short + 10, 0, { v: 1 }]])], [], [])).toBe(false);
            // An inverse that may grow a column counts too: log order passes through the state without the batch.
            expect(commutes(book, [input([[5, 0, { v: 1 }]])], [], [input([[short + 10, 0, { v: 1 }]])])).toBe(false);
            // A column is counted once, at the longest any op makes it, and an emptied cell adds nothing.
            const twice = [input([[short + 4, 0, { v: 1 }]]), input([[short + 9, 0, { v: 1 }]])];
            expect(commutes(book, twice, [], [])).toBe(true);
            expect(commutes(book, [input([[LAST_ROW, 0, null]])], [], [])).toBe(true);
            expect(commutes(book, [{ kind: 'input', sheet: 'a', runs: [[[0, 4, 9, 4], { v: 1 }]] }], [], [])).toBe(
                true,
            );
            expect(commutes(book, [{ kind: 'input', sheet: 'a', runs: [[[0, 4, 10, 4], { v: 1 }]] }], [], [])).toBe(
                false,
            );
        });

        test('a late format that may pass the format limit does not commute', () => {
            // One band of stripes down to the limit less a little: a cut copies them.
            const stripes = 1_300_000;
            const bands = [0, stripes / 2];
            for (let row = 0; row < stripes; row += 2) bands.push(row, row % 4 === 0 ? 1 : 0);
            const book = new Workbook(twoSheets({ looks: [{ bl: 1 }], bands }));
            const { runs } = book.weight();
            expect(runs).toBe(stripes / 2);
            // A whole-row format writes the one band: three runs. A cell cuts it twice: two copies.
            expect(commutes(book, [format([[3, 0, 3, LAST_COLUMN]], { it: 1 })], [], [])).toBe(true);
            expect(runs + 2 * runs + 3 + 3 * BAND_WEIGHT).toBeLessThan(MAX_STYLE_RUNS);
            expect(commutes(book, [format([[3, 4, 3, 4]], { it: 1 })], [], [])).toBe(true);
            const cells = [4, 8, 12].map((column): Rect => [3, column, 3, column]);
            expect(runs + 6 * runs).toBeGreaterThan(MAX_STYLE_RUNS);
            expect(commutes(book, [format(cells, { it: 1 })], [], [])).toBe(false);
            expect(commutes(book, [input([[0, 0, { v: 1 }]])], [], [format(cells, { it: 1 })])).toBe(false);
            // A link writes no look, so it cuts no band.
            expect(commutes(book, [format(cells, { link: LINK })], [], [])).toBe(true);
        });

        test('rich text and links that may pass the format limit do not commute', () => {
            const book = new Workbook(twoSheets());
            const room = (MAX_STYLE_RUNS - book.weight().extras * EXTRA_WEIGHT) / EXTRA_WEIGHT;
            // A link over a block weighs five units a cell.
            const side = Math.floor(Math.sqrt(room / 5));
            expect(commutes(book, [format([[100, 0, 100 + side - 2, side - 1]], { link: LINK })], [], [])).toBe(true);
            expect(commutes(book, [format([[100, 0, 100 + side, side]], { link: LINK })], [], [])).toBe(false);
            expect(commutes(book, [clear([[100, 0, 100 + side, side]], ['link'])], [], [])).toBe(true);
            const runs: Run[] = Array.from({ length: 998 }, (_, at) => ({ v: `${at}` }));
            const many = (count: number): InputOp =>
                input(Array.from({ length: count }, (_, row): [number, number, { s: Run[] }] => [row, 9, { s: runs }]));
            expect(commutes(book, [many(Math.floor(room / 1000) - 1)], [], [])).toBe(true);
            expect(commutes(book, [many(Math.floor(room / 1000) + 1)], [], [])).toBe(false);
            const filled: InputOp = {
                kind: 'input',
                sheet: 'a',
                runs: [[[0, 9, Math.floor(room / 1000), 9], { s: runs }]],
            };
            expect(commutes(book, [filled], [], [])).toBe(false);
        });

        test('a late record that may pass the record limit does not commute', () => {
            const comments: Record<string, { row: number; column: number }> = {};
            for (let at = 0; at < MAX_RECORDS_PER_TYPE - 1; at += 1) comments[`c${at}`] = { row: at, column: 0 };
            const book = new Workbook(twoSheets({ records: { comment: comments } }));
            expect(commutes(book, [comment('x', 4, 4)], [], [])).toBe(true);
            expect(commutes(book, [comment('x', 4, 4), comment('y', 4, 4)], [], [])).toBe(false);
            expect(commutes(book, [comment('x', 4, 4)], [], [comment('y', 4, 4)])).toBe(false);
            // An op that changes or deletes a record adds none.
            const change: RecordOp = { kind: 'record', sheet: 'a', type: 'comment', id: 'c1', set: { row: 9 } };
            expect(
                commutes(
                    book,
                    [comment('x', 4, 4), change, { kind: 'record', sheet: 'a', type: 'comment', id: 'c2' }],
                    [],
                    [],
                ),
            ).toBe(true);
        });
    });

    describe('the laws, over random batches', () => {
        const draw = (random: Random, model: Model): Op =>
            [randomInputOp, randomFormatOp, randomRecordOp, randomLineReaderOp][below(random, 4)](random, model);
        const land = (book: Workbook, batch: Batch) => {
            const inverse = landed(book, batch.ops);
            if (typeof inverse !== 'string') book.setClock(batch.now, batch.seed);
            return inverse;
        };

        test('whenever it says yes, both orders give the same bytes and refusals, and inverses that apply alike', () => {
            const seen = { yes: 0, no: 0, refusedBoth: 0, skipped: 0 };
            const together = new Set<string>();
            for (let seed = 1; seed <= 2500; seed += 1) {
                const random = randomOf(seed * 32_452_843);
                const content = randomBookContent(random);
                const start = modelOf(content);
                const tab = new Workbook(structuredClone(content));
                const late = batchOf(random, start, draw, 2);
                let model = start;
                const applied: Batch[] = [];
                const inverses: Op[][] = [];
                for (let n = 1 + below(random, 2); n > 0; n -= 1) {
                    const batch = batchOf(random, model, draw, 2);
                    const inverse = land(tab, batch);
                    const after = modelAfter(model, batch);
                    // The door only asks about batches that landed.
                    if (typeof inverse === 'string' || typeof after === 'string') continue;
                    model = after;
                    applied.push(batch);
                    inverses.push(inverse);
                }
                if (applied.length === 0) {
                    seen.skipped += 1;
                    continue;
                }
                const ops = applied.flatMap((batch) => batch.ops);
                // The ring's inverses, the newest batch's first.
                if (!commutes(tab, late.ops, ops, inverses.toReversed().flat())) {
                    seen.no += 1;
                    continue;
                }
                seen.yes += 1;
                const onTop = land(tab, late);
                const log = new Workbook(structuredClone(content));
                const lateBack = land(log, late);
                if (typeof onTop === 'string') seen.refusedBoth += 1;
                const backs = applied.map((batch) => land(log, batch));
                const last = applied[applied.length - 1];
                tab.setClock(last.now, last.seed);
                expect(bytes(tab), `seed ${seed}`).toBe(bytes(log));
                expect(alike(log, lateBack, onTop), `seed ${seed}: the late batch`).toBe(true);
                for (const [at, back] of backs.entries()) {
                    expect(alike(log, back, inverses[at]), `seed ${seed}: applied batch ${at}`).toBe(true);
                }
                for (const a of late.ops) {
                    for (const b of ops)
                        if ('sheet' in a && 'sheet' in b && a.sheet === b.sheet) together.add(`${a.kind} ${b.kind}`);
                }
            }
            expect(seen.yes).toBeGreaterThan(1000);
            expect(seen.no).toBeGreaterThan(250);
            expect(seen.refusedBoth).toBeGreaterThan(0);
            expect([...together].sort()).toEqual([
                'format format',
                'format input',
                'format record',
                'input format',
                'input input',
                'input record',
                'record format',
                'record input',
                'record record',
            ]);
        }, 60_000);

        test('the bound never counts less than the ops add, in any part of them', () => {
            let grew = 0;
            let exact = 0;
            const sums = { added: 0, bound: 0 };
            for (let seed = 1; seed <= 1500; seed += 1) {
                const random = randomOf(seed * 49_979_687);
                const content = randomBookContent(random);
                const model = modelOf(content);
                const book = new Workbook(structuredClone(content));
                const ops = Array.from({ length: 1 + below(random, 6) }, () => draw(random, model));
                const bound = weightBound(book, ops);
                const before = book.weight();
                for (const op of ops) {
                    // Each op alone, so a refused one leaves the rest to land: any part of the list.
                    landed(book, [op]);
                    const after = book.weight();
                    for (const key of ['slots', 'runs', 'bands', 'extras', 'records', 'sheets'] as const) {
                        expect(after[key], `seed ${seed} ${key}`).toBeLessThanOrEqual(bound[key]);
                    }
                }
                const after = book.weight();
                const added = (key: 'slots' | 'runs' | 'bands' | 'extras') => Math.max(0, after[key] - before[key]);
                const most = (key: 'slots' | 'runs' | 'bands' | 'extras') => bound[key] - before[key];
                if (added('slots') + added('runs') + added('extras') > 0) grew += 1;
                if (added('slots') === most('slots') && most('slots') > 0) exact += 1;
                sums.added += added('runs') + added('bands') * BAND_WEIGHT + added('extras') * EXTRA_WEIGHT;
                sums.bound += most('runs') + most('bands') * BAND_WEIGHT + most('extras') * EXTRA_WEIGHT;
            }
            expect(grew).toBeGreaterThan(700);
            expect(exact).toBeGreaterThan(50);
            // The format bound counts a few times what random ops add.
            expect(sums.bound / sums.added).toBeLessThan(12);
        }, 60_000);
    });
});
