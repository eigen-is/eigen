import { describe, expect, spyOn, test } from 'bun:test';
import { layoutChart, sampleChartSpec } from '../../charts';
import * as tickModule from '../../charts/ticks';
import type { ChartData, ChartLabel, ChartLayout, ChartSeriesStyle, ChartSpec } from '../../types/chart';
import { CHART_TYPES } from '../../types/chart';
import { parsePoints } from '../../vector/points';
import type { VectorLinearElement, VectorRectangleElement } from '../../vector/types';
import type { AxisPatch, SpecPatch } from './layout-fixtures';
import {
    labelBounds,
    layout,
    lines,
    marked,
    numbersIn,
    ofPart,
    overlaps,
    PAINT,
    plots,
    rects,
    SIZES,
    sampleData,
    series,
    shapeBounds,
    style,
    UNTITLED,
    within,
} from './layout-fixtures';

describe('column and bar', () => {
    const data: ChartData = {
        categories: ['A', 'B', 'C', 'D'],
        series: [series('S1', [10, 20, 0, 40]), series('S2', [5, -15, 25, null])],
    };

    test('column heights are proportional to the values, a zero column has zero height', () => {
        const bars = rects(layout('column', {}, { data }), 'bar');
        const perUnit = bars[0].height / 10;
        expect(bars.find((bar) => bar.id === 'c1:bar:0:1')?.height).toBeCloseTo(20 * perUnit);
        expect(bars.find((bar) => bar.id === 'c1:bar:0:3')?.height).toBeCloseTo(40 * perUnit);
        expect(bars.find((bar) => bar.id === 'c1:bar:0:2')?.height).toBe(0);
        expect(bars.find((bar) => bar.id === 'c1:bar:1:3')).toBeUndefined();
    });

    test('a negative column hangs below the baseline, a negative bar left of it', () => {
        const column = layout('column', {}, { data });
        const baseline = lines(column, 'baseline')[0];
        const down = rects(column, 'bar').find((bar) => bar.id === 'c1:bar:1:1');
        const up = rects(column, 'bar').find((bar) => bar.id === 'c1:bar:0:1');
        expect(down?.y).toBeCloseTo(baseline.y);
        expect(up && up.y + up.height).toBeCloseTo(baseline.y);

        const bar = layout('bar', {}, { data });
        const axis = lines(bar, 'baseline')[0];
        const left = rects(bar, 'bar').find((shape) => shape.id === 'c1:bar:1:1');
        const right = rects(bar, 'bar').find((shape) => shape.id === 'c1:bar:0:1');
        expect(left && left.x + left.width).toBeCloseTo(axis.x);
        expect(right?.x).toBeCloseTo(axis.x);
        expect(axis.height).toBeGreaterThan(0);
        expect(axis.width).toBe(0);
    });

    test("a category's bars fill 61.8% of its band, Google's group width, centered in bands that tile the plot", () => {
        const three = {
            categories: ['A', 'B', 'C', 'D'],
            series: [series('S1', [3, 5, 2, 4]), series('S2', [1, 2, 3, 4]), series('S3', [4, 3, 2, 1])],
        };
        for (const type of ['column', 'bar'] as const) {
            for (const stacking of ['none', 'stacked'] as const) {
                for (const chartData of [data, three]) {
                    const out = layout(type, { plots: plots(stacking) }, { data: chartData });
                    const across = (bar: VectorRectangleElement) =>
                        type === 'column' ? [bar.x, bar.x + bar.width] : [bar.y, bar.y + bar.height];
                    const group = (c: number) => {
                        const spans = rects(out, 'bar')
                            .filter((bar) => bar.id.endsWith(`:${c}`))
                            .map(across);
                        return [Math.min(...spans.map(([from]) => from)), Math.max(...spans.map(([, to]) => to))];
                    };
                    const [first, second] = [group(0), group(1)];
                    const step = Math.abs(second[0] - first[0]);
                    expect(first[1] - first[0]).toBeCloseTo(0.618 * step, 6);
                    // The plot's edge, where a gridline ends, is half a band from the first group's center.
                    const [gridline] = lines(out, 'gridline');
                    const edge = type === 'column' ? gridline.x : gridline.y;
                    expect(Math.abs((first[0] + first[1]) / 2 - edge)).toBeCloseTo(step / 2, 6);
                }
            }
        }
    });

    test('bars run top to bottom in category order', () => {
        const bars = rects(layout('bar', {}, { data }), 'bar').filter((bar) => bar.id.startsWith('c1:bar:0:'));
        expect(bars.map((bar) => bar.y)).toEqual([...bars.map((bar) => bar.y)].sort((x, y) => x - y));
    });

    test('stacked: positives and negatives stack apart, each top at its sum', () => {
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { plots: plots('stacked') }, { data });
            const bars = rects(out, 'bar');
            const along = (bar: VectorRectangleElement) => (type === 'column' ? bar.height : bar.width);
            const perUnit = along(bars[0]) / 10;
            const ofCategory = (c: number) => bars.filter((bar) => bar.id.endsWith(`:${c}`));
            // A: 10 + 5 stack up to 15
            const a = ofCategory(0);
            if (type === 'column') {
                expect(
                    Math.max(...a.map((bar) => bar.y + bar.height)) - Math.min(...a.map((bar) => bar.y)),
                ).toBeCloseTo(15 * perUnit);
            } else {
                expect(Math.max(...a.map((bar) => bar.x + bar.width)) - Math.min(...a.map((bar) => bar.x))).toBeCloseTo(
                    15 * perUnit,
                );
            }
            // B: 20 up, -15 down, meeting at the baseline
            const [b0, b1] = ofCategory(1);
            expect(along(b0)).toBeCloseTo(20 * perUnit);
            expect(along(b1)).toBeCloseTo(15 * perUnit);
            if (type === 'column') expect(b0.y + b0.height).toBeCloseTo(b1.y);
            else expect(b1.x + b1.width).toBeCloseTo(b0.x);
            // stacked bars of one category share one band
            expect(new Set(a.map((bar) => (type === 'column' ? bar.x : bar.y))).size).toBe(1);
        }
    });

    test('100% stacked: every category fills the axis, each bar its share, the ticks percents', () => {
        const shares: ChartData = {
            categories: ['A', 'B'],
            series: [series('S1', [10, 1]), series('S2', [30, 3])],
        };
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { plots: plots('percent') }, { data: shares });
            const bars = rects(out, 'bar');
            const along = (bar: VectorRectangleElement) => (type === 'column' ? bar.height : bar.width);
            const span = (c: number) =>
                bars.filter((bar) => bar.id.endsWith(`:${c}`)).reduce((sum, bar) => sum + along(bar), 0);
            expect(span(1)).toBeCloseTo(span(0));
            expect(along(bars[0]) / span(0)).toBeCloseTo(0.25);
            const ticks = out.labels.map((label) => label.text).filter((text) => text.endsWith('%'));
            expect(ticks[0]).toBe('0%');
            expect(ticks.at(-1)).toBe('100%');
            // The stack ends on the 100% tick.
            const top = lines(out, 'gridline').at(-1);
            if (type === 'column') expect(Math.min(...bars.map((bar) => bar.y))).toBeCloseTo(top?.y ?? 0);
            else expect(Math.max(...bars.map((bar) => bar.x + bar.width))).toBeCloseTo(top?.x ?? 0);
        }
    });

    test('100% stacked: min and max are shares, so 0.5 ends the axis at 50%', () => {
        const data: ChartData = { categories: ['A'], series: [series('S1', [1]), series('S2', [3])] };
        const out = layout('column', { plots: plots('percent'), axes: { y: { scale: { max: 0.5 } } } }, { data });
        const ticks = out.labels.filter((label) => label.anchor === 'end').map((label) => label.text);
        expect(ticks[0]).toBe('0%');
        expect(ticks.at(-1)).toBe('50%');
    });

    test('100% stacked with mixed signs: shares of the absolute sum, negatives below zero', () => {
        const mixed: ChartData = {
            categories: ['A', 'B'],
            series: [series('S1', [5, 4]), series('S2', [-3, 4])],
        };
        const out = layout('column', { plots: plots('percent') }, { data: mixed });
        const bar = (id: string) => rects(out, 'bar').find((shape) => shape.id === `c1:${id}`);
        const [up, down, b0, b1] = ['bar:0:0', 'bar:1:0', 'bar:0:1', 'bar:1:1'].map(bar);
        expect((up?.height ?? 0) / (down?.height ?? 1)).toBeCloseTo(5 / 3);
        expect((up?.height ?? 0) + (down?.height ?? 0)).toBeCloseTo((b0?.height ?? 0) + (b1?.height ?? 0));
        expect(down?.y).toBeCloseTo(lines(out, 'baseline')[0].y);
        expect(out.labels.some((label) => /^-\d+%$/.test(label.text))).toBe(true);
    });

    test('100% stacked: a category that totals zero draws no bar and no NaN', () => {
        const zero: ChartData = {
            categories: ['A', 'B', 'C'],
            series: [series('S1', [0, 10, null]), series('S2', [0, 30, null])],
        };
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { plots: plots('percent') }, { data: zero });
            const ids = rects(out, 'bar').map((bar) => bar.id);
            expect(ids).toEqual(['c1:bar:0:1', 'c1:bar:1:1']);
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
        }
    });

    test('the value domain includes zero and follows nice ticks', () => {
        const out = layout('column', {}, { data: { categories: ['A'], series: [series('S', [50, 80])] } });
        const ticks = out.labels.filter((label) => label.anchor === 'end').map((label) => label.text);
        expect(ticks[0]).toBe('0');
        expect(Number(ticks.at(-1)?.replaceAll(',', ''))).toBeGreaterThanOrEqual(80);
    });

    test('min and max override the nice domain, and bars stay in the plot', () => {
        const out = layout('column', { axes: { y: { scale: { min: 10, max: 30 } } } }, { data });
        const ticks = out.labels.filter((label) => label.anchor === 'end').map((label) => Number(label.text));
        expect(ticks[0]).toBe(10);
        expect(ticks.at(-1)).toBe(30);
        const gridlines = lines(out, 'gridline');
        const top = Math.min(...gridlines.map((line) => line.y));
        const bottom = Math.max(...gridlines.map((line) => line.y), ...lines(out, 'baseline').map((line) => line.y));
        for (const bar of rects(out, 'bar')) {
            expect(bar.y).toBeGreaterThanOrEqual(top - 0.01);
            expect(bar.y + bar.height).toBeLessThanOrEqual(bottom + 0.01);
        }
    });

    test('tick count follows the axis length', () => {
        const count = (height: number) => lines(layout('column', {}, { height, width: 640 }), 'gridline').length;
        expect(count(1200)).toBeGreaterThan(count(250));
    });

    // A peer stores the box, so a huge one must not mean huge work. A tick's text is formatted once per tick of every
    // axis the layout tries, so those calls count the tick work; past the budget the spy throws.
    test.each([
        ['column', 600, 1e6],
        ['bar', 1e6, 600],
        ['column', 600, 1e9],
        ['bar', 1e9, 600],
        ['line', 1e9, 1e9],
    ] as const)('a %s at %d × %d lays out in bounded work', (type, width, height) => {
        let calls = 0;
        const format = spyOn(tickModule, 'formatTickValue').mockImplementation((value, step) => {
            calls++;
            if (calls > 60) throw new Error('unbounded tick work');
            return String(value / step);
        });
        try {
            const out = layoutChart({
                id: 'c1',
                spec: sampleChartSpec(type),
                data: sampleData(type),
                width,
                height,
                paint: PAINT,
            });
            expect(calls).toBeGreaterThan(0);
            expect(lines(out, 'gridline').length).toBeLessThanOrEqual(30);
            expect(out.labels.length).toBeLessThanOrEqual(40);
        } finally {
            format.mockRestore();
        }
    });

    test("a bar chart's value labels drop ticks until they stop touching", () => {
        const wide: ChartData = { categories: ['A', 'B'], series: [series('S', [123456789, -987654321])] };
        for (const width of [240, 320, 480, 640, 1200]) {
            const out = layout('bar', { title: { text: '' }, legend: { position: 'none' } }, { data: wide, width });
            const ticks = out.labels.filter((label) => label.anchor === 'middle').map(labelBounds);
            expect(ticks.length).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < ticks.length; i++) expect(overlaps(ticks[i - 1], ticks[i])).toBe(false);
        }
    });

    // The fewest ticks d3 gives can still be too many: four on a narrow bar chart, three under turned names
    // on a short column chart. Every other label hides then, and every tick keeps its gridline.
    test('value labels never touch, even at the fewest ticks', () => {
        const isTick = (label: ChartLabel) => label.rotate === 0 && /^-?[\d,]+$/.test(label.text);
        const untitled: SpecPatch = { ...UNTITLED, title: { text: '' } };
        const narrow = layout('bar', untitled, {
            data: { categories: ['North', 'South', 'East'], series: [series('Revenue', [12.5e6, 38e6, -15e6])] },
            width: 200,
            height: 220,
        });
        const short = layout(
            'column',
            { ...untitled, axes: { x: { title: { text: 'Teams' } }, y: {} } },
            {
                data: {
                    categories: ['North', 'Total operating costs', 'Total operating costs', '2019'],
                    series: [series('Revenue', [-75054, -37087, 74996, -127040])],
                },
                width: 318,
                height: 80,
            },
        );
        for (const out of [narrow, short]) {
            const ticks = out.labels.filter(isTick);
            expect(ticks.length).toBeGreaterThanOrEqual(1);
            expect(ticks.length).toBeLessThan(lines(out, 'gridline').length + lines(out, 'baseline').length);
            const bounds = ticks.map(labelBounds);
            for (let i = 1; i < bounds.length; i++) expect(overlaps(bounds[i - 1], bounds[i])).toBe(false);
        }
        expect(narrow.labels.filter(isTick).map((label) => label.text)).toContain('0');
    });

    test("the caller's source format draws the ticks of an axis without a format of its own", () => {
        const out = layoutChart({
            id: 'c1',
            spec: sampleChartSpec('column'),
            data: data,
            width: 640,
            height: 400,
            paint: PAINT,
            sourceFormat: '0.0" u"',
        });
        expect(out.labels.some((label) => /^-?\d+\.0 u$/.test(label.text))).toBe(true);
    });
});

