import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    chartPointCount,
    defaultChartPresentation,
    formatTickValue,
    layoutChart,
    layoutChartMessage,
    MAX_SKETCH_POINTS,
    sampleChartSpec,
} from '../../charts';
import {
    CHART_STACKINGS,
    CHART_TYPES,
    type ChartData,
    type ChartLabel,
    type ChartLayout,
    type ChartPaint,
    type ChartSpec,
    type ChartType,
    LEGEND_POSITIONS,
} from '../../types/chart';
import { parseFill, serializeFill, solidFill, TRANSPARENT_FILL } from '../../vector/fill';
import { getLineHeightPx } from '../../vector/font-metrics';
import { parsePoints } from '../../vector/geometry';
import { readElementFromFields } from '../../vector/read-vector';
import { measureLabel } from '../../vector/text-width';
import type { VectorElement, VectorLinearElement, VectorPieElement, VectorRectangleElement } from '../../vector/types';

const PAINT: ChartPaint = {
    color: '#1e1e1e',
    background: solidFill('#ffffff'),
    strokeColor: '#1e1e1e',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    seed: 7,
    fillStyle: 'solid',
};

const style = { markers: false, smooth: false };

function series(name: string, values: (number | null)[], color: string | null = '#2a78d6') {
    return { ...style, color, name, values };
}

// The sample without its axis titles, for tests that measure the room left to the plot and its labels.
const UNTITLED: Partial<ChartSpec> = {
    categoryAxis: defaultChartPresentation('column').categoryAxis,
    valueAxis: defaultChartPresentation('column').valueAxis,
};

type Options = { data?: ChartData; width?: number; height?: number; paint?: Partial<ChartPaint> };

function sampleData(type: ChartType): ChartData {
    const { data } = sampleChartSpec(type);
    return data.source === 'inline' ? data : { categories: [], series: [] };
}

function layout(type: ChartType, patch: Partial<ChartSpec> = {}, options: Options = {}): ChartLayout {
    return layoutChart({
        id: 'c1',
        spec: { ...sampleChartSpec(type), ...patch },
        data: options.data ?? sampleData(type),
        width: options.width ?? 640,
        height: options.height ?? 400,
        paint: { ...PAINT, ...options.paint },
        formatTick: formatTickValue,
    });
}

function ofPart(out: ChartLayout, part: string): VectorElement[] {
    return out.shapes.filter((shape) => shape.id.split(':')[1] === part);
}

function rects(out: ChartLayout, part: string): VectorRectangleElement[] {
    return ofPart(out, part).filter((shape): shape is VectorRectangleElement => shape.type === 'rectangle');
}

function lines(out: ChartLayout, part: string): VectorLinearElement[] {
    return ofPart(out, part).filter((shape): shape is VectorLinearElement => shape.type === 'line');
}

function slices(out: ChartLayout): VectorPieElement[] {
    return out.shapes.filter((shape): shape is VectorPieElement => shape.type === 'pie');
}

type Bounds = { left: number; top: number; right: number; bottom: number };

