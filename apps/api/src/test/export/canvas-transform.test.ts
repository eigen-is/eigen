import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { DocumentExportFormat } from '../../lib/document/transform/protocol';
import type { CanvasPage } from '../../lib/export/canvas/render';
import { canvasHtmlDocument, renderEigenslidesExport } from '../../lib/export/canvas/transform';
import { buildGoldenDeckScene, seedDeckDoc } from '../fixtures/golden-documents';

// The standalone HTML document a canvas export leaves through. The screen document must fit a
// fixed-size page to whatever viewport opens it; the PDF document must not, because WeasyPrint
// gives every page a sheet of its own.
const FRAME_PAGE: CanvasPage = { width: 1920, height: 1080, originX: 0, originY: 0, background: null, layers: [] };

function deckHtml(mode: 'screen' | 'pdf'): string {
    return canvasHtmlDocument({ title: 'Deck', pages: [FRAME_PAGE], scale: 0.5, mode });
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
        // The bottom step has no lower neighbour: it applies at every width below 360, so sizing it
        // for 360 leaves a 320px phone with a page wider than its content box, cropped by .page-fit.
        expect(deckHtml('screen')).toContain(
            '@media (max-width: 360px) {\n    .page-fit > .canvas-page { transform: scale(0.266); }',
        );
    });

    test('the PDF document has no fit box, and its sheet is the composed page', () => {
        const html = deckHtml('pdf');
        expect(html).not.toContain('page-fit');
        expect(html).toContain('@page { size: 960px 540px; margin: 0; }');
    });
});

// A rich-text box is a schemaless collaborator string, and a <style> element in it is document-wide
// CSS in whatever embeds the body — the downloaded .html and the sheet WeasyPrint prints.
function deckExportHtml(format: DocumentExportFormat, html: string): string {
    const scene = buildGoldenDeckScene();
    const doc = new Y.Doc();
    seedDeckDoc(doc, {
        ...scene,
        elements: scene.elements.map((el) => ('html' in el ? { ...el, html } : el)),
    });
    return new TextDecoder().decode(renderEigenslidesExport(doc, format, 'Deck', []).data);
}

describe('renderEigenslidesExport', () => {
    test.each(['html', 'pdf-html'] as const)('drops a <style> block a rich-text box carries (%s)', (format) => {
        const html = deckExportHtml(format, '<style>*{display:none}</style><p>hi</p>');
        expect(html).not.toContain('display:none');
        expect(html).toContain('<p>hi</p>');
    });

    test('keeps the embedded font faces the document needs', () => {
        expect(deckExportHtml('html', '<p>hi</p>')).toContain('@font-face');
    });
});
