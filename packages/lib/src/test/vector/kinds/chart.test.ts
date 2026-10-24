import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    formatTickValue,
    layoutChart,
    MAX_CHART_SPEC_BYTES,
    parseChartSpec,
    sampleChartSpec,
} from '../../../charts';
import { getFontFamily } from '../../../constants/fonts';
import { escapeXml } from '../../../core/xml';
import type { ChartLayout, ChartSpec } from '../../../types/chart';
import { parseFill, serializeFill, TRANSPARENT_FILL } from '../../../vector/fill';
import { ELEMENT_KINDS, SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from '../../../vector/kinds';
import { svgTextLine } from '../../../vector/kinds/render-utils';
import { readElementFromFields } from '../../../vector/read-vector';
import { elementToSvg } from '../../../vector/scene-to-svg';
import type { VectorChartElement, VectorElement } from '../../../vector/types';
import { DEFAULT_ELEMENT_PROPS } from '../../../vector/types';
import { chart, richtext } from '../element-factories';

const specJson = (over: Partial<ChartSpec> = {}, type: ChartSpec['type'] = 'column'): string =>
    JSON.stringify({ ...sampleChartSpec(type), ...over });

const RANGE_SPEC = specJson({
    data: {
        source: 'range',
        categories: { sheetId: 's1', row: [1, 4], column: [0, 0] },
        series: [
            {
                name: 'Sales',
                values: { sheetId: 's1', row: [1, 4], column: [1, 1] },
                color: '#2a78d6',
                markers: false,
                smooth: false,
            },
        ],
    },
});

function svgOf(el: VectorChartElement): string {
    return ELEMENT_KINDS.chart.render(el, {}).svg;
}

function readChart(record: Record<string, unknown>): VectorChartElement {
    const el = readElementFromFields(
        new Map(Object.entries({ id: 'c1', type: 'chart', width: 640, height: 400, ...record })),
    );
    if (el?.type !== 'chart') throw new Error('expected a chart');
    return el;
}

// The layout the painter should draw, its paint read off the element by hand rather than by the kind.
function layoutOf(el: VectorChartElement, spec: ChartSpec): ChartLayout {
    if (spec.data.source !== 'inline') throw new Error('expected inline data');
    const fill = parseFill(el.fill);
    return layoutChart({
        id: el.id,
        spec,
        data: spec.data,
        width: el.width,
        height: el.height,
        paint: {
            color: el.color,
            background: el.fill,
            strokeColor: el.strokeColor,
            strokeWidth: el.strokeWidth,
            strokeStyle: el.strokeStyle,
            roughness: el.roughness,
            seed: el.seed,
            fillStyle: fill.style,
        },
        formatTick: formatTickValue,
    });
}

const textCount = (svg: string): number => svg.split('<text ').length - 1;

describe('chart read', () => {
    test('a malformed spec stays stored as it is and draws the placeholder', () => {
        const broken = '{"type":"column","data":';
        const el = readChart({ chart: broken });
        expect(el.chart).toBe(broken);
        const svg = svgOf(el);
        expect(svg).toContain('stroke-dasharray');
        expect(svg).toContain('This chart can&apos;t be shown');
        expect(textCount(svg)).toBe(1);
    });

    test('a valid spec is kept byte for byte, unknown fields and key order included', () => {
        const stored = `{"future":1,${specJson().slice(1)}`;
        expect(readChart({ chart: stored }).chart).toBe(stored);
    });

    test('a spec over the byte limit reads as empty', () => {
        const padded = specJson() + ' '.repeat(MAX_CHART_SPEC_BYTES);
        expect(readChart({ chart: padded }).chart).toBe('');
        expect(readChart({ chart: 42 }).chart).toBe('');
    });

    test('color and background go through the shared field readers; the font is the spec’s, not a field', () => {
        const el = readChart({ chart: specJson(), fontFamily: 'Inter', color: 'url(#x)', fill: 'nope' });
        expect(el.color).toBe(DEFAULT_ELEMENT_PROPS.strokeColor);
        expect(el.fill).toBe(serializeFill(TRANSPARENT_FILL));
        expect('fontFamily' in el).toBe(false);
        expect(ELEMENT_KINDS.chart.fields).not.toContain('fontFamily');
    });

    test('a new chart is the column sample in the host font, color and fill', () => {
        const el = chart({ id: 'c1' });
        expect(el.chart).toBe(JSON.stringify({ ...sampleChartSpec('column'), fontFamily: 'Excalifont' }));
        expect(parseFill(el.fill).style).toBe('cross-hatch');
        const slide = ELEMENT_KINDS.chart.defaults(SLIDES_STYLE_DEFAULTS);
        expect(parseChartSpec(slide.chart)?.fontFamily).toBe(SLIDES_STYLE_DEFAULTS.fontFamily);
        expect(parseChartSpec(ELEMENT_KINDS.chart.defaults(VECTOR_STYLE_DEFAULTS).chart)?.fontFamily).toBe(
            'Excalifont',
        );
    });
});

describe('chart placeholder', () => {
    test('range data draws the placeholder, since a canvas has no sheet to read', () => {
        const svg = svgOf(chart({ id: 'c1', chart: RANGE_SPEC }));
        expect(svg).toContain('This chart can&apos;t be shown');
        expect(textCount(svg)).toBe(1);
        expect(svg).not.toContain('Sales');
    });

    test('the message fits the box or is left out', () => {
        const narrow = svgOf(chart({ id: 'c1', chart: '', width: 90, height: 60 }));
        expect(narrow).toContain('…');
        const tiny = svgOf(chart({ id: 'c1', chart: '', width: 4, height: 4 }));
        expect(textCount(tiny)).toBe(0);
        expect(tiny).toContain('stroke-dasharray');
    });
});

describe('chart painter', () => {
    test('each shape draws exactly as the same element would on the canvas', () => {
        const el = chart({ id: 'c1' });
        const out = layoutOf(el, { ...sampleChartSpec('column'), fontFamily: 'Excalifont' });
        const svg = svgOf(el);
        expect(out.shapes.filter((shape) => shape.type === 'rectangle').length).toBeGreaterThan(4);
        for (const shape of out.shapes) expect([shape.id, svg.includes(elementToSvg(shape))]).toEqual([shape.id, true]);
    });

    test('the labels are SVG text, one per layout label', () => {
        const el = chart({
            id: 'c1',
            chart: specJson({ valueAxis: { ...sampleChartSpec('column').valueAxis, title: 'Points' } }),
        });
        const spec = {
            ...sampleChartSpec('column'),
            valueAxis: { ...sampleChartSpec('column').valueAxis, title: 'Points' },
        };
        const { labels } = layoutOf(el, spec);
        const svg = svgOf(el);
        expect(textCount(svg)).toBe(labels.length);
        for (const label of labels) expect([label.text, svg.includes(svgTextLine(label))]).toEqual([label.text, true]);
        expect(svg).not.toContain('foreignObject');
    });

    test('a label line sits on its baseline, bold at 600, turned about its top', () => {
        const line = svgTextLine({
            text: 'Title',
            x: 100,
            y: 10,
            anchor: 'end',
            fontFamily: 'Inter',
            fontSize: 20,
            bold: true,
            color: '#123456',
            rotate: -90,
        });
        expect(line).toBe(
            `<text x="100" y="29.38" transform="rotate(-90 100 10)" font-family="&apos;Inter&apos;, sans-serif" font-size="20px" font-weight="600" fill="#123456" text-anchor="end" style="white-space: pre;">Title</text>`,
        );
    });

    test('every label draws in the spec font', () => {
        const svg = svgOf(chart({ id: 'c1', chart: specJson({ fontFamily: 'JetBrains Mono' }) }));
        const fonts = new Set(Array.from(svg.matchAll(/font-family="([^"]*)"/g), (m) => m[1]));
        expect(fonts).toEqual(new Set([escapeXml(getFontFamily('JetBrains Mono'))]));
    });

    test('label text is escaped', () => {
        const svg = svgOf(chart({ id: 'c1', chart: specJson({ title: 'A < B & "C"' }) }));
        expect(svg).toContain('A &lt; B &amp; &quot;C&quot;');
        expect(svg).not.toContain('A < B');
    });

    test('the same element draws the same SVG', () => {
        const el = chart({ id: 'c1' });
        expect(svgOf({ ...el })).toBe(svgOf(el));
    });

    test('the chart opacity rides its layer; the gridlines keep their own', () => {
        const el = chart({ id: 'c1', opacity: 40 });
        const svg = svgOf(el);
        expect(svg).toContain('opacity="0.2"');
        expect(svg).not.toContain('opacity="0.4"');
        expect(elementToSvg(el).split('opacity="0.4"')).toHaveLength(2);
    });

    test('the fill style hatches the bars and the slices', () => {
        const hatched = serializeFill({ ...TRANSPARENT_FILL, style: 'hachure' });
        for (const type of ['column', 'pie'] as const) {
            const el = chart({ id: 'c1', fill: hatched, chart: specJson({}, type) });
            const marks = layoutOf(el, sampleChartSpec(type)).shapes.filter(
                (shape) => shape.id.includes(':bar:') || shape.id.includes(':slice:'),
            );
            expect(marks.length).toBeGreaterThan(3);
            const svg = svgOf(el);
            for (const mark of marks) {
                expect('fill' in mark && parseFill(mark.fill).style).toBe('hachure');
                expect(svg).toContain(elementToSvg(mark));
            }
            // a hachure fill is drawn as stroked sketch lines in the mark's color, never a filled path
            expect(svg).toContain(`stroke="${chartColor(0)}" stroke-width="1" fill="none"`);
        }
    });

    test('a gradient background keeps an id of its own', () => {
        const fill = serializeFill({ type: 'gradient', from: '#ffffff', to: '#dbe7ff', angle: 90, style: 'solid' });
        expect(svgOf(chart({ id: 'c1', fill }))).toContain('id="fill-c1_3a_background"');
    });
});

describe('chart text', () => {
    test('searchText is the title, axis titles, series names and categories', () => {
        expect(ELEMENT_KINDS.chart.searchText(chart({ id: 'c1', chart: specJson() })).split('\n')).toEqual([
            "Where a star's light goes",
            'Wavelength (nm)',
            'Share of light, 300–1000 nm (%)',
            'Sun',
            'Bulb (incandescent)',
            'Hot star',
            '300–400',
            '400–500',
            '500–600',
            '600–700',
            '700–800',
            '800–900',
            '900–1000',
        ]);
        expect(ELEMENT_KINDS.chart.searchText(chart({ id: 'c1', chart: 'nope' }))).toBe('');
        expect(ELEMENT_KINDS.chart.searchText(chart({ id: 'c1', chart: RANGE_SPEC }))).toBe(
            "Where a star's light goes\nWavelength (nm)\nShare of light, 300–1000 nm (%)\nSales",
        );
    });

    test('a chart draws its labels in the font of its spec, and none for a placeholder', () => {
        const serif = chart({ id: 'c1', chart: specJson({ fontFamily: 'Source Serif 4' }) });
        const families = (el: VectorElement) => new Set(ELEMENT_KINDS[el.type].fontFamilies(el));
        expect(families(serif)).toEqual(new Set(['Source Serif 4']));
        expect(families(chart({ id: 'c2', chart: 'nope' }))).toEqual(new Set());
        expect(families(chart({ id: 'c3', chart: RANGE_SPEC }))).toEqual(new Set());
        expect(families(richtext({ id: 't1', html: '<p>Hi</p>', fontFamily: 'JetBrains Mono' }))).toEqual(
            new Set(['JetBrains Mono']),
        );
    });
});
