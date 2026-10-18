import { describe, expect, test } from 'bun:test';
import { CHART_MESSAGES, chartColor, FLAT_CHART_PAINT, layoutChart, sampleChartSpec } from '../../../charts';
import { getFontFamily } from '../../../constants/fonts';
import { escapeXml } from '../../../core/xml';
import type { ChartData, ChartSpec } from '../../../types/chart';
import { isTransparentFill, parseFill } from '../../../vector/fill';
import { renderChartSpecSvg } from '../../../vector/kinds/chart-render';
import { elementToSvg } from '../../../vector/scene-to-svg';

const RANGE_SPEC: ChartSpec = {
    ...sampleChartSpec('column'),
    data: {
        source: 'range',
        categories: { sheetId: 's1', row: [1, 2], column: [0, 0] },
        series: [
            {
                name: 'Sales',
                values: { sheetId: 's1', row: [1, 2], column: [1, 1] },
                color: '#2a78d6',
                markers: false,
                smooth: false,
            },
        ],
    },
};

const RESOLVED: ChartData = {
    categories: ['North', 'South'],
    series: [{ name: 'Sales', values: [3, 5], color: '#2a78d6', markers: false, smooth: false }],
};

const svgOf = (spec: ChartSpec | null, data?: ChartData | 'ref' | 'too-many-points'): string =>
    renderChartSpecSvg({ id: 'c1', spec, data, width: 600, height: 371 });

const textCount = (svg: string): number => svg.split('<text ').length - 1;

describe('renderChartSpecSvg', () => {
    test('an inline spec draws as a standalone svg of the box', () => {
        const svg = svgOf(sampleChartSpec('column'));
        expect(
            svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="371" viewBox="0 0 600 371">'),
        ).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).toContain('Points scored');
        expect(svg).toContain('Team 4');
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
            paint: FLAT_CHART_PAINT,
            formatTick: (value) => String(value),
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

    test('the tick formatter draws the value axis', () => {
        const svg = renderChartSpecSvg({
            id: 'c1',
            spec: sampleChartSpec('column'),
            width: 600,
            height: 371,
            formatTick: (value) => `${value} pts`,
        });
        expect(svg).toContain('>20 pts</text>');
    });

    test('the same input draws the same svg', () => {
        expect(svgOf(sampleChartSpec('pie'))).toBe(svgOf(sampleChartSpec('pie')));
    });

    test('the labels draw in the spec font; the placeholder, which has no spec, in Inter', () => {
        const fontsOf = (svg: string) => new Set(Array.from(svg.matchAll(/font-family="([^"]*)"/g), (m) => m[1]));
        const face = (font: string) => new Set([escapeXml(getFontFamily(font))]);
        const serif: ChartSpec = { ...sampleChartSpec('column'), fontFamily: 'Source Serif 4' };
        expect(fontsOf(svgOf(serif))).toEqual(face('Source Serif 4'));
        expect(fontsOf(svgOf({ ...RANGE_SPEC, fontFamily: 'Excalifont' }, 'ref'))).toEqual(face('Excalifont'));
        expect(fontsOf(svgOf(null))).toEqual(face('Inter'));
    });

    test('the paint is the flat preset: solid marks, no background', () => {
        expect(FLAT_CHART_PAINT.roughness).toBe(0);
        expect(FLAT_CHART_PAINT.fillStyle).toBe('solid');
        expect(isTransparentFill(parseFill(FLAT_CHART_PAINT.background))).toBe(true);
        const svg = svgOf(sampleChartSpec('column'));
        expect(svg).toContain(`font-family="${escapeXml(getFontFamily('Inter'))}"`);
        expect(svg).not.toContain(':background');
        // a hatched mark is drawn as stroked sketch lines; a solid one is a filled path
        expect(svg).not.toContain(`stroke="${chartColor(0)}" stroke-width="1" fill="none"`);
        expect(svg).toContain(`fill="${chartColor(0)}"`);
    });
});
