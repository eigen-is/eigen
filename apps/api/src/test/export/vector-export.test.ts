import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { readVectorFromDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { exportDocument, runDocumentExport } from '../../lib/export/export-document';
import { sanitizeSceneHtml } from '../../lib/export/sanitize';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home/get-home';
import {
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    seedDocumentMedia,
    seedVectorDoc,
} from '../fixtures/golden-documents';
import { authedRequest, driveGet, drivePost, getTestContext, TEST_PNG_BYTES } from '../setup';

// Response contract of GET /drive/:ownerId/:mountId/file/:pathId/export/:format for
// eigenvector: the pdf download is the drawing as compositor layers on a page WeasyPrint renders,
// sharing the route's content-type / filename / error behavior with the other document types. The
// drawing's SVG is the editor's own (packages/ui's canvas image writer), so the route refuses svg.

const mountId = 'default';
let ctx: Awaited<ReturnType<typeof getTestContext>>;
let rootId: string;
let vectorPath: DrivePath;
let emptyPath: DrivePath;

async function seedVector(fileName: string, seed: boolean): Promise<DrivePath> {
    const created = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/vector`,
        { fileName },
    );
    const home = await getHome(ctx.alice.user.id);
    if (seed) {
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        seedVectorDoc(collab.doc, buildGoldenVectorScene());
        const resolved = await home.drive.resolveFile(mountId, created.id);
        await seedDocumentMedia(resolved.mount, resolved.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    }
    return created;
}

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
    vectorPath = await seedVector('Vector Contract', true);
    emptyPath = await seedVector('Empty Drawing', false);
});

// The document WeasyPrint is handed for a drawing's PDF.
async function pdfHtmlOf(pathId: string): Promise<string> {
    const home = await getHome(ctx.alice.user.id);
    const { mount, path } = await home.drive.resolveFile(mountId, pathId);
    const bytes = await runDocumentExport({ documentType: 'eigenvector', format: 'pdf-html' }, mount, path);
    return bytes.toString('utf-8');
}

function exportRequest(pathId: string, format: string) {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/export/${format}`,
    );
}

describe('Eigenvector export route — response contract', () => {
    test.each(['xlsx', 'svg'])(
        'an unsupported format, %s, is rejected with 400',
        async (format) => {
            const res = await exportRequest(vectorPath.id, format);
            expect(res.status).toBe(400);
            expect(await res.text()).toContain('not supported');
        },
        60_000,
    );
});

describe('Eigenvector export — empty drawing', () => {
    test('pdf export of an empty drawing is rejected with 400', async () => {
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, emptyPath.id);
        await expect(exportDocument(mount, path, 'pdf')).rejects.toThrow('The drawing is empty');
    }, 60_000);
});

describe('Eigenvector export — SVG media sanitization', () => {
    test('a scriptable svg media embeds with scripts and external refs stripped', async () => {
        // Media previews serve SVG bytes as-is, so a pasted/uploaded drawing is raw user content;
        // prepareMedia (export/media.ts) must pass it through the export sanitizer before it rides
        // into the document as a data: URI (nested <image href> is SSRF against WeasyPrint).
        const created = await seedVector('Evil Media', false);
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        seedVectorDoc(collab.doc, buildGoldenVectorScene());
        const resolved = await home.drive.resolveFile(mountId, created.id);
        const evil =
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
            '<script>alert(2)</script><image href="http://169.254.169.254/latest"/><rect width="10" height="10"/></svg>';
        await seedDocumentMedia(
            resolved.mount,
            resolved.path,
            GOLDEN_MEDIA_NAME,
            new TextEncoder().encode(evil),
            'image/svg+xml',
        );

        const html = await pdfHtmlOf(created.id);
        const b64 = html.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/)?.[1];
        expect(b64).toBeTruthy();
        const embedded = Buffer.from(b64 ?? '', 'base64').toString('utf8');
        expect(embedded).toContain('<rect');
        expect(embedded).not.toContain('<script');
        expect(embedded).not.toContain('onload');
        expect(embedded).not.toContain('169.254.169.254');
    }, 120_000);
});

