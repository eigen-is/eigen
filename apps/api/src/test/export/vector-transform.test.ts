import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { renderEigenvectorExport } from '../../lib/export/vector/transform';
import { buildGoldenVectorScene, seedVectorDoc } from '../fixtures/golden-documents';

// The PDF prints a rich-text box as real HTML, so the box's markup is the one place a collaborator can
// reach the document that embeds it.
async function pdfHtmlWithRichText(html: string): Promise<string> {
    const scene = buildGoldenVectorScene();
    const doc = new Y.Doc();
    seedVectorDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => (el.id === 'v-text' ? { ...el, html } : el)),
    });
    const { data } = await renderEigenvectorExport(doc, 'Drawing', async () => []);
    return new TextDecoder().decode(data);
}

describe('renderEigenvectorExport', () => {
    test('drops a <style> block a rich-text box carries', async () => {
        const html = await pdfHtmlWithRichText('<style>*{display:none}</style><p>hi</p>');
        expect(html).not.toContain('display:none');
        expect(html).toContain('hi');
    });

    test('filters the body to the tag set the live canvas mounts', async () => {
        const html = await pdfHtmlWithRichText('<p>hi</p><table><tr><td>grid</td></tr></table>');
        expect(html).not.toContain('<table');
        expect(html).toContain('hi');
    });

    // A standalone document has none of the app's CSS, so it carries the rules an inline style cannot reach:
    // list markers, paragraph spacing, and the line a blank paragraph takes.
    test('carries the canvas text rules, so a blank line keeps its height', async () => {
        const html = await pdfHtmlWithRichText('<p>a</p><p></p><p>b</p>');
        expect(html).toContain('<p>a</p><p></p><p>b</p>');
        expect(html).toContain('.eigen-canvas-text p:empty');
        expect(html).toContain('.eigen-canvas-text p + p');
    });
});
