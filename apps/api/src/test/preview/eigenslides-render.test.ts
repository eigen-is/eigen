import { describe, expect, test } from 'bun:test';
import { CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import { FRAME_WIDTH, type VectorScene } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { renderEigenslidesPreviewBody } from '../../lib/preview/eigenslides-render';
import { buildGoldenDeckScene, GOLDEN_BEYOND_CAP, GOLDEN_MEDIA_NAME, seedDeckDoc } from '../fixtures/golden-documents';

// A deck previews as the first slides composed by the same compositor the PDF export prints, and the
// drive hero and the preview pane both inject that body as live DOM. Every scalar field is validated
// by the reader, but a rich-text box's `html` is raw collaborator markup the reader only caps and
// cleans — so this renderer filters each body itself before composing, and the assembled page after.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOfScene(scene: VectorScene): string {
    const doc = new Y.Doc();
    seedDeckDoc(doc, scene);
    const { body } = renderEigenslidesPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

// The golden deck with every rich-text box carrying the given body.
function previewOf(html: string): string {
    const scene = buildGoldenDeckScene();
    return previewOfScene({
        ...scene,
        elements: scene.elements.map((el) => (el.type === 'richtext' ? { ...el, html } : el)),
    });
}

describe('renderEigenslidesPreviewBody', () => {
    test('a slide is a compositor page, composed at the shared preview width', () => {
        const body = previewOf('<p>hello</p>');
        expect(body).toContain('<div class="canvas-page"');
        expect(body).toContain(`width:${CANVAS_PREVIEW_WIDTH}px`);
        // In the shared fit box, so the lightbox and the drive hero can scale it below its own width.
        expect(body).toContain(`<div class="page-fit" style="--page-w:${CANVAS_PREVIEW_WIDTH}px;--page-ar:960/540">`);
        // The frame is 1920 wide, so the page scales by exactly half.
        expect(body).toContain(`transform:scale(${CANVAS_PREVIEW_WIDTH / FRAME_WIDTH})`);
    });

    test('only the first eight slides render, and the marker says so', () => {
        const body = previewOfScene(buildGoldenDeckScene());
        expect(body.match(/class="canvas-page"/g)).toHaveLength(8);
        expect(body).toContain('Deck <strong>title</strong>');
        expect(body).not.toContain(GOLDEN_BEYOND_CAP);
        expect(body).toContain('Preview truncated');
    });

    test('a deck inside the cap renders every slide and no marker', () => {
        const scene = buildGoldenDeckScene();
        const frames = scene.frames.slice(0, 3);
        const kept = new Set(frames.map((frame) => frame.id));
        const body = previewOfScene({
            ...scene,
            frames,
            elements: scene.elements.filter((el) => el.frameId !== null && kept.has(el.frameId)),
        });
        expect(body.match(/class="canvas-page"/g)).toHaveLength(3);
        expect(body).not.toContain('Preview truncated');
    });

    test('a deck with no frames previews as one blank slide, so the artifact is cacheable', () => {
        // getOrCacheText stores only a non-empty body: an empty one re-runs the whole document
        // transform (Yjs load + Worker) on every single request, forever, and never settles.
        const doc = new Y.Doc();
        seedDeckDoc(doc, { elements: [], frames: [], meta: { background: 'transparent' } });
        const { body, warnings } = renderEigenslidesPreviewBody(doc, new Map());
        doc.destroy();
        expect(body.match(/class="canvas-page"/g)).toHaveLength(1);
        expect(body).toContain('background-color:#ffffff');
        expect(warnings).toEqual([]);
    });

    test('the prepared media URLs survive as an image element and a frame background', () => {
        const body = previewOfScene(buildGoldenDeckScene());
        expect(body).toContain(`href="${MEDIA_URL}"`);
        expect(body).toContain(`background-image:url(${MEDIA_URL})`);
    });

    test('a script in a slide body is stripped — the reader is not the trust boundary for html', () => {
        const body = previewOf('<p>ok</p><script>alert(1)</script>');
        expect(body).toContain('<p>ok</p>');
        expect(body).not.toContain('<script');
        expect(body).not.toContain('alert(1)');
    });

    test('a <style> block in a slide body never reaches the page', () => {
        // The body is injected as live DOM in the drive hero and the lightbox, where a style block
        // reaches far outside its own preview: it can blank the app or lay an invisible overlay
        // over it for every user who browses the folder.
        const body = previewOf('<p>ok</p><style>body{display:none}</style>');
        expect(body).toContain('<p>ok</p>');
        expect(body).not.toContain('<style');
        expect(body).not.toContain('display:none');
    });

    test('an event handler on a slide element is stripped', () => {
        expect(previewOf('<p onclick="alert(1)">ok</p>')).not.toContain('onclick');
    });

    test('an external reference in a slide body never reaches a viewer', () => {
        // The body is injected as live DOM, so a url() or an <img src> a collaborator wrote is a
        // beacon fired at everyone who opens the folder. Every attribute that fetches without a
        // click, not just <img src>.
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
        // resolved, for the image element and for the frame that paints one as its background,
        // and the SVG-attribute ref a kind clips its image with.
        expect(body).toContain(`href="${MEDIA_URL}"`);
        expect(body).toContain(`background-image:url(${MEDIA_URL})`);
        expect(body).toContain('clip-path="url(#image-clip-el-2)"');
    });

    test('an image naming a prototype key renders empty, not a crash', () => {
        // mediaName is document data — an unknown name must resolve to null, never to something
        // off Object.prototype.
        const scene = buildGoldenDeckScene();
        const doc = new Y.Doc();
        seedDeckDoc(doc, {
            ...scene,
            elements: scene.elements.map((el) => (el.type === 'image' ? { ...el, mediaName: 'toString' } : el)),
        });
        expect(renderEigenslidesPreviewBody(doc, new Map()).body).not.toContain('<image');
        doc.destroy();
    });

    test('byte guard replaces an oversized body with the truncated notice, never a sliced string', () => {
        // The cap counts slides, not bytes, and the reader caps a single rich-text body at 64 KB —
        // so it takes a slide packed with boxes to get past the 8-slide limit, and then only the
        // byte guard stands between it and the cache.
        const scene = buildGoldenDeckScene();
        const template = scene.elements.find((el) => el.type === 'richtext');
        if (!template) throw new Error('the golden deck lost its rich-text boxes');
        const big = `<p>${'x'.repeat(64 * 1024)}</p>`;
        const elements = scene.frames.flatMap((frame) =>
            Array.from({ length: 20 }, (_, i) => ({
                ...template,
                id: `bulk-${frame.id}-${i}`,
                frameId: frame.id,
                html: big,
            })),
        );
        const doc = new Y.Doc();
        seedDeckDoc(doc, { ...scene, elements });

        const { body, warnings } = renderEigenslidesPreviewBody(doc, new Map());
        doc.destroy();
        expect(warnings.some((warning) => warning.code === 'byte-guard-truncated')).toBe(true);
        expect(body).toContain('Preview truncated');
        expect(body.length).toBeLessThan(1000);
    }, 60_000);

    test('is deterministic run to run', () => {
        expect(previewOf('<p>hi</p>')).toBe(previewOf('<p>hi</p>'));
    });
});
