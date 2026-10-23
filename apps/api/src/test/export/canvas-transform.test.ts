import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import type { SlideSize } from '@workspace/lib/vector';
import * as Y from 'yjs';
import type { DocumentExportFormat } from '../../lib/document/transform/protocol';
import type { CanvasPage } from '../../lib/export/canvas/render';
import { canvasHtmlDocument, renderEigenslidesHtml } from '../../lib/export/canvas/transform';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { buildGoldenDeckScene, seedDeckDoc } from '../fixtures/golden-documents';

// The standalone HTML document a canvas export leaves through. The screen document must fit a
// fixed-size page to whatever viewport opens it; the PDF document must not, because WeasyPrint
// gives every page a sheet of its own.
const FRAME_PAGE: CanvasPage = { width: 1920, height: 1080, originX: 0, originY: 0, background: null, layers: [] };

function deckHtml(mode: 'screen' | 'pdf'): string {
    return canvasHtmlDocument(
        mode === 'pdf'
            ? { title: 'Deck', pages: [FRAME_PAGE], mode }
            : { title: 'Deck', pages: [FRAME_PAGE], scale: 0.5, mode },
    );
}

describe('canvasHtmlDocument', () => {
    test('a screen page rides in the shared fit box, sized from its own composed box', () => {
        const html = deckHtml('screen');
        expect(html).toContain('<div class="page-fit" style="--page-w:960px;--page-ar:960/540">');
        expect(html).toContain('transform: scale(calc(100cqw / var(--page-w)));');
    });

    test('a fallback ladder step scales from the NARROW end of its range, so a page never clips', () => {
        // `max-width: 960px` still applies at 769px — one past the next breakpoint down — so the step
        // is sized 769 - 64 (the body's own padding) over 960, rounded down.
        expect(deckHtml('screen')).toContain(
            '@media (max-width: 960px) {\n    .page-fit > .canvas-page { transform: scale(0.734); }',
        );
    });

    test('the last ladder step is sized for the narrowest viewport, not for its own breakpoint', () => {
        // The bottom step has no lower neighbor: it applies at every width below 360, so sizing it
        // for 360 leaves a 320px phone with a page wider than its content box, cropped by .page-fit.
        expect(deckHtml('screen')).toContain(
            '@media (max-width: 360px) {\n    .page-fit > .canvas-page { transform: scale(0.266); }',
        );
    });

    // htmlToPdf's zoom scales the page onto the sheet: WeasyPrint drops a translucent layer whose parent
    // is scaled wherever the scale moves it.
    test('the PDF document has no fit box, and its sheet is the page at 1:1', () => {
        const html = deckHtml('pdf');
        expect(html).not.toContain('page-fit');
        expect(html).not.toContain('transform:scale');
        expect(html).toContain('@page { size: 1920px 1080px; margin: 0; }');
    });

    test('a PDF page sized from far-out artwork is capped at the PDF page limit', () => {
        const page: CanvasPage = { ...FRAME_PAGE, width: 1e9, height: 30_000 };
        const html = canvasHtmlDocument({ title: 'Drawing', pages: [page], mode: 'pdf' });
        expect(html).toContain('@page { size: 19200px 19200px; margin: 0; }');
    });
});

// A rich-text box is a schemaless collaborator string, and a <style> element in it is document-wide
// CSS in whatever embeds the body — the downloaded .html and the sheet WeasyPrint prints.
async function deckExportHtml(
    format: DocumentExportFormat,
    html: string,
    slideSize: SlideSize = '16:9',
): Promise<string> {
    return new TextDecoder().decode((await deckExport(format, html, slideSize)).data);
}

function deckExport(format: DocumentExportFormat, html: string, slideSize: SlideSize, slideWidth = 720) {
    const scene = buildGoldenDeckScene();
    const doc = new Y.Doc();
    seedDeckDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => ('html' in el ? { ...el, html } : el)),
        meta: { ...scene.meta, slideSize, slideWidth },
    });
    return renderEigenslidesHtml(doc, format, 'Deck', async () => []);
}

