import { describe, expect, test } from 'bun:test';
import type { CellAttrKey, LOOK_KEYS, Op, OpKind, Records, RecordType, SheetContent } from '../../sheets/ops';
import { isStructural, opReferences } from '../../sheets/ops';
import { Refusal } from '../../sheets/refusal';

const NONE = { media: [], comments: [] };

const BOX = { index: 'a', x: 0, y: 0, width: 10, height: 10 };
const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const SPEC = {
    ...{ specChart: '{}', specTitle: '{}', specLegend: '{}', specAxes: '{}' },
    ...{ specPlots: '{}', specSeries: '{}', specPoints: '{}', specData: '{}' },
};
const WHOLE: { [T in RecordType]: Records[T] } = {
    sheet: { name: 'Sales', order: 'a' },
    merge: { rect: [0, 0, 1, 1] },
    filter: { rect: [0, 0, 20, 4] },
    filterColumn: { filter: 'f1', column: 2, rows: [[3, 3]] },
    comment: { row: 1, column: 1 },
    conditionalFormat: { ranges: [{ row: [0, 5], column: [0, 0] }], order: 'a', type: 'dataBar', format: ['#f00'] },
    validation: { ranges: [{ row: [0, 5], column: [1, 1] }], order: 'a', rule: RULE },
    image: { ...BOX, mediaName: 'photo.png' },
    chart: { ...BOX, ...SPEC },
};

// One `whole` make of every record type, each under the id of its own type.
const MAKES: Op[] = [
    { kind: 'record', sheet: 's1', type: 'sheet', id: 's1', set: WHOLE.sheet },
    { kind: 'record', sheet: 's1', type: 'merge', id: 'merge', whole: 1, set: WHOLE.merge },
    { kind: 'record', sheet: 's1', type: 'filter', id: 'filter', whole: 1, set: WHOLE.filter },
    { kind: 'record', sheet: 's1', type: 'filterColumn', id: 'filterColumn', whole: 1, set: WHOLE.filterColumn },
    { kind: 'record', sheet: 's1', type: 'comment', id: 'comment', whole: 1, set: WHOLE.comment },
    { kind: 'record', sheet: 's1', type: 'conditionalFormat', id: 'rule', whole: 1, set: WHOLE.conditionalFormat },
    { kind: 'record', sheet: 's1', type: 'validation', id: 'validation', whole: 1, set: WHOLE.validation },
    { kind: 'record', sheet: 's1', type: 'image', id: 'image', whole: 1, set: WHOLE.image },
    { kind: 'record', sheet: 's1', type: 'chart', id: 'chart', whole: 1, set: WHOLE.chart },
];

const ADDED: SheetContent = {
    id: 's2',
    fields: { name: 'Two', order: 'b' },
    cells: [[0, 0, { v: 1 }]],
    looks: [{ bl: 1 }],
    bands: [0, 1, 0, 1],
    rows: [],
    columns: [],
    records: {
        merge: { m1: WHOLE.merge },
        comment: { 'card-a': WHOLE.comment, 'card-b': { row: 4, column: 0 } },
        image: { i1: WHOLE.image, i2: { ...BOX, mediaName: 'chart.png' } },
        chart: { c1: WHOLE.chart },
    },
};

// One op of each kind but `record`, which has its own table below.
const OF_KIND: { [K in Exclude<OpKind, 'record'>]: Op } = {
    input: { kind: 'input', sheet: 's1', cells: [[0, 0, { v: 'photo.png' }]] },
    format: { kind: 'format', sheet: 's1', ranges: [[0, 0, 0, 0]], set: { bl: 1 } },
    result: { kind: 'result', sheet: 's1', cells: [[0, 0, { f: '=NOW()', v: 46000.5 }]] },
    lines: { kind: 'lines', sheet: 's1', rows: true, insert: true, index: 5, count: 2, like: 4 },
    move: { kind: 'move', sheet: 's1', from: [0, 0, 3, 3], toSheet: 's2', toRow: 10, toColumn: 0 },
    sheet: { kind: 'sheet', delete: 's2' },
};

