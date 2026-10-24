import { describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import type { StyleDefaults, VectorChartElement, VectorScene } from '@workspace/lib/vector';
import {
    baseDefaultsFor,
    DEFAULT_SCENE_META,
    ELEMENT_KINDS,
    elementLayer,
    elementToSvg,
    layerInnerHtml,
    SLIDE_SIZES,
    SLIDES_STYLE_DEFAULTS,
    VECTOR_STYLE_DEFAULTS,
} from '@workspace/lib/vector';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { renderEigenslidesHtml } from '../../lib/export/canvas/transform';
import { renderEigenvectorExport } from '../../lib/export/vector/transform';
import { seedVectorDoc } from '../fixtures/golden-documents';

// A chart is a kind like any other, so every canvas export draws it with nothing chart-specific: plain
// SVG shapes and <text> labels, which WeasyPrint draws and the export sanitizer keeps whole.

const TITLE = 'Q1 <draft> & more';

function chartElement(style: StyleDefaults, over: Partial<VectorChartElement> = {}): VectorChartElement {
    // In the host's font, as Insert → Chart places one.
    const spec = sampleChartSpec('column', style.fontFamily);
    return {
        ...baseDefaultsFor('chart', style),
        ...ELEMENT_KINDS.chart.defaults(style),
        id: 'chart-1',
        type: 'chart',
        x: 40,
        y: 60,
        width: 640,
        height: 400,
        angle: 0,
        index: 'a0',
        seed: 7,
        // A turned axis title, a bold title and escaped text all reach the export.
        chart: JSON.stringify({
            ...spec,
            title: { text: TITLE },
            axes: { ...spec.axes, y: { ...spec.axes.y, title: { text: 'Points' } } },
        }),
        ...over,
    };
}

function docOf(scene: VectorScene): Y.Doc {
    const doc = new Y.Doc();
    seedVectorDoc(doc, scene);
    return doc;
}

const decode = (data: ArrayBuffer): string => new TextDecoder().decode(data);

// The layer bodies of a compositor document, as the browser's HTML parser serializes them. A screen page
// holds its layers in a scene box; a PDF page holds them straight in the page box (renderPrintPage).
function layerBodies(html: string, layers: string): string[] {
    const { document } = new JSDOM(html).window;
    return [...document.querySelectorAll(layers)].map((layer) => layer.innerHTML);
}

function asParsed(fragment: string): string {
    const { document } = new JSDOM('').window;
    const div = document.createElement('div');
    div.innerHTML = fragment;
    return div.innerHTML;
}

describe('a chart in the canvas exports', () => {
    const chart = chartElement(VECTOR_STYLE_DEFAULTS);
    const scene: VectorScene = { elements: [chart], frames: [], meta: DEFAULT_SCENE_META };

    test('the PDF page holds the chart layer the live canvas mounts', async () => {
        const html = decode((await renderEigenvectorExport(docOf(scene), 'Drawing', async () => [])).data);
        const layer = elementLayer(chart);
        if (!layer) throw new Error('a chart always draws');
        const bodies = layerBodies(html, '.canvas-page > div');
        expect(bodies).toEqual([asParsed(layerInnerHtml(layer.content))]);
        // WeasyPrint draws SVG text and ignores a foreignObject (the stylesheet's comments name one).
        expect(bodies[0]).toContain('Q1 &lt;draft&gt; &amp; more</text>');
        expect(bodies[0]).not.toContain('foreignObject');
    });

    test('a deck prints its chart the same way', async () => {
        const slide = chartElement(SLIDES_STYLE_DEFAULTS, { frameId: 'frame-1' });
        const deck: VectorScene = {
            elements: [slide],
            frames: [{ id: 'frame-1', index: 'a0', name: '', background: '', ...SLIDE_SIZES['16:9'] }],
            meta: DEFAULT_SCENE_META,
        };
        const html = decode((await renderEigenslidesHtml(docOf(deck), 'html', 'Deck', async () => [])).data);
        const layer = elementLayer(slide);
        if (!layer) throw new Error('a chart always draws');
        expect(layerBodies(html, '.canvas-page > div > div')).toEqual([asParsed(layerInnerHtml(layer.content))]);
        expect(elementToSvg(slide)).toContain('font-family="&apos;Inter&apos;, sans-serif"');
    });
});
