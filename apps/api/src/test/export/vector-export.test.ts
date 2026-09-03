import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { exportDocument } from '../../lib/export/export-document';
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

const suite = (await isWeasyPrintAvailable()) ? describe : describe.skip;

suite('Eigenvector export route — PDF (WeasyPrint end-to-end)', () => {
    test('pdf export serves a rendered PDF as an attachment', async () => {
        const res = await exportRequest(vectorPath.id, 'pdf');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Vector Contract.pdf"');
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }, 120_000);
});
