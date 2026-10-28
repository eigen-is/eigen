import { beforeAll, describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EXPORT_SUMMARY_HEADER } from '@workspace/lib/types/drive';
import { serializeFill } from '@workspace/lib/vector';
import type { MathRow } from '@workspace/math';
import { writeMathml } from '@workspace/math';
import type { Sharp } from 'sharp';
import sharp from 'sharp';
import { EXPORT_CSP } from '../../lib/export/sanitize';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home/get-home';
import { openZip } from '../../lib/ooxml/zip';
import {
    buildGoldenDeckScene,
    buildGoldenDocJson,
    equation,
    GOLDEN_BEYOND_CAP,
    GOLDEN_MEDIA_NAME,
    seedDeckDoc,
    seedDocumentMedia,
    seedEigendoc,
} from '../fixtures/golden-documents';
import { writeSheetsToYjs } from '../fixtures/heavy-sheets';
import { authedRequest, driveGet, drivePost, driveUpload, getTestContext, TEST_PNG_BYTES } from '../setup';

// Response contract of GET /drive/:ownerId/:mountId/file/:pathId/export/:format for
// eigendoc and eigenslides: content types, filenames, Content-Disposition, and error
// statuses. Pinned here so moving the transforms into the document-transform Worker
// cannot change what the route hands back.

const mountId = 'default';
let ctx: Awaited<ReturnType<typeof getTestContext>>;
let docPath: DrivePath;
let deckPath: DrivePath;
let hatchedDeckPath: DrivePath;

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
    seedDeckDoc(deckCollab.doc, buildGoldenDeckScene());
    const deck = await home.drive.resolveFile(mountId, deckPath.id);
    await seedDocumentMedia(deck.mount, deck.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);

    // The same deck with its title box hatched, a fill a pptx draws solid.
    hatchedDeckPath = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${root.id}/create/slides`,
        { fileName: 'Hatched Deck' },
    );
    const hatched = buildGoldenDeckScene();
    const fill = serializeFill({ type: 'solid', color: '#ff0000', style: 'hachure' });
    hatched.elements = hatched.elements.map((element) =>
        element.id === 'el-1' && element.type === 'richtext' ? { ...element, fill } : element,
    );
    seedDeckDoc((await home.drive.getCollabDocument(mountId, hatchedDeckPath.id)).doc, hatched);
    const hatchedDeck = await home.drive.resolveFile(mountId, hatchedDeckPath.id);
    await seedDocumentMedia(hatchedDeck.mount, hatchedDeck.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
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
        expect(res.headers.get('content-security-policy')).toBe(EXPORT_CSP);

        const html = await res.text();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`);
        // The document <title> carries the UNstripped container name — frozen output,
        // not a bug to fix while moving the transform off-thread.
        expect(html).toContain('<title>Doc Contract.eigendoc</title>');
        // Full document, not the budgeted preview: blocks past the 20-block cap render,
        // media embeds as a data URI, and hostile fixture content stays sanitized.
        expect(html).toContain(GOLDEN_BEYOND_CAP);
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).not.toMatch(/<script/i);
    }, 120_000);

    test('docx export serves a zip workbook with the wordprocessing content type', async () => {
        const res = await exportRequest(docPath.id, 'docx');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Doc Contract.docx"');
        expect(res.headers.get('content-security-policy')).toBe(EXPORT_CSP);
        const buffer = Buffer.from(await res.arrayBuffer());
        expect(buffer.subarray(0, 2).toString()).toBe('PK');
        // Unlike the HTML <title>, the docx document property carries the STRIPPED
        // container name — frozen output, and the conversion now runs in the Worker.
        const core = new TextDecoder().decode(openZip(buffer).read('docProps/core.xml'));
        expect(core).toContain('<dc:title>Doc Contract</dc:title>');
    }, 120_000);

    test.each(['xlsx', 'pptx'])(
        'an unsupported format, %s, is rejected with 400',
        async (format) => {
            const res = await exportRequest(docPath.id, format);
            expect(res.status).toBe(400);
            expect(await res.text()).toContain('not supported');
        },
        60_000,
    );
});

