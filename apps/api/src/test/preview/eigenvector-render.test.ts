import { describe, expect, test } from 'bun:test';
import { CANVAS_PREVIEW_HEIGHT, CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import type { VectorScene } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { renderEigenvectorPreviewBody } from '../../lib/preview/eigenvector-render';
import {
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    GOLDEN_VECTOR_TEXT,
    seedVectorDoc,
} from '../fixtures/golden-documents';

// The preview body is a compositor page served as HTML, the same markup the PDF export prints, and
// the drive hero and the preview pane both inject it as live DOM. Every scalar field is validated by
// the reader, but a rich-text box's `html` is raw collaborator markup the reader only caps and
// cleans — so this renderer filters each body itself before composing, and the assembled page after.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOfScene(scene: VectorScene): string {
    const doc = new Y.Doc();
    seedVectorDoc(doc, scene);
    const { body } = renderEigenvectorPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

// The golden scene with every rich-text box carrying the given body.
function previewOf(html: string): string {
    const scene = buildGoldenVectorScene();
    return previewOfScene({
        ...scene,
        elements: scene.elements.map((el) => (el.type === 'richtext' ? { ...el, html } : el)),
    });
}

// The compositor rounds every length to two decimals.
function round(n: number): number {
    return Math.round(n * 100) / 100;
}

describe('renderEigenvectorPreviewBody', () => {
    test('the body is a compositor page, not an svg document', () => {
        const body = previewOf('<p>hello</p>');
        expect(body).toContain('<div class="canvas-page"');
        // Fitted like a slide is: the drawing preview is the same box on the same surfaces.
        expect(body).toContain('<div class="page-fit" style="--page-w:960px;');
        expect(body).not.toContain('viewBox=');
        expect(body).not.toContain('<foreignObject');
    });

    test('the page composes at the shared preview width', () => {
        const body = previewOf('<p>hello</p>');
        expect(body).toContain(`width:${CANVAS_PREVIEW_WIDTH}px`);
    });

    test('a tall drawing fits the preview box instead of magnifying to the width', () => {
        const golden = buildGoldenVectorScene();
        const tall = golden.elements
            .filter((el) => el.id === 'v-rect')
            .map((el) => ({ ...el, width: 50, height: 5000 }));
        const body = previewOfScene({ ...golden, elements: tall });
        // Scaled on width alone this 70x5020 page (content + padding) would be 96,000px tall.
        expect(body).toContain(`width:${CANVAS_PREVIEW_WIDTH}px;height:${CANVAS_PREVIEW_HEIGHT}px`);
        // The box stays full width — drive-preview.tsx scales the body from exactly that width — so
        // the page is widened in scene units and the drawing sits centred in it.
        expect(body).toContain(`width:${round(CANVAS_PREVIEW_WIDTH / (CANVAS_PREVIEW_HEIGHT / 5020))}px;height:5020px`);
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

    test('a <style> block in a rich-text body never reaches the page', () => {
        // The body is injected as live DOM in the drive hero and the lightbox, where a style block
        // reaches far outside its own preview: it can blank the app or lay an invisible overlay
        // over it for every user who browses the folder.
        const body = previewOf('<p>ok</p><style>body{display:none}</style>');
        expect(body).toContain('<p>ok</p>');
        expect(body).not.toContain('<style');
        expect(body).not.toContain('display:none');
    });

    test('a huge drawing renders a bounded number of elements, and the marker says so', () => {
        // Every other preview type has a budget (20 blocks, 8 slides, a cell cap): without one a
        // 50k-element drawing pays roughjs path generation for all of them before the byte guard
        // even looks at the result.
        const scene = buildGoldenVectorScene();
        const rect = scene.elements.find((el) => el.type === 'rectangle');
        if (!rect) throw new Error('the golden scene has a rectangle');
        const many = Array.from({ length: 520 }, (_, i) => ({
            ...rect,
            id: `many-${i}`,
            index: `b${i.toString().padStart(4, '0')}`,
            x: (i % 40) * 20,
            y: Math.floor(i / 40) * 20,
        }));
        const body = previewOfScene({ ...scene, elements: many });
        expect(body.match(/<svg /g)).toHaveLength(500);
        expect(body).toContain('Preview truncated');
    });

    test('an empty drawing previews as an empty page, so the cache stops serving its old body', () => {
        const doc = new Y.Doc();
        seedVectorDoc(doc, { elements: [], frames: [], meta: { background: '#fef3c7' } });
        const { body, warnings } = renderEigenvectorPreviewBody(doc, new Map());
        doc.destroy();
        expect(body).toContain(`<div class="canvas-page" style="position:relative;overflow:hidden;width:960px;`);
        expect(body).toContain('background-color:#fef3c7');
        expect(body).not.toContain('<svg');
        expect(warnings).toEqual([]);
    });

    test('an external reference in a rich-text body never reaches a viewer', () => {
        // The body is injected as live DOM, so a url() or an <img src> a collaborator wrote is a
        // beacon fired at everyone who opens the folder — the rich-text pass drops both.
        // Every attribute that fetches without a click, not just <img src>.
        const body = previewOf(
            '<p style="background:url(https://evil.example/beacon.png)">ok</p>' +
                '<img src="https://evil.example/pixel.png">' +
                '<img srcset="https://evil.example/candidate.png 1x">' +
                '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>' +
                '<audio src="https://evil.example/a.mp3"></audio>' +
                '<picture><source srcset="https://evil.example/s.png"><img alt=""></picture>' +
                '<input type="image" src="https://evil.example/i.png">',
        );
        expect(body).toContain('<p style="background:url()">ok</p>');
        expect(body).not.toContain('evil.example');
        // What the compositor itself put in the page survives: the media URL the main thread
        // resolved, and the SVG-attribute refs a kind points at its own gradient and clip with.
        expect(body).toContain(MEDIA_URL);
        expect(body).toContain('stroke="url(#fill-v-gradient)"');
        expect(body).toContain('clip-path="url(#image-clip-v-image)"');
    });

    test('is deterministic run to run', () => {
        expect(previewOf('<p>hi</p>')).toBe(previewOf('<p>hi</p>'));
    });
});