describe('Eigenvector export — rich-text HTML sanitization', () => {
    test('a hostile rich-text body exports with scripts, handlers and external refs stripped', async () => {
        // `html` is raw TipTap markup any collaborator can write, and the reader only caps and cleans it
        // (no tag filtering), so the assembled document must go through DOMPurify before WeasyPrint reads it.
        const created = await seedVector('Evil Text', false);
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        const scene = buildGoldenVectorScene();
        seedVectorDoc(collab.doc, {
            ...scene,
            elements: scene.elements.map((el) =>
                el.type === 'richtext'
                    ? {
                          ...el,
                          html:
                              '<p onclick="alert(1)">safe<img src=x onerror="alert(2)">' +
                              '<script>alert(3)</script><a href="javascript:alert(4)">link</a></p>',
                      }
                    : el,
            ),
        });

        const html = await pdfHtmlOf(created.id);
        expect(html).toContain('safe');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('javascript:');
    }, 120_000);
});

describe('Eigenvector export — rich-text nesting', () => {
    const sanitizeRead = (html: string): string => {
        const scene = buildGoldenVectorScene();
        const doc = new Y.Doc();
        seedVectorDoc(doc, {
            ...scene,
            elements: scene.elements.map((el) => (el.type === 'richtext' ? { ...el, html } : el)),
        });
        const text = sanitizeSceneHtml(readVectorFromDoc(doc)).elements.find((el) => el.type === 'richtext');
        return text?.type === 'richtext' ? text.html : '';
    };
    const fill = (prefix: string, unit: string) =>
        prefix + unit.repeat(Math.floor((64 * 1024 - prefix.length) / unit.length));
    const ems = Array.from({ length: 61 }, (_, i) => `<em a=${i}>`).join('');
    const marks = Array.from({ length: 62 }, (_, i) => `<${['em', 'strong', 'u', 's'][i % 4]} t=${i}>`).join('');

    // jsdom walks every ancestor of each node it inserts, so this body took seconds per parse uncapped.
    test('a list a peer nested 3,000 deep reaches the sanitizer flattened, every x kept', () => {
        const start = performance.now();
        const html = sanitizeRead(`${'<ul><li>x'.repeat(3_000)}${'</li></ul>'.repeat(3_000)}`);
        expect(performance.now() - start).toBeLessThan(1_000);
        expect(html).toBe(`<p>${'x'.repeat(3_000)}</p>`);
    });

    // Under the depth cap, but the parser closes what the body leaves open, so formatting elements stay on its
    // active list and every later paragraph rebuilds them: 64 KiB of these held jsdom 10–17 s.
    test.each([
        ['a mismatched </p>', fill(`<p>${ems}</p>`, '<p>x</p>')],
        ['a <p> in an open <p>', fill(`<p>${ems}<p>x</p>`, '<p>x</p>')],
        ['an <li> in an open <li>', fill(`<ul><li>${ems}<li>x</li>`, '<li>x</li>')],
        ['empty paragraphs with a <br>', fill(`<p>${marks}</p>`, '<p><br></p>')],
    ])('%s sanitizes in linear time, its text kept', (_, body) => {
        const start = performance.now();
        const html = sanitizeRead(body);
        // 8,000 flattened paragraphs parse in about 0.5 s; the drift held jsdom 8–17 s.
        expect(performance.now() - start).toBeLessThan(2_000);
        expect(html).not.toContain('<em');
        expect(html.replace(/<[^>]*>/g, '')).toBe(body.replace(/<[^>]*>/g, ''));
    });

    test('hostile markup stays inert, flattened or kept', () => {
        const flattened = sanitizeRead('<div>&lt;img src=x onerror=alert(1)&gt;<img src=x onerror=alert(2)></div>');
        expect(flattened).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
        const kept = sanitizeRead('<p><a href="javascript:alert(1)" onclick="alert(2)">x</a></p>');
        expect(kept).not.toContain('javascript:');
        expect(kept).not.toContain('onclick');
        expect(kept).toContain('x');
    });
});

