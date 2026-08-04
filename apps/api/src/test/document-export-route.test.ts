import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import JSZip from 'jszip';
import { isWeasyPrintAvailable } from '../lib/export/weasyprint';
import { getHome } from '../lib/home/get-home';
import {
    buildGoldenDeck,
    buildGoldenDocJson,
    GOLDEN_BEYOND_CAP,
    GOLDEN_MEDIA_NAME,
    seedDocumentMedia,
    seedEigendoc,
    seedSlidesDoc,
} from './fixtures/golden-documents';
import { authedRequest, driveGet, drivePost, getTestContext, TEST_PNG_BYTES } from './setup';

// Response contract of GET /drive/:ownerId/:mountId/file/:pathId/export/:format for
// eigendoc and eigenslides: content types, filenames, Content-Disposition, and error
// statuses. Pinned here so moving the transforms into the document-transform Worker
// cannot change what the route hands back.

const mountId = 'default';
let ctx: Awaited<ReturnType<typeof getTestContext>>;
let docPath: DrivePath;
let deckPath: DrivePath;

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    const home = await getHome(ctx.alice.user.id);

    docPath = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${root.id}/create/doc`,
        { fileName: 'Doc Contract' },
    );
    const docCollab = await home.drive.getCollabDocument(mountId, docPath.id);
    seedEigendoc(docCollab.doc, buildGoldenDocJson());
    const doc = await home.drive.resolveFile(mountId, docPath.id);
    await seedDocumentMedia(doc.mount, doc.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);

    deckPath = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${root.id}/create/slides`,
        { fileName: 'Deck Contract' },
    );
    const deckCollab = await home.drive.getCollabDocument(mountId, deckPath.id);
    seedSlidesDoc(deckCollab.doc, buildGoldenDeck());
    const deck = await home.drive.resolveFile(mountId, deckPath.id);
    await seedDocumentMedia(deck.mount, deck.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
});

function exportRequest(pathId: string, format: string) {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/export/${format}`,
    );
}

describe('Eigendoc export route — response contract', () => {
    test('html export serves a standalone document as an attachment', async () => {
        const res = await exportRequest(docPath.id, 'html');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Doc Contract.html"');

        const html = await res.text();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        // The document <title> carries the UNstripped container name — frozen output,
        // not a bug to fix while moving the transform off-thread.
        expect(html).toContain('<title>Doc Contract.eigendoc</title>');
        // Full document, not the budgeted preview: blocks past the 20-block cap render,
        // media embeds as a data URI, and hostile fixture content stays sanitized.
        expect(html).toContain(GOLDEN_BEYOND_CAP);
        expect(html).toContain('src="data:image/webp;base64,');
        expect(html).not.toMatch(/<script/i);
    }, 120_000);

    test('docx export serves a zip workbook with the wordprocessing content type', async () => {
        const res = await exportRequest(docPath.id, 'docx');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Doc Contract.docx"');
        const buffer = Buffer.from(await res.arrayBuffer());
        expect(buffer.subarray(0, 2).toString()).toBe('PK');
        // Unlike the HTML <title>, the docx document property carries the STRIPPED
        // container name — frozen output, and the conversion now runs in the Worker.
        const zip = await JSZip.loadAsync(buffer);
        expect(await zip.file('docProps/core.xml')?.async('string')).toContain('<dc:title>Doc Contract</dc:title>');
    }, 120_000);

    test('an unsupported format is rejected with 400', async () => {
        const res = await exportRequest(docPath.id, 'xlsx');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    }, 60_000);
});

describe('Eigenslides export route — response contract', () => {
    test('html export serves a standalone deck as an attachment', async () => {
        const res = await exportRequest(deckPath.id, 'html');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Deck Contract.html"');

        const html = await res.text();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('<title>Deck Contract</title>');
        // Every slide renders (no 8-slide preview cap), media embeds as a data URI,
        // and the injected script never survives into the download.
        expect(html).toContain(GOLDEN_BEYOND_CAP);
        expect(html).toContain('data:image/webp;base64,');
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('<div class="deck">');
    }, 120_000);

    test('an unsupported format is rejected with 400', async () => {
        const res = await exportRequest(deckPath.id, 'docx');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    }, 60_000);
});

const suite = (await isWeasyPrintAvailable()) ? describe : describe.skip;

suite('Document export routes — PDF (WeasyPrint end-to-end)', () => {
    test('eigendoc pdf export serves a rendered PDF as an attachment', async () => {
        const res = await exportRequest(docPath.id, 'pdf');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Doc Contract.pdf"');
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }, 120_000);

    test('eigenslides pdf export serves a rendered PDF as an attachment', async () => {
        const res = await exportRequest(deckPath.id, 'pdf');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Deck Contract.pdf"');
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }, 120_000);
});