describe('Eigenslides export route — response contract', () => {
    test('html export serves a standalone deck as an attachment', async () => {
        const res = await exportRequest(deckPath.id, 'html');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Deck Contract.html"');
        expect(res.headers.get('content-security-policy')).toBe(EXPORT_CSP);

        const html = await res.text();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`);
        expect(html).toContain('<title>Deck Contract</title>');
        // Every slide renders (no 8-slide preview cap), media embeds as a data URI,
        // and the injected script never survives into the download.
        expect(html).toContain(GOLDEN_BEYOND_CAP);
        expect(html).toContain('data:image/png;base64,');
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('<div class="deck">');
    }, 120_000);

    test('pptx export serves a presentation with the presentationml content type', async () => {
        const res = await exportRequest(deckPath.id, 'pptx');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        );
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Deck Contract.pptx"');
        expect(res.headers.get('content-security-policy')).toBe(EXPORT_CSP);
        const zip = openZip(Buffer.from(await res.arrayBuffer()));
        expect(new TextDecoder().decode(zip.read('docProps/core.xml'))).toContain('<dc:title>Deck Contract</dc:title>');
        // Every slide, the ones past the preview's cap too, and the picture as a PNG from its source.
        expect(zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(10);
        expect(
            Buffer.from(zip.read('ppt/media/image1.png') ?? [])
                .subarray(1, 4)
                .toString(),
        ).toBe('PNG');
        // A deck the pptx holds whole says nothing about losses.
        expect(res.headers.get(EXPORT_SUMMARY_HEADER)).toBeNull();
    }, 120_000);

    test('a pptx that draws a fill simpler says so in its summary header', async () => {
        const res = await exportRequest(hatchedDeckPath.id, 'pptx');
        expect(res.status).toBe(200);
        expect(decodeURIComponent(res.headers.get(EXPORT_SUMMARY_HEADER) ?? '')).toBe('1 fill was simplified.');
    }, 120_000);

    test('an unsupported format is rejected with 400', async () => {
        const res = await exportRequest(deckPath.id, 'docx');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    }, 60_000);
});

describe('Export route — a plain file wearing an eigen mime', () => {
    // mimeType is caller-controlled on upload (the multipart part's Content-Type lands in the
    // row verbatim), so the container TYPE is what routes an export. A plain file that claims
    // an eigen mime has no data.db to render and must be refused, not handed to a Worker.
    test('is refused with 400 rather than entering the collab export', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const spoofed = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            root.id,
            new File(['not a container'], 'spoof-vector.txt', { type: 'application/eigenvector' }),
        );
        expect(spoofed.type).toBe('file');

        const res = await exportRequest(spoofed.id, 'pdf');
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

    // MathJax and the font ranges it loads per character run in the Worker, and WeasyPrint draws the SVG as paths: a PDF
    // of text alone holds no curve.
    test('an equation prints as the paths MathJax draws of it', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const path = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'Doc Equation' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, path.id);
        const row: MathRow = [
            { kind: 'identifier', text: 'Q', variant: 'bold-fraktur' },
            { kind: 'operator', text: '⟹' },
            { kind: 'nary', operator: '∯', limits: 'under', body: [{ kind: 'identifier', text: 'ℵ' }] },
        ];
        seedEigendoc(collab.doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [equation(writeMathml(row, 'Q'), true)] }],
        });

        const res = await exportRequest(path.id, 'pdf');
        expect(res.status).toBe(200);
        const pdf = Buffer.from(await res.arrayBuffer());
        const text = pdf.toString('latin1');
        let curves = 0;
        for (const match of text.matchAll(/>>\s*stream\r?\n/g)) {
            const start = match.index + match[0].length;
            const content = inflateSync(pdf.subarray(start, text.indexOf('endstream', start))).toString('latin1');
            curves += content.match(/ c\n/g)?.length ?? 0;
        }
        expect(curves).toBeGreaterThan(20);
    }, 120_000);

    // A new doc or sheet showing one picture, printed to PDF: the filter of each image the PDF holds, and how many soft
    // masks carry an image's alpha.
    async function printedPicture(type: 'doc' | 'sheets', name: string, mimeType: string, bytes: Buffer) {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/${type}`,
            { fileName: `Printed ${type} ${name}` },
        );
        const home = await getHome(ctx.alice.user.id);
        const { doc } = await home.drive.getCollabDocument(mountId, created.id);
        if (type === 'doc') {
            const figure = { type: 'figure', attrs: { mediaName: name, width: 320 } };
            seedEigendoc(doc, { type: 'doc', content: [{ type: 'paragraph', content: [figure] }] });
        } else {
            const image = { id: 'picture', index: 'a0', x: 10, y: 10, width: 320, height: 200, mediaName: name };
            writeSheetsToYjs(doc, [{ name: 'One', celldata: [], images: { picture: image } }], { computed: false });
        }
        const { mount, path } = await home.drive.resolveFile(mountId, created.id);
        await seedDocumentMedia(mount, path, name, bytes, mimeType);
        const res = await exportRequest(created.id, 'pdf');
        expect(res.status).toBe(200);
        const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
        const images = [...pdf.matchAll(/\/Subtype \/Image(.*?)>>\s*stream/gs)].map(([, image]) => image);
        const filterOf = (image: string) => image.match(/\/Filter \/(\w+)/)?.[1];
        return {
            images: images.filter((image) => !image.includes('/DeviceGray')).map(filterOf),
            masks: images.filter((image) => image.includes('/DeviceGray')).length,
        };
    }

    // A gradient, so the picture is no flat colour an encoder could shrink to nothing.
    function gradient(channels: 3 | 4): Sharp {
        const pixels = Buffer.alloc(600 * 400 * channels);
        for (let i = 0; i < 600 * 400; i++)
            pixels.set([i % 256, (i * 7) % 256, (i * 13) % 256, 128].slice(0, channels), i * channels);
        return sharp(pixels, { raw: { width: 600, height: 400, channels } });
    }

    // WeasyPrint embeds a JPEG's own bytes under DCTDecode and decodes nothing. Any other raster, a WebP among them, it
    // decodes and writes again as a Flate stream, 40 times the CPU for a photo.
    test.each([
        ['doc', 'doc'],
        ['sheet', 'sheets'],
    ] as const)(
        'a photo in a %s prints as the JPEG WeasyPrint embeds as it is',
        async (_, type) => {
            const printed = await printedPicture(type, 'photo.jpg', 'image/jpeg', await gradient(3).jpeg().toBuffer());
            expect(printed).toEqual({ images: ['DCTDecode'], masks: 0 });
        },
        120_000,
    );

    // JPEG has no alpha, so a lossy WebP with one prints as a PNG, its alpha a soft mask beside it.
    test('a picture with alpha prints as a PNG, its alpha a soft mask', async () => {
        const printed = await printedPicture('doc', 'clear.webp', 'image/webp', await gradient(4).webp().toBuffer());
        expect(printed).toEqual({ images: ['FlateDecode'], masks: 1 });
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
