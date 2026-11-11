import { describe, expect, test } from 'bun:test';
import { newChartSpecParts, sampleChartSpec } from '../../charts';
import { MAX_CONDITIONAL_FORMATS, MAX_VALIDATIONS } from '../../sheets/range-rules';
import type { ConditionalFormatRule, Op, Sheet, SheetChart, SheetImage } from '../../sheets/types';
import { applySheetWrites, opToPatchOnSheets } from '../../sheets/yjs-ops';

const SHEETS: Sheet[] = [
    { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} },
    { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} },
];

describe('opToPatchOnSheets', () => {
    test('drops a write to the stored cell list or the whole sheet, which only a reader without a matrix would apply', () => {
        const link = { type: 'sheet', address: 5 };
        const ops: Op[] = [
            { op: 'replace', id: SHEETS[0].id, path: ['celldata'], value: [{ r: 0, c: 0, v: { link } }] },
            { op: 'add', id: SHEETS[0].id, path: ['celldata', 0], value: { r: 0, c: 0, v: { link } } },
            { op: 'replace', id: SHEETS[0].id, path: ['celldata', 0, 'v', 'link'], value: link },
            { op: 'replace', id: SHEETS[0].id, path: [], value: { id: SHEETS[0].id, celldata: [] } },
        ];
        expect(opToPatchOnSheets(SHEETS, ops)).toEqual([]);
    });

    test('drops a link of a kind no reader follows, and keeps the kinds they do', () => {
        const write = (type: string): Op => ({
            op: 'replace',
            id: SHEETS[0].id,
            path: ['data', 0, 0, 'link'],
            value: { type, address: 'Sheet1!A1' },
        });
        const patches = opToPatchOnSheets(SHEETS, ['file', 'webpage', 'cellrange', 'sheet'].map(write));
        expect(patches.map((patch) => patch.value.type)).toEqual(['webpage', 'cellrange', 'sheet']);
    });

    test('replace op on existing sheet → patch with [i, ...path]', () => {
        const ops: Op[] = [{ op: 'replace', id: 'sheet-2', path: ['data', 0, 0, 'v'], value: 42 }];
        expect(opToPatchOnSheets(SHEETS, ops)).toEqual([{ op: 'replace', value: 42, path: [1, 'data', 0, 0, 'v'] }]);
    });

    test('orphan op (sheet id not in array) → dropped', () => {
        const ops: Op[] = [{ op: 'replace', id: 'sheet-missing', path: ['celldata', 0], value: 99 }];
        expect(opToPatchOnSheets(SHEETS, ops)).toEqual([]);
    });

    test('op with no id → dropped (no Sheet[]-rooted mapping)', () => {
        // immer emits a whole ['sheets'] replace when a recipe reassigns ctx.sheets, which names no sheet.
        const ops: Op[] = [
            { op: 'replace', path: ['sheets'], value: SHEETS },
            { op: 'add', path: ['something'], value: 1 },
        ];
        const patches = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([]);
    });

    test('a sheet, row or column op is left to the caller', () => {
        const ops: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['color'], value: 'red' },
            { op: 'addSheet', path: [], value: { id: 'sheet-3', name: 'Sheet3' } },
            { op: 'deleteSheet', path: [], value: { id: 'sheet-2' } },
        ];
        expect(opToPatchOnSheets(SHEETS, ops)).toEqual([{ op: 'replace', value: 'red', path: [0, 'color'] }]);
    });

    // A peer can store anything under an id, and every reader walks an entry's ranges, so a write that would leave an
    // entry not well formed never applies.
    test('a validation write applies only when it leaves every entry well formed', () => {
        const entry = {
            ranges: [{ row: [0, 9], column: [1, 1] }],
            order: 'a0',
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const ops: Op[] = [
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v1'], value: entry },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations', 'v1'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { v1: entry } },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v2'], value: { ...entry, ranges: 'A1' } },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { v1: entry, v2: {} } },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'v1', 'ranges'], value: [] },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v3'], value: { ...entry, order: undefined } },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v4'], value: { ...entry, order: 'not a key' } },
        ];
        const patches = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([
            { op: 'add', value: entry, path: [0, 'dataValidations', 'v1'] },
            { op: 'remove', value: undefined, path: [0, 'dataValidations', 'v1'] },
            { op: 'replace', value: { v1: entry }, path: [0, 'dataValidations'] },
        ]);
    });
});