describe('Eigenvector export — the pdf-html document (what WeasyPrint is handed)', () => {
    // One render for every assertion below: the document is deterministic, and a transform Worker
    // per test would be seven more spawns for the same bytes.
    let rendered: Promise<string> | null = null;
    function pdfHtml(): Promise<string> {
        rendered ??= pdfHtmlOf(vectorPath.id);
        return rendered;
    }

    test('the drawing prints as compositor layers, not as one inline svg', async () => {
        const html = await pdfHtml();
        // The page is the document body's only child, and every <svg> in it is one layer's own
        // viewport — the old arm put the whole drawing in a single root <svg> with a viewBox.
        expect(html).toContain('<body>\n    <div class="canvas-page"');
        // The page prints at 1:1, so no transform sits above a layer (canvas-pdf.test.ts says why).
        expect(html).not.toContain('transform:scale');
        const svgs = (html.match(/<svg\b/g) ?? []).length;
        const layerViewports = (html.match(/<div style="position:absolute[^"]*"><svg\b/g) ?? []).length;
        expect(svgs).toBeGreaterThan(1);
        expect(layerViewports).toBe(svgs);
    }, 120_000);

    test('rich text prints as HTML — the thing foreignObject could never give WeasyPrint', async () => {
        const html = await pdfHtml();
        expect(html).toContain('<p>Vector &lt;sketch&gt;</p>');
        expect(html).not.toContain('<foreignObject');
    }, 120_000);

    test('a gradient fill carries its own <defs> inside its own element svg', async () => {
        const html = await pdfHtml();
        expect(html).toContain('<linearGradient');
        expect(html).toContain('#e60076');
        // url(#id) across two <svg> elements renders NOTHING in WeasyPrint. Each gradient
        // must therefore be defined in the same <svg> that references it.
        const svgs = html.split('<svg ');
        const withGradient = svgs.filter((chunk) => chunk.includes('<linearGradient'));
        expect(withGradient.length).toBeGreaterThan(0);
        for (const chunk of withGradient) expect(chunk).toContain('url(#');
    }, 120_000);

    test('paint references survive the sanitizer because they are attributes, not CSS', async () => {
        const html = await pdfHtml();
        // sanitize.ts rewrites every non-data url() it finds in a `style` attribute or a <style>
        // block to `url()`. A gradient or a clip expressed in CSS would therefore reach WeasyPrint
        // as `url()` and paint nothing — silently. These attribute forms are what keeps that safe.
        expect(html).toMatch(/(?:fill|stroke)="url\(#/);
        expect(html).toContain('clip-path="url(#');
        expect(html).not.toContain('url()');
    }, 120_000);

    test('a round-cornered image clips through the shared outline path', async () => {
        const html = await pdfHtml();
        expect(html).toContain('<clipPath');
        // Mime-agnostic on purpose: collectExportMedia embeds the SCREEN PREVIEW of each media
        // child (webp today), not the stored bytes. What matters is that it is a data: URI.
        expect(html).toMatch(/href="data:image\/[a-z+]+;base64,/);
    }, 120_000);

    test('fonts ride the wrapping document and every reference is a data: URI', async () => {
        const html = await pdfHtml();
        expect(html).toContain('@font-face');
        expect(html).toContain('data:font/woff2;base64,');
        expect(html).not.toContain('href="http');
        expect(html).not.toContain('src="http');
    }, 120_000);

    test('the page is sized to the drawing', async () => {
        const html = await pdfHtml();
        expect(html).toMatch(/@page \{ size: [\d.]+px [\d.]+px; margin: 0; \}/);
    }, 120_000);

    test('an empty drawing is still a 400', async () => {
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, emptyPath.id);
        await expect(
            runDocumentExport({ documentType: 'eigenvector', format: 'pdf-html' }, mount, path),
        ).rejects.toThrow('The drawing is empty');
    }, 60_000);
});

const suite = (await isWeasyPrintAvailable()) ? describe : describe.skip;

suite('Eigenvector export route — PDF (WeasyPrint end-to-end)', () => {
    test('pdf export serves a rendered PDF as an attachment', async () => {
        const res = await exportRequest(vectorPath.id, 'pdf');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Vector Contract.pdf"');
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        // A page WeasyPrint renders nothing onto is ~770 bytes (measured); this drawing's page —
        // roughjs paths, a subsetted Excalifont and the raster image — is ~9.5 kB. The floor is what
        // stops "renders nothing" from passing; the structural assertions above are what pin the
        // content, since the exact byte count moves with the host's WeasyPrint and font stack.
        expect(pdf.byteLength).toBeGreaterThan(5_000);
    }, 120_000);
});
