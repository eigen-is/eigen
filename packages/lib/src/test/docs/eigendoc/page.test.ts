import { describe, expect, test } from 'bun:test';
import type { PageSetup } from '../../../docs/eigendoc';
import { DEFAULT_PAGE_SETUP, pageBoxStyle, pagePx, pageStylesheet, pageTwips } from '../../../docs/eigendoc';

// Landscape A4 with four different margins, so no derivation can hide a hard-coded value or a swapped side.
const LANDSCAPE: PageSetup = { width: 297, height: 210, margin: { top: 10, right: 15, bottom: 25, left: 30 } };

describe('page setup', () => {
    test('the default page is A4 with 2 cm margins', () => {
        expect(DEFAULT_PAGE_SETUP).toEqual({
            width: 210,
            height: 297,
            margin: { top: 20, right: 20, bottom: 20, left: 20 },
        });
    });

    test('pagePx is CSS px at 96 dpi, unrounded', () => {
        const px = pagePx(DEFAULT_PAGE_SETUP);
        expect(px.width).toBeCloseTo(793.7007874, 6);
        expect(px.height).toBeCloseTo(1122.519685, 6);
        for (const side of Object.values(px.margin)) expect(side).toBeCloseTo(75.5905512, 6);

        const landscape = pagePx(LANDSCAPE);
        expect(landscape.width).toBeCloseTo(1122.519685, 6);
        expect(landscape.height).toBeCloseTo(793.7007874, 6);
        expect(landscape.margin.top).toBeCloseTo(37.7952756, 6);
        expect(landscape.margin.right).toBeCloseTo(56.6929134, 6);
        expect(landscape.margin.bottom).toBeCloseTo(94.488189, 6);
        expect(landscape.margin.left).toBeCloseTo(113.3858268, 6);
    });

    test('pageBoxStyle is the page width and its margins as padding, top right bottom left', () => {
        expect(pageBoxStyle(DEFAULT_PAGE_SETUP)).toEqual({ width: '210mm', padding: '20mm 20mm 20mm 20mm' });
        expect(pageBoxStyle(LANDSCAPE)).toEqual({ width: '297mm', padding: '10mm 15mm 25mm 30mm' });
    });

    test('pageStylesheet sizes the printed page, boxes the page on screen and leaves the margins to @page on paper', () => {
        expect(pageStylesheet(DEFAULT_PAGE_SETUP, '[data-document]')).toBe(
            [
                '@page { size: 210mm 297mm; margin: 20mm 20mm 20mm 20mm; }',
                '[data-document] { width: 210mm; padding: 20mm 20mm 20mm 20mm; }',
                '@media print { [data-document] { padding: 0; width: auto; } }',
            ].join('\n'),
        );
        expect(pageStylesheet(LANDSCAPE, '.page')).toBe(
            [
                '@page { size: 297mm 210mm; margin: 10mm 15mm 25mm 30mm; }',
                '.page { width: 297mm; padding: 10mm 15mm 25mm 30mm; }',
                '@media print { .page { padding: 0; width: auto; } }',
            ].join('\n'),
        );
    });

    test('pageTwips is whole twips', () => {
        expect(pageTwips(DEFAULT_PAGE_SETUP)).toEqual({
            width: 11906,
            height: 16838,
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
        });
        expect(pageTwips(LANDSCAPE)).toEqual({
            width: 16838,
            height: 11906,
            margin: { top: 567, right: 850, bottom: 1417, left: 1701 },
        });
    });
});
