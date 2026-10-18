import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { renderEigenvectorExport } from '../../lib/export/vector/transform';
import { buildGoldenVectorScene, seedVectorDoc } from '../fixtures/golden-documents';

// The .svg download keeps a rich-text box as real HTML inside a foreignObject, so the box's markup
// is the one place a collaborator can reach the document that embeds it.
function svgWithRichText(html: string): string {
    const scene = buildGoldenVectorScene();
    const doc = new Y.Doc();
    seedVectorDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => (el.id === 'v-text' ? { ...el, html } : el)),
    });
    const { data } = renderEigenvectorExport(doc, 'svg', 'Drawing', []);
    return new TextDecoder().decode(data);
}

describe('renderEigenvectorExport', () => {
    test('drops a <style> block a rich-text box carries', () => {
        const svg = svgWithRichText('<style>*{display:none}</style><p>hi</p>');
        expect(svg).not.toContain('display:none');
        expect(svg).toContain('hi');
    });

    test('filters the body to the tag set the live canvas mounts', () => {
        const svg = svgWithRichText('<p>hi</p><table><tr><td>grid</td></tr></table>');
        expect(svg).not.toContain('<table');
        expect(svg).toContain('hi');
    });

    // A standalone SVG has none of the app's CSS, so it carries the rules an inline style cannot reach:
    // list markers, paragraph spacing, and the line a blank paragraph takes.
    test('carries the canvas text rules, so a blank line keeps its height', () => {
        const svg = svgWithRichText('<p>a</p><p></p><p>b</p>');
        expect(svg).toContain('<p>a</p><p></p><p>b</p>');
        expect(svg).toContain('.eigen-canvas-text p:empty');
        expect(svg).toContain('.eigen-canvas-text p + p');
    });
});
