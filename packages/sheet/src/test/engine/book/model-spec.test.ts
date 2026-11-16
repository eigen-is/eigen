import { describe, expect, test } from 'bun:test';
import type { Op, SheetContent, SheetFields } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';
import { linesOp, moveOp } from './book-fixtures';
import { contentOfModel, modelAfter, modelOf } from './model';
import { chartData, chartOf, formulaRule, keyOfRule, LAST_COLUMN, LAST_ROW, ref } from './records-fixtures';

// The parts of the model that mirror the store's own rules, held to cases worked out by hand from the words of
// SPEC-W § 1b and § 1d alone, with its amendments over them, and run against the model and the workbook both, so an
// error the two share cannot pass.

type Read = Pick<SheetContent, 'fields' | 'records'>;
type Part = { fields?: Partial<SheetFields>; records?: SheetContent['records'] };
type Case = {
    name: string;
    sheets: { S?: Part; T?: Part };
    ops: Op[];
    read: (sheets: ReadonlyMap<string, Read>) => unknown;
    expected: unknown;
};

const FILTER = { rect: [2, 0, 20, 4] } as const;
const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };

function bookOf({ S, T }: Case['sheets']): Book {
    const sheet = (id: string, order: string, part: Part = {}): SheetContent => {
        const fields: SheetFields = { name: id, order, ...part.fields };
        return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: part.records ?? {} };
    };
    return { g: 1, now: 1, seed: 1, computed: false, sheets: [sheet('S', 'a0', S), sheet('T', 'a1', T)] };
}

function product({ sheets, ops, read }: Case): unknown {
    const book = new Workbook(bookOf(sheets));
    try {
        applyOps(book, ops);
    } catch (error) {
        if (error instanceof Refusal) return { refused: error.key };
        throw error;
    }
    return read(new Map(book.content().sheets.map((sheet) => [sheet.id, sheet])));
}

function model({ sheets, ops, read }: Case): unknown {
    const next = modelAfter(modelOf(bookOf(sheets)), { now: 1, seed: 1, ops });
    if (typeof next === 'string') return { refused: next };
    return read(new Map(contentOfModel(next).sheets.map((sheet) => [sheet.id, sheet])));
}

const onS = (read: (sheet: Read) => unknown) => (sheets: ReadonlyMap<string, Read>) => {
    const sheet = sheets.get('S');
    return sheet && read(sheet);
};
const filterRect = onS(({ records }) => records.filter?.f?.rect);
const mergeRect = onS(({ records }) => records.merge?.m?.rect);
const ruleOf = onS(({ records }) => {
    const rule = records.conditionalFormat?.r;
    return rule && { ranges: rule.ranges, key: keyOfRule(rule) };
});
const frozen = onS(({ fields }) => [fields.frozenRows, fields.frozenColumns]);
const validationRanges = onS(({ records }) => records.validation?.v?.ranges);
const chartRows = (id: 'S' | 'T') => (sheets: ReadonlyMap<string, Read>) => {
    const data = chartData(sheets.get(id)?.records.chart?.c);
    return data?.series[0].values?.row ?? null;
};
const chartOn = (sheet: string, row: [number, number]) => ({
    chart: { c: chartOf({ categories: null, series: [{ id: 's', name: 'n', values: ref(sheet, row, [0, 0]) }] }) },
});
const rows = (insert: boolean, index: number, count = 1) => linesOp(true, insert, index, count);
const columns = (insert: boolean, index: number, count = 1) => linesOp(false, insert, index, count);

