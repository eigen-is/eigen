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
        // The text element and the bound arrow label both render, XML-escaped by the serializer.
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
