import { describe, expect, test } from 'bun:test';
// The vector barrel loads geometry before any kind. Without it, the imports below reach a kind's module first, and the
// file throws a TDZ ReferenceError when it runs alone.
import '../../../vector';
import {
    CHART_MESSAGES,
    chartColor,
    chartPaintOf,
    FLAT_CHART_LOOK,
    layoutChart,
    newChartSpecParts,
    sampleChartSpec,
} from '../../../charts';
import { getFontFamily } from '../../../constants/fonts';
import { escapeXml } from '../../../core/xml';
import type { ChartData, ChartLook, ChartSpec } from '../../../types/chart';
import { serializeFill } from '../../../vector/fill';
import { renderChartSpecSvg, renderChartSvg } from '../../../vector/kinds/chart-render';
import { svgId } from '../../../vector/kinds/render-utils';
import { outlinePath, rectOutline } from '../../../vector/outline';
import { elementToSvg } from '../../../vector/scene-to-svg';

const RANGE_SPEC: ChartSpec = {
    ...sampleChartSpec('column'),
    data: {
        source: 'range',
        categories: { sheetId: 's1', row: [1, 2], column: [0, 0] },
        series: [
            {
                id: 's-1',
                name: 'Sales',
                values: { sheetId: 's1', row: [1, 2], column: [1, 1] },
            },
        ],
    },
};

const RESOLVED: ChartData = {
    categories: ['North', 'South'],
    series: [{ id: 's-1', name: 'Sales', values: [3, 5] }],
};

// Shares as fractions, ticked every 0.05. A copy from a sheet carries them with their cells' percent format on the
// value axis.
const SHARES_SPEC: ChartSpec = {
    ...sampleChartSpec('column'),
    data: {
        source: 'inline',
        categories: ['North', 'South'],
        series: [{ id: 's-1', name: 'Share', values: [0.1, 0.25] }],
    },
};
const { x: X_AXIS, y: Y_AXIS } = SHARES_SPEC.axes;
const PERCENT_SPEC: ChartSpec = {
    ...SHARES_SPEC,
    axes: { x: X_AXIS, y: { ...Y_AXIS, labels: { ...Y_AXIS.labels, format: '0%' } } },
};

const svgOf = (spec: ChartSpec | null, data?: ChartData | 'ref' | 'too-many-points'): string =>
    renderChartSpecSvg({ id: 'c1', spec, data, width: 600, height: 371 });

// The same chart as a canvas or a slide holds it.
const canvasSvgOf = (spec: ChartSpec, look: ChartLook = FLAT_CHART_LOOK): string =>
    renderChartSvg({
        id: 'c1',
        type: 'chart',
        x: 0,
        y: 0,
        width: 600,
        height: 371,
        angle: 0,
        index: 'a0',
        frameId: '',
        commentCardIds: '',
        opacity: 100,
        ...newChartSpecParts(spec),
        ...look,
    });

const textCount = (svg: string): number => svg.split('<text ').length - 1;

