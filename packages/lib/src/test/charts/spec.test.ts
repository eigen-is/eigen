import { describe, expect, spyOn, test } from 'bun:test';
import { upperFirst } from 'es-toolkit';
import {
    chartSpecWrites,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    isChartSpecKey,
    MAX_CHART_POINTS,
    MAX_CHART_SPEC_BYTES,
    MAX_CHART_SPEC_DEPTH,
    mapChartSpecParts,
    newChartSpecParts,
    newSheetChartSpecParts,
    parseChartSpec,
    readChartSpec,
    sampleChartSpec,
    sheetChartSpecWrites,
} from '../../charts';
import type { ChartSpecChange } from '../../types/chart';
import { CHART_SPEC_PART_KEYS, CHART_SPEC_PARTS, CHART_TYPES } from '../../types/chart';
import { chart, stored } from './spec-fixtures';

describe('readChartSpec and parseChartSpec', () => {
    const partsOf = (raw: Record<string, unknown>) => mapChartSpecParts((part) => JSON.stringify(raw[part]));

    test('returns the spec as stored, unknown keys and values in place, beside the view resolved from it', () => {
        const raw = { ...chart(), chart: { ...chart().chart, future: { on: true } }, legend: { position: 'inside' } };
        const { stored, spec } = readChartSpec(partsOf(raw));
        expect(stored).toEqual(raw);
        expect(spec).toEqual(chart());
    });

    test('a spec that does not resolve keeps what is stored; one string that is no JSON object, or past the limit, reads none', () => {
        const scatter = { ...chart(), chart: { type: 'scatter' } };
        expect(readChartSpec(partsOf(scatter))).toEqual({ stored: scatter, spec: null });
        for (const value of ['{', '[1]', '"x"']) expect(parseChartSpec(value)).toBeNull();
        expect(parseChartSpec(JSON.stringify({ ...chart(), pad: 'x'.repeat(MAX_CHART_SPEC_BYTES) }))).toBeNull();
    });

    // The spec is one level, so a key on it nested `levels` deep reaches 1 + levels.
    const nested = (levels: number, open: string, close: string, base = stored({})) =>
        base.replace(/}$/, `,"future":${open.repeat(levels)}0${close.repeat(levels)}}`);

    test('one string nested up to the depth limit reads; one level past it reads none, in arrays and in records', () => {
        for (const [open, close] of [
            ['[', ']'],
            ['{"a":', '}'],
        ]) {
            expect(parseChartSpec(nested(MAX_CHART_SPEC_DEPTH - 1, open, close))).toEqual(chart());
            expect(parseChartSpec(nested(MAX_CHART_SPEC_DEPTH, open, close))).toBeNull();
        }
    });

    test('brackets inside a string are no nesting, after an escaped quote too, and an escaped backslash ends it', () => {
        const brackets = '[{'.repeat(MAX_CHART_SPEC_DEPTH);
        for (const pad of [brackets, `"${brackets}`, `\\"${brackets}`]) {
            expect(parseChartSpec(stored({ pad }))).toEqual(chart());
        }
        const afterBackslash = nested(MAX_CHART_SPEC_DEPTH, '[', ']', stored({ pad: '\\' }));
        expect(parseChartSpec(afterBackslash)).toBeNull();
    });
});