const CASES: Case[] = [
    // The filter header row.
    // § 1d Records under lines: the filter rectangle, mapSpan, except that an end on the last line stays there.
    // § 1d: an insert inside a range grows it.
    // § 1d: a range that is gone is removed, a record with no range left is removed.
    {
        name: 'a filter loses rows inside it',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [rows(false, 5, 2)],
        read: filterRect,
        expected: [2, 0, 18, 4],
    },
    {
        name: 'a filter grows by an insert inside it',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [rows(true, 10, 2)],
        read: filterRect,
        expected: [2, 0, 22, 4],
    },
    {
        name: 'a filter moves down by an insert above it',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [rows(true, 0)],
        read: filterRect,
        expected: [3, 0, 21, 4],
    },
    {
        name: 'a filter to the last row keeps its end under an insert',
        sheets: { S: { records: { filter: { f: { rect: [2, 0, LAST_ROW, 4] } } } } },
        ops: [rows(true, 5)],
        read: filterRect,
        expected: [2, 0, LAST_ROW, 4],
    },
    {
        name: 'a filter to the last row keeps its end under a delete',
        sheets: { S: { records: { filter: { f: { rect: [2, 0, LAST_ROW, 4] } } } } },
        ops: [rows(false, 5, 3)],
        read: filterRect,
        expected: [2, 0, LAST_ROW, 4],
    },
    {
        name: 'a filter whose rows are all deleted is removed',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [rows(false, 2, 19)],
        read: filterRect,
        expected: undefined,
    },
    {
        name: 'a filter loses its first column',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [columns(false, 0)],
        read: filterRect,
        expected: [2, 0, 20, 3],
    },
    // Amendment 1 § 5: a filter whose header line is deleted is removed.
    {
        name: 'a filter whose header row is deleted is removed',
        sheets: { S: { records: { filter: { f: FILTER } } } },
        ops: [rows(false, 2)],
        read: filterRect,
        expected: undefined,
    },
    // The merge cut to one cell.
    // § 1d: a merge, mapSpan; GONE removes the record; a delete clips a merge.
    {
        name: 'a merge loses a row inside it',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 7, 6] } } } } },
        ops: [rows(false, 6)],
        read: mergeRect,
        expected: [5, 5, 6, 6],
    },
    {
        name: 'a merge whose rows are all deleted is removed',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 7, 6] } } } } },
        ops: [rows(false, 4, 5)],
        read: mergeRect,
        expected: undefined,
    },
    {
        name: 'a merge grows by an insert inside it',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 7, 6] } } } } },
        ops: [rows(true, 6, 2)],
        read: mergeRect,
        expected: [5, 5, 9, 6],
    },
    {
        name: 'a merge on a line an insert pushes off refuses it',
        sheets: { S: { records: { merge: { m: { rect: [LAST_ROW - 1, 0, LAST_ROW, 0] } } } } },
        ops: [rows(true, 0)],
        read: mergeRect,
        expected: { refused: 'grid-end' },
    },
    // Amendment 1 § 5: a merge a delete cuts to one cell is removed.
    {
        name: 'a merge of two cells a delete cuts to one is removed',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 6, 5] } } } } },
        ops: [rows(false, 6)],
        read: mergeRect,
        expected: undefined,
    },
    // The host choice of a rule formula.
    // § 1d Rule formulas: hosted at the top-left of its first range; when the host line is deleted, the first surviving line of the first range, or the top-left of the first surviving range.
    {
        name: 'a rule whose host line is deleted is read on the first line of its first range that stays',
        sheets: { S: { records: { conditionalFormat: { r: formulaRule([[3, 0, 5, 0]], '=R[-2]C>0') } } } },
        ops: [rows(false, 3)],
        read: ruleOf,
        expected: { ranges: [[3, 0, 4, 0]], key: '=R[-1]C>0' },
    },
    {
        name: 'a rule whose first range is deleted is read at the top-left of the first range that stays',
        sheets: {
            S: {
                records: {
                    conditionalFormat: {
                        r: formulaRule(
                            [
                                [3, 0, 4, 0],
                                [8, 0, 8, 0],
                            ],
                            '=R[-4]C>0',
                        ),
                    },
                },
            },
        },
        ops: [rows(false, 3, 2)],
        read: ruleOf,
        expected: { ranges: [[6, 0, 6, 0]], key: '=#REF!>0' },
    },
    {
        name: 'a rule is read at its first range, not its topmost one',
        sheets: {
            S: {
                records: {
                    conditionalFormat: {
                        r: formulaRule(
                            [
                                [5, 0, 6, 0],
                                [1, 0, 1, 0],
                            ],
                            '=R[-3]C>0',
                        ),
                    },
                },
            },
        },
        ops: [rows(true, 3)],
        read: ruleOf,
        expected: {
            ranges: [
                [6, 0, 7, 0],
                [1, 0, 1, 0],
            ],
            key: '=R[-4]C>0',
        },
    },
    {
        name: 'a rule of another sheet follows the lines it reads',
        sheets: { T: { records: { conditionalFormat: { r: formulaRule([[0, 0, 0, 0]], '=[S]!R5C1>0') } } } },
        ops: [rows(false, 2)],
        read: (sheets) => keyOfRule(sheets.get('T')?.records.conditionalFormat?.r),
        expected: '=[S]!R4C1>0',
    },
    {
        name: 'a rule with no range left is removed',
        sheets: { S: { records: { conditionalFormat: { r: formulaRule([[3, 0, 3, 0]], '=RC>0') } } } },
        ops: [rows(false, 3)],
        read: ruleOf,
        expected: undefined,
    },
    // The freeze under line edits.
    // § 1d: an insert before the freeze adds count; a delete from index < frozen subtracts min(count, frozen − index).
    {
        name: 'an insert inside the freeze adds its count',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(true, 1, 2)],
        read: frozen,
        expected: [5, undefined],
    },
    {
        name: 'an insert at the first line adds its count',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(true, 0)],
        read: frozen,
        expected: [4, undefined],
    },
    {
        name: 'an insert right below the freeze leaves it',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(true, 3)],
        read: frozen,
        expected: [3, undefined],
    },
    {
        name: 'a delete that reaches past the freeze takes its frozen lines',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(false, 1, 5)],
        read: frozen,
        expected: [1, undefined],
    },
    {
        name: 'a delete of every frozen line leaves no freeze',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(false, 0, 3)],
        read: frozen,
        expected: [undefined, undefined],
    },
    {
        name: 'a delete below the freeze leaves it',
        sheets: { S: { fields: { frozenRows: 3 } } },
        ops: [rows(false, 4)],
        read: frozen,
        expected: [3, undefined],
    },
    {
        name: 'a column delete inside the column freeze takes one',
        sheets: { S: { fields: { frozenColumns: 2 } } },
        ops: [columns(false, 0)],
        read: frozen,
        expected: [undefined, 1],
    },
    // A whole axis under line edits.
    // § 1d Records under lines: the filter rectangle, mapSpan, except that an end on the last line stays there.
    // § 1b: a record range that reaches the last line is open-ended: it stays reaching the end.
    // Amendment 1 § 5: a rule range over a whole axis stays whole under any line edit.
    {
        name: 'a range over the whole column stays whole under an insert at the first row',
        sheets: { S: { records: { validation: { v: { ranges: [[0, 0, LAST_ROW, 0]], order: 'a0', rule: RULE } } } } },
        ops: [rows(true, 0)],
        read: validationRanges,
        expected: [[0, 0, LAST_ROW, 0]],
    },
    {
        name: 'a range over the whole column stays whole under a delete at the first row',
        sheets: { S: { records: { validation: { v: { ranges: [[0, 0, LAST_ROW, 0]], order: 'a0', rule: RULE } } } } },
        ops: [rows(false, 0, 2)],
        read: validationRanges,
        expected: [[0, 0, LAST_ROW, 0]],
    },
    {
        name: 'a range to the last row moves its start and keeps its end',
        sheets: { S: { records: { validation: { v: { ranges: [[2, 0, LAST_ROW, 0]], order: 'a0', rule: RULE } } } } },
        ops: [rows(true, 0)],
        read: validationRanges,
        expected: [[3, 0, LAST_ROW, 0]],
    },
    {
        name: 'a range to the last column keeps its end under a column insert',
        sheets: {
            S: { records: { validation: { v: { ranges: [[2, 3, 4, LAST_COLUMN]], order: 'a0', rule: RULE } } } },
        },
        ops: [columns(true, 5, 2)],
        read: validationRanges,
        expected: [[2, 3, 4, LAST_COLUMN]],
    },
    {
        name: 'a range whose column is deleted is removed',
        sheets: { S: { records: { validation: { v: { ranges: [[5, 0, 9, 0]], order: 'a0', rule: RULE } } } } },
        ops: [columns(false, 0)],
        read: validationRanges,
        expected: undefined,
    },
    // Chart refs under lines.
    // § 1d: chart refs go through mapChartRefs (no reach rule given: they follow lines as a range does).
    {
        name: 'a chart ref loses a row inside it',
        sheets: { S: { records: chartOn('S', [2, 8]) } },
        ops: [rows(false, 4)],
        read: chartRows('S'),
        expected: [2, 7],
    },
    {
        name: 'a chart ref moves down by an insert above it',
        sheets: { S: { records: chartOn('S', [2, 8]) } },
        ops: [rows(true, 0)],
        read: chartRows('S'),
        expected: [3, 9],
    },
    {
        name: 'a chart ref grows by an insert inside it',
        sheets: { S: { records: chartOn('S', [2, 8]) } },
        ops: [rows(true, 5, 2)],
        read: chartRows('S'),
        expected: [2, 10],
    },
    {
        name: 'a chart ref whose rows are all deleted is emptied',
        sheets: { S: { records: chartOn('S', [2, 8]) } },
        ops: [rows(false, 2, 7)],
        read: chartRows('S'),
        expected: null,
    },
    {
        name: 'a chart on another sheet follows the lines it reads',
        sheets: { T: { records: chartOn('S', [2, 8]) } },
        ops: [rows(false, 0, 2)],
        read: chartRows('T'),
        expected: [0, 6],
    },
    // A move, planned on every sheet before it writes.
    // § 1d move: a merge the block cuts: merge-cut; a target merge partly covered: merge-cut; wholly covered: removed.
    // § 1a move: comments in it, merges wholly in it, and on one sheet the rule ranges wholly in it go along.
    {
        name: 'a block that cuts a merge refuses',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 6, 6] } } } } },
        ops: [moveOp([5, 5, 5, 6], 30, 30)],
        read: mergeRect,
        expected: { refused: 'merge-cut' },
    },
    {
        name: 'a block that lands on part of a merge refuses',
        sheets: { S: { records: { merge: { m: { rect: [30, 30, 31, 31] } } } } },
        ops: [moveOp([0, 0, 0, 0], 30, 30)],
        read: mergeRect,
        expected: { refused: 'merge-cut' },
    },
    {
        name: 'a block that lands on part of a merge of another sheet refuses',
        sheets: { T: { records: { merge: { m: { rect: [30, 30, 31, 31] } } } } },
        ops: [moveOp([0, 0, 0, 0], 31, 31, 'T')],
        read: mergeRect,
        expected: { refused: 'merge-cut' },
    },
    {
        name: 'a block that lands on a whole merge removes it',
        sheets: { S: { records: { merge: { m: { rect: [30, 30, 30, 31] } } } } },
        ops: [moveOp([0, 0, 1, 2], 30, 30)],
        read: mergeRect,
        expected: undefined,
    },
    {
        name: 'a merge wholly in the block goes along',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 6, 6] } } } } },
        ops: [moveOp([4, 4, 7, 7], 10, 10)],
        read: mergeRect,
        expected: [11, 11, 12, 12],
    },
    {
        name: 'a merge wholly in the block goes along to another sheet',
        sheets: { S: { records: { merge: { m: { rect: [5, 5, 6, 6] } } } } },
        ops: [moveOp([4, 4, 7, 7], 10, 10, 'T')],
        read: (sheets) => [sheets.get('S')?.records.merge?.m, sheets.get('T')?.records.merge?.m?.rect],
        expected: [undefined, [11, 11, 12, 12]],
    },
    {
        name: 'a comment in the block goes along',
        sheets: { S: { records: { comment: { c: { row: 3, column: 1 } } } } },
        ops: [moveOp([3, 1, 3, 1], 8, 2)],
        read: onS(({ records }) => records.comment?.c),
        expected: { row: 8, column: 2 },
    },
    {
        name: 'a comment the block lands on is removed',
        sheets: { S: { records: { comment: { c: { row: 8, column: 2 } } } } },
        ops: [moveOp([3, 1, 3, 1], 8, 2)],
        read: onS(({ records }) => records.comment?.c),
        expected: undefined,
    },
    {
        name: 'a rule range wholly in the block goes along on one sheet',
        sheets: { S: { records: { validation: { v: { ranges: [[2, 2, 3, 2]], order: 'a0', rule: RULE } } } } },
        ops: [moveOp([2, 2, 3, 2], 10, 5)],
        read: validationRanges,
        expected: [[10, 5, 11, 5]],
    },
    {
        name: 'a rule range wholly in the block stays when the block goes to another sheet',
        sheets: { S: { records: { validation: { v: { ranges: [[2, 2, 3, 2]], order: 'a0', rule: RULE } } } } },
        ops: [moveOp([2, 2, 3, 2], 10, 5, 'T')],
        read: validationRanges,
        expected: [[2, 2, 3, 2]],
    },
    {
        name: 'a rule range partly in the block stays',
        sheets: { S: { records: { validation: { v: { ranges: [[2, 2, 5, 2]], order: 'a0', rule: RULE } } } } },
        ops: [moveOp([2, 2, 3, 2], 10, 5)],
        read: validationRanges,
        expected: [[2, 2, 5, 2]],
    },
];

describe('engine/book — the model and the workbook against the words of the spec', () => {
    for (const row of CASES) {
        test(`the workbook: ${row.name}`, () => expect(product(row)).toEqual(row.expected));
        test(`the model: ${row.name}`, () => expect(model(row)).toEqual(row.expected));
    }
});