// A batch as every reader lands it: the ops no sheet can take left out, the rest applied one by one. The sheets a
// reader holds are a store's, frozen, so the apply writes on copies.
function landed(sheets: Sheet[], ops: Op[]) {
    const before = structuredClone(sheets);
    const written = applySheetWrites(sheets, opToPatchOnSheets(sheets, ops));
    expect(sheets).toEqual(before);
    return written;
}

describe('applySheetWrites', () => {
    const BOX = { x: 10, y: 20, width: 40, height: 30 };
    const image = (id: string, index: string): SheetImage => ({ id, index, ...BOX, mediaName: `${id}.png` });
    const chart = (id: string, index: string): SheetChart => ({
        id,
        index,
        ...BOX,
        ...newChartSpecParts(sampleChartSpec('column')),
    });
    const cell = (v: string) => ({ v, m: v });
    const sheets = (): Sheet[] => [
        {
            id: 's1',
            name: 'S',
            data: [
                [cell('a'), null],
                [null, cell('d')],
            ],
            config: { rowlen: { 0: 30 } },
            images: {},
            charts: { c1: chart('c1', 'a1') },
        },
    ];
    const write = (op: Op['op'], path: Op['path'], value?: unknown): Op => ({ op, id: 's1', path, value });
    const paths = (ops: Op[], stored = sheets()) =>
        landed(stored, ops).applied.map(({ path }) => path.slice(1).join('/'));

    test('a write lands when everything above it is there, and is skipped alone when it is not', () => {
        const ops = [
            write('replace', ['data', 0, 0, 'v'], 'b'),
            write('add', ['data', 0, 1, 'bg'], '#ff0000'),
            write('replace', ['data', 2, 0], cell('x')),
            write('replace', ['data', 0, 2], cell('x')),
            write('replace', ['data', 5], [null, null]),
            write('replace', ['data', -1], [null, null]),
            write('replace', ['data', 0.5], [null, null]),
            write('replace', ['data', '0'], [null, null]),
            write('remove', ['data', 2]),
            write('remove', ['data', 1]),
            write('remove', ['data', 0, 1]),
            write('remove', ['data']),
            write('replace', ['data', 'length'], 5),
            write('replace', ['data', 0, 0, 'v', 'deeper'], 1),
            write('add', ['filter', '1'], {}),
            write('remove', ['config', 'rowlen', '7']),
            write('add', ['config', '__proto__'], { polluted: true }),
            write('replace', ['data', 1, 1], cell('e')),
            write('replace', ['color'], 'red'),
        ];
        const { sheets: next, applied } = landed(sheets(), ops);
        expect(applied.map(({ path }) => path.slice(1).join('/'))).toEqual(['data/0/0/v', 'data/1/1', 'color']);
        expect(next[0].data).toEqual([
            [{ v: 'b', m: 'a' }, null],
            [null, cell('e')],
        ]);
        expect(next[0].color).toBe('red');
        expect(Object.getPrototypeOf(next[0].config)).toBe(Object.prototype);
    });

    test('a path that holds anything but text and numbers is no write', () => {
        const forged: Op[] = JSON.parse(
            '[{"op":"add","id":"s1","path":["config",["__proto__"]],"value":{"polluted":true}}]',
        );
        const { sheets: next, applied } = landed(sheets(), forged);
        expect(applied).toEqual([]);
        expect(Object.getPrototypeOf(next[0].config)).toBe(Object.prototype);
    });

    test('an add puts a row in at its index, at the end past it, and a shorter length cuts the array', () => {
        const row = (v: string) => [cell(v), null];
        const grown = landed(sheets(), [write('add', ['data', 1], row('in')), write('add', ['data', 9], row('end'))]);
        expect(grown.sheets[0].data?.map((r) => r[0]?.v)).toEqual(['a', 'in', undefined, 'end']);
        const cut = landed(grown.sheets, [write('replace', ['data', 'length'], 2)]);
        expect(cut.sheets[0].data?.map((r) => r[0]?.v)).toEqual(['a', 'in']);
    });

    test('copies only what a write changes, and writes into no value a batch brought', () => {
        const stored = sheets();
        const brought = { c9: chart('c9', 'a9') };
        const { sheets: next } = landed(stored, [
            write('replace', ['data', 0, 0, 'v'], 'b'),
            write('replace', ['charts'], brought),
            write('replace', ['charts', 'c9', 'x'], 99),
            write('replace', ['config', 'rowlen', '0'], 30),
        ]);
        expect(next[0].data?.[1]).toBe(stored[0].data?.[1]);
        expect(next[0].config).toBe(stored[0].config);
        expect(next[0].charts?.c9.x).toBe(99);
        expect(brought.c9.x).toBe(10);
    });

    test('a write into an object lands where the batch has left it, else where it stood', () => {
        expect(
            paths([
                write('replace', ['charts', 'gone', 'x'], 1),
                write('add', ['charts', 'c2'], chart('c2', 'a2')),
                write('replace', ['charts', 'c2', 'x'], 1),
                write('replace', ['charts', 'c1', 'x'], 1),
                write('remove', ['charts', 'c1']),
                write('replace', ['charts', 'c1', 'y'], 1),
                write('replace', ['images'], { i1: image('i1', 'a0') }),
                write('replace', ['images', 'i1', 'x'], 1),
                write('replace', ['images', 'i1', 'x', 'y'], 1),
            ]),
        ).toEqual(['charts/c2', 'charts/c2/x', 'charts/c1/x', 'charts/c1', 'images', 'images/i1/x']);
    });

    // A chart's fields are plain values, a part one string, so nothing is written below one.
    test("a chart's part is written whole, and a write below any field of a chart is dropped", () => {
        const series = '{"s-1":{"color":"#ff0000"}}';
        const written = landed(sheets(), [
            write('replace', ['charts', 'c1', 'specSeries'], series),
            write('add', ['charts', 'c1', 'specPoints', 's-1/3'], '{"color":"#ff0000"}'),
            write('add', ['charts', 'c1', 'specTitle', 'text'], 'Goals'),
            write('add', ['charts', 'c1', 'future', 'a'], 1),
            write('replace', ['charts', 'c1', 'x'], 99),
        ]);
        expect(written.applied.map(({ path }) => path.slice(1).join('/'))).toEqual([
            'charts/c1/specSeries',
            'charts/c1/x',
        ]);
        expect(written.sheets[0].charts?.c1).toEqual({ ...chart('c1', 'a1'), specSeries: series, x: 99 });
    });

    // A whole-entry write over a rule a peer deleted would bring the rule back. Immer writes `add` for an id its base
    // lacked, so a `replace` means the writer saw the rule, and where it is gone the delete wins.
    test('a whole-entry replace of a rule the sheet no longer holds is dropped', () => {
        const entry = {
            ranges: [{ row: [0, 9], column: [1, 1] }],
            order: 'a0',
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const sheets: Sheet[] = [{ ...SHEETS[0], dataValidations: { x: entry } }];
        const ops: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'gone'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'x'], value: entry },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations', 'x'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'x'], value: entry },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { z: entry } },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'z'], value: entry },
        ];
        expect(landed(sheets, ops).applied.map(({ op, path }) => [op, ...path])).toEqual([
            ['replace', 0, 'dataValidations', 'x'],
            ['remove', 0, 'dataValidations', 'x'],
            ['add', 0, 'dataValidations', 'y'],
            ['replace', 0, 'dataValidations', 'y'],
            ['replace', 0, 'dataValidations'],
            ['replace', 0, 'dataValidations', 'z'],
        ]);
    });

    test('a new rule on a sheet that holds as many rules as a sheet may is dropped, and a changed one applies', () => {
        const entry = {
            ranges: [{ row: [0, 0], column: [0, 0] }],
            order: 'a0',
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const full = Object.fromEntries(Array.from({ length: MAX_VALIDATIONS }, (_, i) => [`v${i}`, entry]));
        const sheets: Sheet[] = [{ ...SHEETS[0], dataValidations: full }];
        const ops: Op[] = [
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'new'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'v0'], value: entry },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations', 'v1'] },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'next'], value: entry },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'over'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { one: entry } },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'two'], value: entry },
        ];
        expect(landed(sheets, ops).applied.map(({ path }) => path.slice(2).join('/'))).toEqual([
            'v0',
            'v1',
            'next',
            '',
            'two',
        ]);
    });

    const format = (order: string, cellColor = '#ff0000'): ConditionalFormatRule => ({
        type: 'default',
        ranges: [{ row: [0, 0], column: [0, 0] }],
        order,
        format: { cellColor },
        conditionName: 'greaterThan',
        conditionValue: [1],
    });
    const formats = (stored: Sheet[]) => Object.keys(stored[0].conditionalFormats ?? {});

    test('two peers adding a conditional format at once keep both, on a sheet that had none', () => {
        const base: Sheet[] = [{ ...SHEETS[0], conditionalFormats: {} }];
        const fromA: Op[] = [{ op: 'add', id: 'sheet-1', path: ['conditionalFormats', 'a'], value: format('a0') }];
        const fromB: Op[] = [{ op: 'add', id: 'sheet-1', path: ['conditionalFormats', 'b'], value: format('a0') }];
        const after = landed(landed(base, fromA).sheets, fromB).sheets;
        expect(formats(after)).toEqual(['a', 'b']);
    });

    test("a delete by id takes its own rule out after a peer's add and delete moved the others", () => {
        const base: Sheet[] = [{ ...SHEETS[0], conditionalFormats: { x: format('a0'), y: format('a1') } }];
        const peer: Op[] = [
            { op: 'remove', id: 'sheet-1', path: ['conditionalFormats', 'x'] },
            { op: 'add', id: 'sheet-1', path: ['conditionalFormats', 'w'], value: format('Zz') },
        ];
        const mine: Op[] = [
            { op: 'remove', id: 'sheet-1', path: ['conditionalFormats', 'y'] },
            { op: 'replace', id: 'sheet-1', path: ['conditionalFormats', 'x'], value: format('a0', '#00ff00') },
        ];
        const after = landed(landed(base, peer).sheets, mine);
        expect(formats(after.sheets)).toEqual(['w']);
        expect(after.applied.map(({ path }) => path[2])).toEqual(['y']);
    });

    test('a conditional format that is not well formed, or past the cap, is dropped', () => {
        const full = Object.fromEntries(
            Array.from({ length: MAX_CONDITIONAL_FORMATS - 1 }, (_, i) => [`f${i}`, format('a0')]),
        );
        const base: Sheet[] = [{ ...SHEETS[0], conditionalFormats: full }];
        const add = (id: string, value: unknown): Op => ({
            op: 'add',
            id: 'sheet-1',
            path: ['conditionalFormats', id],
            value,
        });
        const ops: Op[] = [
            add('noOrder', { ...format('a0'), order: undefined }),
            add('badKey', { ...format('a0'), order: 'a0 ' }),
            add('noRanges', { ...format('a0'), ranges: [] }),
            add('oldShape', { type: 'default', cellrange: [{ row: [0, 0], column: [0, 0] }], format: {} }),
            add('badStop', { type: 'colorGradation', ranges: format('a0').ranges, order: 'a0', format: ['red'] }),
            { op: 'replace', id: 'sheet-1', path: ['conditionalFormats', 'f0', 'ranges'], value: [] },
            add('last', format('a1')),
            add('over', format('a2')),
        ];
        expect(landed(base, ops).applied.map(({ path }) => path[2])).toEqual(['last']);
    });

    // An op log an older build wrote names a conditional format by its place in a list no sheet holds any more.
    test("an older build's write into the rule list by index is skipped, as its parent is gone", () => {
        const base: Sheet[] = [{ ...SHEETS[0], conditionalFormats: { x: format('a0') } }];
        const old = { type: 'default', cellrange: [{ row: [0, 0], column: [0, 0] }], format: {} };
        const ops: Op[] = [
            { op: 'add', id: 'sheet-1', path: ['conditionalFormatRules', 1], value: old },
            { op: 'replace', id: 'sheet-1', path: ['conditionalFormatRules', 0, 'cellrange'], value: [] },
            { op: 'remove', id: 'sheet-1', path: ['conditionalFormatRules', 0] },
            { op: 'replace', id: 'sheet-1', path: ['conditionalFormatRules', 'length'], value: 0 },
        ];
        const after = landed(base, ops);
        expect(after.applied).toEqual([]);
        expect(after.sheets).toEqual(base);
    });
});
