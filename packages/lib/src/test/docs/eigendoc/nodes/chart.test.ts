import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CHART_DEFAULT_SIZE, CHART_MAX_SIDE, FLAT_CHART_LOOK, sampleChartSpec } from '../../../../charts';
import { chartSvg, getDocExtensions, readChartAttrs } from '../../../../docs/eigendoc';
import type { ChartLook } from '../../../../types/chart';
import { serializeFill } from '../../../../vector/fill';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const SPEC = JSON.stringify(sampleChartSpec('column'));
const LOOK: ChartLook = {
    fill: serializeFill({ type: 'gradient', from: '#ffeeaa', to: 'transparent', angle: 90, style: 'hachure' }),
    color: '#334455',
    strokeColor: '#556677',
    strokeWidth: 4,
    strokeStyle: 'dashed',
    roughness: 2,
    seed: 4242,
};
const chartDoc = (attrs: Record<string, unknown>): JSONContent => ({
    type: 'doc',
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Sales ' },
                { type: 'chart', attrs },
            ],
        },
    ],
});

function chartsIn(html: string): Record<string, unknown>[] {
    const charts: Record<string, unknown>[] = [];
    createDocument(html, getSchema(extensions)).descendants((node) => {
        if (node.type.name === 'chart') charts.push(node.attrs);
    });
    return charts;
}

describe('chart HTML', () => {
    // The clipboard carries a docs copy as this HTML, so a chart pastes back whole within Docs.
    test('a chart survives the HTML round-trip with its spec, size, look and frame', () => {
        const attrs = {
            ...LOOK,
            spec: SPEC,
            width: 480,
            height: 300,
            layout: 'wrap-right',
            alignment: 'center',
            caption: 'Points',
            commentCardId: 'card-1',
        };
        expect(chartsIn(generateHTML(chartDoc(attrs), extensions))).toEqual([attrs]);
    });

    test('its span holds no figure, and an image of the chart for other apps', () => {
        const html = generateHTML(chartDoc({ spec: SPEC, width: 480, height: 300 }), extensions);
        const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span.chart');
        expect(span?.getAttribute('data-width')).toBe('480');
        expect(span?.getAttribute('data-height')).toBe('300');
        const img = span?.querySelector('img');
        expect(img?.getAttribute('alt')).toBe("Where a star's light goes");
        expect(decodeURIComponent(img?.getAttribute('src') ?? '')).toContain('>300–400</text>');
        expect(chartsIn(html)).toHaveLength(1);
        let figures = 0;
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') figures++;
        });
        expect(figures).toBe(0);
    });

    test('a spec that does not parse is kept as stored and renders the placeholder, never throwing', () => {
        const html = generateHTML(chartDoc({ spec: 'not a chart', width: 200, height: 100 }), extensions);
        expect(decodeURIComponent(html)).toContain('This chart can&apos;t be shown');
        expect(chartsIn(html)).toMatchObject([{ spec: 'not a chart', width: 200, height: 100 }]);
    });

    test('a chart with no spec, size or look renders at the default size, and pastes back flat', () => {
        const html = generateHTML(chartDoc({}), extensions);
        expect(html).toContain(`width="${CHART_DEFAULT_SIZE.width}"`);
        expect(chartsIn(html)).toMatchObject([{ spec: null, width: null, height: null, ...FLAT_CHART_LOOK }]);
    });

    test('a pasted span.chart reads its look through the chart look validators', () => {
        const look = JSON.stringify({ ...LOOK, color: 'url(#x)', roughness: 1e9 });
        const html = `<p><span class="chart" data-chart='${SPEC}' data-look='${look}'></span></p>`;
        expect(readChartAttrs(chartsIn(html)[0])).toMatchObject({
            ...LOOK,
            color: FLAT_CHART_LOOK.color,
            roughness: 10,
        });
    });

    // A peer's write or a pasted span.chart sets any size; the layout runs for seconds at a side of millions.
    test('a chart with an unbounded size renders at the max side', () => {
        const html = generateHTML(chartDoc({ spec: SPEC, width: 1e8, height: 1e8 }), extensions);
        const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span.chart');
        expect(span?.getAttribute('data-width')).toBe(String(CHART_MAX_SIDE));
        expect(span?.getAttribute('data-height')).toBe(String(CHART_MAX_SIDE));
    });

    test('a pasted span.chart with an unbounded size parses at the max side', () => {
        const html = `<p><span class="chart" data-chart='${SPEC}' data-width="300" data-height="100000000"></span></p>`;
        expect(chartsIn(html)).toMatchObject([{ width: 300, height: CHART_MAX_SIDE }]);
    });

    test('a caption that is not a string renders none, never throwing', () => {
        const html = generateHTML(chartDoc({ spec: SPEC, caption: 3 }), extensions);
        expect(html).not.toContain('figcaption');
    });
});

