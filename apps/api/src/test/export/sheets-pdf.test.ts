import { describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import { sheetsHtmlDocument } from '../../lib/export/sheets/render';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import type { Raster } from '../pdf-test-helpers';
import { pixelAt, rasterize, rasterizer } from '../pdf-test-helpers';
import { NO_MEDIA } from '../setup';

// The page margin the export sets, in CSS px, and the points a CSS px prints at.
const MARGIN = 40;
const PT_PER_PX = 0.75;

// The box, in points, around every pixel that is not white.
function inkBox(page: Raster): { minX: number; minY: number; maxX: number; maxY: number } {
    const box = { minX: page.width, minY: page.height, maxX: -1, maxY: -1 };
    for (let y = 0; y < page.height; y++) {
        for (let x = 0; x < page.width; x++) {
            if (pixelAt(page, x, y).every((channel) => channel > 230)) continue;
            box.minX = Math.min(box.minX, x);
            box.minY = Math.min(box.minY, y);
            box.maxX = Math.max(box.maxX, x);
            box.maxY = Math.max(box.maxY, y);
        }
    }
    return box;
}

// CI installs neither WeasyPrint nor a rasterizer, so this suite runs only where both are on the machine.
const suite = (await isWeasyPrintAvailable()) && rasterizer ? describe : describe.skip;

suite('sheets PDF — a rotated chart', () => {
    // WeasyPrint draws a CSS rotate about the box's center, as the editor does: a 480 × 240 chart at 90° prints 240 wide
    // and 480 tall about the center of the box it stores, (340, 420).
    test('prints turned about the center of its stored box, on a page that holds it', async () => {
        const chart = { id: 'c1', index: 'a0', x: 100, y: 300, width: 480, height: 240, angle: 90 };
        const sheet: Sheet = {
            name: 'Chart',
            id: 's1',
            charts: { c1: { ...chart, ...newSheetChartSpecParts(sampleChartSpec('column')) } },
        };
        const html = sheetsHtmlDocument({ title: 'Chart', sheets: [sheet], mediaUrls: NO_MEDIA, mode: 'pdf' });
        const page = await rasterize(await htmlToPdf(html));
        const ink = inkBox(page);
        const pt = (px: number) => (MARGIN + px) * PT_PER_PX;
        const turned = { minX: pt(220), minY: pt(180), maxX: pt(460), maxY: pt(660) };
        expect(ink.maxY - ink.minY).toBeGreaterThan(1.5 * (ink.maxX - ink.minX));
        expect(ink.minX).toBeGreaterThanOrEqual(turned.minX - 2);
        expect(ink.maxX).toBeLessThanOrEqual(turned.maxX + 2);
        expect(ink.minY).toBeGreaterThanOrEqual(turned.minY - 2);
        expect(ink.maxY).toBeLessThanOrEqual(turned.maxY + 2);
        expect(page.height).toBeGreaterThan(turned.maxY);
    });
});