describe('category labels', () => {
    const long = Array.from({ length: 12 }, (_, i) => `A rather long category name ${i + 1}`);
    const data: ChartData = {
        categories: long,
        series: [
            series(
                'S',
                long.map((_, i) => i + 1),
            ),
        ],
    };

    test('fit under their band upright', () => {
        const out = layout('column');
        for (const band of ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000']) {
            expect(out.labels.find((label) => label.text === band)?.rotate).toBe(0);
        }
    });

    test('rotate when they collide, then ellipsize, never overlapping', () => {
        const out = layout('column', {}, { data, width: 640, height: 400 });
        const categories = out.labels.filter((label) => label.rotate === -45);
        expect(categories.length).toBeGreaterThan(0);
        expect(categories.every((label) => label.anchor === 'end')).toBe(true);
        expect(categories.some((label) => label.text.endsWith('…'))).toBe(true);
        const bounds = categories.map(labelBounds);
        for (let i = 1; i < bounds.length; i++) {
            const gap = bounds[i].left - bounds[i - 1].left;
            expect(gap).toBeGreaterThan(0);
        }
    });

    test('a crowded axis labels every nth category, none overlapping', () => {
        const many = Array.from({ length: 200 }, (_, i) => `Category ${i}`);
        const out = layout(
            'column',
            {},
            {
                data: {
                    categories: many,
                    series: [
                        series(
                            'S',
                            many.map((_, i) => i),
                        ),
                    ],
                },
            },
        );
        const labels = out.labels.filter((label) => label.text.startsWith('Category') || label.text.startsWith('Cat'));
        expect(labels.length).toBeGreaterThan(1);
        expect(labels.length).toBeLessThan(200);
        const upright = labels.filter((label) => label.rotate === 0);
        const bounds = upright.map(labelBounds);
        for (let i = 1; i < bounds.length; i++) expect(overlaps(bounds[i - 1], bounds[i])).toBe(false);
    });

    test('bar charts ellipsize long category names in the left column', () => {
        const out = layout('bar', {}, { data });
        const names = out.labels.filter((label) => label.anchor === 'end' && label.text.startsWith('A '));
        expect(names.length).toBeGreaterThan(0);
        expect(names.every((label) => label.rotate === 0)).toBe(true);
        expect(names.some((label) => label.text.endsWith('…'))).toBe(true);
    });

    test('axis titles: the category title below, the value title turned -90', () => {
        const out = layout('column', { axes: { x: { title: { text: 'Teams' } }, y: { title: { text: 'Points' } } } });
        const teams = out.labels.find((label) => label.text === 'Teams');
        const points = out.labels.find((label) => label.text === 'Points');
        expect(teams?.rotate).toBe(0);
        expect(points?.rotate).toBe(-90);
        const uv = out.labels.find((label) => label.text === '300–400');
        expect(teams && uv && teams.y > uv.y).toBe(true);
    });
    // Thin bands put a centered name's half line past the plot's ends.
    test("a bar chart's crowded names stay below the title or legend and above the value labels", () => {
        const many = Array.from({ length: 1000 }, (_, i) => `C${i}`);
        const data = {
            categories: many,
            series: [
                series(
                    'S',
                    many.map((_, i) => i),
                ),
            ],
        };
        for (const legend of ['none', 'top'] as const) {
            const out = layout('bar', { ...UNTITLED, legend: { position: legend } }, { data });
            const above = out.labels.filter((label) => label.bold || label.anchor === 'start').map(labelBounds);
            const ticks = out.labels.filter((label) => label.anchor === 'middle' && !label.bold).map(labelBounds);
            const names = out.labels.filter((label) => label.anchor === 'end').map(labelBounds);
            expect(names.length).toBeGreaterThan(1);
            const ceiling = Math.max(...above.map((bounds) => bounds.bottom));
            const floor = Math.min(...ticks.map((bounds) => bounds.top));
            for (const name of names) {
                expect(name.top).toBeGreaterThanOrEqual(ceiling);
                expect(name.bottom).toBeLessThanOrEqual(floor);
            }
        }
    });
});

