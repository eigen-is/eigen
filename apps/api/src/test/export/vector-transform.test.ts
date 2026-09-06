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
});
