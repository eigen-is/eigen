import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE, MAX_CHART_SPEC_ENTRIES, newSheetChartSpecParts, sampleChartSpec } from '../../charts';
import { isRecord } from '../../core/guards';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '../../sheets/defaults';
import {
    chartsWithinEntryCap,
    floatingItems,
    floatingWriteFilter,
    nextFloatingIndex,
    sheetFloatingBox,
} from '../../sheets/floating';
import type { Sheet, SheetChart, SheetImage } from '../../sheets/types';

const BOX = { x: 10, y: 20, width: 40, height: 30 };
const image = (id: string, index: string): SheetImage => ({ id, index, ...BOX, mediaName: `${id}.png` });
const chart = (id: string, index: string): SheetChart => ({
    id,
    index,
    ...BOX,
    ...newSheetChartSpecParts(sampleChartSpec('column')),
});

describe('sheetFloatingBox', () => {
    test('keeps a box on the grid as it is, with no angle as 0', () => {
        expect(sheetFloatingBox({ x: 120.5, y: 40, width: 400, height: 300 })).toEqual({
            x: 120.5,
            y: 40,
            width: 400,
            height: 300,
            angle: 0,
        });
        expect(sheetFloatingBox({ ...BOX, angle: 90 }).angle).toBe(90);
    });

    test('a side past the max is the max, and one under a pixel a pixel', () => {
        expect(sheetFloatingBox({ x: 0, y: 0, width: 9.4e11, height: Number.POSITIVE_INFINITY })).toMatchObject({
            width: CHART_MAX_SIDE,
            height: CHART_MAX_SIDE,
        });
        expect(sheetFloatingBox({ x: 0, y: 0, width: 0, height: Number.NaN })).toMatchObject({ width: 1, height: 1 });
    });

    test("its corner lies on Excel's grid at the default track sizes", () => {
        expect(sheetFloatingBox({ x: 9.4e11, y: 9.4e11, width: 400, height: 300 })).toMatchObject({
            x: REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH,
            y: REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT,
        });
        expect(sheetFloatingBox({ x: -5, y: Number.NaN, width: 400, height: 300 })).toMatchObject({ x: 0, y: 0 });
    });

    // Geometry is schemaless at the Yjs boundary: a peer can store a string or a non-finite angle.
    test('reads a stored string as its number and a non-finite angle as 0', () => {
        const stored = JSON.parse('{"x":"12","y":"8","width":"40","height":"30","angle":"45"}');
        expect(sheetFloatingBox(stored)).toEqual({ x: 12, y: 8, width: 40, height: 30, angle: 45 });
        expect(sheetFloatingBox({ ...BOX, angle: Number.POSITIVE_INFINITY }).angle).toBe(0);
        expect(sheetFloatingBox({ ...BOX, angle: JSON.parse('"red"') }).angle).toBe(0);
    });
});

describe('floatingItems', () => {
    test('orders images and charts by one index, ties broken by id', () => {
        const sheet: Sheet = {
            name: 'S',
            images: { i1: image('i1', 'a2'), i2: image('i2', 'a0') },
            charts: { c1: chart('c1', 'a1'), c0: chart('c0', 'a2') },
        };
        expect(floatingItems(sheet).map(({ kind, object }) => `${kind}:${object.id}`)).toEqual([
            'image:i2',
            'chart:c1',
            'chart:c0',
            'image:i1',
        ]);
    });

    test('a sheet without maps has none', () => {
        expect(floatingItems({ name: 'S' })).toEqual([]);
    });

    test('an entry a peer stored as no object is skipped', () => {
        const sheet: Sheet = JSON.parse(
            JSON.stringify({ name: 'S', images: { a: null, i1: image('i1', 'a0') }, charts: { b: 7, c: 'x' } }),
        );
        expect(floatingItems(sheet).map(({ object }) => object.id)).toEqual(['i1']);
    });
});

