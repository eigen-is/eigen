import { describe, expect, test } from 'bun:test';
import { CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import * as Y from 'yjs';
import { renderEigenvectorPreviewBody } from '../../lib/preview/eigenvector-render';
import {
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    GOLDEN_VECTOR_TEXT,
    seedVectorDoc,
} from '../fixtures/golden-documents';

// The preview body is a compositor page served as HTML, the same markup the PDF export prints.
// Every scalar field is validated by the reader, but a rich-text box's `html` is raw collaborator
// markup the reader only caps and cleans — so this renderer filters each body itself, per element,
// leaving the page's own generated markup untouched.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOf(html: string): string {
    const doc = new Y.Doc();
    const scene = buildGoldenVectorScene();
    seedVectorDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => (el.type === 'richtext' ? { ...el, html } : el)),
    });
    const { body } = renderEigenvectorPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

describe('renderEigenvectorPreviewBody', () => {
    test('the body is a compositor page, not an svg document', () => {
        const body = previewOf('<p>hello</p>');
        expect(body).toContain('<div class="canvas-page"');
        expect(body).not.toContain('viewBox=');
        expect(body).not.toContain('<foreignObject');
    });

    test('the page composes at the shared preview width', () => {
        const body = previewOf('<p>hello</p>');
        expect(body).toContain(`width:${CANVAS_PREVIEW_WIDTH}px`);
    });

    test('rich text renders as HTML', () => {
        expect(previewOf(`<p>${GOLDEN_VECTOR_TEXT.replace('<', '&lt;').replace('>', '&gt;')}</p>`)).toContain(
            '<p>Vector &lt;sketch&gt;</p>',
        );
    });

    test('media resolves through the URL map the main thread prepared', () => {
        expect(previewOf('<p>hi</p>')).toContain(MEDIA_URL);
    });

    test('a script in a rich-text body is stripped — the reader is not the trust boundary for html', () => {
        const body = previewOf('<p>ok</p><script>alert(1)</script>');
        expect(body).toContain('<p>ok</p>');
        expect(body).not.toContain('<script');
        expect(body).not.toContain('alert(1)');
    });

    test('an event handler on a rich-text element is stripped', () => {
        expect(previewOf('<p onclick="alert(1)">ok</p>')).not.toContain('onclick');
    });

    test('an empty drawing previews as an empty body, never a throw', () => {
        const doc = new Y.Doc();
        seedVectorDoc(doc, { elements: [], frames: [], meta: { background: 'transparent', gridSize: 20 } });
        const { body, warnings } = renderEigenvectorPreviewBody(doc, new Map());
        expect(body).toBe('');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('is deterministic run to run', () => {
        expect(previewOf('<p>hi</p>')).toBe(previewOf('<p>hi</p>'));
    });
});
