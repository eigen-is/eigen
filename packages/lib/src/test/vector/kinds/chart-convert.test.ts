import { describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '../../../charts';
import type { ChartLabel, ChartSpec } from '../../../types/chart';
import { serializeFill, TRANSPARENT_FILL } from '../../../vector/fill';
import { getLineHeightPx } from '../../../vector/font-metrics';
import { boxCenter, type Point, rotatePoint } from '../../../vector/geometry';
import { convertToShapes, ELEMENT_KINDS } from '../../../vector/kinds';
import { chartToElements } from '../../../vector/kinds/chart-convert';
import { chartLayout, renderChartSvg } from '../../../vector/kinds/chart-render';
import { elementGroupOpen, svgTextLine } from '../../../vector/kinds/render-utils';
import type { VectorChartElement, VectorElement, VectorRichTextElement } from '../../../vector/types';
import { chart, shape } from '../element-factories';

const SOLID = serializeFill({ type: 'solid', color: '#fffbe6', style: 'cross-hatch' });

const specJson = (type: ChartSpec['type'], over: Partial<ChartSpec> = {}): string =>
    JSON.stringify({ ...sampleChartSpec(type), ...over });

// Crowded enough that the category labels turn -45°.
const CROWDED = specJson('column', {
    data: {
        source: 'inline',
        categories: Array.from({ length: 12 }, (_, i) => `Category number ${i + 1}`),
        series: [
            {
                name: 'Sales',
                values: Array.from({ length: 12 }, (_, i) => i + 1),
                color: '#2a78d6',
                markers: false,
                smooth: false,
            },
        ],
    },
});

function layoutOf(el: VectorChartElement) {
    const layout = chartLayout(el);
    if (!layout) throw new Error('expected a chart that draws');
    return layout;
}

const labelsOf = (elements: VectorElement[]): VectorRichTextElement[] =>
    elements.filter((el): el is VectorRichTextElement => el.type === 'richtext');

const shapesOf = (elements: VectorElement[]): VectorElement[] => elements.filter((el) => el.type !== 'richtext');

const typesById = (elements: VectorElement[], key: string): string[] =>
    elements.filter((el) => el.id.includes(`:${key}`)).map((el) => el.type);

// A point of the scene in the element's own unrotated frame, relative to its top-left corner.
function inBox(el: VectorElement, point: Point): Point {
    const local = rotatePoint(point, boxCenter(el), -el.angle);
    return { x: local.x - el.x, y: local.y - el.y };
}

function expectClose(actual: Point, expected: Point): void {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
}

describe('chartToElements', () => {
    test('a column chart: bars, swatches and the background are rectangles, rules lines, labels rich text', () => {
        const elements = chartToElements(chart({ id: 'c1', fill: SOLID }));
        expect(typesById(elements, 'background')).toEqual(['rectangle']);
        expect(typesById(elements, 'bar:')).toEqual(Array(18).fill('rectangle'));
        expect(typesById(elements, 'legend:')).toEqual(['rectangle', 'rectangle', 'rectangle']);
        expect(typesById(elements, 'baseline')).toEqual(['line']);
        expect(typesById(elements, 'gridline:').length).toBeGreaterThan(2);
        expect(new Set(typesById(elements, 'gridline:'))).toEqual(new Set(['line']));
        expect(labelsOf(elements).map((el) => el.html)).toContain('<p>Where a star&#39;s light goes</p>');
    });

    test('a bar chart draws its bars as rectangles too', () => {
        const elements = chartToElements(chart({ id: 'c1', chart: specJson('bar') }));
        expect(typesById(elements, 'bar:')).toEqual(Array(18).fill('rectangle'));
    });

    test('a line chart: one line per series, an ellipse per marker', () => {
        const spec = sampleChartSpec('line');
        if (spec.data.source !== 'inline') throw new Error('expected inline data');
        const series = spec.data.series.map((s) => ({ ...s, markers: true }));
        const elements = chartToElements(
            chart({ id: 'c1', chart: specJson('line', { data: { ...spec.data, series } }) }),
        );
        expect(typesById(elements, 'line:')).toEqual(['line', 'line', 'line']);
        expect(typesById(elements, 'marker:')).toEqual(Array(18).fill('ellipse'));
    });

    test('a pie chart: one pie element per slice', () => {
        const elements = chartToElements(chart({ id: 'c1', chart: specJson('pie') }));
        expect(typesById(elements, 'slice:')).toEqual(Array(6).fill('pie'));
        expect(labelsOf(elements).length).toBeGreaterThan(4);
    });

    test('every layout shape converts in paint order with its seed and size, then one box per label', () => {
        const el = chart({ id: 'c1', fill: SOLID });
        const layout = layoutOf(el);
        const elements = chartToElements(el);
        expect(elements).toHaveLength(layout.shapes.length + layout.labels.length);
        expect(
            shapesOf(elements).map(({ id, type, seed, width, height }) => ({ id, type, seed, width, height })),
        ).toEqual(layout.shapes.map(({ id, type, seed, width, height }) => ({ id, type, seed, width, height })));
    });

    test('a chart that does not draw converts to nothing', () => {
        expect(chartToElements(chart({ id: 'c1', chart: '{"type":"column"' }))).toEqual([]);
        const range = specJson('column', {
            data: { source: 'range', categories: null, series: [] },
        });
        expect(chartToElements(chart({ id: 'c1', chart: range }))).toEqual([]);
    });

    test('a rotated, framed, half-transparent chart: centers turn about the chart center, angle and opacity compose', () => {
        const el = chart({ id: 'c1', fill: SOLID, x: 100, y: 50, angle: 30, opacity: 50, frameId: 'f1' });
        const layout = layoutOf(el);
        const elements = shapesOf(chartToElements(el));
        const center = boxCenter(el);

        // The background covers the chart's own box, so it lands exactly on it.
        const background = elements[0];
        expect(background.id).toBe('c1:background');
        expectClose(boxCenter(background), center);
        expect(background.width).toBe(el.width);

        for (const [i, converted] of elements.entries()) {
            const original = layout.shapes[i];
            const expected = rotatePoint(
                { x: el.x + original.x + original.width / 2, y: el.y + original.y + original.height / 2 },
                center,
                30,
            );
            expectClose(boxCenter(converted), expected);
            expect(converted.angle).toBe(30);
            expect(converted.frameId).toBe('f1');
            expect(converted.opacity).toBe(original.opacity / 2);
        }
        expect(elements.some((converted) => converted.opacity === 10)).toBe(true);
    });

    test('a label box keeps the text anchor where the painter put it, turned labels and a turned chart included', () => {
        const el = chart({ id: 'c1', chart: CROWDED, x: 40, y: -20, angle: 30 });
        const { labels } = layoutOf(el);
        const boxes = labelsOf(chartToElements(el));
        expect(labels.some((label) => label.rotate === -45)).toBe(true);
        expect(boxes).toHaveLength(labels.length);
        const shift: Record<ChartLabel['anchor'], number> = { start: 0, middle: 0.5, end: 1 };
        for (const [i, label] of labels.entries()) {
            const box = boxes[i];
            const height = getLineHeightPx(label.fontFamily, label.fontSize);
            // The anchor at mid-line, in the chart's local frame and then in the scene.
            const local = rotatePoint({ x: label.x, y: label.y + height / 2 }, label, label.rotate);
            const scene = rotatePoint({ x: el.x + local.x, y: el.y + local.y }, boxCenter(el), el.angle);
            expectClose(inBox(box, scene), { x: shift[label.anchor] * box.width, y: height / 2 });
            expect(box.height).toBeCloseTo(height, 9);
            expect(box.angle).toBeCloseTo((((label.rotate + 30) % 360) + 360) % 360, 9);
        }
    });

    test('a label box is rich text in the spec font, aligned by its anchor, with no paint of its own', () => {
        const el = chart({
            id: 'c1',
            chart: specJson('column', { title: 'A < B & "C"', fontFamily: 'Source Serif 4' }),
        });
        const title = labelsOf(chartToElements(el)).find((box) => box.fontWeight === 'bold');
        if (!title) throw new Error('expected a bold title');
        expect(title).toMatchObject({
            html: '<p>A &lt; B &amp; &quot;C&quot;</p>',
            textAlign: 'center',
            fontFamily: 'Source Serif 4',
            color: el.color,
            padding: 0,
            fill: serializeFill(TRANSPARENT_FILL),
            strokeColor: 'transparent',
        });
        expect(ELEMENT_KINDS.richtext.render(title, {})).toMatchObject({ svg: '' });
    });

    test('the converted shapes draw exactly what the painter drew, the labels aside', () => {
        for (const type of ['column', 'bar', 'line', 'pie'] as const) {
            const el = chart({ id: 'c1', fill: SOLID, chart: specJson(type) });
            const elements = chartToElements(el);
            const shapes = shapesOf(elements)
                .map((converted) => {
                    const body = ELEMENT_KINDS[converted.type].render(converted, {});
                    return 'html' in body || body.svg === '' ? '' : `${elementGroupOpen(converted)}${body.svg}</g>`;
                })
                .join('');
            const labels = layoutOf(el).labels.map(svgTextLine).join('');
            expect([type, renderChartSvg(el)]).toEqual([type, shapes + labels]);
        }
    });

    test('the registry offers Convert to shapes for a chart that draws, and nothing else', () => {
        expect(convertToShapes(chart({ id: 'c1' })).length).toBeGreaterThan(0);
        expect(convertToShapes(chart({ id: 'c1', chart: '' }))).toEqual([]);
        expect(convertToShapes(shape({ id: 'r1', type: 'rectangle' }))).toEqual([]);
    });
});
