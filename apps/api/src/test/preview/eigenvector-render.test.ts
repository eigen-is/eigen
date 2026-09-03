import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { renderEigenvectorPreview } from '../../lib/preview/eigenvector-render';
import { buildGoldenVectorScene, GOLDEN_MEDIA_NAME, seedVectorDoc } from '../fixtures/golden-documents';

// The preview body is served inline as image/svg+xml. Every scalar field is validated by the reader, but
// a rich-text box's `html` is raw collaborator markup the reader only caps and cleans — so this renderer
// filters each body itself, while leaving the eigen-media: hrefs the embed route resolves.
function previewOf(html: string): string {
    const doc = new Y.Doc();
    const scene = buildGoldenVectorScene();
    seedVectorDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => (el.type === 'richtext' ? { ...el, html } : el)),
    });
    return renderEigenvectorPreview(doc, new Map([[GOLDEN_MEDIA_NAME, `eigen-media:${GOLDEN_MEDIA_NAME}`]])).body;
}

describe('renderEigenvectorPreview', () => {
    test('strips scripts, event handlers and javascript: refs from a rich-text body', () => {
        const body = previewOf(
            '<p onclick="alert(1)">safe<img src=x onerror="alert(2)">' +
                '<script>alert(3)</script><a href="javascript:alert(4)">link</a></p>',
        );
        expect(body).toContain('safe');
        expect(body).not.toContain('<script');
        expect(body).not.toContain('onerror');
        expect(body).not.toContain('onclick');
        expect(body).not.toContain('javascript:');
    });

    test('keeps ordinary markup and the media href the embed route resolves', () => {
        const body = previewOf('<p><strong>bold</strong> text</p>');
        expect(body).toContain('<strong>bold</strong>');
        expect(body).toContain(`eigen-media:${GOLDEN_MEDIA_NAME}`);
    });
});
