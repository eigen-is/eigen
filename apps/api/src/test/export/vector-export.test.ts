import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { exportDocument, runDocumentExport } from '../../lib/export/export-document';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home/get-home';
import {
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    GOLDEN_VECTOR_LABEL,
    GOLDEN_VECTOR_TEXT,
    seedDocumentMedia,
    seedVectorDoc,
} from '../fixtures/golden-documents';
import { authedRequest, driveGet, drivePost, getTestContext, TEST_PNG_BYTES } from '../setup';

// Response contract of GET /drive/:ownerId/:mountId/file/:pathId/export/:format for
// eigenvector: the svg download inlines fonts + media as the drawing's own SVG, the pdf
// download is the same SVG on a white page rendered by WeasyPrint, and both share the
// route's content-type / filename / error behaviour with the other document types.

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

function exportRequest(pathId: string, format: string) {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/export/${format}`,
    );
}

describe('Eigenvector export route — response contract', () => {
    test('svg export serves the drawing SVG with fonts and media inlined', async () => {
        const res = await exportRequest(vectorPath.id, 'svg');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Vector Contract.svg"');

        const svg = await res.text();
        expect(svg.startsWith('<svg')).toBe(true);
        // A rich-text box rides in a <foreignObject>, which the export sanitizer keeps only because
        // the vector transform declares it an HTML integration point — without that the box's markup
        // is dropped and the drawing exports wordless.
        expect(svg).toContain('<foreignObject');
        // The rich-text box and the bound arrow label both render, the payload still escaped.
        expect(svg).toContain(GOLDEN_VECTOR_TEXT.replace('<', '&lt;').replace('>', '&gt;'));
        expect(svg).toContain(GOLDEN_VECTOR_LABEL);
        // Fonts are inlined for the families the text actually uses (Excalifont here).
        expect(svg).toContain('@font-face');
        expect(svg).toContain('Excalifont');
        expect(svg).toContain('data:font/woff2;base64,');
        // Media resolves to an embedded data: URI, never an external href WeasyPrint could fetch.
        expect(svg).toContain('data:image/');
        expect(svg).not.toMatch(/href="https?:/);
    }, 120_000);

    test('an unsupported format is rejected with 400', async () => {
        const res = await exportRequest(vectorPath.id, 'xlsx');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    }, 60_000);
});

describe('Eigenvector export — empty drawing', () => {
    test('svg export of an empty drawing returns the empty document, not an error', async () => {
        const res = await exportRequest(emptyPath.id, 'svg');
        expect(res.status).toBe(200);
        const svg = await res.text();
        expect(svg.startsWith('<svg')).toBe(true);
    }, 60_000);

    test('pdf export of an empty drawing is rejected with 400', async () => {
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, emptyPath.id);
        expect(exportDocument(mount, path, 'pdf')).rejects.toThrow('The drawing is empty');
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

        const res = await exportRequest(created.id, 'svg');
        expect(res.status).toBe(200);
        const svg = await res.text();
        const b64 = svg.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/)?.[1];
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
        // (no tag filtering), so the assembled SVG must go through DOMPurify before it is served.
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

        const res = await exportRequest(created.id, 'svg');
        expect(res.status).toBe(200);
        const svg = await res.text();
        expect(svg).toContain('safe');
        expect(svg).not.toContain('<script');
        expect(svg).not.toContain('onerror');
        expect(svg).not.toContain('onclick');
        expect(svg).not.toContain('javascript:');
    }, 120_000);
});

describe('Eigenvector export — the pdf-html document (what WeasyPrint is handed)', () => {
    // One render for every assertion below: the document is deterministic, and a transform Worker
    // per test would be seven more spawns for the same bytes.
    let rendered: Promise<string> | null = null;
    function pdfHtml(): Promise<string> {
        rendered ??= (async () => {
            const home = await getHome(ctx.alice.user.id);
            const { mount, path } = await home.drive.resolveFile(mountId, vectorPath.id);
            const bytes = await runDocumentExport({ documentType: 'eigenvector', format: 'pdf-html' }, mount, path);
            return bytes.toString('utf-8');
        })();
        return rendered;
    }

    test('the drawing prints as compositor layers, not as one inline svg', async () => {
        const html = await pdfHtml();
        // The page is the document body's only child, and every <svg> in it is one layer's own
        // viewport — the old arm put the whole drawing in a single root <svg> with a viewBox.
        expect(html).toContain('<body>\n    <div class="canvas-page"');
        expect(html).toContain('transform-origin:0 0');
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
        // Phase 0: url(#id) across two <svg> elements renders NOTHING in WeasyPrint. Each gradient
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
