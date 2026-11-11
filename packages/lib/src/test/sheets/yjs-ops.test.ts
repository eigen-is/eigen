import { describe, expect, test } from 'bun:test';
import { MAX_CHART_SPEC_ENTRIES, newSheetChartSpecParts, sampleChartSpec } from '../../charts';
import { isRecord } from '../../core/guards';
import type { Op, Sheet, SheetChart, SheetImage } from '../../sheets/types';
import { MAX_VALIDATIONS } from '../../sheets/validations';
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
        ...newSheetChartSpecParts(sampleChartSpec('column')),
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

    // A keyed part is a record from the chart's creation on, so only a forged chart has another value there: an entry
    // write below it is skipped, not the batch, and so is a write that would leave the part no record. A write below
    // an entry is skipped whatever the entry holds: under a forged record entry, an add and its remove would each
    // lower the chart's count by one, and take the chart past its cap.
    test('an entry write lands on a record field only, and a keyed part stays a record', () => {
        const forged = { ...chart('c2', 'a2'), specPoints: '{}' };
        expect(
            paths([
                write('add', ['charts', 'c1', 'specPoints', 'forged'], { k: 1 }),
                write('add', ['charts', 'c1', 'specPoints', 'forged', 'k2'], 1),
                write('remove', ['charts', 'c1', 'specPoints', 'forged', 'k2']),
                write('remove', ['charts', 'c1', 'specPoints', 'forged', 'k']),
                write('remove', ['charts', 'c1', 'specPoints', 'forged']),
                write('add', ['charts', 'c2'], forged),
                write('add', ['charts', 'c2', 'specPoints', 's-1/3'], '{"color":"#ff0000"}'),
                write('add', ['charts', 'c1', 'specPoints', 's-1/3'], '{"color":"#ff0000"}'),
                write('add', ['charts', 'c1', 'specTitle', 'text'], 'Goals'),
                write('add', ['charts', 'c1', 'specSeries', 's-1', 'color'], '#ff0000'),
                write('replace', ['charts', 'c1', 'specPoints'], 'gone'),
                write('remove', ['charts', 'c1', 'specSeries']),
                write('add', ['charts', 'c1', 'specPoints', 's-1/4'], '{}'),
                write('add', ['charts', 'c1', 'specSeries', 's-1'], '{}'),
                write('replace', ['charts', 'c1', 'specTitle'], '{"text":"Goals"}'),
                write('replace', ['charts', 'c2', 'specPoints'], {}),
                write('add', ['charts', 'c2', 'specPoints', 's-1/4'], '{}'),
            ]),
        ).toEqual([
            'charts/c1/specPoints/forged',
            'charts/c1/specPoints/forged',
            'charts/c2',
            'charts/c1/specPoints/s-1/3',
            'charts/c1/specPoints/s-1/4',
            'charts/c1/specSeries/s-1',
            'charts/c1/specTitle',
            'charts/c2/specPoints',
            'charts/c2/specPoints/s-1/4',
        ]);
    });

    // Every read lists a chart's entries, so a forged one of a million would cost every peer that walk on every draw.
    test('a chart past the entry cap is skipped, whole or an entry at a time', () => {
        const entries = (count: number) =>
            Object.fromEntries(Array.from({ length: count }, (_, i) => [`s-1/${i}`, '{}']));
        const fields = Object.values(chart('c1', 'a1'));
        const held = fields.reduce(
            (sum: number, value) => sum + 1 + (isRecord(value) ? Object.keys(value).length : 0),
            0,
        );
        const full = MAX_CHART_SPEC_ENTRIES - held;
        const forged = { ...chart('c2', 'a2'), specPoints: entries(full + 1) };
        const keys = Object.fromEntries(Array.from({ length: full + 1 }, (_, i) => [`specFuture${i}`, '']));
        expect(
            paths([
                write('add', ['charts', 'c2'], forged),
                write('add', ['charts', 'c3'], { ...chart('c3', 'a3'), ...keys }),
                write('replace', ['charts'], { c1: chart('c1', 'a1'), c2: forged }),
                write('replace', ['charts', 'c1', 'specPoints'], entries(full + 1)),
                write('replace', ['charts', 'c1', 'specPoints'], entries(full)),
                write('add', ['charts', 'c1', 'specPoints', 's-1/0'], '{"color":"#ff0000"}'),
                write('add', ['charts', 'c1', 'specPoints', `s-1/${full}`], '{}'),
                write('remove', ['charts', 'c1', 'specPoints', 's-1/0']),
                write('add', ['charts', 'c1', 'specPoints', `s-1/${full}`], '{}'),
                write('add', ['charts', 'c1', 'specPoints', 's-1/0'], '{}'),
                write('replace', ['charts', 'c1'], chart('c1', 'a1')),
                write('add', ['charts', 'c1', 'specPoints', 's-1/0'], '{}'),
                write('replace', ['charts', 'c1', 'specPoints'], entries(full)),
                write('add', ['charts', 'c1', 'specPoints', `s-1/${full}`], '{}'),
                write('replace', ['charts'], { c1: chart('c1', 'a1') }),
                write('add', ['charts', 'c1', 'specPoints', 's-1/0'], '{}'),
            ]).map((path) => path.split('/').slice(0, 4).join('/')),
        ).toEqual([
            'charts/c1/specPoints',
            'charts/c1/specPoints/s-1',
            'charts/c1/specPoints/s-1',
            'charts/c1/specPoints/s-1',
            'charts/c1',
            'charts/c1/specPoints/s-1',
            'charts/c1/specPoints',
            'charts',
            'charts/c1/specPoints/s-1',
        ]);
    });

    // A whole-entry write over a rule a peer deleted would bring the rule back. Immer writes `add` for an id its base
    // lacked, so a `replace` means the writer saw the rule, and where it is gone the delete wins.
    test('a whole-entry replace of a rule the sheet no longer holds is dropped', () => {
        const entry = {
            ranges: [{ row: [0, 9], column: [1, 1] }],
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
});