describe('readChartAttrs', () => {
    test('reads the attributes a chart stores', () => {
        expect(readChartAttrs({ spec: SPEC, width: 480, height: 300, layout: 'wrap-left', ...LOOK })).toEqual({
            ...LOOK,
            spec: SPEC,
            width: 480,
            height: 300,
            caption: null,
            alignment: null,
            layout: 'wrap-left',
            commentCardId: null,
        });
    });

    test('a chart that stores no look reads flat', () => {
        expect(readChartAttrs({ spec: SPEC })).toMatchObject(FLAT_CHART_LOOK);
    });

    test('reads a value of the wrong type as unset', () => {
        expect(readChartAttrs({ spec: 7, width: '480', height: null, caption: 3 })).toMatchObject({
            spec: null,
            width: null,
            height: null,
            caption: null,
        });
    });

    test('reads a side past the max as the max, and one that is not positive as unset', () => {
        expect(readChartAttrs({ width: 1e8, height: Number.POSITIVE_INFINITY })).toMatchObject({
            width: CHART_MAX_SIDE,
            height: CHART_MAX_SIDE,
        });
        expect(readChartAttrs({ width: 0, height: Number.NaN })).toMatchObject({ width: null, height: null });
        expect(readChartAttrs({ width: -5, height: CHART_MAX_SIDE })).toMatchObject({
            width: null,
            height: CHART_MAX_SIDE,
        });
    });

    // Word's largest page, 22 inches, at 96 px an inch.
    test('the max side is the largest page', () => {
        expect(CHART_MAX_SIDE).toBe(2112);
    });
});

describe('chartSvg', () => {
    const spec = sampleChartSpec('column');
    const size = { width: 600, height: 371 };

    test('draws the stored look', () => {
        const flat = chartSvg(spec, size);
        expect(chartSvg(spec, { ...size, ...readChartAttrs({ roughness: 2, seed: 9 }) })).not.toBe(flat);
        expect(chartSvg(spec, { ...size, ...readChartAttrs({}) })).toBe(flat);
    });

    // Two charts on a page, or a page's chart and its copy, never share a gradient's id.
    test('a gradient fill draws under an id no other drawing of a chart has', () => {
        const ids = (svg: string) => Array.from(svg.matchAll(/<linearGradient id="([^"]+)"/g), (m) => m[1]);
        const attrs = { ...size, ...readChartAttrs(LOOK) };
        const [a] = ids(chartSvg(spec, attrs));
        const [b] = ids(chartSvg(spec, attrs));
        expect(a).toBeString();
        expect(a).not.toBe(b);
    });
});

describe('insertChart', () => {
    const editorWith = (text: string) =>
        new Editor({
            extensions,
            content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        });

    test('inserts the sample at the caret at the default size, and selects it', () => {
        const editor = editorWith('ab');
        editor.commands.setTextSelection(2);
        expect(editor.commands.insertChart('bar')).toBe(true);
        const { selection } = editor.state;
        expect(selection).toBeInstanceOf(NodeSelection);
        expect(selection.from).toBe(2);
        const chart = editor.state.doc.nodeAt(2);
        expect(chart?.type.name).toBe('chart');
        expect(chart?.attrs).toMatchObject({ spec: JSON.stringify(sampleChartSpec('bar')), ...CHART_DEFAULT_SIZE });
        expect(editor.getText()).toBe('ab');
        editor.destroy();
    });

    // Flat, as Google's is, with a seed of its own, so a sketch picked later draws the same jitter everywhere.
    test('a new chart is flat with a random seed', () => {
        const editor = editorWith('ab');
        editor.commands.insertChart('column');
        editor.commands.setTextSelection(1);
        editor.commands.insertChart('column');
        const charts: Record<string, unknown>[] = [];
        editor.state.doc.descendants((node) => {
            if (node.type.name === 'chart') charts.push(node.attrs);
        });
        const [first, second] = charts.map(readChartAttrs);
        const { seed: _seed, ...flat } = FLAT_CHART_LOOK;
        expect(first).toMatchObject(flat);
        expect(charts[0]['seed']).toBeNumber();
        expect(first.seed).not.toBe(second.seed);
        editor.destroy();
    });

    test('a column narrower than the default shrinks the chart to it, keeping its shape', () => {
        const editor = editorWith('ab');
        editor.commands.insertChart('pie', 300);
        expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ width: 300, height: 186 });
        editor.destroy();
    });

    test('updateChart writes the selected chart and keeps it selected', () => {
        const editor = editorWith('ab');
        editor.commands.insertChart('line');
        const spec = JSON.stringify(sampleChartSpec('pie'));
        expect(editor.commands.updateChart({ spec, width: 320 })).toBe(true);
        expect(editor.state.selection).toBeInstanceOf(NodeSelection);
        expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ spec, width: 320, height: 371 });
        editor.destroy();
    });
});