describe('nextFloatingIndex', () => {
    test('sits above every image and chart', () => {
        const sheet: Sheet = { name: 'S', images: { i1: image('i1', 'a3') }, charts: { c1: chart('c1', 'a5') } };
        expect(nextFloatingIndex(sheet) > 'a5').toBe(true);
        expect(nextFloatingIndex({ name: 'S' })).toBe('a0');
    });

    // Two peers inserting at once store one key twice, and a file or a peer can store any string.
    test('never throws on a tied or malformed top key', () => {
        const tied: Sheet = { name: 'S', images: { i1: image('i1', 'a1') }, charts: { c1: chart('c1', 'a1') } };
        expect(nextFloatingIndex(tied) > 'a1').toBe(true);
        const malformed: Sheet = { name: 'S', images: { i1: image('i1', 'a0') }, charts: { c1: chart('c1', '') } };
        expect(() => nextFloatingIndex(malformed)).not.toThrow();
    });

    // A malformed key sorts as a string, so 'zz' or 'a10' paints above every valid key a repair in memory would put
    // the insert at: the repair is written back to the record, as a z-order move writes its own.
    test.each(['zz', 'a10'])('lands above a malformed key %p on top, and writes its repair', (top) => {
        const sheet: Sheet = { name: 'S', images: { i1: image('i1', 'a0') }, charts: { c1: chart('c1', top) } };
        const index = nextFloatingIndex(sheet);
        const repaired = sheet.charts?.c1.index ?? '';
        expect(repaired).not.toBe(top);
        expect(repaired > 'a0').toBe(true);
        expect(index > repaired).toBe(true);
        expect(sheet.images?.i1.index).toBe('a0');
    });
});