describe('opReferences', () => {
    test.each([
        ['an input', OF_KIND.input],
        ['a cell format', OF_KIND.format],
        ['a line format', { kind: 'format', sheet: 's1', lines: 'rows', spans: [[0, 4]], set: { hidden: 1 } }],
        ['a result', OF_KIND.result],
        ['a lines edit', OF_KIND.lines],
        ['a move', OF_KIND.move],
        ['a sheet delete', OF_KIND.sheet],
    ] satisfies [string, Op][])('%s names nothing', (_name, op) => {
        expect(opReferences(op)).toEqual(NONE);
    });

    test('a sheet add names every image of its content and every comment, and nothing else', () => {
        expect(opReferences({ kind: 'sheet', add: ADDED })).toEqual({
            media: ['photo.png', 'chart.png'],
            comments: ['card-a', 'card-b'],
        });
        expect(opReferences({ kind: 'sheet', add: { ...ADDED, records: {} } })).toEqual(NONE);
    });

    test('of the makes of every record type, only an image names its media and only a comment its id', () => {
        expect(MAKES.map(opReferences)).toEqual([
            ...[NONE, NONE, NONE, NONE, { media: [], comments: ['comment'] }],
            ...[NONE, NONE, { media: ['photo.png'], comments: [] }, NONE],
        ]);
    });

    test.each([
        ['a field edit of an image to new media', { mediaName: 'other.png' }, ['other.png']],
        ['a field edit of an image that leaves its media', { x: 40 }, []],
        ['a field edit that clears an image media', { mediaName: null }, []],
        ['an image deleted', undefined, []],
    ] satisfies [string, { mediaName?: string | null; x?: number } | undefined, string[]][])(
        '%s names that media only',
        (_name, set, media) => {
            expect(opReferences({ kind: 'record', sheet: 's1', type: 'image', id: 'i1', set })).toEqual({
                media,
                comments: [],
            });
        },
    );

    test('a comment moved to another cell or deleted names nothing: only its make brings the card in', () => {
        const moved: Op = { kind: 'record', sheet: 's1', type: 'comment', id: 'card-a', set: { row: 9 } };
        const deleted: Op = { kind: 'record', sheet: 's1', type: 'comment', id: 'card-a' };
        const wholeWithNoSet: Op = { kind: 'record', sheet: 's1', type: 'comment', id: 'card-a', whole: 1 };
        expect([moved, deleted, wholeWithNoSet].map(opReferences)).toEqual([NONE, NONE, NONE]);
    });
});

describe('isStructural', () => {
    test('lines, move and sheet renumber places; input, format, result and record do not', () => {
        const kinds = [...Object.values(OF_KIND), MAKES[1]];
        expect(kinds.map((op) => [op.kind, isStructural(op)])).toEqual([
            ['input', false],
            ['format', false],
            ['result', false],
            ['lines', true],
            ['move', true],
            ['sheet', true],
            ['record', false],
        ]);
        expect(isStructural({ kind: 'sheet', add: ADDED })).toBe(true);
    });
});

test('a refusal carries its key, which is also its message', () => {
    const refusal = new Refusal('merge-cut');
    expect([refusal instanceof Error, refusal.key, refusal.message]).toEqual([true, 'merge-cut', 'merge-cut']);
});

// Checked when the tests are compiled: an op holds only the shapes of the vocabulary.
describe('the shapes an op may take', () => {
    test('a shape outside the vocabulary does not compile', () => {
        const rows: Op[] = [
            // @ts-expect-error a cell holds no key outside its content, such as the old display text
            { kind: 'input', sheet: 's', cells: [[0, 0, { m: '5' }]] },
            // @ts-expect-error an op names places, never a path into a sheet
            { kind: 'input', sheet: 's', path: ['data', 0, 0] },
            // @ts-expect-error a record's fields are those of its own type
            { kind: 'record', sheet: 's', type: 'merge', id: 'm', set: { mediaName: 'x' } },
            // @ts-expect-error a kind that is gone
            { kind: 'field', sheet: 's' },
            // @ts-expect-error a look is never part of a cell's content
            { kind: 'input', sheet: 's', cells: [[0, 0, { v: 1, bl: 1 }]] },
            // @ts-expect-error nor is this kind, which `input` replaced
            { kind: 'cells', sheet: 's', cells: [] },
            // @ts-expect-error `clear` names keys one by one, with no word for the rest
            { kind: 'format', sheet: 's', ranges: [[0, 0, 0, 0]], clear: 'rest' },
            // @ts-expect-error a result is for a formula, so it names one
            { kind: 'result', sheet: 's', cells: [[0, 0, { v: 1 }]] },
            // @ts-expect-error an input empties with null content, never with a list of rectangles
            { kind: 'input', sheet: 's', clear: [[0, 0, 1, 1]] },
        ];
        expect(rows.length).toBe(9);
    });

    test('a conditional-format rule is made with its own fields, and one of them edited alone', () => {
        const rows: Op[] = [
            {
                kind: 'record',
                sheet: 's',
                type: 'conditionalFormat',
                id: 'r',
                whole: 1,
                set: {
                    ranges: [{ row: [0, 5], column: [0, 0] }],
                    order: 'a',
                    type: 'default',
                    format: { cellColor: '#f00' },
                    conditionName: 'greaterThan',
                    conditionValue: [5],
                },
            },
            { kind: 'record', sheet: 's', type: 'conditionalFormat', id: 'r', set: { conditionValue: [6] } },
        ];
        expect(rows.length).toBe(2);
    });

    test('every look key is in LOOK_KEYS', () => {
        const everyKeyListed: Exclude<CellAttrKey, (typeof LOOK_KEYS)[number]> extends never ? true : never = true;
        expect(everyKeyListed).toBe(true);
    });
});