describe('the stored parts', () => {
    const styled = chart({
        series: {
            ...chart().series,
            's-2': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' },
        },
        points: { 's-1': { 3: { color: '#eb6834' } } },
    });
    const parts = (patch: Record<string, unknown> = {}) => ({ ...newChartSpecParts(styled), ...patch });
    const sheet = (patch: Record<string, unknown> = {}) => ({ ...newSheetChartSpecParts(styled), ...patch });
    const point = JSON.stringify({ color: '#eb6834' });

    test('a part per key, spec and its name, every key of the spec a part', () => {
        expect(Object.keys(CHART_SPEC_PARTS)).toEqual(Object.keys(sampleChartSpec('column')));
        const capitalized = Object.keys(CHART_SPEC_PARTS).map((part) => `spec${upperFirst(part)}`);
        expect(capitalized).toEqual(CHART_SPEC_PART_KEYS);
        expect(['specChart', 'specFuture'].map(isChartSpecKey)).toEqual([true, true]);
        expect(['spec', 'special', 'chart'].map(isChartSpecKey)).toEqual([false, false, false]);
    });

    test('a spec round-trips through its parts, a string each or Sheets entries', () => {
        for (const type of CHART_TYPES) {
            const spec = { ...styled, chart: { ...styled.chart, type } };
            const strings = readChartSpec(newChartSpecParts(spec));
            const entries = readChartSpec(newSheetChartSpecParts(spec));
            expect(strings.spec).toEqual(spec);
            expect(entries.spec).toEqual(spec);
            expect(entries.stored).toEqual(strings.stored);
        }
    });

    test("a new chart's parts hold every keyed part, empty if it has no entries", () => {
        const spec = chart();
        const strings = newChartSpecParts(spec);
        expect(Object.keys(strings)).toEqual([...CHART_SPEC_PART_KEYS]);
        expect(strings.specPoints).toBe('{}');
        const entries = newSheetChartSpecParts(spec);
        expect(Object.keys(entries)).toEqual([...CHART_SPEC_PART_KEYS]);
        expect(entries.specPoints).toEqual({});
    });

    test('Sheets stores a keyed part an entry per axis, plot type, series and point, its path / -joined', () => {
        const entries = newSheetChartSpecParts(styled);
        expect(entries.specTitle).toBe(JSON.stringify(styled.title));
        expect(Object.keys(entries.specAxes)).toEqual(['x', 'y']);
        expect(Object.keys(entries.specPlots)).toEqual([...CHART_TYPES]);
        expect(entries.specSeries['s-2']).toBe(JSON.stringify(styled.series['s-2']));
        expect(entries.specPoints).toEqual({ 's-1/3': point });
    });

    test('a write is the parts the change touched, as strings', () => {
        const { stored } = readChartSpec(parts());
        expect(chartSpecWrites(stored, [{ op: 'set', path: ['title', 'text'], value: 'New' }])).toEqual({
            specTitle: JSON.stringify({ text: 'New' }),
        });
        const writes = chartSpecWrites(stored, [
            { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
            { op: 'set', path: ['points', 's-2', '0', 'color'], value: '#000000' },
        ]);
        expect(Object.keys(writes)).toEqual(['specAxes', 'specPoints']);
        expect(JSON.parse(writes.specPoints ?? '')).toEqual({ ...styled.points, 's-2': { 0: { color: '#000000' } } });
    });

    test('a Sheets write is the entries the change touched, never a keyed record whole', () => {
        const { stored } = readChartSpec(sheet());
        const scale = { ...styled.axes.y.scale, min: 0 };
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['title', 'text'], value: 'New' },
                { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
                { op: 'set', path: ['plots', 'bar', 'stacking'], value: 'percent' },
                { op: 'set', path: ['series', 's-2', 'color'], value: null },
                { op: 'move', from: ['points', 's-1', '3'], path: ['points', 's-1', '2'] },
            ]),
        ).toEqual([
            { key: 'specTitle', value: JSON.stringify({ text: 'New' }) },
            { key: 'specAxes', entry: 'y', value: JSON.stringify({ ...styled.axes.y, scale }) },
            { key: 'specPlots', entry: 'bar', value: JSON.stringify({ stacking: 'percent' }) },
            { key: 'specSeries', entry: 's-2', value: JSON.stringify(DEFAULT_CHART_SERIES_STYLE) },
            { key: 'specPoints', entry: 's-1/3', value: null },
            { key: 'specPoints', entry: 's-1/2', value: point },
        ]);
    });

    test("a first entry write ships one entry, not its record, and a part's whole set ships its entries", () => {
        const { stored } = readChartSpec(newSheetChartSpecParts(chart()));
        expect(
            sheetChartSpecWrites(stored, [{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]),
        ).toEqual([{ key: 'specPoints', entry: 's-1/3', value: point }]);
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['points'], value: { 's-1': { 3: { color: '#eb6834' } } } },
            ]),
        ).toEqual([{ key: 'specPoints', entry: 's-1/3', value: point }]);
    });

    test('a remove of what is not stored writes nothing', () => {
        const removes: ChartSpecChange = [
            { op: 'remove', path: ['points', 's-1', '5'] },
            { op: 'remove', path: ['points', 's-3', '0'] },
            { op: 'move', from: ['points', 's-2', '1'], path: ['points', 's-2', '0'] },
        ];
        expect(chartSpecWrites(readChartSpec(parts()).stored, removes)).toEqual({});
        expect(sheetChartSpecWrites(readChartSpec(sheet()).stored, removes)).toEqual([]);
    });

    test("a set to the stored value writes nothing, so a peer's edit of another entry in that part stands", () => {
        const same: ChartSpecChange = [
            { op: 'set', path: ['series', 's-1', 'color'], value: null },
            { op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' },
            { op: 'set', path: ['title', 'text'], value: styled.title.text },
        ];
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-2', 'color'], value: '#000000' }];
        const base = parts();
        const { stored } = readChartSpec(base);
        expect(chartSpecWrites(stored, same)).toEqual({});
        const both = { ...base, ...chartSpecWrites(stored, recolor), ...chartSpecWrites(stored, same) };
        expect(readChartSpec(both).spec?.series['s-2'].color).toBe('#000000');
        expect(sheetChartSpecWrites(readChartSpec(sheet()).stored, same)).toEqual([]);
    });

    test("data labels on two series of three write those two series' entries, and a newer key survives a color edit", () => {
        const { stored } = readChartSpec(sheet());
        const labeled = { ...DEFAULT_CHART_SERIES_STYLE, labels: { visible: true } };
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['series', 's-1', 'labels', 'visible'], value: true },
                { op: 'set', path: ['series', 's-2', 'labels', 'visible'], value: true },
            ]),
        ).toEqual([
            { key: 'specSeries', entry: 's-1', value: JSON.stringify(labeled) },
            {
                key: 'specSeries',
                entry: 's-2',
                value: JSON.stringify({ ...styled.series['s-2'], labels: { visible: true } }),
            },
        ]);
        const newer = { ...labeled, labels: { visible: true, position: 'inEnd' } };
        const kept = readChartSpec(sheet({ specSeries: { ...sheet().specSeries, 's-3': JSON.stringify(newer) } }));
        expect(
            sheetChartSpecWrites(kept.stored, [{ op: 'set', path: ['series', 's-3', 'color'], value: '#000000' }]),
        ).toEqual([{ key: 'specSeries', entry: 's-3', value: JSON.stringify({ ...newer, color: '#000000' }) }]);
    });

    test('a Sheets write is never an entry key the reader ignores', () => {
        const { stored } = readChartSpec(sheet());
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['points', 's-1', '03', 'color'], value: '#000000' },
                { op: 'set', path: ['points', 's-1', '1e3', 'color'], value: '#000000' },
            ]),
        ).toEqual([]);
    });

    test("a series delete writes the data alone, and the next write of series or points drops the gone series' entries", () => {
        const [first, second] = styled.data.series;
        const deleteSecond: ChartSpecChange = [{ op: 'set', path: ['data', 'series'], value: [first] }];
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-1', 'color'], value: '#000000' }];
        const strings = parts(chartSpecWrites(readChartSpec(parts()).stored, deleteSecond));
        expect(strings).toEqual(parts({ specData: JSON.stringify({ ...styled.data, series: [first] }) }));
        const recolored = chartSpecWrites(readChartSpec(strings).stored, recolor);
        expect(Object.keys(recolored)).toEqual(['specSeries']);
        expect(Object.keys(JSON.parse(recolored.specSeries ?? ''))).toEqual(['s-1']);

        const firstTwo = sheet({ specData: JSON.stringify({ ...styled.data, series: [first, second] }) });
        expect(sheetChartSpecWrites(readChartSpec(firstTwo).stored, recolor)).toEqual([
            { key: 'specSeries', entry: 's-1', value: JSON.stringify({ ...styled.series['s-1'], color: '#000000' }) },
            { key: 'specSeries', entry: 's-3', value: null },
        ]);
        const secondOnly = sheet({ specData: JSON.stringify({ ...styled.data, series: [second] }) });
        const repoint: ChartSpecChange = [{ op: 'set', path: ['points', 's-2', '0', 'color'], value: '#000000' }];
        expect(sheetChartSpecWrites(readChartSpec(secondOnly).stored, repoint)).toEqual([
            { key: 'specPoints', entry: 's-1/3', value: null },
            { key: 'specPoints', entry: 's-2/0', value: JSON.stringify({ color: '#000000' }) },
        ]);
    });

    test('a broken presentation part reads its default, and broken data resolves no spec but keeps the rest', () => {
        const defaults = defaultChartSpec('column', styled.data);
        for (const read of [parts, sheet]) {
            const broken = readChartSpec(read({ specLegend: '{', specTitle: '[1]', specAxes: '"x"' }));
            expect(broken.spec).toEqual({
                ...styled,
                legend: defaults.legend,
                title: defaults.title,
                axes: defaults.axes,
            });
            expect([broken.stored.legend, broken.stored.title, broken.stored.axes]).toEqual([undefined, undefined, {}]);
            const noData = readChartSpec(read({ specData: '{' }));
            expect(noData.spec).toBeNull();
            expect(noData.stored.data).toBeUndefined();
            expect(noData.stored.chart).toEqual(styled.chart);
        }
    });

    test('a part nested past the depth limit reads as broken, in a string and in an entry', () => {
        const deep = `${'['.repeat(MAX_CHART_SPEC_DEPTH + 1)}${']'.repeat(MAX_CHART_SPEC_DEPTH + 1)}`;
        const deepEntry = `{"color":${deep}}`;
        expect(readChartSpec(parts({ specLegend: deep })).stored.legend).toBeUndefined();
        const { stored, spec } = readChartSpec(sheet({ specPoints: { 's-1/3': deepEntry, 's-1/4': point } }));
        expect(stored.points).toEqual({ 's-1': { 4: { color: '#eb6834' } } });
        expect(spec?.points).toEqual({ 's-1': { 4: { color: '#eb6834' } } });
    });

    test('a missing keyed record reads as empty', () => {
        const { specAxes, specPoints, ...rest } = sheet();
        const { stored, spec } = readChartSpec(rest);
        expect([stored.axes, stored.points]).toEqual([{}, {}]);
        expect(spec).toEqual({ ...styled, axes: defaultChartSpec('column', styled.data).axes, points: {} });
    });

    test('an entry key that is no path is ignored, and the other entries read', () => {
        const specPoints = Object.fromEntries(
            [
                's-1/1',
                's-1',
                '12',
                's-1/3/4',
                's-1/-1',
                's-1/1e3',
                's-1/03',
                `s-1/${MAX_CHART_POINTS}`,
                '/1',
                'a b/1',
            ].map((key) => [key, point]),
        );
        const specSeries = { ...sheet().specSeries, 'a/b': '{}', ['__proto__']: '{}' };
        const { stored, spec } = readChartSpec(sheet({ specPoints, specSeries }));
        expect(stored.points).toEqual({ 's-1': { 1: { color: '#eb6834' } } });
        expect(spec?.points).toEqual({ 's-1': { 1: { color: '#eb6834' } } });
        expect(Object.keys(stored.series ?? {})).toEqual(['s-1', 's-2', 's-3']);
    });

    test('past the limit summed over every prefixed key, unknown ones and Sheets entries too, nothing is read or parsed', () => {
        const bytes = (texts: unknown[]): number =>
            texts.reduce<number>(
                (sum, text) =>
                    sum +
                    (typeof text === 'string'
                        ? new TextEncoder().encode(text).length
                        : bytes(Object.entries(text ?? {}).flat())),
                0,
            );
        const left = MAX_CHART_SPEC_BYTES - bytes(Object.entries(parts({ specFuture: '' })).flat());
        const half = Math.ceil((MAX_CHART_SPEC_BYTES - bytes(Object.entries(sheet()).flat())) / 2);
        const parse = spyOn(JSON, 'parse');
        try {
            for (const over of [
                parts({ specFuture: 'x'.repeat(left + 1) }),
                parts({ specFuture: 'é'.repeat(Math.ceil(left / 2) + 1) }),
                sheet({ specFuture: { a: 'x'.repeat(half), b: 'x'.repeat(half) } }),
            ]) {
                expect(readChartSpec(over)).toEqual({ stored: {}, spec: null });
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        expect(readChartSpec(parts({ specFuture: 'x'.repeat(left) })).spec).toEqual(styled);
        expect(readChartSpec(parts({ future: 'x'.repeat(MAX_CHART_SPEC_BYTES) })).spec).toEqual(styled);
    });

    test('the count stops at the limit, so a million forged points measure about 6,000', () => {
        const target = Object.fromEntries(Array.from({ length: 1_000_000 }, (_, i) => [`s-1/${i}`, '{}']));
        let reads = 0;
        const specPoints = new Proxy(target, {
            get: (entries, key, receiver) => {
                reads += 1;
                return Reflect.get(entries, key, receiver);
            },
        });
        expect(readChartSpec(sheet({ specPoints }))).toEqual({ stored: {}, spec: null });
        expect(reads).toBeGreaterThan(1000);
        expect(reads).toBeLessThan(10_000);
    });

    test("every prefixed key's name counts, so a million forged empty keys measure a few thousand", () => {
        const target = {
            ...sheet(),
            ...Object.fromEntries(Array.from({ length: 1_000_000 }, (_, i) => [`specF${i}`, ''])),
        };
        let reads = 0;
        const forged = new Proxy(target, {
            get: (entries, key, receiver) => {
                reads += 1;
                return Reflect.get(entries, key, receiver);
            },
        });
        expect(readChartSpec(forged)).toEqual({ stored: {}, spec: null });
        expect(reads).toBeLessThan(15_000);
    });
});