describe('floatingWriteFilter', () => {
    const sheets = (): Sheet[] => [{ name: 'S', images: {}, charts: { c1: chart('c1', 'a1') } }];
    // The sheets the filter reads are a store's, frozen, so it tracks a batch on copies.
    const kept = (writes: { op: string; path: (string | number)[]; value?: unknown }[]) => {
        const stored = sheets();
        const before = structuredClone(stored);
        const applied = writes.filter(floatingWriteFilter(stored)).map(({ path }) => path.join('/'));
        expect(stored).toEqual(before);
        return applied;
    };

    test('a write into an object lands where the batch has left it, else where it stood', () => {
        expect(
            kept([
                { op: 'replace', path: [0, 'charts', 'gone', 'x'], value: 1 },
                { op: 'add', path: [0, 'charts', 'c2'], value: chart('c2', 'a2') },
                { op: 'replace', path: [0, 'charts', 'c2', 'x'], value: 1 },
                { op: 'replace', path: [0, 'charts', 'c1', 'x'], value: 1 },
                { op: 'remove', path: [0, 'charts', 'c1'] },
                { op: 'replace', path: [0, 'charts', 'c1', 'y'], value: 1 },
            ]),
        ).toEqual(['0/charts/c2', '0/charts/c2/x', '0/charts/c1/x', '0/charts/c1']);
    });

    test('a whole map or sheet the batch writes holds the objects it carries', () => {
        expect(
            kept([
                { op: 'replace', path: [0, 'images'], value: { i1: image('i1', 'a0') } },
                { op: 'replace', path: [0, 'images', 'i1', 'x'], value: 1 },
                { op: 'replace', path: [0], value: { name: 'S', charts: {} } },
                { op: 'replace', path: [0, 'charts', 'c1', 'x'], value: 1 },
                { op: 'replace', path: [0, 'images', 'i1', 'y'], value: 1 },
            ]),
        ).toEqual(['0/images', '0/images/i1/x', '0']);
    });

    // A keyed part is a record from the chart's creation on, so only a forged chart has another value there: an entry
    // write below it is dropped, not the batch, and so is a write below an entry, which is a string, and a write that
    // would leave the part no record.
    test('an entry write lands on a record field only, and a keyed part stays a record', () => {
        const forged = { ...chart('c2', 'a2'), specPoints: '{}' };
        expect(
            kept([
                { op: 'add', path: [0, 'charts', 'c2'], value: forged },
                { op: 'add', path: [0, 'charts', 'c2', 'specPoints', 's-1/3'], value: '{"color":"#ff0000"}' },
                { op: 'add', path: [0, 'charts', 'c1', 'specPoints', 's-1/3'], value: '{"color":"#ff0000"}' },
                { op: 'add', path: [0, 'charts', 'c1', 'specTitle', 'text'], value: 'Goals' },
                { op: 'add', path: [0, 'charts', 'c1', 'specSeries', 's-1', 'color'], value: '#ff0000' },
                { op: 'replace', path: [0, 'charts', 'c1', 'specPoints'], value: 'gone' },
                { op: 'remove', path: [0, 'charts', 'c1', 'specSeries'] },
                { op: 'add', path: [0, 'charts', 'c1', 'specPoints', 's-1/4'], value: '{}' },
                { op: 'add', path: [0, 'charts', 'c1', 'specSeries', 's-1'], value: '{}' },
                { op: 'replace', path: [0, 'charts', 'c1', 'specTitle'], value: '{"text":"Goals"}' },
                { op: 'replace', path: [0, 'charts', 'c2', 'specPoints'], value: {} },
                { op: 'add', path: [0, 'charts', 'c2', 'specPoints', 's-1/4'], value: '{}' },
            ]),
        ).toEqual([
            '0/charts/c2',
            '0/charts/c1/specPoints/s-1/3',
            '0/charts/c1/specPoints/s-1/4',
            '0/charts/c1/specSeries/s-1',
            '0/charts/c1/specTitle',
            '0/charts/c2/specPoints',
            '0/charts/c2/specPoints/s-1/4',
        ]);
    });

    // Every read lists a chart's entries, so a forged one of a million would cost every peer that walk on every draw.
    test('a chart past the entry cap is dropped, whole or an entry at a time', () => {
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
            kept([
                { op: 'add', path: [0, 'charts', 'c2'], value: forged },
                { op: 'add', path: [0, 'charts', 'c3'], value: { ...chart('c3', 'a3'), ...keys } },
                { op: 'replace', path: [0, 'charts'], value: { c2: forged } },
                { op: 'replace', path: [0], value: { name: 'S', charts: { c2: forged } } },
                { op: 'replace', path: [0, 'charts', 'c1', 'specPoints'], value: entries(full + 1) },
                { op: 'replace', path: [0, 'charts', 'c1', 'specPoints'], value: entries(full) },
                { op: 'add', path: [0, 'charts', 'c1', 'specPoints', 's-1/0'], value: '{"color":"#ff0000"}' },
                { op: 'add', path: [0, 'charts', 'c1', 'specPoints', `s-1/${full}`], value: '{}' },
                { op: 'remove', path: [0, 'charts', 'c1', 'specPoints', 's-1/0'] },
                { op: 'add', path: [0, 'charts', 'c1', 'specPoints', `s-1/${full}`], value: '{}' },
            ]).map((path) => path.split('/').slice(0, 5).join('/')),
        ).toEqual([
            '0/charts/c1/specPoints',
            '0/charts/c1/specPoints/s-1',
            '0/charts/c1/specPoints/s-1',
            '0/charts/c1/specPoints/s-1',
        ]);
    });

    test('a snapshot or a whole sheet keeps the charts within the cap', () => {
        const charts = { c1: chart('c1', 'a1') };
        expect(chartsWithinEntryCap(charts)).toBe(charts);
        const points = Object.fromEntries(Array.from({ length: MAX_CHART_SPEC_ENTRIES }, (_, i) => [`s-1/${i}`, '{}']));
        const forged = { ...chart('c2', 'a2'), specPoints: points };
        expect(Object.keys(chartsWithinEntryCap({ ...charts, c2: forged }))).toEqual(['c1']);
    });
});
