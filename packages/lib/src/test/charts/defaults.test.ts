import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    chartPointColor,
    chartSeriesStyle,
    DEFAULT_CHART_SERIES_STYLE,
    INLINE_GRID_MAX_SERIES,
    parseChartSpec,
    sampleChartSpec,
} from '../../charts';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';
import { CHART_SPEC_PARTS, CHART_TYPES } from '../../types/chart';
import { isColorToken } from '../../vector/fill';
import { chart } from './spec-fixtures';

describe('the shape', () => {
    test('a spec is eight parts, each a record', () => {
        const spec = sampleChartSpec('column');
        expect(Object.keys(spec).sort()).toEqual(Object.keys(CHART_SPEC_PARTS).sort());
        for (const part of Object.values(spec)) expect(typeof part === 'object' && !Array.isArray(part)).toBe(true);
    });
});

describe('sampleChartSpec', () => {
    test('every chart type round-trips through its stored string', () => {
        for (const type of CHART_TYPES) {
            const spec = sampleChartSpec(type);
            expect(spec.chart.type).toBe(type);
            expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
        }
    });

    test("the sample: where a star's light goes, three sources over seven 100 nm bins; pie draws the Sun", () => {
        const column = sampleChartSpec('column');
        expect(column.title.text).toBe("Where a star's light goes");
        expect(column.axes.x.title.text).toBe('Wavelength (nm)');
        expect(column.axes.y.title.text).toBe('Share of light, 300–1000 nm (%)');
        expect(column.legend.position).toBe('top');
        expect(column.axes.y.gridlines.visible).toBe(true);
        expect(column.axes.x.gridlines.visible).toBe(false);
        expect(column.data).toMatchObject({
            source: 'inline',
            categories: ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'],
        });
        expect(column.data.series.map((s) => s.name)).toEqual(['Sun', 'Bulb (incandescent)', 'Hot star']);
        expect(column.plots.column.stacking).toBe('none');
        const pie = sampleChartSpec('pie');
        expect(pie.legend.position).toBe('none');
        expect(pie.data.series.map((s) => s.name)).toEqual(['Sun']);
    });

    test("each source's shares are positive and sum to 100, so every type and the pie draw them", () => {
        const { data } = sampleChartSpec('column');
        if (data.source !== 'inline') throw new Error(data.source);
        for (const { values } of data.series) {
            expect(values.every((value) => value !== null && value > 0)).toBe(true);
            expect(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(100, 9);
        }
    });

    test("the sample draws in Google's Inter, or the host's font", () => {
        for (const type of CHART_TYPES) expect(sampleChartSpec(type).chart.fontFamily).toBe('Inter');
        expect(sampleChartSpec('bar', 'Excalifont').chart.fontFamily).toBe('Excalifont');
    });
});

describe('palette', () => {
    const palette = EIGEN_ACCENT_COLORS_SHUFFLED.map(({ value }) => value);

    test('series take the shared accent colors in the shuffled order calendars assign, so neighbors stay apart', () => {
        expect(palette.map((_, i) => chartColor(i))).toEqual(palette);
    });

    test('a sample stores no colors, so its series and slices take the palette as it is when drawn', () => {
        for (const type of CHART_TYPES) {
            const spec = sampleChartSpec(type);
            expect(spec.data.series.map((s) => spec.series[s.id].color)).toEqual(spec.data.series.map(() => null));
            expect(spec.points).toEqual({});
        }
    });

    test('the grid’s series never repeat a color, and the one past the palette starts over', () => {
        expect(palette.length).toBeGreaterThanOrEqual(INLINE_GRID_MAX_SERIES);
        expect(new Set(palette).size).toBe(palette.length);
        expect(palette.every(isColorToken)).toBe(true);
        expect(chartColor(palette.length)).toBe(chartColor(0));
    });
});

describe('chartSeriesStyle and chartPointColor', () => {
    test("read a spec's own entries only, so an id an object inherits finds nothing", () => {
        const spec = chart({
            series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#eb6834' } },
            points: { 's-1': { 2: { color: '#2a78d6' } } },
        });
        expect(chartSeriesStyle(spec, 's-1').color).toBe('#eb6834');
        expect(chartSeriesStyle(spec, 'toString')).toEqual(DEFAULT_CHART_SERIES_STYLE);
        expect(chartPointColor(spec, 's-1', 2)).toBe('#2a78d6');
        expect([chartPointColor(spec, 's-1', 0), chartPointColor(spec, 'toString', 0)]).toEqual([null, null]);
    });
});