describe('renderChartSpecSvg', () => {
    test('an inline spec draws as a standalone svg of the box', () => {
        const svg = svgOf(sampleChartSpec('column'));
        expect(
            svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="371" viewBox="0 0 600 371">'),
        ).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).toContain('Where a star&apos;s light goes');
        expect(svg).toContain('900–1000');
    });

    test('each shape draws as its own element would', () => {
        const spec = sampleChartSpec('line');
        if (spec.data.source !== 'inline') throw new Error('expected inline data');
        const svg = svgOf(spec);
        const { shapes } = layoutChart({
            id: 'c1',
            spec,
            data: spec.data,
            width: 600,
            height: 371,
            paint: chartPaintOf(FLAT_CHART_LOOK),
        });
        for (const shape of shapes) expect([shape.id, svg.includes(elementToSvg(shape))]).toEqual([shape.id, true]);
    });

    test('an unparseable spec draws the placeholder', () => {
        const svg = svgOf(null);
        expect(svg).toContain('stroke-dasharray');
        expect(svg).toContain(escapeXml(CHART_MESSAGES.unreadable));
        expect(textCount(svg)).toBe(1);
    });

    test('range data with nothing resolved draws the placeholder', () => {
        const svg = svgOf(RANGE_SPEC);
        expect(svg).toContain(escapeXml(CHART_MESSAGES.unreadable));
        expect(svg).not.toContain('Sales');
    });

    test('resolved range data draws in place of the spec’s refs', () => {
        const svg = svgOf(RANGE_SPEC, RESOLVED);
        expect(svg).toContain('North');
        expect(svg).toContain('Sales');
        expect(svg).not.toContain('stroke-dasharray');
    });

    test('a data error draws its message, without the placeholder box', () => {
        const cases = [
            ['ref', '#REF!'],
            ['too-many-points', 'Too much data for a chart'],
        ] as const;
        for (const [error, message] of cases) {
            const svg = svgOf(RANGE_SPEC, error);
            expect(svg).toContain(`>${message}</text>`);
            expect(textCount(svg)).toBe(1);
            expect(svg).not.toContain('stroke-dasharray');
        }
    });

    test("the source cells' format draws the ticks of an axis without a format of its own", () => {
        const svg = renderChartSpecSvg({
            id: 'c1',
            spec: sampleChartSpec('column'),
            width: 600,
            height: 371,
            sourceFormat: '0" pts"',
        });
        expect(svg).toContain('>20 pts</text>');
        const own = renderChartSpecSvg({ id: 'c1', spec: PERCENT_SPEC, width: 600, height: 371, sourceFormat: '0.0' });
        expect(own).toContain('>25%</text>');
    });

    test('ticks draw in the axis format a chart copied from a sheet carries', () => {
        const svg = svgOf(PERCENT_SPEC);
        expect(svg).toContain('>25%</text>');
        expect(svg).not.toContain('>0.25</text>');
    });

    test('ticks of an axis with no format draw as the step reads', () => {
        const svg = svgOf(SHARES_SPEC);
        expect(svg).toContain('>0.00</text>');
        expect(svg).toContain('>0.25</text>');
    });

    test('the same input draws the same svg', () => {
        expect(svgOf(sampleChartSpec('pie'))).toBe(svgOf(sampleChartSpec('pie')));
    });

    test('the labels draw in the spec font; the placeholder, which has no spec, in Inter', () => {
        const fontsOf = (svg: string) => new Set(Array.from(svg.matchAll(/font-family="([^"]*)"/g), (m) => m[1]));
        const face = (font: string) => new Set([escapeXml(getFontFamily(font))]);
        expect(fontsOf(svgOf(sampleChartSpec('column', 'Source Serif 4')))).toEqual(face('Source Serif 4'));
        const excalifont = { ...RANGE_SPEC, chart: { ...RANGE_SPEC.chart, fontFamily: 'Excalifont' } };
        expect(fontsOf(svgOf(excalifont, 'ref'))).toEqual(face('Excalifont'));
        expect(fontsOf(svgOf(null))).toEqual(face('Inter'));
    });

    test('with no look it draws flat: solid marks, no background', () => {
        const svg = svgOf(sampleChartSpec('column'));
        expect(svg).toContain(`font-family="${escapeXml(getFontFamily('Inter'))}"`);
        expect(svg).not.toContain(':background');
        // a hatched mark is drawn as stroked sketch lines; a solid one is a filled path
        expect(svg).not.toContain(`stroke="${chartColor(0)}" stroke-width="1" fill="none"`);
        expect(svg).toContain(`fill="${chartColor(0)}"`);
    });

    test('a hatched bar, slice or legend swatch draws its hatch inside a clip of its own outline', () => {
        const look: ChartLook = {
            ...FLAT_CHART_LOOK,
            fill: serializeFill({ type: 'solid', color: 'transparent', style: 'zigzag' }),
            roughness: 0,
        };
        for (const type of ['column', 'pie'] as const) {
            const spec: ChartSpec = { ...sampleChartSpec(type), legend: { position: 'top' } };
            if (spec.data.source !== 'inline') throw new Error('expected inline data');
            const svg = renderChartSpecSvg({ id: 'c1', spec, width: 600, height: 371, look });
            const { shapes } = layoutChart({
                id: 'c1',
                spec,
                data: spec.data,
                width: 600,
                height: 371,
                paint: chartPaintOf(look),
            });
            const marks = shapes.filter((shape) => /:(bar|slice|legend):/.test(shape.id));
            expect(marks.some((shape) => shape.id.includes(':legend:'))).toBe(true);
            for (const shape of marks) {
                const id = svgId('hatch', shape.id);
                const clip = new RegExp(`<clipPath id="${id}"><path d="([^"]*)"/></clipPath>`).exec(svg);
                expect([shape.id, clip !== null]).toEqual([shape.id, true]);
                if (shape.type === 'rectangle') {
                    const box = { x: 0, y: 0, width: shape.width, height: shape.height };
                    expect([shape.id, clip?.[1]]).toEqual([shape.id, outlinePath(rectOutline(box, 0, 0))]);
                }
                expect(svg).toContain(`<g clip-path="url(#${id})"><path d="`);
            }
            const ids = Array.from(svg.matchAll(/<clipPath id="([^"]*)"/g), (m) => m[1]);
            expect(new Set(ids).size).toBe(ids.length);
        }
    });

    test('a look draws as a canvas chart storing the same fields', () => {
        const look: ChartLook = {
            fill: serializeFill({ type: 'gradient', from: '#ffeeaa', to: 'transparent', angle: 90, style: 'hachure' }),
            color: '#334455',
            strokeColor: '#556677',
            strokeWidth: 4,
            strokeStyle: 'dotted',
            roughness: 2,
            seed: 99,
        };
        const spec = sampleChartSpec('column');
        const svg = renderChartSpecSvg({ id: 'c1', spec, width: 600, height: 371, look });
        expect(svg).toContain(canvasSvgOf(spec, look));
        expect(svg).not.toBe(svgOf(spec));
        expect(svg).toContain('<linearGradient id="fill-c1_3a_background"');
    });

    test('a canvas or slide chart draws its ticks in the axis format too', () => {
        expect(canvasSvgOf(PERCENT_SPEC)).toContain('>25%</text>');
    });
});