describe('axes', () => {
    const data: ChartData = {
        categories: ['A', 'B', 'C', 'D'],
        series: [series('S1', [10, 20, 30, 40]), series('S2', [5, 15, 25, 35])],
    };
    // Both axes laid over the untitled defaults.
    function axes({ x = {}, y = {} }: { x?: AxisPatch; y?: AxisPatch }): SpecPatch {
        return { axes: { x, y } };
    }
    const bar = (out: ChartLayout, s: number, c: number) => {
        const found = rects(out, 'bar').find((shape) => shape.id === `c1:bar:${s}:${c}`);
        if (!found) throw new Error(`no bar ${s}:${c}`);
        return found;
    };
    const texts = (out: ChartLayout) => out.labels.map((label) => label.text);
    const isTick = (text: string) => /^-?[\d,.]+$/.test(text);

    test('a hidden category axis draws no names and no baseline, and the plot takes its room', () => {
        for (const type of ['column', 'bar'] as const) {
            const shown = layout(type, {}, { data });
            const hidden = layout(type, axes({ x: { visible: false } }), { data });
            expect(texts(shown)).toContain('A');
            expect(texts(hidden)).not.toContain('A');
            expect(lines(hidden, 'baseline')).toEqual([]);
            expect(lines(hidden, 'gridline').length).toBeGreaterThan(0);
            if (type === 'column')
                expect(bar(hidden, 0, 0).y + bar(hidden, 0, 0).height).toBeGreaterThan(
                    bar(shown, 0, 0).y + bar(shown, 0, 0).height + 1,
                );
            else expect(bar(hidden, 0, 0).x).toBeLessThan(bar(shown, 0, 0).x - 1);
        }
    });

    test('a hidden category axis keeps the gridline at zero, as Office keeps its 0 line, and gridlines off draw none', () => {
        const signed = { ...data, series: [series('S1', [-10, 20, 30, 40]), series('S2', [5, 15, 25, 35])] };
        for (const type of ['column', 'bar'] as const) {
            const zero = (out: ChartLayout) => {
                const positive = bar(out, 0, 1);
                return type === 'column' ? positive.y + positive.height : positive.x;
            };
            const at = (shape: VectorLinearElement) => (type === 'column' ? shape.y : shape.x);
            const hidden = layout(type, axes({ x: { visible: false } }), { data: signed });
            expect(lines(hidden, 'baseline')).toEqual([]);
            expect(lines(hidden, 'gridline').some((shape) => Math.abs(at(shape) - zero(hidden)) < 0.01)).toBe(true);
            const bare = layout(type, axes({ x: { visible: false }, y: { gridlines: { visible: false } } }), {
                data: signed,
            });
            expect(bare.shapes.filter((shape) => shape.type === 'line')).toEqual([]);
        }
    });

    test('a hidden category axis keeps half a line below the plot for the lowest tick label, off the title and legend', () => {
        for (const type of ['column', 'line'] as const) {
            for (const patch of [
                axes({ x: { visible: false, title: { text: 'Teams' } } }),
                { ...axes({ x: { visible: false } }), legend: { position: 'bottom' } },
            ] satisfies SpecPatch[]) {
                const out = layout(type, patch, { data });
                const ticks = out.labels.filter((label) => isTick(label.text));
                const lowest = ticks.reduce((a, b) => (a.y > b.y ? a : b));
                const below = out.labels.filter((label) => !isTick(label.text) && label.y > lowest.y);
                expect(below.length).toBeGreaterThan(0);
                for (const label of below)
                    expect(labelBounds(lowest).bottom).toBeLessThanOrEqual(labelBounds(label).top + 0.01);
            }
        }
    });

    test('a hidden value axis draws no tick labels, keeps its gridlines, and the plot takes its room', () => {
        for (const type of ['column', 'bar'] as const) {
            const shown = layout(type, {}, { data });
            const hidden = layout(type, axes({ y: { visible: false } }), { data });
            expect(texts(shown).some(isTick)).toBe(true);
            expect(texts(hidden).some(isTick)).toBe(false);
            expect(lines(hidden, 'gridline').length).toBeGreaterThan(0);
            expect(lines(hidden, 'baseline')).toHaveLength(1);
            if (type === 'column') expect(bar(hidden, 0, 0).x).toBeLessThan(bar(shown, 0, 0).x - 1);
            else
                expect(bar(hidden, 0, 3).y + bar(hidden, 0, 3).height).toBeGreaterThan(
                    bar(shown, 0, 3).y + bar(shown, 0, 3).height + 1,
                );
        }
    });

    test('a hidden axis keeps its title', () => {
        const out = layout(
            'column',
            axes({
                x: { visible: false, title: { text: 'Teams' } },
                y: { visible: false, title: { text: 'Points' } },
            }),
            { data },
        );
        expect(texts(out)).toContain('Teams');
        expect(texts(out)).toContain('Points');
    });

    test("a bar chart runs Google's way by default: the first category on top, its first series topmost", () => {
        const out = layout('bar', {}, { data });
        expect(bar(out, 0, 0).y).toBeLessThan(bar(out, 0, 3).y);
        expect(bar(out, 0, 0).y).toBeLessThan(bar(out, 1, 0).y);
    });

    test('a reversed bar chart runs up from the bottom, each first series lowest in its band, as Excel draws one', () => {
        const out = layout('bar', axes({ x: { scale: { reversed: true } } }), { data });
        expect(bar(out, 0, 0).y).toBeGreaterThan(bar(out, 0, 3).y);
        expect(bar(out, 0, 0).y).toBeGreaterThan(bar(out, 1, 0).y);
        const name = (text: string) => out.labels.find((label) => label.text === text)?.y ?? Number.NaN;
        expect(name('A')).toBeGreaterThan(name('D'));
    });

    test('a reversed column or line chart runs right to left', () => {
        const reversed = axes({ x: { scale: { reversed: true } } });
        const column = layout('column', reversed, { data });
        expect(bar(column, 0, 0).x).toBeGreaterThan(bar(column, 0, 3).x);
        expect(bar(column, 0, 0).x).toBeGreaterThan(bar(column, 1, 0).x);
        const line = layout('line', { ...reversed, series: marked(data) }, { data });
        const marker = (c: number) =>
            ofPart(line, 'marker').find((shape) => shape.id === `c1:marker:0:${c}`)?.x ?? Number.NaN;
        expect(marker(0)).toBeGreaterThan(marker(3));
    });

    test('hidden and reversed axes stay inside the box at every size', () => {
        for (const type of CHART_TYPES) {
            for (const [width, height] of SIZES) {
                const spec = axes({ x: { visible: false, scale: { reversed: true } }, y: { visible: false } });
                const out = layout(type, spec, { width, height });
                for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
                for (const shape of out.shapes) expect(within(shapeBounds(shape), width, height)).toBe(true);
                for (const label of out.labels) expect(within(labelBounds(label), width, height)).toBe(true);
            }
        }
    });
});

