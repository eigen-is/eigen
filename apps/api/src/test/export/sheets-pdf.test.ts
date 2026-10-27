import { beforeAll, describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import { sheetsHtmlDocument } from '../../lib/export/sheets/render';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import type { Raster } from '../pdf-test-helpers';
import { pageCount, pixelAt, rasterize, rasterizer } from '../pdf-test-helpers';
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

// CI installs neither WeasyPrint nor a rasterizer, so these suites run only where they are on the machine.
const weasyPrint = await isWeasyPrintAvailable();
const suite = weasyPrint && rasterizer ? describe : describe.skip;

(weasyPrint ? describe : describe.skip)('sheets PDF — rows print at their stored height', () => {
    const pdfOf = async (sheet: Sheet) => {
        const html = sheetsHtmlDocument({
            title: 'Rows',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
        return pageCount(await htmlToPdf(html));
    };

    // The editor clips a cell to its row, so a row as tall as its text would print pages the cap never charged.
    test('a wrapped cell of 600 lines prints on the one page its row takes', async () => {
        const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
        const sheet: Sheet = { name: 'Tall', id: 's1', celldata: [{ r: 0, c: 0, v: { v: text, m: text, tb: '2' } }] };
        expect(await pdfOf(sheet)).toBe(1);
    });

    test('a font too large for its row prints the row at its stored height', async () => {
        const celldata = Array.from({ length: 200 }, (_, r) => ({ r, c: 0, v: { v: 'X', m: 'X', fs: 409 } }));
        expect(await pdfOf({ name: 'Large', id: 's1', celldata })).toBe(1);
    });

    // 956 rows of 20 px fill the 19,120 px a page prints, so 2,000 rows take three pages, wrapped or not.
    test('2,000 rows of wrapped text print on the pages their stored heights pack into', async () => {
        const text = 'one\ntwo\nthree';
        const celldata = Array.from({ length: 2_000 }, (_, r) => ({ r, c: 0, v: { v: text, m: text, tb: '2' } }));
        expect(await pdfOf({ name: 'Rows', id: 's1', celldata })).toBe(3);
    }, 60_000);
});

// The rows, in points, that hold ink between two heights of the page.
function inkRows(page: Raster, from: number, to: number): { top: number; bottom: number } {
    const rows = { top: to, bottom: from - 1 };
    for (let y = Math.ceil(from); y < to; y++) {
        for (let x = 0; x < page.width; x++) {
            if (pixelAt(page, x, y).every((channel) => channel > 230)) continue;
            rows.top = Math.min(rows.top, y);
            rows.bottom = Math.max(rows.bottom, y);
            break;
        }
    }
    return rows;
}

suite('sheets PDF — a cell draws its text as the editor does', () => {
    // Each text prints twice: in a default row of 20 px, then wrapped on one line in a row of 60 px that nothing can cut,
    // where it is clipped as a 12 pt line in a default row is. The editor draws all of these whole in the default row, so
    // the PDF must too: the default row's ink is as tall as the tall row's.
    const texts = [
        { v: 'gjpqy Ag', fs: 10 },
        { v: 'gjpqy Ag', fs: 12 },
        { v: 'gjpqy Ag', fs: 14 },
        { v: 'under 12', fs: 12, un: 1 },
        { v: 'top gjpqy Ag', fs: 14, vt: 1 },
        { v: 'bottom gjpqy Ag', fs: 14, vt: 2 },
    ];
    const DEFAULT_ROW = 20;
    const TALL_ROW = 60;
    const tallFrom = texts.length * DEFAULT_ROW;
    const rowTop = (i: number) => (i < texts.length ? i * DEFAULT_ROW : tallFrom + (i - texts.length) * TALL_ROW);
    const rowHeight = (i: number) => (i < texts.length ? DEFAULT_ROW : TALL_ROW);
    let page: Raster;
    const band = (i: number) => {
        const pt = (px: number) => (MARGIN + px) * PT_PER_PX;
        const ink = inkRows(page, pt(rowTop(i)), pt(rowTop(i) + rowHeight(i)));
        return { ...ink, rowTop: pt(rowTop(i)), rowBottom: pt(rowTop(i) + rowHeight(i)) };
    };

    beforeAll(async () => {
        const wrapped = texts.map((text) => ({ ...text, tb: '2' }));
        const celldata = [...texts, ...wrapped].map((text, r) => ({ r, c: 0, v: { ...text, m: text.v } }));
        const rowlen = Object.fromEntries(texts.map((_, i) => [texts.length + i, TALL_ROW]));
        const sheet: Sheet = {
            name: 'Look',
            id: 's1',
            celldata,
            showGridLines: 0,
            config: { rowlen, columnlen: { 0: 300 } },
        };
        const html = sheetsHtmlDocument({
            title: 'Look',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
        page = await rasterize(await htmlToPdf(html));
    }, 60_000);

    test('text the editor draws whole in a default row prints whole, descenders and underline included', () => {
        for (let i = 0; i < texts.length; i++) {
            const inRow = band(i);
            const whole = band(texts.length + i);
            expect(inRow.bottom - inRow.top).toBeGreaterThanOrEqual(whole.bottom - whole.top - 1);
        }
    });

    // The canvas centers the text's ink in the cell, and puts it 2 px from the top or the bottom. Clipped text sits
    // there too; a plain line sits where CSS puts it, its ink about 0.1em low.
    test('the ink sits where the canvas puts it: in the middle, or 2 px from the top or the bottom', () => {
        const middle = band(texts.length + 2);
        const offCenter = (middle.top + middle.bottom - middle.rowTop - middle.rowBottom) / 2;
        expect(Math.abs(offCenter)).toBeLessThanOrEqual(1);
        const top = band(texts.length + 4);
        expect(Math.abs(top.top - top.rowTop - 2 * PT_PER_PX)).toBeLessThanOrEqual(1);
        const bottom = band(texts.length + 5);
        expect(Math.abs(bottom.rowBottom - bottom.bottom - 2 * PT_PER_PX)).toBeLessThanOrEqual(1.5);
    });
});

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
        const html = sheetsHtmlDocument({
            title: 'Chart',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
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
