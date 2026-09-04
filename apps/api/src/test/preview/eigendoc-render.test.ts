import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { renderEigendocPreviewBody } from '../../lib/preview/eigendoc-render';
import { buildGoldenDocJson, GOLDEN_MEDIA_NAME, seedEigendoc } from '../fixtures/golden-documents';

// The preview body is injected as live DOM by the drive hero and the preview pane, so every
// reference in it is fetched by the viewer's browser. A figure's `src` is collaborator data (a
// pasted <img> keeps its remote URL when it carries no mediaName), so the body goes through the
// shared ref restriction with exactly the prepared media URLs allowed through.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOf(json: JSONContent): string {
    const doc = new Y.Doc();
    seedEigendoc(doc, json);
    const { body } = renderEigendocPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

function docWithFigure(attrs: Record<string, unknown>): JSONContent {
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'figure', attrs }] }] };
}

describe('renderEigendocPreviewBody', () => {
    test("a figure's prepared media URL reaches the viewer", () => {
        const body = previewOf(docWithFigure({ mediaName: GOLDEN_MEDIA_NAME, alt: 'A pixel' }));
        expect(body).toContain(`src="${MEDIA_URL}"`);
    });

    test('an external image reference never reaches a viewer', () => {
        const body = previewOf(docWithFigure({ src: 'https://evil.example/pixel.png', alt: '' }));
        expect(body).not.toContain('evil.example');
    });

    test('the golden document keeps its media and its hyperlink', () => {
        const body = previewOf(buildGoldenDocJson());
        expect(body).toContain(MEDIA_URL);
        expect(body).toContain('href="https://example.com/report"');
        expect(body).not.toMatch(/<script/i);
    });
});
