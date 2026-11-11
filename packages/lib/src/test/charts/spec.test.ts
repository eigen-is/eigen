import { describe, expect, spyOn, test } from 'bun:test';
import { upperFirst } from 'es-toolkit';
import {
    chartSpecTexts,
    chartSpecWrites,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    exceedsChartSpecBytes,
    MAX_CHART_SPEC_BYTES,
    newChartSpecParts,
    parseChartSpec,
    readChartSpec,
    sampleChartSpec,
} from '../../charts';
import type { ChartSpecChange } from '../../types/chart';
import { CHART_SPEC_PART_KEY, CHART_SPEC_PART_KEYS, CHART_SPEC_PARTS, CHART_TYPES } from '../../types/chart';
import { chart, stored } from './spec-fixtures';

// Mirrors the parser's nesting limit.
const MAX_CHART_SPEC_DEPTH = 32;

describe('readChartSpec and parseChartSpec', () => {
    const partsOf = (raw: Record<string, unknown>) =>
        Object.fromEntries(CHART_SPEC_PARTS.map((part) => [CHART_SPEC_PART_KEY[part], JSON.stringify(raw[part])]));

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
    const point = JSON.stringify({ color: '#eb6834' });
    const blank = Object.fromEntries(CHART_SPEC_PART_KEYS.map((key) => [key, '']));

    test('a part per key, spec and its name, every key of the spec a part', () => {
        expect(Object.keys(sampleChartSpec('column'))).toEqual([...CHART_SPEC_PARTS]);
        expect(CHART_SPEC_PARTS.map((part) => `spec${upperFirst(part)}`)).toEqual(CHART_SPEC_PART_KEYS);
    });

    test('a spec round-trips through its parts, a string each', () => {
        for (const type of CHART_TYPES) {
            const spec = { ...styled, chart: { ...styled.chart, type } };
            const strings = newChartSpecParts(spec);
            expect(Object.keys(strings)).toEqual([...CHART_SPEC_PART_KEYS]);
            expect(readChartSpec(strings).spec).toEqual(spec);
        }
    });

    test('the part set is closed at eight: a ninth prefixed key is never listed, read, counted or carried', () => {
        const forged = parts({ specFuture: 'x'.repeat(MAX_CHART_SPEC_BYTES + 1) });
        let listed = 0;
        const watched = new Proxy(forged, {
            ownKeys: (target) => {
                listed += 1;
                return Reflect.ownKeys(target);
            },
        });
        expect(readChartSpec(watched).spec).toEqual(styled);
        expect(exceedsChartSpecBytes(watched)).toBe(false);
        expect(chartSpecTexts(watched)).toEqual(parts());
        expect(listed).toBe(0);
        expect(chartSpecTexts(new Map(Object.entries(forged)))).toEqual(parts());
        expect(newChartSpecParts(Object.assign(newChartSpecParts(styled), { specFuture: '{}' }))).toEqual(parts());
        expect(newChartSpecParts({ specChart: '{}' })).toEqual({ ...parts(), ...blank, specChart: '{}' });
    });

    test('a part that is no string reads as missing, the record of entries a sheet once stored too', () => {
        const { stored, spec } = readChartSpec(
            parts({ specSeries: { 's-2': '{"color":"#000000"}' }, specPoints: { 's-1/3': point }, specAxes: 7 }),
        );
        expect([stored.series, stored.points, stored.axes]).toEqual([undefined, undefined, undefined]);
        const defaults = defaultChartSpec('column', styled.data);
        expect(spec).toEqual({ ...styled, series: defaults.series, points: {}, axes: defaults.axes });
        expect(chartSpecTexts(parts({ specSeries: { 's-2': '{}' } }))).toEqual(parts({ specSeries: undefined }));
    });

    test('the byte limit is one sum over the eight texts, and past it nothing is read or parsed', () => {
        const bytes = (text: string) => new TextEncoder().encode(text).length;
        const texts = { ...newChartSpecParts(styled), specLegend: '' };
        const used = Object.values(texts).reduce((sum, text) => sum + bytes(text), 0);
        const left = MAX_CHART_SPEC_BYTES - used;
        const parse = spyOn(JSON, 'parse');
        try {
            for (const specLegend of ['x'.repeat(left + 1), 'é'.repeat(Math.ceil(left / 2) + 1)]) {
                expect(readChartSpec(parts({ specLegend }))).toEqual({ stored: {}, spec: null });
                expect(chartSpecTexts(parts({ specLegend }))).toBeNull();
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        const padded = { position: 'top', pad: '' };
        const specLegend = JSON.stringify({ ...padded, pad: 'x'.repeat(left - bytes(JSON.stringify(padded))) });
        expect(readChartSpec(parts({ specLegend })).spec).toEqual(styled);
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

    test('a remove of what is not stored writes nothing', () => {
        const removes: ChartSpecChange = [
            { op: 'remove', path: ['points', 's-1', '5'] },
            { op: 'remove', path: ['points', 's-3', '0'] },
        ];
        expect(chartSpecWrites(readChartSpec(parts()).stored, removes)).toEqual({});
    });

    test("a set to the stored value writes nothing, so it can't undo a peer's edit of that part", () => {
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
    });

    test("a series delete writes the data alone, and the next write of series or points drops the gone series' entries", () => {
        const [first] = styled.data.series;
        const deleteSecond: ChartSpecChange = [{ op: 'set', path: ['data', 'series'], value: [first] }];
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-1', 'color'], value: '#000000' }];
        const strings = parts(chartSpecWrites(readChartSpec(parts()).stored, deleteSecond));
        expect(strings).toEqual(parts({ specData: JSON.stringify({ ...styled.data, series: [first] }) }));
        const recolored = chartSpecWrites(readChartSpec(strings).stored, recolor);
        expect(Object.keys(recolored)).toEqual(['specSeries']);
        expect(Object.keys(JSON.parse(recolored.specSeries ?? ''))).toEqual(['s-1']);
    });

    test('a broken presentation part reads its default, and broken data resolves no spec but keeps the rest', () => {
        const defaults = defaultChartSpec('column', styled.data);
        const { specPoints, ...rest } = parts({ specLegend: '{', specTitle: '[1]', specAxes: '"x"' });
        const broken = readChartSpec(rest);
        expect(broken.spec).toEqual({
            ...styled,
            legend: defaults.legend,
            title: defaults.title,
            axes: defaults.axes,
            points: {},
        });
        const { legend, title, axes, points } = broken.stored;
        expect([legend, title, axes, points]).toEqual([undefined, undefined, undefined, undefined]);
        const noData = readChartSpec(parts({ specData: '{' }));
        expect(noData.spec).toBeNull();
        expect(noData.stored.data).toBeUndefined();
        expect(noData.stored.chart).toEqual(styled.chart);
    });

    test('a part nested past the depth limit reads as broken, and the other parts still read', () => {
        const deep = `${'['.repeat(MAX_CHART_SPEC_DEPTH + 1)}${']'.repeat(MAX_CHART_SPEC_DEPTH + 1)}`;
        const { stored, spec } = readChartSpec(parts({ specPoints: `{"s-1":{"3":{"color":${deep}}}}` }));
        expect(stored.points).toBeUndefined();
        expect(spec).toEqual({ ...styled, points: {} });
    });
});
