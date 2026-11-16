import { describe, expect, test } from 'bun:test';
import type {
    CellAttrs,
    CellContent,
    FormatOp,
    InputOp,
    LineAttrs,
    Op,
    RecordOp,
    Rect,
    Run,
    SheetContent,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { names, RUN_KEYS } from '../../../engine/book/apply-format';
import { cellAt } from '../../../engine/book/apply-input';
import { applyOps } from '../../../engine/book/apply-ops';
import { stillHolding } from '../../../engine/book/still-holding';
import { Workbook } from '../../../engine/book/workbook';
import { LATER, randomBookContent, randomFormatOp, randomInputOp, randomLineReaderOp, randomRecordOp } from './batches';
import type { Book, Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { modelAfter, modelOf } from './model';

const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
// Runs that disagree on bold, so a format of bold cannot say them back.
const RICH: Run[] = [{ v: 'bold ', bl: 1 }, { v: 'plain' }];

function sheetOf(id: string, order: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function twoSheets(): Book {
    const a = sheetOf('a', 'a0', {
        cells: [
            [0, 0, { v: 1 }],
            [1, 0, { v: 2 }],
            [5, 5, { s: RICH }],
        ],
        records: {
            filter: { f: { rect: [30, 0, 40, 3] } },
            filterColumn: { k: { filter: 'f', column: 1, rows: [] } },
            comment: { c: { row: 3, column: 1 } },
            image: { i: { index: 'a0', x: 1, y: 2, width: 30, height: 40, mediaName: 'i.png' } },
        },
    });
    return { g: 1, now: 45_000, seed: 3, computed: false, sheets: [a, sheetOf('b', 'a1')] };
}

// A book after `written`, with its inverse, then after the peers' ops.
function edited(written: readonly Op[], ...peers: Op[]): { book: Workbook; apply: Op[]; before: string } {
    const book = new Workbook(twoSheets());
    const before = bytes(book);
    const apply = applyOps(book, written);
    for (const op of peers) applyOps(book, [op]);
    return { book, apply, before };
}

const input = (cells: InputOp['cells'], sheet = 'a'): InputOp => ({ kind: 'input', sheet, cells });
const format = (ranges: Rect[], set: Extract<FormatOp, { ranges: unknown }>['set'], sheet = 'a'): FormatOp => ({
    kind: 'format',
    sheet,
    ranges,
    set,
});
const rows = (first: number, last: number, set: LineAttrs): FormatOp => ({
    kind: 'format',
    sheet: 'a',
    lines: 'rows',
    spans: [[first, last]],
    set,
});
const contentAt = (book: Workbook, row: number, column: number, sheet = 'a') => {
    const part = book.sheets.get(sheet);
    return part ? cellAt(book, sheet, part.extras, row, column) : undefined;
};
const lookAt = (book: Workbook, row: number, column: number) => {
    const part = book.sheets.get('a');
    return part ? book.looks.look(part.bands.look(row, column)) : undefined;
};

describe('engine/book/still-holding — stillHolding', () => {
    describe('nothing changed since the edit', () => {
        test('the inverse comes back as it is, for every kind of op', () => {
            const written: Op[] = [
                format([[0, 0, 9, 9]], { bl: 1, link: LINK }),
                input([
                    [0, 0, { v: 5 }],
                    [2, 2, { f: '=R1C1+1' }],
                    [3, 3, { f: "='[b.xlsx]S'!R1C1" }],
                    [4, 4, { f: '=R[1]C+1', v: 5 }],
                ]),
                { kind: 'input', sheet: 'a', runs: [[[10, 0, 14, 2], { v: 7 }]] },
                rows(2, 5, { size: 30, hidden: 1 }),
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9 } },
                { kind: 'record', sheet: 'a', type: 'comment', id: 'd', set: { row: 1, column: 1 }, whole: 1 },
                { kind: 'record', sheet: 'a', type: 'image', id: 'i' },
                { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 3] }, whole: 1 },
                { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { color: '#123456', hide: 1 } },
            ];
            const { book, apply, before } = edited(written);
            const held = stillHolding(book, apply, written);
            expect(held).toEqual(apply);
            applyOps(book, held);
            expect(bytes(book)).toBe(before);
        });

        test('an inverse that holds a structural op comes back whole, whatever a peer wrote', () => {
            const written: Op[] = [
                input([[0, 0, { v: 5 }]]),
                { kind: 'lines', sheet: 'a', rows: true, insert: false, index: 1, count: 1 },
            ];
            const { book, apply } = edited(written, input([[0, 0, { v: 'peer' }]]));
            expect(stillHolding(book, apply, written)).toEqual(apply);
        });

        test('an op on a sheet that is gone leaves the inverse', () => {
            const written: Op[] = [input([[0, 0, { v: 5 }]], 'b'), input([[0, 0, { v: 5 }]])];
            const { book, apply } = edited(written, { kind: 'sheet', delete: 'b' });
            expect(stillHolding(book, apply, written)).toEqual([input([[0, 0, { v: 1 }]])]);
        });

        test('a change or delete of a filter that is no longer the live one wrote nothing: the old filter comes back', () => {
            const lates: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [13, 3, 20, 3] } },
                { kind: 'record', sheet: 'a', type: 'filter', id: 'f' },
            ];
            for (const late of lates) {
                const written: RecordOp[] = [
                    { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 5, 3] }, whole: 1 },
                    late,
                ];
                const { book, apply, before } = edited(written);
                const held = stillHolding(book, apply, written);
                expect(held).toEqual(apply);
                applyOps(book, held);
                expect(bytes(book)).toBe(before);
            }
        });
    });

    describe('content', () => {
        test('my listed cell inside my run: it holds what the cell said, and a peer’s typing cuts both', () => {
            const written: Op[] = [
                { kind: 'input', sheet: 'a', runs: [[[0, 2, 3, 3], { v: 7 }]], cells: [[1, 3, { v: 9 }]] },
            ];
            const whole = edited(written);
            expect(stillHolding(whole.book, whole.apply, written)).toEqual(whole.apply);
            applyOps(whole.book, whole.apply);
            expect(bytes(whole.book)).toBe(whole.before);

            const { book, apply } = edited(written, input([[1, 3, { v: 'peer' }]]));
            const held = stillHolding(book, apply, written);
            expect(JSON.stringify(held)).not.toContain('[1,3,');
            applyOps(book, held);
            expect([contentAt(book, 1, 3), contentAt(book, 1, 2), contentAt(book, 3, 3)]).toEqual([
                { v: 'peer' },
                null,
                null,
            ]);
        });

        test('a cell a peer typed into leaves the inverse, and the others stay', () => {
            const written = [
                input([
                    [0, 0, { v: 5 }],
                    [1, 0, { v: 6 }],
                ]),
            ];
            const { book, apply } = edited(written, input([[1, 0, { v: 'peer' }]]));
            const held = stillHolding(book, apply, written);
            expect(held).toEqual([input([[0, 0, { v: 1 }]])]);
            applyOps(book, held);
            expect([contentAt(book, 0, 0), contentAt(book, 1, 0)]).toEqual([{ v: 1 }, { v: 'peer' }]);
        });

        test('a peer’s typing in one cell of my run cuts the run around it, into four rectangles', () => {
            const written: Op[] = [{ kind: 'input', sheet: 'a', runs: [[[10, 2, 19, 8], { v: 7 }]] }];
            const { book, apply } = edited(written, input([[14, 5, { v: 'peer' }]]));
            expect(apply).toEqual([{ kind: 'input', sheet: 'a', runs: [[[10, 2, 19, 8], null]] }]);
            const held = stillHolding(book, apply, written);
            expect(held).toEqual([
                {
                    kind: 'input',
                    sheet: 'a',
                    runs: [
                        [[10, 2, 19, 4], null],
                        [[10, 5, 13, 5], null],
                        [[15, 5, 19, 5], null],
                        [[10, 6, 19, 8], null],
                    ],
                },
            ]);
            applyOps(book, held);
            expect(contentAt(book, 14, 5)).toEqual({ v: 'peer' });
            expect([contentAt(book, 13, 5), contentAt(book, 15, 5), contentAt(book, 14, 4)]).toEqual([
                null,
                null,
                null,
            ]);
        });

        test('a peer who typed what I typed changed nothing: the cell goes back', () => {
            const written = [input([[0, 0, { v: 5 }]])];
            const { book, apply } = edited(written, input([[0, 0, { v: 5 }]]));
            expect(stillHolding(book, apply, written)).toEqual(apply);
        });

        test('a peer’s link on a cell I typed into leaves my undo of that cell', () => {
            const written = [input([[0, 0, { v: 5 }]])];
            const { book, apply } = edited(written, format([[0, 0, 0, 0]], { link: LINK }));
            expect(stillHolding(book, apply, written)).toEqual([]);
        });

        test('a cell of the last op of the edit that wrote it: an earlier op’s content does not count', () => {
            const written = [input([[0, 0, { v: 5 }]]), input([[0, 0, { v: 6 }]])];
            const { book, apply } = edited(written);
            expect(stillHolding(book, apply, written)).toEqual(apply);
            applyOps(book, [input([[0, 0, { v: 5 }]])]);
            expect(stillHolding(book, apply, written)).toEqual([]);
        });

        test('ledger 83: a peer’s run-style key or link on a rich cell is not wiped by the inverse of my format', () => {
            const written = [format([[5, 5, 6, 6]], { bl: 1 })];
            const whole = edited(written);
            // The runs disagreed on bold, so the inverse writes them back after its format.
            expect(whole.apply).toEqual([
                { kind: 'format', sheet: 'a', ranges: [[5, 5, 6, 6]], clear: ['bl'] },
                input([[5, 5, { s: RICH }]]),
            ]);
            expect(stillHolding(whole.book, whole.apply, written)).toEqual(whole.apply);

            const peers: [FormatOp, CellAttrs][] = [
                [format([[5, 5, 5, 5]], { it: 1 }), { bl: 1, it: 1 }],
                [format([[5, 5, 5, 5]], { link: LINK }), { bl: 1 }],
            ];
            for (const [peer, look] of peers) {
                const { book, apply } = edited(written, peer);
                const mine = contentAt(book, 5, 5);
                const held = stillHolding(book, apply, written);
                // The cell holds what the peer left, not what I left: my undo leaves it, its look and its runs alone.
                expect(held).toEqual([
                    {
                        kind: 'format',
                        sheet: 'a',
                        ranges: [
                            [6, 5, 6, 6],
                            [5, 6, 5, 6],
                        ],
                        clear: ['bl'],
                    },
                ]);
                applyOps(book, held);
                expect(contentAt(book, 5, 5)).toEqual(mine);
                expect(lookAt(book, 5, 5)).toEqual(look);
                expect(lookAt(book, 6, 6)).toEqual({});
            }
            // Without the guard the inverse's input puts the old runs back over the peer's italic.
            const { book, apply } = edited(written, format([[5, 5, 5, 5]], { it: 1 }));
            applyOps(book, apply);
            expect(contentAt(book, 5, 5)?.s?.map(({ it }) => it)).toEqual([undefined, undefined]);
        });

        test('a peer’s rich text typed into my sized range keeps its runs: my undo of the size skips that cell', () => {
            const written = [format([[0, 0, 9, 9]], { fs: 9 })];
            const peer: Run[] = [{ v: 'BIG', fs: 20 }, { v: ' small' }];
            const { book, apply } = edited(written, input([[2, 2, { s: peer }]]));
            const held = stillHolding(book, apply, written);
            expect(held).toEqual([
                {
                    kind: 'format',
                    sheet: 'a',
                    ranges: [
                        [0, 0, 1, 9],
                        [3, 0, 9, 9],
                        [2, 0, 2, 1],
                        [2, 3, 2, 9],
                    ],
                    clear: ['fs'],
                },
            ]);
            applyOps(book, held);
            expect(contentAt(book, 2, 2)?.s).toEqual(peer);
            expect([lookAt(book, 2, 2), lookAt(book, 2, 3)]).toEqual([{ fs: 9 }, {}]);
        });

        test('a formula a rename bound goes back while it holds what the rename left, and a peer’s typing stays', () => {
            const typed = "='Later'!R1C1+1";
            const book = (): Book => ({
                g: 1,
                now: 45_000,
                seed: 3,
                computed: false,
                sheets: [sheetOf('a', 'a0', { cells: [[0, 0, { f: typed }]] }), sheetOf('b', 'a1')],
            });
            const written: Op[] = [{ kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { name: 'Later' } }];
            const whole = new Workbook(book());
            const before = bytes(whole);
            const apply = applyOps(whole, written);
            expect(apply).toEqual([
                { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { name: 'b' } },
                input([[0, 0, { f: typed }]]),
            ]);
            expect(contentAt(whole, 0, 0)?.f).not.toBe(typed);
            expect(stillHolding(whole, apply, written)).toEqual(apply);
            applyOps(whole, apply);
            expect(bytes(whole)).toBe(before);

            const peer = new Workbook(book());
            const inverse = applyOps(peer, written);
            applyOps(peer, [input([[0, 0, { v: 'peer typed this' }]])]);
            const held = stillHolding(peer, inverse, written);
            expect(held).toEqual([inverse[0]]);
            applyOps(peer, held);
            expect(contentAt(peer, 0, 0)).toEqual({ v: 'peer typed this' });
        });

        test('a formula my rename bound goes back only while the sheet still has the name my rename gave it', () => {
            const typed = "='Later'!R1C1+1";
            const rename = (sheet: string, name: string): Op => ({
                kind: 'record',
                sheet,
                type: 'sheet',
                id: sheet,
                set: { name },
            });
            for (const peers of [[rename('b', 'Away'), rename('c', 'Later')], [rename('b', 'LATER')]]) {
                const book = new Workbook({
                    g: 1,
                    now: 45_000,
                    seed: 3,
                    computed: false,
                    sheets: [
                        sheetOf('a', 'a0', { cells: [[0, 0, { f: typed }]] }),
                        sheetOf('b', 'a1'),
                        sheetOf('c', 'a2'),
                    ],
                });
                const written = [rename('b', 'Later')];
                const apply = applyOps(book, written);
                for (const op of peers) applyOps(book, [op]);
                const left = contentAt(book, 0, 0);
                const held = stillHolding(book, apply, written);
                expect(held, JSON.stringify(peers)).toEqual([]);
                applyOps(book, held);
                expect(contentAt(book, 0, 0)).toEqual(left);
            }
        });

        test('a formula I typed with a new name, then bound by my rename: the rename’s binding is what I left', () => {
            const typed = "='Later'!R1C1+1";
            const written: Op[] = [
                input([[0, 0, { f: typed }]]),
                { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { name: 'Later' } },
            ];
            const { book, apply, before } = edited(written);
            const held = stillHolding(book, apply, written);
            expect(held).toEqual(apply);
            applyOps(book, held);
            expect(bytes(book)).toBe(before);
        });

        test('my format over rich text I typed in the same edit: the cell holds what both left', () => {
            const written = [input([[2, 2, { s: RICH }]]), format([[2, 2, 2, 2]], { it: 1, link: LINK })];
            const { book, apply, before } = edited(written);
            const held = stillHolding(book, apply, written);
            expect(held).toEqual(apply);
            applyOps(book, held);
            expect(bytes(book)).toBe(before);
        });
    });

    describe('formats', () => {
        test('a peer’s italic on one cell of my bold range leaves my range whole', () => {
            const written = [format([[0, 0, 9, 9]], { bl: 1 })];
            const { book, apply } = edited(written, format([[4, 4, 4, 4]], { it: 1 }));
            expect(stillHolding(book, apply, written)).toEqual(apply);
            applyOps(book, apply);
            expect(lookAt(book, 4, 4)).toEqual({ it: 1 });
        });

        test('a peer’s bold on one cell of my bold-clearing range cuts that cell out', () => {
            const book = new Workbook(twoSheets());
            applyOps(book, [format([[0, 0, 9, 9]], { bl: 1 })]);
            const written: Op[] = [{ kind: 'format', sheet: 'a', ranges: [[0, 0, 9, 9]], clear: ['bl'] }];
            const apply = applyOps(book, written);
            applyOps(book, [format([[4, 4, 4, 4]], { bl: 1, bg: '#ff0000' })]);
            const held = stillHolding(book, apply, written);
            expect(held).toHaveLength(1);
            const [op] = held;
            const cells = op.kind === 'format' && 'ranges' in op ? op.ranges : [];
            const area = cells.reduce(
                (sum, [top, left, bottom, right]) => sum + (bottom - top + 1) * (right - left + 1),
                0,
            );
            expect(area).toBe(99);
            expect(cells.some(([top, left, bottom, right]) => top <= 4 && 4 <= bottom && left <= 4 && 4 <= right)).toBe(
                false,
            );
        });

        test('a paste that clears the rest: a peer’s fill on one of its cells stays, per key and per cell', () => {
            const book = new Workbook(twoSheets());
            applyOps(book, [format([[0, 0, 0, 0]], { it: 1 })]);
            const rest = LOOK_KEYS.filter((key) => key !== 'bl');
            const written: Op[] = [{ kind: 'format', sheet: 'a', ranges: [[0, 0, 0, 1]], set: { bl: 1 }, clear: rest }];
            const apply = applyOps(book, written);
            applyOps(book, [format([[0, 0, 0, 0]], { bg: '#ff0000' })]);
            applyOps(book, stillHolding(book, apply, written));
            // The peer's fill stays, my bold is gone, and the italic the paste cleared is back.
            expect(lookAt(book, 0, 0)).toEqual({ it: 1, bg: '#ff0000' });
            expect(lookAt(book, 0, 1)).toEqual({});
        });

        test('one op that names two keys is cut key by key', () => {
            const written = [format([[0, 0, 0, 3]], { bl: 1, it: 1 })];
            const { book, apply } = edited(written);
            const both: Op = { kind: 'format', sheet: 'a', ranges: [[0, 0, 0, 3]], clear: ['bl', 'it'] };
            expect(stillHolding(book, [both], written)).toEqual([both]);
            expect(apply).toHaveLength(2);
            applyOps(book, [{ kind: 'format', sheet: 'a', ranges: [[0, 1, 0, 1]], clear: ['it'] }]);
            expect(stillHolding(book, [both], written)).toEqual([
                { kind: 'format', sheet: 'a', ranges: [[0, 0, 0, 3]], clear: ['bl'] },
                {
                    kind: 'format',
                    sheet: 'a',
                    ranges: [
                        [0, 0, 0, 0],
                        [0, 2, 0, 3],
                    ],
                    clear: ['it'],
                },
            ]);
        });

        test('the part of a range the edit never wrote stays, beside the part a peer cut', () => {
            const written = [format([[0, 0, 0, 3]], { bg: '#111111' })];
            const { book } = edited(written, format([[0, 1, 0, 1]], { bg: '#222222' }));
            const wider: Op = { kind: 'format', sheet: 'a', ranges: [[0, 0, 0, 5]], clear: ['bg'] };
            const [held] = stillHolding(book, [wider], written);
            const ranges = held.kind === 'format' && 'ranges' in held ? held.ranges : [];
            expect(ranges.toSorted((a, b) => a[1] - b[1])).toEqual([
                [0, 0, 0, 0],
                [0, 2, 0, 3],
                [0, 4, 0, 5],
            ]);
        });

        test('the last format of the edit on a cell says what it left there', () => {
            const written = [format([[0, 0, 0, 3]], { bg: '#111111' }), format([[0, 2, 0, 5]], { bg: '#222222' })];
            const { book, apply, before } = edited(written);
            expect(stillHolding(book, apply, written)).toEqual(apply);
            // A peer puts the first format's fill back on a cell the second wrote: that cell no longer holds.
            applyOps(book, [format([[0, 3, 0, 3]], { bg: '#111111' })]);
            const held = stillHolding(book, apply, written);
            applyOps(book, held);
            expect(lookAt(book, 0, 3)).toEqual({ bg: '#111111' });
            expect([lookAt(book, 0, 0), lookAt(book, 0, 2), lookAt(book, 0, 5)]).toEqual([{}, {}, {}]);
            expect(bytes(book)).not.toBe(before);
        });

        test('a link holds cell by cell, and a peer’s typing takes the link with it', () => {
            const written = [format([[10, 0, 11, 1]], { link: LINK })];
            const { book, apply } = edited(written, input([[10, 1, { v: 'peer' }]]));
            expect(apply).toEqual([{ kind: 'format', sheet: 'a', ranges: [[10, 0, 11, 1]], clear: ['link'] }]);
            expect(stillHolding(book, apply, written)).toEqual([
                {
                    kind: 'format',
                    sheet: 'a',
                    ranges: [
                        [10, 0, 11, 0],
                        [11, 1, 11, 1],
                    ],
                    clear: ['link'],
                },
            ]);
            const whole = edited(written);
            expect(stillHolding(whole.book, whole.apply, written)).toEqual(whole.apply);
        });

        test('line keys hold per key and per line', () => {
            const written = [rows(2, 9, { size: 30 })];
            const hidden = edited(written, rows(4, 5, { hidden: 1 }));
            expect(stillHolding(hidden.book, hidden.apply, written)).toEqual(hidden.apply);
            const { book, apply } = edited(written, rows(4, 5, { size: 44 }), rows(9, 12, { size: 30 }));
            expect(stillHolding(book, apply, written)).toEqual([
                {
                    kind: 'format',
                    sheet: 'a',
                    lines: 'rows',
                    spans: [
                        [2, 3],
                        [6, 9],
                    ],
                    clear: ['size'],
                },
            ]);
            // Columns are another axis.
            const columns: FormatOp = {
                kind: 'format',
                sheet: 'a',
                lines: 'columns',
                spans: [[2, 9]],
                set: { size: 30 },
            };
            const other = edited([columns], rows(4, 5, { size: 44 }));
            expect(stillHolding(other.book, other.apply, [columns])).toEqual(other.apply);
        });
    });

    describe('records', () => {
        test('a peer’s field write drops that field, and the others go back', () => {
            const written: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { x: 9, y: 9, angle: 30 } },
            ];
            const { book, apply } = edited(written, {
                kind: 'record',
                sheet: 'a',
                type: 'image',
                id: 'i',
                set: { y: 50 },
            });
            expect(apply).toEqual([
                { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { x: 1, y: 2, angle: null } },
            ]);
            expect(stillHolding(book, apply, written)).toEqual([
                { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { x: 1, angle: null } },
            ]);
            // A field the peer wrote and my edit did not is no reason to keep mine.
            const other = edited(written, { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { width: 99 } });
            expect(stillHolding(other.book, other.apply, written)).toEqual(other.apply);
            // Every field written since: nothing of the op is left.
            const all = edited(written, {
                kind: 'record',
                sheet: 'a',
                type: 'image',
                id: 'i',
                set: { x: 7, y: 7, angle: 7 },
            });
            expect(stillHolding(all.book, all.apply, written)).toEqual([]);
        });

        test('a sheet’s fields hold field by field', () => {
            const written: RecordOp[] = [
                { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { color: '#111111', grid: 0 } },
            ];
            const { book, apply } = edited(written, {
                kind: 'record',
                sheet: 'b',
                type: 'sheet',
                id: 'b',
                set: { color: '#222222' },
            });
            expect(stillHolding(book, apply, written)).toEqual([
                { kind: 'record', sheet: 'b', type: 'sheet', id: 'b', set: { grid: null } },
            ]);
        });

        test('a record I made or deleted goes back only while it is as I left it', () => {
            const made: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'comment', id: 'd', set: { row: 1, column: 1 }, whole: 1 },
            ];
            const moved = edited(made, { kind: 'record', sheet: 'a', type: 'comment', id: 'd', set: { row: 8 } });
            expect(stillHolding(moved.book, moved.apply, made)).toEqual([]);
            const gone = edited(made, { kind: 'record', sheet: 'a', type: 'comment', id: 'd' });
            expect(stillHolding(gone.book, gone.apply, made)).toEqual([]);

            const deleted: RecordOp[] = [{ kind: 'record', sheet: 'a', type: 'comment', id: 'c' }];
            const remade = edited(deleted, {
                kind: 'record',
                sheet: 'a',
                type: 'comment',
                id: 'c',
                set: { row: 7, column: 7 },
                whole: 1,
            });
            expect(stillHolding(remade.book, remade.apply, deleted)).toEqual([]);
            const still = edited(deleted, {
                kind: 'record',
                sheet: 'a',
                type: 'comment',
                id: 'e',
                set: { row: 7, column: 7 },
                whole: 1,
            });
            expect(stillHolding(still.book, still.apply, deleted)).toEqual(still.apply);

            const replaced: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 9, column: 9 }, whole: 1 },
            ];
            const changed = edited(replaced, {
                kind: 'record',
                sheet: 'a',
                type: 'comment',
                id: 'c',
                set: { column: 2 },
            });
            expect(stillHolding(changed.book, changed.apply, replaced)).toEqual([]);
        });

        test('a sheet has one filter: the old one comes back only while mine is the live one', () => {
            const written: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'filter', id: 'g', set: { rect: [0, 0, 9, 3] }, whole: 1 },
            ];
            const whole = edited(written);
            expect(whole.apply.map((op) => op.kind === 'record' && [op.type, op.id])).toEqual([
                ['filter', 'f'],
                ['filterColumn', 'k'],
            ]);
            expect(stillHolding(whole.book, whole.apply, written)).toEqual(whole.apply);
            // A peer's filter took the place of mine: the old filter stays away, and its column is skipped with it.
            const peer: RecordOp = {
                kind: 'record',
                sheet: 'a',
                type: 'filter',
                id: 'h',
                set: { rect: [0, 0, 5, 3] },
                whole: 1,
            };
            const { book, apply } = edited(written, peer);
            const held = stillHolding(book, apply, written);
            expect(held.map((op) => op.kind === 'record' && op.type)).toEqual(['filterColumn']);
            applyOps(book, held);
            expect([...(book.sheets.get('a')?.records.records('filter').keys() ?? [])]).toEqual(['h']);
            expect(book.sheets.get('a')?.records.records('filterColumn').size).toBe(0);
            const resized = edited(written, {
                kind: 'record',
                sheet: 'a',
                type: 'filter',
                id: 'g',
                set: { rect: [0, 0, 7, 3] },
            });
            expect(
                stillHolding(resized.book, resized.apply, written).map((op) => op.kind === 'record' && op.type),
            ).toEqual(['filterColumn']);
        });
    });
    describe('the law, over random edits and peers', () => {
        // Past row 70, where a book's formula waits for a sheet named `LATER`.
        const ROWS = 72;
        const COLUMNS = 22;
        const LINES = 26;
        const draw = (random: Random, model: Model): Op =>
            [randomInputOp, randomFormatOp, randomRecordOp, randomLineReaderOp][below(random, 4)](random, model);
        // My own ops name sheets by id, as a writer's keys do, and write no name: a key typed with a sheet's name is
        // bound when it enters, so the cell would not read as the op said it.
        const mine = (random: Random, model: Model): Op => {
            for (;;) {
                const op = draw(random, model);
                if (!/'!R1C1\+1|"name":/.test(JSON.stringify(op))) return op;
            }
        };
        const lands = (book: Workbook, ops: readonly Op[]): Op[] | undefined => {
            try {
                return applyOps(book, ops);
            } catch (error) {
                if (error instanceof Refusal) return undefined;
                throw error;
            }
        };
        // Runs that disagree on every run-style key, so no format over them leaves them as they are.
        const TYPED_RICH: Run[] = [
            { v: 'BIG', bl: 1, it: 1, ff: 'Mono', fs: 20, fc: '#0000ff', cl: 1, un: 1 },
            { v: ' small' },
        ];
        type Cell = { whole: string; link: string; text: string; runs: string; look: string };
        type Facets = { cells: Map<string, Cell>; lines: Map<string, string>; records: Map<string, object> };
        const json = (value: unknown) => JSON.stringify(value ?? null);
        const textOf = (content: CellContent | null) =>
            json(content && { ...content, link: undefined, s: content.s?.map((run) => run.v) });
        const facets = (book: Workbook): Facets => {
            // A kept formula with no value reads #REF! once computed.
            while (book.engine.recalc(Number.MAX_SAFE_INTEGER).stopped);
            const read: Facets = { cells: new Map(), lines: new Map(), records: new Map() };
            for (const [sheet, part] of book.sheets) {
                for (let row = 0; row < ROWS; row += 1) {
                    for (let column = 0; column < COLUMNS; column += 1) {
                        const content = cellAt(book, sheet, part.extras, row, column);
                        const look = json(book.looks.look(part.bands.look(row, column)));
                        if (!content && look === '{}') continue;
                        const runs = json(content?.s?.map(({ v: _, ...style }) => style));
                        const cell = {
                            whole: json(content),
                            link: json(content?.link),
                            text: textOf(content),
                            runs,
                            look,
                        };
                        read.cells.set(`${sheet} ${row} ${column}`, cell);
                    }
                }
                for (let line = 0; line < LINES; line += 1) {
                    read.lines.set(`${sheet} rows ${line}`, json(part.rows.at(line)));
                    read.lines.set(`${sheet} columns ${line}`, json(part.columns.at(line)));
                }
                read.records.set(`${sheet} sheet`, part.records.fields);
                // A sheet has one filter, whatever its id: the filters read as one record by id.
                read.records.set(`${sheet} filter`, Object.fromEntries(part.records.records('filter')));
                for (const type of [
                    'merge',
                    'filterColumn',
                    'comment',
                    'conditionalFormat',
                    'validation',
                    'image',
                    'chart',
                ] as const) {
                    for (const [id, record] of part.records.records(type))
                        read.records.set(`${sheet} ${type} ${id}`, record);
                }
            }
            return read;
        };
        const EMPTY: Cell = { whole: 'null', link: 'null', text: 'null', runs: 'null', look: '{}' };
        const field = (record: object | undefined, name: string) =>
            json(new Map(Object.entries(record ?? {})).get(name));
        const filters = (read: Facets, sheet: string) => json(read.records.get(`${sheet} filter`));

        test('a place a peer wrote stays as the peer left it, a place only I wrote goes back', () => {
            const seen = {
                whole: 0,
                cut: 0,
                refused: 0,
                skipped: 0,
                untouched: 0,
                typedRich: 0,
                typedLost: 0,
                back: 0,
                kept: 0,
            };
            const cuts = { cells: 0, runs: 0, ranges: 0, spans: 0, fields: 0, records: 0 };
            for (let seed = 1; seed <= 700; seed += 1) {
                const random = randomOf(seed * 86_028_121);
                const content = randomBookContent(random);
                let model = modelOf(content);
                const book = new Workbook(structuredClone(content));
                const before = facets(book);
                // The edit's own rename and the peers' typing draw from a stream of their own, so the others stay.
                const extra = randomOf(seed * 7_919);
                const written = Array.from({ length: 2 + below(random, 4) }, () => mine(random, model));
                // Now and then the edit renames a sheet to the name a book's formula waits for, which binds it.
                const [renamed] = model.sheets.keys();
                if (extra() < 0.2)
                    written.push({ kind: 'record', sheet: renamed, type: 'sheet', id: renamed, set: { name: LATER } });
                const after = modelAfter(model, { now: 1, seed: 1, ops: written });
                const apply = lands(book, written);
                if (!apply || typeof after === 'string') {
                    seen.skipped += 1;
                    continue;
                }
                model = after;
                const left = facets(book);
                const leftBytes = bytes(book);
                for (let n = below(random, 3) * 4; n > 0; n -= 1) {
                    const ops = Array.from({ length: 1 + below(random, 3) }, () => draw(random, model));
                    const next = modelAfter(model, { now: 1, seed: 1, ops });
                    if (lands(book, ops) && typeof next !== 'string') model = next;
                }
                // A peer types rich text into a range my format gave a run-style key, or onto a formula my rename bound.
                const typing: InputOp[] = [];
                const format = written.find(
                    (op) => op.kind === 'format' && 'ranges' in op && RUN_KEYS.some((key) => names(op, key)),
                );
                if (format?.kind === 'format' && 'ranges' in format && extra() < 0.7) {
                    const [top, left] = format.ranges[0];
                    if (top < ROWS && left < COLUMNS)
                        typing.push(input([[top, left, { s: TYPED_RICH }]], format.sheet));
                }
                const lost = apply.find((op) => op.kind === 'input' && JSON.stringify(op).includes(`'${LATER}'`));
                if (lost?.kind === 'input' && lost.cells && written.some((op) => op.kind === 'record')) {
                    const [row, column] = lost.cells[0];
                    if (row < ROWS && column < COLUMNS)
                        typing.push(input([[row, column, { v: 'peer typed this' }]], lost.sheet));
                }
                for (const op of typing) {
                    const next = modelAfter(model, { now: 1, seed: 1, ops: [op] });
                    if (!lands(book, [op]) || typeof next === 'string') continue;
                    model = next;
                    if (op.cells?.[0][2]?.s) seen.typedRich += 1;
                    else seen.typedLost += 1;
                }
                const peers = facets(book);
                const held = stillHolding(book, apply, written);
                const where = `seed ${seed}`;
                if (bytes(book) === leftBytes) {
                    expect(held, where).toEqual(apply);
                    seen.untouched += 1;
                }
                if (JSON.stringify(held) === JSON.stringify(apply)) seen.whole += 1;
                else {
                    seen.cut += 1;
                    const count = (ops: readonly Op[], of: (op: Op) => number) =>
                        ops.reduce((sum, op) => sum + of(op), 0);
                    const size = (of: (op: Op) => number) => count(held, of) !== count(apply, of);
                    if (size((op) => (op.kind === 'input' ? (op.cells?.length ?? 0) : 0))) cuts.cells += 1;
                    if (size((op) => (op.kind === 'input' ? (op.runs?.length ?? 0) : 0))) cuts.runs += 1;
                    if (size((op) => (op.kind === 'format' && 'ranges' in op ? op.ranges.length : 0))) cuts.ranges += 1;
                    if (size((op) => (op.kind === 'format' && 'spans' in op ? op.spans.length : 0))) cuts.spans += 1;
                    if (size((op) => (op.kind === 'record' ? Object.keys(op.set ?? {}).length : 0))) cuts.fields += 1;
                    if (size((op) => (op.kind === 'record' ? 1 : 0))) cuts.records += 1;
                }
                if (!lands(book, held)) {
                    seen.refused += 1;
                    continue;
                }
                const undone = facets(book);
                // A formula my rename bound goes back only while the sheet has the name my rename gave it.
                const renamedNow = field(peers.records.get(`${renamed} sheet`), 'name') === json(LATER);
                const bound = written.some(
                    (op) => op.kind === 'record' && op.type === 'sheet' && op.set.name === LATER,
                );

                for (const key of new Set([
                    ...before.cells.keys(),
                    ...left.cells.keys(),
                    ...peers.cells.keys(),
                    ...undone.cells.keys(),
                ])) {
                    const [b0, b1, bp, f] = [before, left, peers, undone].map((read) => read.cells.get(key) ?? EMPTY);
                    const [l0, l1, lp, lf] = [b0, b1, bp, f].map((cell): CellAttrs => JSON.parse(cell.look));
                    if (bp.whole === b1.whole) {
                        const lost = bound && b0.whole.includes(`'${LATER}'!`) && b1.whole !== b0.whole;
                        expect(f.whole, `${where} cell ${key}`).toBe(lost && !renamedNow ? bp.whole : b0.whole);
                        if (lost) seen[renamedNow ? 'back' : 'kept'] += 1;
                    } else {
                        if (bp.link !== b1.link) expect(f.link, `${where} link ${key}`).toBe(bp.link);
                        if (bp.text !== b1.text) expect(f.text, `${where} text ${key}`).toBe(bp.text);
                        // A run-style key a peer changed stays on the runs as the peer left it, unless every run wears
                        // what my format left: a peer who wrote what I wrote changed nothing, so my undo takes it off.
                        const styles = (cell: Cell): Run[] => JSON.parse(cell.runs) ?? [];
                        for (const name of RUN_KEYS) {
                            const of = (cell: Cell) => json(styles(cell).map((run) => run[name]));
                            if (of(bp) === of(b1)) continue;
                            const asMine = styles(bp).every((run) => json(run[name]) === json(l1[name]));
                            const back = json(styles(bp).map(() => l0[name]));
                            const kept = asMine && json(lf[name]) === json(l0[name]) ? back : of(bp);
                            expect(of(f), `${where} runs ${name} ${key}`).toBe(kept);
                        }
                    }
                    // A rich cell a peer changed may be left out of my run-style keys, its look with it.
                    const richChanged = bp.whole !== b1.whole && bp.runs !== 'null';
                    for (const name of LOOK_KEYS) {
                        const out = richChanged && RUN_KEYS.some((run) => run === name);
                        if (out && json(lf[name]) === json(lp[name])) continue;
                        const kept = json(lp[name]) === json(l1[name]) ? l0[name] : lp[name];
                        expect(json(lf[name]), `${where} look ${name} ${key}`).toBe(json(kept));
                    }
                }
                for (const [key, f] of undone.lines) {
                    const [l0, l1, lp, lf] = [before, left, peers]
                        .map((read): LineAttrs => JSON.parse(read.lines.get(key) ?? '{}'))
                        .concat(JSON.parse(f));
                    for (const name of ['size', 'custom', 'hidden'] as const) {
                        const kept = lp[name] === l1[name] ? l0[name] : lp[name];
                        expect(lf[name], `${where} line ${name} ${key}`).toBe(kept);
                    }
                }
                for (const key of new Set([
                    ...before.records.keys(),
                    ...left.records.keys(),
                    ...peers.records.keys(),
                    ...undone.records.keys(),
                ])) {
                    const [r0, r1, rp, rf] = [before, left, peers, undone].map((read) => read.records.get(key));
                    const [sheet, type] = key.split(' ');
                    const names = new Set([r0, r1, rp, rf].flatMap((record) => Object.keys(record ?? {})));
                    if (type === 'sheet') {
                        for (const name of names) {
                            const changed = field(rp, name) !== field(r1, name);
                            // A name another sheet took since cannot come back.
                            if (name === 'name' && !changed && field(rf, name) === field(r1, name)) continue;
                            expect(field(rf, name), `${where} ${key} ${name}`).toBe(field(changed ? rp : r0, name));
                        }
                        continue;
                    }
                    // A column goes and comes with its filter.
                    if (
                        type === 'filterColumn' &&
                        filters(undone, sheet) !== filters(json(rp) === json(r1) ? before : peers, sheet)
                    )
                        continue;
                    if (json(rp) === json(r1)) expect(json(rf), `${where} ${key}`).toBe(json(r0));
                    else {
                        for (const name of names) {
                            if (field(rp, name) !== field(r1, name))
                                expect(field(rf, name), `${where} ${key} ${name}`).toBe(field(rp, name));
                        }
                    }
                }
            }
            expect(seen.untouched).toBeGreaterThan(100);
            expect(seen.whole).toBeGreaterThan(200);
            expect(seen.cut).toBeGreaterThan(60);
            expect(cuts.cells).toBeGreaterThan(30);
            expect(cuts.runs).toBeGreaterThan(10);
            expect(cuts.ranges).toBeGreaterThan(20);
            expect(cuts.spans).toBeGreaterThan(1);
            expect(cuts.fields).toBeGreaterThan(2);
            expect(cuts.records).toBeGreaterThan(4);
            expect(seen.refused).toBeLessThan(40);
            expect(seen.typedRich).toBeGreaterThan(150);
            expect(seen.typedLost).toBeGreaterThan(70);
            expect(Math.min(seen.back, seen.kept)).toBeGreaterThan(0);
        }, 120_000);
    });
});
