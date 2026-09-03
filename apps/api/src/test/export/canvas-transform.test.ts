import { describe, expect, test } from 'bun:test';
import type { CanvasPage } from '../../lib/export/canvas/render';
import { canvasHtmlDocument } from '../../lib/export/canvas/transform';

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

    test('the PDF document has no fit box, and its sheet is the composed page', () => {
        const html = deckHtml('pdf');
        expect(html).not.toContain('page-fit');
        expect(html).toContain('@page { size: 960px 540px; margin: 0; }');
    });
});