// The label's line box from measureLabel and the font's line height, turned about its anchor point.
function labelBounds(label: ChartLabel): Bounds {
    const width = measureLabel(label.text, label.fontFamily, label.fontSize, label.bold);
    const height = getLineHeightPx(label.fontFamily, label.fontSize);
    const x0 = label.anchor === 'start' ? 0 : label.anchor === 'middle' ? -width / 2 : -width;
    const rad = (label.rotate * Math.PI) / 180;
    const corners = [
        [x0, 0],
        [x0 + width, 0],
        [x0, height],
        [x0 + width, height],
    ].map(([dx, dy]) => [
        label.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        label.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    ]);
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function shapeBounds(shape: VectorElement): Bounds {
    return { left: shape.x, top: shape.y, right: shape.x + shape.width, bottom: shape.y + shape.height };
}

function within(bounds: Bounds, width: number, height: number): boolean {
    const slack = 0.01;
    return (
        bounds.left >= -slack &&
        bounds.top >= -slack &&
        bounds.right <= width + slack &&
        bounds.bottom <= height + slack
    );
}

function overlaps(a: Bounds, b: Bounds): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function numbersIn(value: unknown): number[] {
    if (typeof value === 'number') return [value];
    if (typeof value === 'string' && value.startsWith('[')) return numbersIn(JSON.parse(value));
    if (Array.isArray(value)) return value.flatMap(numbersIn);
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
    return [];
}

const SIZES: [number, number][] = [
    [640, 400],
    [1200, 675],
    [320, 200],
    [180, 120],
];

describe('layoutChart invariants', () => {
    const cases = CHART_TYPES.flatMap((type) =>
        LEGEND_POSITIONS.flatMap((legend) =>
            CHART_STACKINGS.flatMap((stacking) =>
                SIZES.map(([width, height]) => ({ type, legend, stacking, width, height })),
            ),
        ),
    );

    test.each(cases)(
        '$type legend $legend stacking $stacking at $width × $height',
        ({ type, legend, stacking, width, height }) => {
            const spec: Partial<ChartSpec> = {
                legend,
                stacking,
                categoryAxis: { ...defaultChartPresentation('column').categoryAxis, title: 'Teams' },
                valueAxis: { ...defaultChartPresentation('column').valueAxis, title: 'Points' },
            };
            const out = layout(type, spec, { width, height });

            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
            for (const shape of out.shapes) {
                expect(within(shapeBounds(shape), width, height)).toBe(true);
                expect(shape.id.startsWith('c1:')).toBe(true);
                expect(Number.isInteger(shape.seed) && shape.seed >= 1 && shape.seed < 2 ** 31).toBe(true);
                // A shape is a whole stored element: the canvas reader keeps it as it is.
                expect(readElementFromFields(new Map(Object.entries(shape)))).toEqual(shape);
            }
            expect(new Set(out.shapes.map((shape) => shape.id)).size).toBe(out.shapes.length);
            for (const label of out.labels) {
                expect(label.text).not.toBe('');
                expect(within(labelBounds(label), width, height)).toBe(true);
            }
            expect(layout(type, spec, { width, height })).toEqual(out);
        },
    );

    test('seeds follow the paint seed; ids do not', () => {
        const a = layout('column');
        const b = layout('column', {}, { paint: { seed: 8 } });
        expect(b.shapes.map((shape) => shape.id)).toEqual(a.shapes.map((shape) => shape.id));
        expect(b.shapes.map((shape) => shape.seed)).not.toEqual(a.shapes.map((shape) => shape.seed));
        expect(new Set(a.shapes.map((shape) => shape.seed)).size).toBe(a.shapes.length);
    });

    test('paint order: background, gridlines, bars, lines, markers, baseline, legend', () => {
        const order = ['background', 'gridline', 'bar', 'slice', 'line', 'marker', 'baseline', 'legend'];
        for (const type of CHART_TYPES) {
            const { categories, series } = sampleData(type);
            const out = layout(
                type,
                { legend: 'top' },
                { data: { categories, series: series.map((s) => ({ ...s, markers: true })) } },
            );
            const ranks = out.shapes.map((shape) => order.indexOf(shape.id.split(':')[1]));
            expect(ranks).not.toContain(-1);
            expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
        }
    });

    test('a transparent background draws no shape; others draw one first, unstroked', () => {
        expect(
            ofPart(layout('column', {}, { paint: { background: serializeFill(TRANSPARENT_FILL) } }), 'background'),
        ).toEqual([]);
        const out = layout('column');
        expect(out.shapes[0].id).toBe('c1:background');
        expect(out.shapes[0].strokeColor).toBe('transparent');
        expect(shapeBounds(out.shapes[0])).toEqual({ left: 0, top: 0, right: 640, bottom: 400 });
    });

    test("the background paints solid; the fill's hatch style is the marks' alone", () => {
        const out = layout(
            'column',
            {},
            { paint: { background: solidFill('#ffffff', 'cross-hatch'), fillStyle: 'cross-hatch' } },
        );
        const [background] = rects(out, 'background');
        expect(parseFill(background.fill)).toEqual({ type: 'solid', color: '#ffffff', style: 'solid' });
        for (const bar of rects(out, 'bar')) expect(parseFill(bar.fill).style).toBe('cross-hatch');
    });

    test('gridlines are faint, every other shape opaque', () => {
        const out = layout('column');
        expect(ofPart(out, 'gridline').length).toBeGreaterThan(1);
        for (const shape of out.shapes) {
            if (shape.id.split(':')[1] === 'gridline') expect(shape.opacity).toBeLessThanOrEqual(20);
            else expect(shape.opacity).toBe(100);
        }
        expect(
            ofPart(
                layout('column', { valueAxis: { ...defaultChartPresentation('column').valueAxis, gridlines: false } }),
                'gridline',
            ),
        ).toEqual([]);
    });

    test('the paint dashes the gridlines and the baseline, never the marks', () => {
        const out = layout('column', {}, { paint: { strokeStyle: 'dashed' } });
        for (const shape of out.shapes) {
            const part = shape.id.split(':')[1];
            const rule = part === 'gridline' || part === 'baseline';
            expect([part, shape.strokeStyle]).toEqual([part, rule ? 'dashed' : 'solid']);
        }
    });

    test('text sizes scale with the box, the title bold and larger', () => {
        const small = layout('column', {}, { width: 320, height: 200 });
        const large = layout('column', {}, { width: 1200, height: 675 });
        const title = (out: ChartLayout) => out.labels.find((label) => label.text === "Where a star's light goes");
        const tick = (out: ChartLayout) => out.labels.find((label) => label.text === '0');
        expect(title(large)?.fontSize).toBeGreaterThan(title(small)?.fontSize ?? Infinity);
        expect(title(large)?.bold).toBe(true);
        expect(title(large)?.fontSize).toBeGreaterThan(tick(large)?.fontSize ?? Infinity);
        expect(title(large)?.anchor).toBe('middle');
        expect(title(large)?.x).toBe(600);
    });

    test('every label draws in the spec font and reserves its room by that font', () => {
        // Narrow in Inter, a full cell each in a monospace face.
        const data = { categories: ['illicit', 'iii'], series: [series('S', [3, 5])] };
        const bar = (fontFamily: string) => {
            const out = layout('bar', { ...UNTITLED, fontFamily }, { data });
            expect(out.labels.every((label) => label.fontFamily === fontFamily)).toBe(true);
            const names = out.labels.filter((label) => data.categories.includes(label.text));
            const widest = Math.max(...names.map((l) => measureLabel(l.text, fontFamily, l.fontSize, l.bold)));
            // The left column ends where the end-anchored names do: the pad plus the widest name.
            return { end: names[0].x, pad: names[0].x - widest };
        };
        const inter = bar('Inter');
        const mono = bar('JetBrains Mono');
        expect(mono.end).toBeGreaterThan(inter.end + 1);
        expect(mono.pad).toBeCloseTo(inter.pad, 6);
    });
});

describe('column and bar', () => {
    const data: ChartData = {
        categories: ['A', 'B', 'C', 'D'],
        series: [series('S1', [10, 20, 0, 40]), series('S2', [5, -15, 25, null], '#eb6834')],
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

    test('bars run top to bottom in category order', () => {
        const bars = rects(layout('bar', {}, { data }), 'bar').filter((bar) => bar.id.startsWith('c1:bar:0:'));
        expect(bars.map((bar) => bar.y)).toEqual([...bars.map((bar) => bar.y)].sort((x, y) => x - y));
    });

    test('stacked: positives and negatives stack apart, each top at its sum', () => {
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { stacking: 'stacked' }, { data });
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
            series: [series('S1', [10, 1]), series('S2', [30, 3], '#eb6834')],
        };
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { stacking: 'percent' }, { data: shares });
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
        const data: ChartData = { categories: ['A'], series: [series('S1', [1]), series('S2', [3], '#eb6834')] };
        const out = layout(
            'column',
            { stacking: 'percent', valueAxis: { ...defaultChartPresentation('column').valueAxis, max: 0.5 } },
            { data },
        );
        const ticks = out.labels.filter((label) => label.anchor === 'end').map((label) => label.text);
        expect(ticks[0]).toBe('0%');
        expect(ticks.at(-1)).toBe('50%');
    });

    test('100% stacked with mixed signs: shares of the absolute sum, negatives below zero', () => {
        const mixed: ChartData = {
            categories: ['A', 'B'],
            series: [series('S1', [5, 4]), series('S2', [-3, 4], '#eb6834')],
        };
        const out = layout('column', { stacking: 'percent' }, { data: mixed });
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
            series: [series('S1', [0, 10, null]), series('S2', [0, 30, null], '#eb6834')],
        };
        for (const type of ['column', 'bar'] as const) {
            const out = layout(type, { stacking: 'percent' }, { data: zero });
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
        const out = layout(
            'column',
            {
                valueAxis: { ...defaultChartPresentation('column').valueAxis, min: 10, max: 30 },
            },
            { data },
        );
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

    // A peer stores the box, so a huge one must not mean huge work. formatTick runs once per tick of
    // every axis the layout tries, so its calls count the tick work; past the budget it throws.
    test.each([
        ['column', 600, 1e6],
        ['bar', 1e6, 600],
        ['column', 600, 1e9],
        ['bar', 1e9, 600],
        ['line', 1e9, 1e9],
    ] as const)('a %s at %d × %d lays out in bounded work', (type, width, height) => {
        let calls = 0;
        const out = layoutChart({
            id: 'c1',
            spec: sampleChartSpec(type),
            data: sampleData(type),
            width,
            height,
            paint: PAINT,
            formatTick: (value, step) => {
                calls++;
                if (calls > 60) throw new Error('unbounded tick work');
                return formatTickValue(value, step);
            },
        });
        expect(lines(out, 'gridline').length).toBeLessThanOrEqual(30);
        expect(out.labels.length).toBeLessThanOrEqual(40);
    });

    test("a bar chart's value labels drop ticks until they stop touching", () => {
        const wide: ChartData = { categories: ['A', 'B'], series: [series('S', [123456789, -987654321])] };
        for (const width of [240, 320, 480, 640, 1200]) {
            const out = layout('bar', { title: '', legend: 'none' }, { data: wide, width });
            const ticks = out.labels.filter((label) => label.anchor === 'middle').map(labelBounds);
            expect(ticks.length).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < ticks.length; i++) expect(overlaps(ticks[i - 1], ticks[i])).toBe(false);
        }
    });

    test('the caller formats the ticks', () => {
        const out = layoutChart({
            id: 'c1',
            spec: sampleChartSpec('column'),
            data: data,
            width: 640,
            height: 400,
            paint: PAINT,
            formatTick: (value, step) => `${value}/${step}`,
        });
        expect(out.labels.some((label) => /^-?\d+\/\d+$/.test(label.text))).toBe(true);
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
        for (const band of ['UV', 'Blue', 'Green', 'Red', 'IR-A', 'IR-B/C']) {
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
        const out = layout('column', {
            categoryAxis: { ...defaultChartPresentation('column').categoryAxis, title: 'Teams' },
            valueAxis: { ...defaultChartPresentation('column').valueAxis, title: 'Points' },
        });
        const teams = out.labels.find((label) => label.text === 'Teams');
        const points = out.labels.find((label) => label.text === 'Points');
        expect(teams?.rotate).toBe(0);
        expect(points?.rotate).toBe(-90);
        const uv = out.labels.find((label) => label.text === 'UV');
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
            const out = layout('bar', { ...UNTITLED, legend }, { data });
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
        series: [series('S1', [10, 20, 30, 40], '#2a78d6'), series('S2', [5, 15, 25, 35], '#eb6834')],
    };
    type AxesPatch = { category?: Partial<ChartSpec['categoryAxis']>; value?: Partial<ChartSpec['valueAxis']> };
    function axes(type: ChartType, { category = {}, value = {} }: AxesPatch): Partial<ChartSpec> {
        const spec = defaultChartPresentation(type);
        return {
            categoryAxis: { ...spec.categoryAxis, ...category },
            valueAxis: { ...spec.valueAxis, ...value },
        };
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
            const hidden = layout(type, axes(type, { category: { visible: false } }), { data });
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
            const hidden = layout(type, axes(type, { category: { visible: false } }), { data: signed });
            expect(lines(hidden, 'baseline')).toEqual([]);
            expect(lines(hidden, 'gridline').some((shape) => Math.abs(at(shape) - zero(hidden)) < 0.01)).toBe(true);
            const bare = layout(type, axes(type, { category: { visible: false }, value: { gridlines: false } }), {
                data: signed,
            });
            expect(bare.shapes.filter((shape) => shape.type === 'line')).toEqual([]);
        }
    });

    test('a hidden category axis keeps half a line below the plot for the lowest tick label, off the title and legend', () => {
        for (const type of ['column', 'line'] as const) {
            for (const patch of [
                axes(type, { category: { visible: false, title: 'Teams' } }),
                { ...axes(type, { category: { visible: false } }), legend: 'bottom' as const },
            ]) {
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
            const hidden = layout(type, axes(type, { value: { visible: false } }), { data });
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
            axes('column', {
                category: { visible: false, title: 'Teams' },
                value: { visible: false, title: 'Points' },
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
        const out = layout('bar', axes('bar', { category: { reversed: true } }), { data });
        expect(bar(out, 0, 0).y).toBeGreaterThan(bar(out, 0, 3).y);
        expect(bar(out, 0, 0).y).toBeGreaterThan(bar(out, 1, 0).y);
        const name = (text: string) => out.labels.find((label) => label.text === text)?.y ?? Number.NaN;
        expect(name('A')).toBeGreaterThan(name('D'));
    });

    test('a reversed column or line chart runs right to left', () => {
        const column = layout('column', axes('column', { category: { reversed: true } }), { data });
        expect(bar(column, 0, 0).x).toBeGreaterThan(bar(column, 0, 3).x);
        expect(bar(column, 0, 0).x).toBeGreaterThan(bar(column, 1, 0).x);
        const marked = { ...data, series: data.series.map((s) => ({ ...s, markers: true })) };
        const line = layout('line', axes('line', { category: { reversed: true } }), { data: marked });
        const marker = (c: number) =>
            ofPart(line, 'marker').find((shape) => shape.id === `c1:marker:0:${c}`)?.x ?? Number.NaN;
        expect(marker(0)).toBeGreaterThan(marker(3));
    });

    test('hidden and reversed axes stay inside the box at every size', () => {
        for (const type of CHART_TYPES) {
            for (const [width, height] of SIZES) {
                const spec = axes(type, { category: { visible: false, reversed: true }, value: { visible: false } });
                const out = layout(type, spec, { width, height });
                for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
                for (const shape of out.shapes) expect(within(shapeBounds(shape), width, height)).toBe(true);
                for (const label of out.labels) expect(within(labelBounds(label), width, height)).toBe(true);
            }
        }
    });
});

describe('legend', () => {
    test('top and bottom are a centered row of swatches, left and right a column', () => {
        const top = layout('column', { legend: 'top' });
        const swatches = rects(top, 'legend');
        expect(swatches.map((swatch) => swatch.fill)).toEqual([0, 1, 2].map((i) => solidFill(chartColor(i))));
        expect(swatches[0].y).toBeCloseTo(swatches[1].y);
        const titleBottom = Math.max(...top.labels.filter((l) => l.bold).map((l) => labelBounds(l).bottom));
        expect(swatches[0].y).toBeGreaterThan(titleBottom);
        const left = swatches[0].x;
        const last = top.labels.find((label) => label.text === 'Hot star');
        const right = (last?.x ?? 0) + measureLabel('Hot star', 'Inter', last?.fontSize ?? 0, false);
        expect((left + right) / 2).toBeCloseTo(320, -1);

        const bottom = rects(layout('column', { legend: 'bottom' }), 'legend');
        expect(bottom[0].y).toBeGreaterThan(300);

        for (const side of ['left', 'right'] as const) {
            const column = rects(layout('column', { legend: side }), 'legend');
            expect(column[0].x).toBeCloseTo(column[1].x);
            expect(column[1].y).toBeGreaterThan(column[0].y);
            expect(side === 'left' ? column[0].x < 100 : column[0].x > 500).toBe(true);
        }
        expect(rects(layout('column', { legend: 'none' }), 'legend')).toEqual([]);
    });

    test('a null series color is the palette color at its index, on the bar and the swatch', () => {
        const data: ChartData = {
            categories: ['A'],
            series: [series('S1', [1], null), series('S2', [2], '#123456'), series('S3', [3], null)],
        };
        const out = layout('column', {}, { data, paint: { fillStyle: 'hachure' } });
        const colors = [chartColor(0), '#123456', chartColor(2)];
        expect(rects(out, 'legend').map((swatch) => swatch.strokeColor)).toEqual(colors);
        expect(rects(out, 'bar').map((bar) => bar.strokeColor)).toEqual(colors);
        expect(rects(out, 'bar').map((bar) => bar.fill)).toEqual(colors.map((color) => solidFill(color, 'hachure')));
    });

    test('a wide legend wraps into rows that stay inside the box', () => {
        const names = Array.from({ length: 12 }, (_, i) => `Series number ${i + 1}`);
        const out = layout(
            'column',
            { legend: 'top' },
            {
                data: { categories: ['A', 'B'], series: names.map((name, i) => series(name, [i, i + 1])) },
            },
        );
        const swatches = rects(out, 'legend');
        expect(new Set(swatches.map((swatch) => swatch.y)).size).toBeGreaterThan(1);
    });
});

describe('line', () => {
    const categories = ['A', 'B', 'C', 'D', 'E'];
    const values = [1, 2, null, 4, 5];

    function lineOf(blanks: ChartSpec['blanks'], s = { ...series('S', values), markers: true }) {
        return layout('line', { blanks }, { data: { categories, series: [s] } });
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
        const out = lineOf('gap', { ...series('S', [1, null, 3, null, 5]), markers: false });
        expect(lines(out, 'line')).toEqual([]);
    });

    test('smooth draws round, markers are ellipses in the series color', () => {
        const out = lineOf('span', { ...series('S', values, '#1baf7a'), markers: true, smooth: true });
        expect(lines(out, 'line')[0].roundness).toBe('round');
        expect(lines(out, 'line')[0].strokeColor).toBe('#1baf7a');
        expect(
            ofPart(out, 'marker').every((marker) => marker.type === 'ellipse' && marker.strokeColor === '#1baf7a'),
        ).toBe(true);
        expect(lines(lineOf('span'), 'line')[0].roundness).toBe('sharp');
        expect(ofPart(layout('line'), 'marker')).toEqual([]);
    });
});

describe('pie', () => {
    test("slices sweep their share clockwise from 12 o'clock and sum to 360", () => {
        const out = layout('pie');
        const pie = slices(out);
        expect(pie).toHaveLength(6);
        expect(pie[0].startAngle).toBe(270);
        expect(pie.reduce((sum, slice) => sum + slice.sweepAngle, 0)).toBeCloseTo(360);
        expect(pie[0].sweepAngle).toBeCloseTo((12.2 / 100) * 360);
        for (let i = 1; i < pie.length; i++) {
            expect(pie[i].startAngle).toBeCloseTo((pie[i - 1].startAngle + pie[i - 1].sweepAngle) % 360);
        }
        const [first] = pie;
        expect(first.width).toBe(first.height);
        for (const slice of pie) expect(slice.x).toBe(first.x);
    });

    test('slices take sliceColors, then the palette', () => {
        const out = layout('pie', { sliceColors: ['#000000'] });
        const pie = slices(out);
        expect(pie[0].fill).toBe(solidFill('#000000'));
        expect(pie[1].fill).toBe(solidFill(chartColor(1)));
        const automatic = slices(layout('pie', { sliceColors: [null, '#000000'] }));
        expect(automatic.map((slice) => slice.fill)).toEqual(
            [chartColor(0), '#000000', chartColor(2), chartColor(3), chartColor(4), chartColor(5)].map((color) =>
                solidFill(color),
            ),
        );
    });

    test('labels read name and percent; slices under 5% go unlabeled', () => {
        const out = layout(
            'pie',
            {},
            {
                data: { categories: ['Big', 'Small', 'Rest'], series: [series('S', [70, 4, 26])] },
            },
        );
        const texts = out.labels.map((label) => label.text);
        expect(texts).toContain('Big 70%');
        expect(texts).toContain('Rest 26%');
        expect(texts.some((text) => text.startsWith('Small'))).toBe(false);
        expect(slices(out)).toHaveLength(3);
        const big = out.labels.find((label) => label.text === 'Big 70%');
        const rest = out.labels.find((label) => label.text === 'Rest 26%');
        // 70% clockwise from 12 o'clock is centered lower right, the last 26% upper left
        expect(big?.anchor).toBe('start');
        expect(rest?.anchor).toBe('end');
    });

    test('one slice of 100% sweeps the full circle', () => {
        const out = layout('pie', {}, { data: { categories: ['All', 'None'], series: [series('S', [5, 0])] } });
        const pie = slices(out);
        expect(pie).toHaveLength(1);
        expect(pie[0].sweepAngle).toBe(360);
        expect(out.labels.map((label) => label.text)).toContain('All 100%');
    });

    test('a negative value or a zero total draws a message, no slices', () => {
        for (const values of [
            [5, -1],
            [0, 0],
            [null, null],
        ]) {
            const out = layout('pie', {}, { data: { categories: ['A', 'B'], series: [series('S', values)] } });
            expect(slices(out)).toEqual([]);
            expect(out.labels).toHaveLength(1);
            expect(out.labels[0].anchor).toBe('middle');
        }
    });
});

describe('unusable data', () => {
    test('no series or no categories draws one centered message over the background', () => {
        for (const type of CHART_TYPES) {
            for (const data of [
                { categories: [], series: [] },
                { categories: ['A'], series: [] },
                { categories: [], series: [series('S', [])] },
            ]) {
                const out = layout(type, {}, { data });
                expect(out.shapes.map((shape) => shape.id)).toEqual(['c1:background']);
                expect(out.labels).toHaveLength(1);
                expect(out.labels[0]).toMatchObject({ text: 'No data', anchor: 'middle', x: 320 });
            }
        }
    });

    test('a message alone is the background and one centered line that fits the box', () => {
        const box = { id: 'c1', width: 640, height: 400, paint: PAINT };
        const out = layoutChartMessage(box, 'Nothing here', 'Inter');
        expect(out.shapes.map((shape) => shape.id)).toEqual(['c1:background']);
        expect(out.labels).toEqual(
            layout('column', {}, { data: { categories: [], series: [] } }).labels.map((l) => ({
                ...l,
                text: 'Nothing here',
            })),
        );
        const narrow = layoutChartMessage({ ...box, width: 90 }, 'A message far wider than the box', 'Inter');
        expect(narrow.labels).toHaveLength(1);
        expect(narrow.labels[0].text.endsWith('…')).toBe(true);
        expect(measureLabel(narrow.labels[0].text, 'Inter', narrow.labels[0].fontSize, false)).toBeLessThanOrEqual(90);
        const mono = layoutChartMessage(box, 'Nothing here', 'JetBrains Mono');
        expect(mono.labels[0].fontFamily).toBe('JetBrains Mono');
    });

    test('a box too small draws no chart and nothing outside the box', () => {
        for (const [width, height] of [
            [0, 0],
            [40, 30],
            [12, 400],
        ]) {
            for (const type of CHART_TYPES) {
                const out = layout(type, {}, { width, height });
                expect(out.shapes.filter((shape) => shape.id !== 'c1:background')).toEqual([]);
                for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
                for (const label of out.labels) expect(within(labelBounds(label), width, height)).toBe(true);
            }
        }
    });

    test('extreme values stay finite', () => {
        for (const [type, stacking] of CHART_TYPES.flatMap((type) => CHART_STACKINGS.map((s) => [type, s] as const))) {
            const out = layout(
                type,
                { stacking },
                {
                    data: {
                        categories: ['A', 'B'],
                        series: [
                            series('S', [Number.MAX_VALUE, 1e-300]),
                            series('T', [Number.MAX_VALUE, -Number.MAX_VALUE]),
                        ],
                    },
                },
            );
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
        }
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
        const column = layout('column', { title: '', legend: 'none' }, { data: one([61]), width: 400, height: 2000 });
        expect(valueTicks(column).length).toBeGreaterThan(10);
        expect(valueTicks(column).length).toBeLessThanOrEqual(20);
        const pinned = { ...defaultChartPresentation('column').valueAxis, min: 10, max: 30 };
        const fixed = layout('column', { valueAxis: pinned }, { data: one([20]), width: 400, height: 2000 });
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

    test('no plottable value says No data for every type', () => {
        for (const type of CHART_TYPES) {
            for (const blanks of ['gap', 'zero', 'span'] as const) {
                const out = layout(type, { blanks }, { data: one([null, null]) });
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
        const out = layout('column', { stacking: 'stacked' }, { data });
        const ticks = valueTicks(out).map(Number);
        expect(ticks[0]).toBeLessThanOrEqual(-4);
        expect(ticks.at(-1)).toBeGreaterThanOrEqual(7);
        const baseline = lines(out, 'baseline')[0].y;
        for (const bar of rects(out, 'bar').filter((bar) => bar.id.endsWith(':1'))) {
            expect(bar.y).toBeGreaterThanOrEqual(baseline - 0.01);
        }
    });

    test('pinned bounds: exact decimal labels, and a min past the data draws a finite empty plot', () => {
        const axis = { ...defaultChartPresentation('column').valueAxis, min: 0.1, max: 0.7 };
        expect(valueTicks(layout('column', { ...UNTITLED, valueAxis: axis }, { data: one([0.3, 0.5]) }))).toEqual([
            '0.1',
            '0.2',
            '0.3',
            '0.4',
            '0.5',
            '0.6',
            '0.7',
        ]);
        const past = layout('column', { valueAxis: { ...axis, min: 200, max: null } }, { data: one([1, 2]) });
        for (const n of numbersIn(past)) expect(Number.isFinite(n)).toBe(true);
        expect(Number(valueTicks(past)[0])).toBe(200);
        for (const bar of rects(past, 'bar')) expect(bar.height).toBe(0);
        for (const [min, max] of [
            [1e20, null],
            [0, 1e-310],
        ]) {
            const out = layout('column', { valueAxis: { ...axis, min, max } }, { data: one([1, 2]) });
            for (const n of numbersIn(out)) expect(Number.isFinite(n)).toBe(true);
        }
    });

    test('a 100% stack holds at the edges: denormals, no data and the tick cap', () => {
        for (const type of ['column', 'bar'] as const) {
            const tiny = layout(type, { stacking: 'percent' }, { ...small, data: one([1e-310, 2e-310]) });
            for (const n of numbersIn(tiny)) expect(Number.isFinite(n)).toBe(true);
            const ticks = tiny.labels.map((label) => label.text).filter((text) => text.endsWith('%'));
            expect([ticks[0], ticks.at(-1)]).toEqual(['0%', '100%']);
            const blank = layout(type, { stacking: 'percent' }, { data: one([null, null]) });
            expect(blank.labels.map((label) => label.text)).toEqual(['No data']);
        }
        const tall = layout(
            'column',
            { stacking: 'percent', title: '', legend: 'none' },
            { data: one([1]), width: 400, height: 2000 },
        );
        expect(valueTicks(tall).length).toBeLessThanOrEqual(20);
    });

    test('a crowded legend keeps to its share of the box and counts what it drops', () => {
        const many = Array.from({ length: 32 }, (_, i) => series(`Series ${i + 1}`, [i, i + 1]));
        for (const legend of ['top', 'bottom', 'left', 'right'] as const) {
            const out = layout(
                'column',
                { legend, title: '' },
                { ...small, data: { categories: ['A', 'B'], series: many } },
            );
            const swatches = rects(out, 'legend');
            expect(swatches.length).toBeLessThan(32);
            const more = out.labels.find((label) => /^\+\d+$/.test(label.text));
            expect(more?.text).toBe(`+${32 - swatches.length}`);
            if (legend === 'top') {
                const rows = out.labels.filter((label) => label.anchor === 'start').map(labelBounds);
                const top = Math.min(...rows.map((row) => row.top));
                const bottom = Math.max(...rows.map((row) => row.bottom));
                expect(bottom - top).toBeLessThanOrEqual(300 * 0.3);
                expect(Math.min(...lines(out, 'gridline').map((line) => line.y))).toBeGreaterThan(bottom);
            }
        }
    });

    test("grouped bars and their outlines never overlap a neighbor's", () => {
        const data = {
            categories: ['A', 'B', 'C', 'D', 'E'],
            series: Array.from({ length: 4 }, (_, s) =>
                series(
                    `S${s}`,
                    [3, 5, 2, 4, 1].map((v) => v + s),
                    chartColor(s),
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
                    const out = layout(type, { stacking: 'none' }, { data, width, height, paint });
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

describe('outlines follow the fill style', () => {
    const legend = { legend: 'right' } as const;

    test('a solid fill draws bars, slices and legend swatches with no outline, the bars filling their slots', () => {
        const column = layout('column', legend, { paint: { strokeWidth: 4 } });
        const pie = layout('pie', legend);
        for (const shape of [
            ...rects(column, 'bar'),
            ...rects(column, 'legend'),
            ...slices(pie),
            ...rects(pie, 'legend'),
        ])
            expect([shape.id, shape.strokeColor]).toEqual([shape.id, 'transparent']);
        for (const bar of rects(column, 'bar')) expect(bar.strokeWidth).toBe(0);
    });

    test.each(['hachure', 'cross-hatch', 'zigzag'] as const)('%s outlines each in its own color', (fillStyle) => {
        const colors = [chartColor(0), chartColor(1), chartColor(2)];
        const column = layout('column', legend, { paint: { fillStyle, strokeWidth: 4 } });
        const bars = rects(column, 'bar');
        expect(new Set(bars.map((bar) => bar.strokeColor))).toEqual(new Set(colors));
        for (const bar of bars) {
            expect(bar.fill).toBe(solidFill(bar.strokeColor, fillStyle));
            expect(bar.strokeWidth).toBeGreaterThan(0);
        }
        expect(rects(column, 'legend').map((swatch) => swatch.strokeColor)).toEqual(colors);
        const pie = layout('pie', legend, { paint: { fillStyle } });
        for (const slice of slices(pie)) expect(slice.fill).toBe(solidFill(slice.strokeColor, fillStyle));
        expect(rects(pie, 'legend').map((swatch) => swatch.fill)).toEqual(slices(pie).map((slice) => slice.fill));
    });

    test('the axes and gridlines draw in the paint stroke whatever the fill style', () => {
        for (const fillStyle of ['solid', 'cross-hatch'] as const) {
            const out = layout('column', {}, { paint: { fillStyle, strokeColor: '#336699', strokeWidth: 4 } });
            for (const rule of [...lines(out, 'gridline'), ...lines(out, 'baseline')])
                expect([rule.strokeColor, rule.strokeWidth]).toEqual(['#336699', 4]);
        }
    });
});

describe('sketch cap', () => {
    const SKETCH = { roughness: 2, fillStyle: 'cross-hatch', background: solidFill('#ffffff') } as const;
    // `count` points over one series for a pie, four otherwise.
    function wide(type: ChartType, count: number): ChartData {
        const perSeries = type === 'pie' ? count : count / 4;
        const categories = Array.from({ length: perSeries }, (_, i) => `C${i}`);
        const rows = type === 'pie' ? 1 : 4;
        return {
            categories,
            series: Array.from({ length: rows }, (_, s) =>
                series(
                    `S${s}`,
                    categories.map((_, i) => 1 + ((i + s) % 5)),
                    chartColor(s),
                ),
            ).map((s) => ({ ...s, markers: type === 'line' })),
        };
    }
    const DATA_PARTS = new Set(['bar', 'slice', 'line', 'marker']);

    test('counts the points the chart plots: a pie its first series, others every series', () => {
        const spec = sampleChartSpec('column');
        expect(chartPointCount(spec, wide('column', 40))).toBe(40);
        expect(chartPointCount({ ...spec, type: 'pie' }, wide('column', 40))).toBe(10);
    });

    test.each([...CHART_TYPES])('%s: at the cap every shape keeps the sketch', (type) => {
        const out = layout(type, { legend: 'top' }, { data: wide(type, MAX_SKETCH_POINTS), paint: SKETCH });
        for (const shape of out.shapes) {
            const part = shape.id.split(':')[1];
            if (part === 'background') continue;
            expect([part, shape.roughness]).toEqual([part, 2]);
            if (shape.type === 'rectangle' || shape.type === 'pie')
                expect([part, parseFill(shape.fill).style]).toEqual([part, 'cross-hatch']);
        }
    });

    test.each([...CHART_TYPES])('%s: past the cap the data draws flat, the rest keeps the sketch', (type) => {
        const out = layout(
            type,
            { legend: 'top' },
            { data: wide(type, MAX_SKETCH_POINTS + 4), paint: SKETCH, width: 2000, height: 1200 },
        );
        const parts = new Set(out.shapes.map((shape) => shape.id.split(':')[1]));
        expect(parts.has('legend')).toBe(true);
        for (const shape of out.shapes) {
            const part = shape.id.split(':')[1];
            if (part === 'background') continue;
            const data = DATA_PARTS.has(part);
            expect([part, shape.roughness]).toEqual([part, data ? 0 : 2]);
            if (shape.type === 'rectangle' || shape.type === 'pie')
                expect([part, parseFill(shape.fill).style]).toEqual([part, data ? 'solid' : 'cross-hatch']);
        }
    });
});