describe('line', () => {
    const categories = ['A', 'B', 'C', 'D', 'E'];
    const values = [1, 2, null, 4, 5];

    test("a line series draws at the series width, the axes and gridlines at the stroke's", () => {
        const out = layout('line', {}, { paint: { strokeWidth: 1, seriesStrokeWidth: 3 } });
        expect(new Set(lines(out, 'line').map((line) => line.strokeWidth))).toEqual(new Set([3]));
        const rules = [...lines(out, 'gridline'), ...lines(out, 'baseline')];
        expect(rules.length).toBeGreaterThan(0);
        expect(new Set(rules.map((line) => line.strokeWidth))).toEqual(new Set([1]));
    });

    function lineOf(
        blanks: ChartSpec['chart']['blanks'],
        patch: Partial<ChartSeriesStyle> = { marker: { visible: true } },
        s = series('S', values),
    ) {
        return layout(
            'line',
            { chart: { blanks }, series: { S: style(patch) } },
            { data: { categories, series: [s] } },
        );
    }

    test('points sit at band centers with the min corner at 0,0', () => {
        const out = lineOf('zero');
        const [line] = lines(out, 'line');
        const points = parsePoints(line.points);
        expect(points).toHaveLength(5);
        expect(Math.min(...points.map((p) => p.x))).toBe(0);
        expect(Math.min(...points.map((p) => p.y))).toBe(0);
        const xs = points.map((p) => p.x);
        const step = xs[1] - xs[0];
        for (let i = 2; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(step, 1);
    });

    test("blanks: 'gap' splits, 'zero' plots 0, 'span' joins neighbors", () => {
        expect(lines(lineOf('gap'), 'line').map((line) => parsePoints(line.points).length)).toEqual([2, 2]);
        expect(lines(lineOf('zero'), 'line').map((line) => parsePoints(line.points).length)).toEqual([5]);
        expect(lines(lineOf('span'), 'line').map((line) => parsePoints(line.points).length)).toEqual([4]);
        expect(ofPart(lineOf('gap'), 'marker')).toHaveLength(4);
        expect(ofPart(lineOf('zero'), 'marker')).toHaveLength(5);
    });

    test('a lone point between gaps draws no line', () => {
        const out = lineOf('gap', {}, series('S', [1, null, 3, null, 5]));
        expect(lines(out, 'line')).toEqual([]);
    });

    test('smooth draws round, markers are ellipses in the series color', () => {
        const out = lineOf('span', { color: '#1baf7a', marker: { visible: true }, line: { smooth: true } });
        expect(lines(out, 'line')[0].roundness).toBe('round');
        expect(lines(out, 'line')[0].strokeColor).toBe('#1baf7a');
        expect(
            ofPart(out, 'marker').every((marker) => marker.type === 'ellipse' && marker.strokeColor === '#1baf7a'),
        ).toBe(true);
        expect(lines(lineOf('span'), 'line')[0].roundness).toBe('sharp');
        expect(ofPart(layout('line'), 'marker')).toEqual([]);
    });
});

describe('edge cases', () => {
    const one = (values: (number | null)[]): ChartData => ({
        categories: values.map((_, i) => `C${i}`),
        series: [series('S', values)],
    });
    const valueTicks = (out: ChartLayout) =>
        out.labels.filter((label) => label.anchor === 'end' && label.rotate === 0).map((label) => label.text);
    const small = { width: 400, height: 300 };

    test('a span too small for a tick step lays out as a zero span, every number finite', () => {
        for (const type of ['column', 'bar', 'line'] as const) {
            const out = layout(type, {}, { ...small, data: one([1e-310, 2e-310]) });
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
            expect(ofPart(out, 'baseline')).toHaveLength(1);
        }
    });

    test('the value axis draws at most 20 ticks, however many d3 hands back', () => {
        const column = layout(
            'column',
            { title: { text: '' }, legend: { position: 'none' } },
            { data: one([61]), width: 400, height: 2000 },
        );
        expect(valueTicks(column).length).toBeGreaterThan(10);
        expect(valueTicks(column).length).toBeLessThanOrEqual(20);
        const pinned = { axes: { y: { scale: { min: 10, max: 30 } } } };
        const fixed = layout('column', pinned, { data: one([20]), width: 400, height: 2000 });
        expect(valueTicks(fixed).length).toBeLessThanOrEqual(20);
    });

    test('tiny values get distinct tick labels', () => {
        const texts = valueTicks(layout('column', {}, { ...small, data: one([1e-20, 3e-20]) }));
        expect(texts.length).toBeGreaterThan(2);
        expect(new Set(texts).size).toBe(texts.length);
    });

    test('a huge value still draws a plot', () => {
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, {}, { ...small, data: one([1e100]) });
            expect(out.labels.map((label) => label.text)).not.toContain('Chart too small');
            expect(rects(out, 'bar')).toHaveLength(1);
        }
    });

    test('a line axis fits the data; bars still start at zero', () => {
        const out = layout('line', {}, { data: one([1000, 1002, 1004]) });
        const lowest = Number(valueTicks(out)[0].replaceAll(',', ''));
        expect(lowest).toBeGreaterThan(0);
        expect(lowest).toBeLessThanOrEqual(1000);
        const gridlines = lines(out, 'gridline').map((line) => line.y);
        const plotHeight = Math.max(...gridlines, lines(out, 'baseline')[0].y) - Math.min(...gridlines);
        expect(lines(out, 'line')[0].height).toBeGreaterThan(plotHeight / 2);
        expect(valueTicks(layout('column', {}, { data: one([1000, 1002, 1004]) }))[0]).toBe('0');
        // A flat line has no span of its own, so its axis starts at zero.
        expect(valueTicks(layout('line', {}, { data: one([7]) }))[0]).toBe('0');
        expect(valueTicks(layout('line', {}, { data: one([-5, -5]) })).at(-1)).toBe('0');
    });

    test("a line axis takes in zero once the data spreads over a sixth of its largest magnitude, as Excel's does", () => {
        // The line's lowest point sits as far above the baseline at zero as it sits below its highest point.
        const wide = layout('line', {}, { data: one([50, 70, 100]) });
        expect(valueTicks(wide)[0]).toBe('0');
        const [line] = lines(wide, 'line');
        expect(lines(wide, 'baseline')[0].y - (line.y + line.height)).toBeCloseTo(line.height, 6);
        expect(valueTicks(layout('line', {}, { data: one([-50, -70, -100]) })).at(-1)).toBe('0');
        // 49 is under 5/6 of 60; 50 is exactly 5/6 and still fits.
        expect(valueTicks(layout('line', {}, { data: one([49, 60]) }))[0]).toBe('0');
        for (const values of [
            [90, 95, 100],
            [50, 60],
        ]) {
            expect(Number(valueTicks(layout('line', {}, { data: one(values) }))[0])).toBeGreaterThan(0);
            expect(Number(valueTicks(layout('line', {}, { data: one(values.map((v) => -v)) })).at(-1))).toBeLessThan(0);
        }
        // A pinned min still wins.
        const pinned = layout('line', { axes: { y: { scale: { min: 40, max: null } } } }, { data: one([50, 70, 100]) });
        expect(valueTicks(pinned)[0]).toBe('40');
    });

    test('no plottable value says No data for every type', () => {
        for (const type of CHART_TYPES) {
            for (const blanks of ['gap', 'zero', 'span'] as const) {
                const out = layout(type, { chart: { blanks } }, { data: one([null, null]) });
                expect(out.shapes.map((shape) => shape.id)).toEqual(['c1:background']);
                expect(out.labels.map((label) => label.text)).toEqual(['No data']);
            }
        }
    });

    test('all zeros draw axes from 0 to 1 with flat marks', () => {
        for (const type of ['column', 'bar', 'line'] as const) {
            const out = layout(type, {}, { data: one([0, 0, 0]) });
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
            const ticks = out.labels
                .filter((label) => /^\d/.test(label.text) && !label.text.startsWith('C'))
                .map((label) => label.text);
            expect([ticks[0], ticks.at(-1)]).toEqual(['0.0', '1.0']);
            if (type === 'line') expect(lines(out, 'line')[0].height).toBe(0);
            else for (const bar of rects(out, 'bar')) expect(type === 'column' ? bar.height : bar.width).toBe(0);
        }
    });

    test('a stack of mixed signs covers both sums, negatives below zero', () => {
        const data = { categories: ['A', 'B'], series: [series('S', [5, -3]), series('T', [2, -1])] };
        const out = layout('column', { plots: plots('stacked') }, { data });
        const ticks = valueTicks(out).map(Number);
        expect(ticks[0]).toBeLessThanOrEqual(-4);
        expect(ticks.at(-1)).toBeGreaterThanOrEqual(7);
        const baseline = lines(out, 'baseline')[0].y;
        for (const bar of rects(out, 'bar').filter((bar) => bar.id.endsWith(':1'))) {
            expect(bar.y).toBeGreaterThanOrEqual(baseline - 0.01);
        }
    });

    test('pinned bounds: exact decimal labels, and a min past the data draws a finite empty plot', () => {
        const pinned = { axes: { x: {}, y: { scale: { min: 0.1, max: 0.7 } } } };
        expect(valueTicks(layout('column', pinned, { data: one([0.3, 0.5]) }))).toEqual([
            '0.1',
            '0.2',
            '0.3',
            '0.4',
            '0.5',
            '0.6',
            '0.7',
        ]);
        const past = layout('column', { axes: { y: { scale: { min: 200, max: null } } } }, { data: one([1, 2]) });
        for (const n of numbersIn(past)) expect(Number.isFinite(n)).toBe(true);
        expect(Number(valueTicks(past)[0])).toBe(200);
        for (const bar of rects(past, 'bar')) expect(bar.height).toBe(0);
        for (const [min, max] of [
            [1e20, null],
            [0, 1e-310],
        ]) {
            const out = layout('column', { axes: { y: { scale: { min, max } } } }, { data: one([1, 2]) });
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
        }
    });

    test('a 100% stack holds at the edges: denormals, no data and the tick cap', () => {
        for (const type of ['column', 'bar'] as const) {
            const tiny = layout(type, { plots: plots('percent') }, { ...small, data: one([1e-310, 2e-310]) });
            for (const n of numbersIn(tiny)) expect(Number.isFinite(n)).toBe(true);
            const ticks = tiny.labels.map((label) => label.text).filter((text) => text.endsWith('%'));
            expect([ticks[0], ticks.at(-1)]).toEqual(['0%', '100%']);
            const blank = layout(type, { plots: plots('percent') }, { data: one([null, null]) });
            expect(blank.labels.map((label) => label.text)).toEqual(['No data']);
        }
        const tall = layout(
            'column',
            { plots: plots('percent'), title: { text: '' }, legend: { position: 'none' } },
            { data: one([1]), width: 400, height: 2000 },
        );
        expect(valueTicks(tall).length).toBeLessThanOrEqual(20);
    });

    test("grouped bars and their outlines never overlap a neighbor's", () => {
        const data = {
            categories: ['A', 'B', 'C', 'D', 'E'],
            series: Array.from({ length: 4 }, (_, s) =>
                series(
                    `S${s}`,
                    [3, 5, 2, 4, 1].map((v) => v + s),
                ),
            ),
        };
        for (const type of ['column', 'bar'] as const) {
            for (const paint of [{ strokeWidth: 2, roughness: 0 }, { strokeWidth: 4, roughness: 1 }, {}]) {
                for (const [width, height] of [
                    [180, 120],
                    [400, 300],
                    [1200, 675],
                ]) {
                    const out = layout(type, { plots: plots('none') }, { data, width, height, paint });
                    const bars = rects(out, 'bar');
                    expect(bars).toHaveLength(20);
                    // Each bar's extent across the band, its outline included.
                    const extent = (bar: VectorRectangleElement) => {
                        const [from, size] = type === 'column' ? [bar.x, bar.width] : [bar.y, bar.height];
                        return [from - bar.strokeWidth / 2, from + size + bar.strokeWidth / 2];
                    };
                    const spans = bars.map(extent).sort((a, b) => a[0] - b[0]);
                    for (let i = 1; i < spans.length; i++)
                        expect(spans[i - 1][1]).toBeLessThanOrEqual(spans[i][0] + 1e-9);
                }
            }
        }
    });
});
