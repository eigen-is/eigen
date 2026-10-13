import { describe, expect, test } from 'bun:test';
import { formatTickValue, layoutChart, sampleChartSpec } from '../../charts';
import {
    CHART_TYPES,
    type ChartData,
    type ChartLabel,
    type ChartLayout,
    type ChartPaint,
    type ChartSpec,
    type ChartType,
    LEGEND_POSITIONS,
} from '../../types/chart';
import { serializeFill, solidFill, TRANSPARENT_FILL } from '../../vector/fill';
import { getLineHeightPx } from '../../vector/font-metrics';
import { parsePoints } from '../../vector/geometry';
import { readElementFromFields } from '../../vector/read-vector';
import { measureLabel } from '../../vector/text-width';
import type { VectorElement, VectorLinearElement, VectorPieElement, VectorRectangleElement } from '../../vector/types';

const PAINT: ChartPaint = {
    fontFamily: 'Inter',
    color: '#1e1e1e',
    background: solidFill('#ffffff'),
    strokeColor: '#1e1e1e',
    strokeWidth: 1,
    roughness: 0,
    seed: 7,
    fillStyle: 'solid',
};

const style = { markers: false, smooth: false };

function series(name: string, values: (number | null)[], color = '#2a78d6') {
    return { ...style, color, name, values };
}

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
            [false, true].flatMap((stacked) =>
                SIZES.map(([width, height]) => ({ type, legend, stacked, width, height })),
            ),
        ),
    );

    test.each(cases)(
        '$type legend $legend stacked $stacked at $width × $height',
        ({ type, legend, stacked, width, height }) => {
            const spec: Partial<ChartSpec> = {
                legend,
                stacked,
                categoryAxis: { title: 'Teams' },
                valueAxis: { title: 'Points', min: null, max: null, gridlines: true, format: null },
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

    test('gridlines are faint, every other shape opaque', () => {
        const out = layout('column');
        expect(ofPart(out, 'gridline').length).toBeGreaterThan(1);
        for (const shape of out.shapes) {
            if (shape.id.split(':')[1] === 'gridline') expect(shape.opacity).toBeLessThanOrEqual(20);
            else expect(shape.opacity).toBe(100);
        }
        expect(
            ofPart(
                layout('column', { valueAxis: { ...sampleChartSpec('column').valueAxis, gridlines: false } }),
                'gridline',
            ),
        ).toEqual([]);
    });

    test('text sizes scale with the box, the title bold and larger', () => {
        const small = layout('column', {}, { width: 320, height: 200 });
        const large = layout('column', {}, { width: 1200, height: 675 });
        const title = (out: ChartLayout) => out.labels.find((label) => label.text === 'Points scored');
        const tick = (out: ChartLayout) => out.labels.find((label) => label.text === '0');
        expect(title(large)?.fontSize).toBeGreaterThan(title(small)?.fontSize ?? Infinity);
        expect(title(large)?.bold).toBe(true);
        expect(title(large)?.fontSize).toBeGreaterThan(tick(large)?.fontSize ?? Infinity);
        expect(title(large)?.anchor).toBe('middle');
        expect(title(large)?.x).toBe(600);
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
            const out = layout(type, { stacked: true }, { data });
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
                valueAxis: { title: '', min: 10, max: 30, gridlines: true, format: null },
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
        expect(count(800)).toBeGreaterThan(count(250));
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
        for (const team of ['Team 1', 'Team 2', 'Team 3', 'Team 4']) {
            expect(out.labels.find((label) => label.text === team)?.rotate).toBe(0);
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
            categoryAxis: { title: 'Teams' },
            valueAxis: { title: 'Points', min: null, max: null, gridlines: true, format: null },
        });
        const teams = out.labels.find((label) => label.text === 'Teams');
        const points = out.labels.find((label) => label.text === 'Points');
        expect(teams?.rotate).toBe(0);
        expect(points?.rotate).toBe(-90);
        const team1 = out.labels.find((label) => label.text === 'Team 1');
        expect(teams && team1 && teams.y > team1.y).toBe(true);
    });
});

describe('legend', () => {
    test('top and bottom are a centered row of swatches, left and right a column', () => {
        const top = layout('column', { legend: 'top' });
        const swatches = rects(top, 'legend');
        expect(swatches.map((swatch) => swatch.strokeColor)).toEqual(['#2a78d6', '#eb6834']);
        expect(swatches[0].y).toBeCloseTo(swatches[1].y);
        const titleBottom = Math.max(...top.labels.filter((l) => l.bold).map((l) => labelBounds(l).bottom));
        expect(swatches[0].y).toBeGreaterThan(titleBottom);
        const left = swatches[0].x;
        const period2 = top.labels.find((label) => label.text === 'Period 2');
        const right = (period2?.x ?? 0) + measureLabel('Period 2', 'Inter', period2?.fontSize ?? 0, false);
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
        expect(pie).toHaveLength(4);
        expect(pie[0].startAngle).toBe(270);
        expect(pie.reduce((sum, slice) => sum + slice.sweepAngle, 0)).toBeCloseTo(360);
        expect(pie[0].sweepAngle).toBeCloseTo((42 / 225) * 360);
        for (let i = 1; i < pie.length; i++) {
            expect(pie[i].startAngle).toBeCloseTo((pie[i - 1].startAngle + pie[i - 1].sweepAngle) % 360);
        }
        const [first] = pie;
        expect(first.width).toBe(first.height);
        for (const slice of pie) expect(slice.x).toBe(first.x);
    });

    test('slices take sliceColors, then the palette; edges take the background', () => {
        const out = layout('pie', { sliceColors: ['#000000'] });
        const pie = slices(out);
        expect(pie[0].fill).toBe(solidFill('#000000'));
        expect(pie[1].fill).toBe(solidFill('#eb6834'));
        expect(pie.every((slice) => slice.strokeColor === '#ffffff')).toBe(true);
        const bare = slices(layout('pie', {}, { paint: { background: serializeFill(TRANSPARENT_FILL) } }));
        expect(bare[1].strokeColor).toBe('#eb6834');
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
        for (const type of CHART_TYPES) {
            const out = layout(
                type,
                { stacked: true },
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