describe('renderEigenslidesHtml', () => {
    test.each(['html', 'pdf-html'] as const)('drops a <style> block a rich-text box carries (%s)', async (format) => {
        const html = await deckExportHtml(format, '<style>*{display:none}</style><p>hi</p>');
        expect(html).not.toContain('display:none');
        expect(html).toContain('<p>hi</p>');
    });

    test('the html download opens a text box link in a new tab, as the canvas does', async () => {
        const link = '<p><a href="https://a.example/" target="_blank" rel="noopener noreferrer">a</a></p>';
        expect(await deckExportHtml('html', link)).toContain(link);
    });

    // The PDF document's sheet is the slide at 1:1, which htmlToPdf zooms to 960 px wide: 254 mm at 96 dpi,
    // so a 16:9 sheet is 254 x 142.875 mm and a 4:3 one 254 x 190.5 mm, Google's PDF sizes (canvas-pdf.test.ts
    // measures them). Every page of the download takes the deck's shape too.
    test.each([
        ['16:9', 540],
        ['4:3', 720],
    ] as const)('a %s deck prints on its own sheet, and the download pages follow', async (slideSize, height) => {
        expect(await deckExportHtml('pdf-html', '<p>hi</p>', slideSize)).toContain(
            `@page { size: 1920px ${height * 2}px; margin: 0; }`,
        );
        const screen = await deckExportHtml('html', '<p>hi</p>', slideSize);
        const pages = screen.match(/<div class="page-fit" style="[^"]*">/g) ?? [];
        expect(pages.length).toBe(buildGoldenDeckScene().frames.length);
        for (const page of pages) expect(page).toContain(`--page-ar:960/${height}`);
    });

    // A PowerPoint widescreen deck is 960 pt, 1280 px at 96 dpi, wide: the PDF's zoom and the download's pages follow it.
    test.each([
        [720, 0.5, 960],
        [960, 2 / 3, 1280],
    ])('a %s pt wide deck prints and shows at its own width', async (slideWidth, zoom, width) => {
        expect((await deckExport('pdf-html', '<p>hi</p>', '16:9', slideWidth)).zoom).toBe(zoom);
        const screen = new TextDecoder().decode((await deckExport('html', '<p>hi</p>', '16:9', slideWidth)).data);
        expect(screen).toContain(`--page-w:${width}px`);
    });

    test('keeps the embedded font faces the document needs', async () => {
        expect(await deckExportHtml('html', '<p>hi</p>')).toContain('@font-face');
    });
});

// Where WeasyPrint set each text run: the text matrix of every run in the PDF's page streams.
function textOrigins(pdf: Buffer): string[] {
    const text = pdf.toString('latin1');
    return [...text.matchAll(/stream\r?\n/g)].flatMap(({ index, 0: open }) => {
        const stream = pdf.subarray(index + open.length, text.indexOf('endstream', index + open.length));
        let content: string;
        try {
            content = inflateSync(stream).toString('latin1');
        } catch {
            return [];
        }
        return [...content.matchAll(/(?:-?[\d.]+ ){6}Tm/g)].map(([matrix]) => matrix);
    });
}

const weasyprint = (await isWeasyPrintAvailable()) ? describe : describe.skip;

// The editor shows an empty paragraph one line tall because ProseMirror gives it a trailing <br>; the
// stored html has none, so the print must lay out `<p></p>` as the editor lays out `<p><br></p>`.
weasyprint('renderEigenslidesHtml — an empty paragraph prints a line (WeasyPrint)', () => {
    const printed = async (html: string) => textOrigins(await htmlToPdf(await deckExportHtml('pdf-html', html)));

    test.each([
        ['a paragraph', '<p>a</p><p></p><p>b</p>', '<p>a</p><p><br></p><p>b</p>'],
        [
            'a list item',
            '<ul><li><p>a</p></li><li><p></p></li><li><p>b</p></li></ul>',
            '<ul><li><p>a</p></li><li><p><br></p></li><li><p>b</p></li></ul>',
        ],
    ])(
        '%s',
        async (_, stored, editor) => {
            const [origins, expected] = await Promise.all([printed(stored), printed(editor)]);
            expect(expected.length).toBeGreaterThan(0);
            expect(origins).toEqual(expected);
        },
        60_000,
    );
});
