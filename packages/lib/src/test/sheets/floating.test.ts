import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE } from '../../charts';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '../../sheets/defaults';
import { floatingItems, floatingWriteFilter, nextFloatingIndex, sheetFloatingBox } from '../../sheets/floating';
import type { Sheet, SheetChart, SheetImage } from '../../sheets/types';

const BOX = { x: 10, y: 20, width: 40, height: 30 };
const image = (id: string, index: string): SheetImage => ({ id, index, ...BOX, mediaName: `${id}.png` });
const chart = (id: string, index: string): SheetChart => ({ id, index, ...BOX, spec: '{}' });

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
    const kept = (writes: { op: string; path: (string | number)[]; value?: unknown }[]) =>
        writes.filter(floatingWriteFilter(sheets())).map(({ path }) => path.join('/'));

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
});
