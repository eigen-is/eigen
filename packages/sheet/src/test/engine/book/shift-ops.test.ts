import { describe, expect, test } from 'bun:test';
import { GRID_ROWS } from '@workspace/formula/text';
import type { InputOp, LinesOp, Op, RecordOp, SheetContent } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { shiftOps } from '../../../engine/book/shift-ops';
import { Workbook } from '../../../engine/book/workbook';
import {
    randomBookContent,
    randomFormatOp,
    randomInputOp,
    randomLineReaderOp,
    randomLinesOp,
    randomRecordOp,
} from './batches';
import type { Book, Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';
import { bytes } from './bytes';
import type { Model } from './model';
import { modelOf } from './model';
import { chartData, chartOf, formulaRule, keyOfRule, ref } from './records-fixtures';

const LAST_ROW = GRID_ROWS - 1;

function lines(rows: boolean, insert: boolean, index: number, count = 1, sheet = 'a', like?: number): LinesOp {
    return { kind: 'lines', sheet, rows, insert, index, count, ...(like !== undefined && { like }) };
}

function sheetOf(id: string, order: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function twoSheets(): Book {
    const cells: SheetContent['cells'] = [];
    for (let row = 0; row < 12; row += 1) cells.push([row, 0, { v: row }]);
    return {
        g: 1,
        now: 45_000,
        seed: 3,
        computed: false,
        sheets: [sheetOf('a', 'a0', { cells }), sheetOf('b', 'a1', { cells })],
    };
}

// Whether the ops landed: a refusal leaves the book as it was.
function lands(book: Workbook, ops: readonly Op[]): boolean {
    try {
        applyOps(book, ops);
        return true;
    } catch (error) {
        if (error instanceof Refusal) return false;
        throw error;
    }
}

// The bytes of a book after the ops and then the edit, and after the edit and then the ops as shifted.
function bothOrders(content: Book, ops: readonly Op[], edit: LinesOp): [string, string] {
    const first = new Workbook(structuredClone(content));
    applyOps(first, ops);
    applyOps(first, [edit]);
    const second = new Workbook(structuredClone(content));
    applyOps(second, [edit]);
    applyOps(second, shiftOps(ops, edit) ?? []);
    return [bytes(first), bytes(second)];
}

function expectSame(content: Book, ops: readonly Op[], edit: LinesOp): void {
    const [first, second] = bothOrders(content, ops, edit);
    expect(second).toBe(first);
}

const input = (cells: InputOp['cells'], sheet = 'a'): InputOp => ({ kind: 'input', sheet, cells });
const fill = (runs: InputOp['runs'], sheet = 'a'): InputOp => ({ kind: 'input', sheet, runs });

describe('engine/book/shift-ops — shiftOps', () => {
    describe('an entry with no shifted form', () => {
        test.each<[string, Op]>([
            ['lines', lines(true, true, 2)],
            ['move', { kind: 'move', sheet: 'a', from: [0, 0, 1, 1], toSheet: 'a', toRow: 4, toColumn: 4 }],
            ['sheet', { kind: 'sheet', delete: 'b' }],
        ])('an entry that holds a %s op is null', (_, op) => {
            expect(shiftOps([input([[0, 0, { v: 1 }]]), op], lines(true, true, 2))).toBeNull();
        });

        test('an entry whose every target is deleted is null', () => {
            const ops: Op[] = [
                input([[3, 0, { v: 1 }]]),
                { kind: 'format', sheet: 'a', ranges: [[3, 0, 4, 2]], set: { bl: 1 } },
                { kind: 'format', sheet: 'a', lines: 'rows', spans: [[4, 4]], set: { size: 30 } },
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 3, column: 1 }, whole: 1 },
            ];
            expect(shiftOps(ops, lines(true, false, 3, 2))).toBeNull();
            expect(shiftOps(ops, lines(true, false, 3, 1))).toHaveLength(2);
        });

        test('an entry of another sheet with no formula comes back as it is', () => {
            const ops: Op[] = [
                input([[3, 0, { v: 1 }]], 'b'),
                { kind: 'format', sheet: 'b', ranges: [[3, 0, 4, 2]], set: { bl: 1 } },
                { kind: 'record', sheet: 'b', type: 'merge', id: 'm', set: { rect: [3, 0, 4, 2] }, whole: 1 },
            ];
            expect(shiftOps(ops, lines(true, false, 0, 9))).toEqual(ops);
        });
    });

    describe('an input', () => {
        test('listed cells go where their lines go, and a cell on a deleted line leaves', () => {
            const op = input([
                [1, 0, { v: 1 }],
                [4, 0, { v: 4 }],
                [7, 0, null],
                [2, 3, { v: 9 }],
            ]);
            expect(shiftOps([op], lines(true, true, 4, 2))).toEqual([
                input([
                    [1, 0, { v: 1 }],
                    [6, 0, { v: 4 }],
                    [9, 0, null],
                    [2, 3, { v: 9 }],
                ]),
            ]);
            expect(shiftOps([op], lines(true, false, 2, 3))).toEqual([
                input([
                    [1, 0, { v: 1 }],
                    [4, 0, null],
                ]),
            ]);
            expect(shiftOps([op], lines(false, true, 1, 2))).toEqual([
                input([
                    [1, 0, { v: 1 }],
                    [4, 0, { v: 4 }],
                    [7, 0, null],
                    [2, 5, { v: 9 }],
                ]),
            ]);
            expectSame(twoSheets(), [op], lines(true, true, 4, 2));
            expectSame(twoSheets(), [op], lines(true, false, 2, 3));
        });

        test('a rectangle is split around inserted lines and clipped by deleted ones', () => {
            const op = fill([[[2, 1, 6, 2], { v: 7 }]]);
            expect(shiftOps([op], lines(true, true, 4, 3))).toEqual([
                fill([
                    [[2, 1, 3, 2], { v: 7 }],
                    [[7, 1, 9, 2], { v: 7 }],
                ]),
            ]);
            expect(shiftOps([op], lines(true, true, 2, 3))).toEqual([fill([[[5, 1, 9, 2], { v: 7 }]])]);
            expect(shiftOps([op], lines(true, false, 5, 4))).toEqual([fill([[[2, 1, 4, 2], { v: 7 }]])]);
            expect(shiftOps([op], lines(false, true, 2, 1))).toEqual([
                fill([
                    [[2, 1, 6, 1], { v: 7 }],
                    [[2, 3, 6, 3], { v: 7 }],
                ]),
            ]);
            expect(shiftOps([op], lines(true, false, 0, 9))).toBeNull();
            for (const edit of [lines(true, true, 4, 3), lines(true, false, 5, 4), lines(false, true, 2, 1)]) {
                expectSame(twoSheets(), [op], edit);
            }
        });

        test('a rectangle to the last line does not reach the lines a delete lets in', () => {
            const op = fill([[[LAST_ROW - 3, 1, LAST_ROW, 1], { v: 7 }]]);
            expect(shiftOps([op], lines(true, false, 5, 2))).toEqual([
                fill([[[LAST_ROW - 5, 1, LAST_ROW - 2, 1], { v: 7 }]]),
            ]);
            expectSame(twoSheets(), [op], lines(true, false, 5, 2));
        });

        test('a formula is rewritten with its own cell as host, on the edited sheet and on another', () => {
            const ops = [
                input([
                    [5, 2, { f: '=R[-2]C[-2]+R1C1' }],
                    [6, 2, { f: '=SUM(R2C1:R9C1)', link: { type: 'webpage', address: 'https://eigen.is' } }],
                ]),
                input([[5, 2, { f: '=[a]!R[1]C[-2]*2' }]], 'b'),
            ];
            // Rows inserted between the formula and what it reads: the offset grows, and the other sheet's key too.
            expect(shiftOps(ops, lines(true, true, 4, 2))).toEqual([
                input([
                    [7, 2, { f: '=R[-4]C[-2]+R1C1' }],
                    [8, 2, { f: '=SUM(R2C1:R11C1)', link: { type: 'webpage', address: 'https://eigen.is' } }],
                ]),
                input([[5, 2, { f: '=[a]!R[3]C[-2]*2' }]], 'b'),
            ]);
            for (const edit of [lines(true, true, 4, 2), lines(true, false, 3, 1), lines(true, false, 6, 3)]) {
                expectSame(twoSheets(), ops, edit);
            }
        });

        test('a filled formula is cut where its outcome differs along the lines', () => {
            // Each cell reads the cell two rows up: the rows below the insert read across it.
            const op = fill([[[4, 2, 9, 3], { f: '=R[-2]C1+1' }]]);
            const shifted = shiftOps([op], lines(true, true, 6, 1));
            expect(shifted).toEqual([
                fill([
                    [[4, 2, 5, 3], { f: '=R[-2]C1+1' }],
                    [[7, 2, 8, 3], { f: '=R[-3]C1+1' }],
                    [[9, 2, 10, 3], { f: '=R[-2]C1+1' }],
                ]),
            ]);
            expectSame(twoSheets(), [op], lines(true, true, 6, 1));
            expectSame(twoSheets(), [op], lines(true, false, 5, 2));
            // On another sheet the block stays where it is and is cut the same way.
            const other = fill([[[4, 2, 9, 3], { f: '=[a]!R[-2]C1+1' }]], 'b');
            expect(shiftOps([other], lines(true, true, 6, 1))).toEqual([
                fill(
                    [
                        [[4, 2, 7, 3], { f: '=[a]!R[-2]C1+1' }],
                        [[8, 2, 9, 3], { f: '=[a]!R[-1]C1+1' }],
                    ],
                    'b',
                ),
            ]);
            expectSame(twoSheets(), [other], lines(true, true, 6, 1));
            expectSame(twoSheets(), [other], lines(true, false, 5, 2));
        });
    });

    describe('a format', () => {
        test('(b) a rectangle an insert cuts becomes two, and the new lines are not in it', () => {
            const op: Op = { kind: 'format', sheet: 'a', ranges: [[2, 1, 6, 2]], set: { bl: 1 } };
            const edit = lines(true, true, 4, 2, 'a', 3);
            expect(shiftOps([op], edit)).toEqual([
                {
                    kind: 'format',
                    sheet: 'a',
                    ranges: [
                        [2, 1, 3, 2],
                        [6, 1, 8, 2],
                    ],
                    set: { bl: 1 },
                },
            ]);
            const first = new Workbook(twoSheets());
            applyOps(first, [op, edit]);
            const second = new Workbook(twoSheets());
            applyOps(second, [edit, ...(shiftOps([op], edit) ?? [])]);
            // The new lines took the bold of the line they are like only where the format came first.
            expect(bytes(second)).not.toBe(bytes(first));
            const back = lines(true, false, 4, 2);
            applyOps(first, [back]);
            applyOps(second, [back]);
            expect(bytes(second)).toBe(bytes(first));
        });

        test('rectangles are clipped by a delete, and one to the last line still reaches it', () => {
            const op: Op = {
                kind: 'format',
                sheet: 'a',
                ranges: [
                    [2, 1, 6, 2],
                    [0, 4, LAST_ROW, 4],
                    [3, 6, 4, 6],
                ],
                clear: ['bg'],
                set: { it: 1 },
            };
            expect(shiftOps([op], lines(true, false, 3, 2))).toEqual([
                {
                    ...op,
                    ranges: [
                        [2, 1, 4, 2],
                        [0, 4, LAST_ROW, 4],
                    ],
                },
            ]);
            expectSame(twoSheets(), [op], lines(true, false, 3, 2));
            expectSame(twoSheets(), [op], lines(false, false, 2, 3));
            expectSame(twoSheets(), [op], lines(true, true, 8, 2));
        });

        test('line spans along the edited axis are split and clipped, and the other axis stays', () => {
            const rows: Op = { kind: 'format', sheet: 'a', lines: 'rows', spans: [[2, 6]], set: { size: 30 } };
            const columns: Op = { kind: 'format', sheet: 'a', lines: 'columns', spans: [[2, 6]], set: { hidden: 1 } };
            expect(shiftOps([rows, columns], lines(true, true, 4, 2))).toEqual([
                {
                    ...rows,
                    spans: [
                        [2, 3],
                        [6, 8],
                    ],
                },
                columns,
            ]);
            expect(shiftOps([rows, columns], lines(false, false, 5, 9))).toEqual([
                rows,
                { ...columns, spans: [[2, 4]] },
            ]);
            for (const edit of [lines(true, true, 4, 2), lines(false, false, 5, 9), lines(true, false, 0, 4)]) {
                expectSame(twoSheets(), [rows, columns], edit);
            }
            // The lines a delete lets in at the grid's end hold no key, so a span to the last line does not reach them.
            const last: Op = { ...rows, spans: [[LAST_ROW - 3, LAST_ROW]] };
            expect(shiftOps([last], lines(true, false, 5, 2))).toEqual([
                { ...rows, spans: [[LAST_ROW - 5, LAST_ROW - 2]] },
            ]);
            expectSame(twoSheets(), [last], lines(true, false, 5, 2));
        });
    });

    describe('a record op', () => {
        const merge = (rect: [number, number, number, number]): RecordOp => ({
            kind: 'record',
            sheet: 'a',
            type: 'merge',
            id: 'm',
            set: { rect },
            whole: 1,
        });

        test('(c) a range grows when the insert is inside it, where a rectangle of cells is split', () => {
            expect(shiftOps([merge([2, 1, 6, 2])], lines(true, true, 4, 2))).toEqual([merge([2, 1, 8, 2])]);
            expectSame(twoSheets(), [merge([2, 1, 6, 2])], lines(true, true, 4, 2));
            expectSame(twoSheets(), [merge([2, 1, 6, 2])], lines(true, false, 4, 1));
        });

        test('a record that is gone drops its op, and an op that deletes stays', () => {
            const gone: RecordOp = { kind: 'record', sheet: 'a', type: 'merge', id: 'm' };
            expect(shiftOps([merge([2, 1, 3, 2]), gone], lines(true, false, 2, 2))).toEqual([gone]);
            // A merge the delete cuts to one cell is a merge no more, as the store has it.
            expect(shiftOps([merge([2, 1, 3, 1])], lines(true, false, 2, 1))).toBeNull();
        });

        test('each field goes where the store puts that record', () => {
            const ops: RecordOp[] = [
                { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { frozenRows: 3, color: '#123456' } },
                { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [1, 0, LAST_ROW, 3] } },
                {
                    kind: 'record',
                    sheet: 'a',
                    type: 'filterColumn',
                    id: 'k',
                    set: {
                        rows: [
                            [2, 3],
                            [5, 6],
                        ],
                    },
                },
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 5 } },
                { kind: 'record', sheet: 'a', type: 'validation', id: 'v', set: { ranges: [[0, 1, LAST_ROW, 1]] } },
                { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { x: 4 } },
            ];
            expect(shiftOps(ops, lines(true, true, 2, 2))).toEqual([
                { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { frozenRows: 5, color: '#123456' } },
                { kind: 'record', sheet: 'a', type: 'filter', id: 'f', set: { rect: [1, 0, LAST_ROW, 3] } },
                {
                    kind: 'record',
                    sheet: 'a',
                    type: 'filterColumn',
                    id: 'k',
                    set: {
                        rows: [
                            [4, 5],
                            [7, 8],
                        ],
                    },
                },
                { kind: 'record', sheet: 'a', type: 'comment', id: 'c', set: { row: 7 } },
                { kind: 'record', sheet: 'a', type: 'validation', id: 'v', set: { ranges: [[0, 1, LAST_ROW, 1]] } },
                { kind: 'record', sheet: 'a', type: 'image', id: 'i', set: { x: 4 } },
            ]);
            // A delete that takes every frozen row clears the field, as the store does.
            expect(shiftOps([ops[0]], lines(true, false, 0, 4))).toEqual([
                { kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { frozenRows: null, color: '#123456' } },
            ]);
            // A column edit moves a filter's column and leaves its rows.
            expect(shiftOps([ops[2], ops[3]], lines(false, true, 0, 2))).toEqual([ops[2], ops[3]]);
        });

        test('a rule’s formula and a chart’s refs follow the edited lines from any sheet', () => {
            const rule = (key: string, top: number): RecordOp => ({
                kind: 'record',
                sheet: 'b',
                type: 'conditionalFormat',
                id: 'r',
                set: formulaRule([[top, 0, top + 3, 0]], key),
                whole: 1,
            });
            const chart = (rows: [number, number]): RecordOp => ({
                kind: 'record',
                sheet: 'b',
                type: 'chart',
                id: 'g',
                set: chartOf({ categories: null, series: [{ id: 's', name: 'n', values: ref('a', rows, [0, 0]) }] }),
                whole: 1,
            });
            const shifted = shiftOps([rule('=[a]!R5C1>0', 2), chart([4, 8])], lines(true, true, 3, 2));
            expect(shifted).toHaveLength(2);
            const [ruled, charted] = shifted ?? [];
            expect(ruled.kind === 'record' && ruled.type === 'conditionalFormat' && keyOfRule(ruled.set)).toBe(
                keyOfRule(formulaRule([[2, 0, 5, 0]], '=[a]!R7C1>0')),
            );
            expect(
                charted.kind === 'record' && charted.type === 'chart' && charted.whole && chartData(charted.set),
            ).toEqual(
                chartData(
                    chartOf({ categories: null, series: [{ id: 's', name: 'n', values: ref('a', [6, 10], [0, 0]) }] }),
                ),
            );
            expectSame(twoSheets(), [rule('=[a]!R5C1>0', 2), chart([4, 8])], lines(true, true, 3, 2));
            expectSame(twoSheets(), [rule('=[a]!R5C1>0', 2), chart([4, 8])], lines(true, false, 5, 2));
        });
    });

    describe('the laws, over random entries and edits', () => {
        // A key typed with a sheet's name is bound when it enters, and a rename binds the keys that wait for its name:
        // both read the sheet as it is then, which the shift of an op cannot know.
        const typedByName = (op: Op) => /'!R1C1\+1|"name":"Later"/.test(JSON.stringify(op));
        const draw = (random: Random, model: Model): Op => {
            for (;;) {
                // Frozen lines among the first, where a line edit often moves them.
                if (random() < 0.1) {
                    const sheet = [...model.sheets.keys()][below(random, model.sheets.size)];
                    const set =
                        random() < 0.5 ? { frozenRows: 1 + below(random, 9) } : { frozenColumns: 1 + below(random, 5) };
                    return { kind: 'record', sheet, type: 'sheet', id: sheet, set };
                }
                const op = [randomInputOp, randomFormatOp, randomRecordOp, randomLineReaderOp][below(random, 4)](
                    random,
                    model,
                );
                if (!typedByName(op)) return op;
            }
        };
        const count = (ops: readonly Op[], kind: Op['kind']) => ops.filter((op) => op.kind === kind).length;
        const keys = (ops: readonly Op[]) =>
            ops.flatMap((op) =>
                op.kind === 'input'
                    ? [
                          ...(op.runs ?? []).map(([, content]) => content?.f),
                          ...(op.cells ?? []).map(([, , content]) => content?.f),
                      ]
                    : [],
            );

        test('(a) the edit then the shifted ops is the ops then the edit; (b) outside inserted lines; (c) records', () => {
            const seen = { exact: 0, outside: 0, lost: 0, refused: 0, insert: 0, delete: 0, columns: 0 };
            const kinds = { cut: 0, rekeyed: 0, otherSheet: 0, cutRuns: 0, records: new Set<string>() };
            for (let seed = 1; seed <= 1000; seed += 1) {
                const random = randomOf(seed * 15_485_863);
                const content = randomBookContent(random);
                const model = modelOf(content);
                const ops = Array.from({ length: 1 + below(random, 4) }, () => draw(random, model));
                const edit = randomLinesOp(random, model);
                const first = new Workbook(structuredClone(content));
                const second = new Workbook(structuredClone(content));
                if (!lands(first, ops) || !lands(first, [edit]) || !lands(second, [edit])) {
                    seen.refused += 1;
                    continue;
                }
                const shifted = shiftOps(ops, edit) ?? [];
                applyOps(second, shifted);
                if (edit.insert) seen.insert += 1;
                else seen.delete += 1;
                if (!edit.rows) seen.columns += 1;
                // A record op whose record the edit took is dropped, and with it what the op replaced.
                if (count(shifted, 'record') < count(ops, 'record')) {
                    seen.lost += 1;
                    continue;
                }
                const said = keys(ops);
                const after = keys(shifted);
                if (after.some((f) => f !== undefined && !said.includes(f))) kinds.rekeyed += 1;
                if (after.length > said.length) kinds.cutRuns += 1;
                const of = <K extends Op['kind']>(list: readonly Op[], kind: K, here: boolean) =>
                    list.filter(
                        (op): op is Extract<Op, { kind: K }> =>
                            op.kind === kind && 'sheet' in op && (op.sheet === edit.sheet) === here,
                    );
                // No record op was dropped, and no input of another sheet ever is, so they stand in step.
                const records = [...of(shifted, 'record', true), ...of(shifted, 'record', false)];
                for (const [at, op] of [...of(ops, 'record', true), ...of(ops, 'record', false)].entries()) {
                    if (JSON.stringify(records[at]) !== JSON.stringify(op)) kinds.records.add(op.type);
                }
                const others = of(shifted, 'input', false);
                for (const [at, op] of of(ops, 'input', false).entries()) {
                    if (JSON.stringify(others[at]) !== JSON.stringify(op)) kinds.otherSheet += 1;
                }
                const ranges = (list: readonly Op[]) =>
                    of(list, 'format', true).reduce((sum, op) => sum + ('ranges' in op ? op.ranges.length : 0), 0);
                if (ranges(shifted) > ranges(ops)) kinds.cut += 1;
                // New lines wear the look of the line they are like: where a format of the entry holds that line,
                // they wear it only when the format came first.
                const { like } = edit;
                const inherits =
                    like !== undefined &&
                    ops.some(
                        (op) =>
                            op.kind === 'format' &&
                            op.sheet === edit.sheet &&
                            'ranges' in op &&
                            op.ranges.some(
                                (rect) => rect[edit.rows ? 0 : 1] <= like && like <= rect[edit.rows ? 2 : 3],
                            ),
                    );
                if (inherits) {
                    const back: LinesOp = { ...edit, insert: false, like: undefined };
                    applyOps(first, [back]);
                    applyOps(second, [back]);
                    seen.outside += 1;
                } else seen.exact += 1;
                expect(bytes(second), `seed ${seed}`).toBe(bytes(first));
            }
            expect(seen.exact).toBeGreaterThan(600);
            expect(seen.outside).toBeGreaterThan(8);
            expect(seen.insert).toBeGreaterThan(250);
            expect(seen.delete).toBeGreaterThan(300);
            expect(seen.columns).toBeGreaterThan(200);
            expect(kinds.cut).toBeGreaterThan(10);
            expect(kinds.rekeyed).toBeGreaterThan(40);
            expect(kinds.cutRuns).toBeGreaterThan(3);
            expect(kinds.otherSheet).toBeGreaterThan(10);
            expect([...kinds.records].sort()).toEqual([
                'chart',
                'comment',
                'conditionalFormat',
                'filter',
                'filterColumn',
                'merge',
                'sheet',
                'validation',
            ]);
        }, 30_000);
    });
});
