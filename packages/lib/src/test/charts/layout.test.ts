import { describe, expect, test } from 'bun:test';
import { chartPointCount, layoutChartMessage, MAX_SKETCH_POINTS, sampleChartSpec } from '../../charts';
import type { ChartData, ChartLayout, ChartType } from '../../types/chart';
import { CHART_STACKINGS, CHART_TYPES, LEGEND_POSITIONS } from '../../types/chart';
import { parseFill, serializeFill, solidFill, TRANSPARENT_FILL } from '../../vector/fill';
import { readElementFromFields } from '../../vector/read-vector';
import { measureLabel } from '../../vector/text-width';
import type { SpecPatch } from './layout-fixtures';
import {
    labelBounds,
    layout,
    marked,
    numbersIn,
    ofPart,
    PAINT,
    plots,
    rects,
    SIZES,
    sampleData,
    series,
    shapeBounds,
    UNTITLED,
    within,
} from './layout-fixtures';

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
            const spec: SpecPatch = {
                legend: { position: legend },
                plots: plots(stacking),
                axes: { x: { title: { text: 'Teams' } }, y: { title: { text: 'Points' } } },
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
            const data = sampleData(type);
            const out = layout(type, { legend: { position: 'top' }, series: marked(data) }, { data });
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
        expect(ofPart(layout('column', { axes: { y: { gridlines: { visible: false } } } }), 'gridline')).toEqual([]);
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
            const out = layout('bar', { ...UNTITLED, chart: { fontFamily } }, { data });
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
                { plots: plots(stacking) },
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
                ),
            ),
        };
    }
    const DATA_PARTS = new Set(['bar', 'slice', 'line', 'marker']);

    test('counts the points the chart plots: a pie its first series, others every series', () => {
        const spec = sampleChartSpec('column');
        expect(chartPointCount(spec, wide('column', 40))).toBe(40);
        expect(chartPointCount({ ...spec, chart: { ...spec.chart, type: 'pie' } }, wide('column', 40))).toBe(10);
    });

    test.each([...CHART_TYPES])('%s: at the cap every shape keeps the sketch', (type) => {
        const data = wide(type, MAX_SKETCH_POINTS);
        const out = layout(type, { legend: { position: 'top' }, series: marked(data) }, { data, paint: SKETCH });
        for (const shape of out.shapes) {
            const part = shape.id.split(':')[1];
            if (part === 'background') continue;
            expect([part, shape.roughness]).toEqual([part, 2]);
            if (shape.type === 'rectangle' || shape.type === 'pie')
                expect([part, parseFill(shape.fill).style]).toEqual([part, 'cross-hatch']);
        }
    });

    test.each([...CHART_TYPES])('%s: past the cap the data draws flat, the rest keeps the sketch', (type) => {
        const data = wide(type, MAX_SKETCH_POINTS + 4);
        const out = layout(
            type,
            { legend: { position: 'top' }, series: marked(data) },
            { data, paint: SKETCH, width: 2000, height: 1200 },
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
