import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { restoreYjsDoc } from '../../../core/collab/yjs-utils';
import type { PageSetup } from '../../../docs/eigendoc';
import {
    cmText,
    DEFAULT_PAGE_SETUP,
    MIN_TEXT_MM,
    matchPaperSize,
    mmToPx,
    PAGE_ROOT,
    PAPER_SIZES,
    pageBoxStyle,
    pagePx,
    pageRecord,
    pageStylesheet,
    pageTwips,
    pxToMm,
    readCm,
    readPageSetup,
} from '../../../docs/eigendoc';
import { EIGEN_DOC_TYPE_INFO } from '../../../types/drive';

// Landscape A4 with four different margins, so no derivation can hide a hard-coded value or a swapped side.
const LANDSCAPE: PageSetup = {
    width: 297,
    height: 210,
    margin: { top: 10, right: 15, bottom: 25, left: 30 },
    headerDistance: 8,
    footerDistance: 12.7,
    differentFirstPage: true,
};

describe('page setup', () => {
    test('the default page is A4 with 2 cm margins and one header and footer for every page, 1.27 cm from its edge', () => {
        expect(DEFAULT_PAGE_SETUP).toEqual({
            width: 210,
            height: 297,
            margin: { top: 20, right: 20, bottom: 20, left: 20 },
            headerDistance: 12.7,
            footerDistance: 12.7,
            differentFirstPage: false,
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
            headerDistance: 720,
            footerDistance: 720,
            differentFirstPage: false,
        });
        expect(pageTwips(LANDSCAPE)).toEqual({
            width: 16838,
            height: 11906,
            margin: { top: 567, right: 850, bottom: 1417, left: 1701 },
            headerDistance: 454,
            footerDistance: 720,
            differentFirstPage: true,
        });
    });

    test("the paper sizes are Google's eleven, in Google's order, portrait, in mm", () => {
        expect(PAPER_SIZES.map(({ name, width, height }) => [name, width, height])).toEqual([
            ['Letter', 215.9, 279.4],
            ['Tabloid', 279.4, 431.8],
            ['Legal', 215.9, 355.6],
            ['Statement', 139.7, 215.9],
            ['Executive', 184.15, 266.7],
            ['Folio', 215.9, 330.2],
            ['A3', 297, 420],
            ['A4', 210, 297],
            ['A5', 148, 210],
            ['B4', 250, 353],
            ['B5', 176, 250],
        ]);
        expect(matchPaperSize(DEFAULT_PAGE_SETUP)).toBe('A4');
    });

    test('a page matches its paper within 1 mm, either way round, and a custom size matches none', () => {
        const page = (width: number, height: number): PageSetup => ({ ...DEFAULT_PAGE_SETUP, width, height });
        expect(matchPaperSize(page(215.9, 279.4))).toBe('Letter');
        expect(matchPaperSize(LANDSCAPE)).toBe('A4');
        // Word stores Letter as 12240 × 15840 twips, A4 as 11906 × 16838: neither is exact in mm.
        expect(matchPaperSize(page(215.9 + 0.9, 279.4 - 0.9))).toBe('Letter');
        expect(matchPaperSize(page(210.02, 297.04))).toBe('A4');
        expect(matchPaperSize(page(211.1, 297))).toBeUndefined();
        expect(matchPaperSize(page(148, 105))).toBeUndefined();
    });
});

describe('the stored page', () => {
    test('pageRecord writes one key per field, in mm, and readPageSetup reads it back unchanged', () => {
        expect(pageRecord(LANDSCAPE)).toEqual({
            width: 297,
            height: 210,
            marginTop: 10,
            marginRight: 15,
            marginBottom: 25,
            marginLeft: 30,
            headerDistance: 8,
            footerDistance: 12.7,
            differentFirstPage: true,
        });
        expect(readPageSetup(pageRecord(LANDSCAPE))).toEqual(LANDSCAPE);
        const letter: PageSetup = {
            width: 215.9,
            height: 279.4,
            margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
            headerDistance: 15,
            footerDistance: 25.4,
            differentFirstPage: false,
        };
        expect(readPageSetup(pageRecord(letter))).toEqual(letter);
    });

    test('a missing, non-number or non-finite key reads as the default', () => {
        expect(readPageSetup({})).toEqual(DEFAULT_PAGE_SETUP);
        expect(readPageSetup({ width: 215.9, height: 279.4 })).toEqual({
            ...DEFAULT_PAGE_SETUP,
            width: 215.9,
            height: 279.4,
        });
        expect(
            readPageSetup({
                width: '300',
                height: Number.NaN,
                marginTop: Number.POSITIVE_INFINITY,
                marginRight: null,
                marginBottom: true,
                marginLeft: { mm: 5 },
            }),
        ).toEqual(DEFAULT_PAGE_SETUP);
    });

    // Any peer writes the map, so only a stored true turns it on.
    test('differentFirstPage reads as true only when it is stored as true', () => {
        for (const stored of [undefined, false, 'true', 1, null, {}]) {
            expect(readPageSetup({ differentFirstPage: stored }).differentFirstPage).toBe(false);
        }
        expect(readPageSetup({ differentFirstPage: true }).differentFirstPage).toBe(true);
    });

    test("the paper is kept between 5 cm and 55.88 cm, Word's 22 inches", () => {
        expect(readPageSetup({ width: 1e9, height: 1, marginTop: 0, marginBottom: 0 })).toMatchObject({
            width: 558.8,
            height: 50,
        });
        expect(readPageSetup({ width: -1e9, height: 1e9 })).toMatchObject({ width: 50, height: 558.8 });
    });

    // Word's Header from top and Footer from bottom. A band never sits in the body's column, nor past the paper's edge.
    test('a header and a footer sit their distance from the edge, held between the edge and their margin', () => {
        expect(readPageSetup({ headerDistance: 5, footerDistance: 15 })).toMatchObject({
            headerDistance: 5,
            footerDistance: 15,
        });
        expect(readPageSetup({ marginTop: 10, headerDistance: 15, footerDistance: -3 })).toMatchObject({
            headerDistance: 10,
            footerDistance: 0,
        });
        // A missing one is Word's and Google's 1.27 cm, within a narrower margin too.
        expect(readPageSetup({ marginBottom: 8, headerDistance: '9' })).toMatchObject({
            headerDistance: 12.7,
            footerDistance: 8,
        });
        // Within the margin as it reads, shrunk to leave the text its room.
        const shrunk = readPageSetup({ height: 50, marginTop: 30, marginBottom: 30, headerDistance: 20 });
        expect(shrunk.headerDistance).toBe(shrunk.margin.top);
    });

    test('a negative margin reads as its size', () => {
        expect(readPageSetup({ marginTop: -15, marginLeft: -5 }).margin).toEqual({
            top: 15,
            right: 20,
            bottom: 20,
            left: 5,
        });
    });

    test('margins that leave less than the minimum text shrink in proportion, never reset', () => {
        expect(MIN_TEXT_MM).toBe(25);
        // A 20 cm top margin on A5 (14.8 × 21 cm), and a 15 cm left one.
        const { width, height, margin } = readPageSetup({
            width: 148,
            height: 210,
            marginTop: 200,
            marginBottom: 20,
            marginLeft: 150,
            marginRight: 50,
        });
        expect(height - margin.top - margin.bottom).toBeCloseTo(MIN_TEXT_MM, 9);
        expect(margin.top / margin.bottom).toBeCloseTo(10, 9);
        expect(width - margin.left - margin.right).toBeCloseTo(MIN_TEXT_MM, 9);
        expect(margin.left / margin.right).toBeCloseTo(3, 9);
        // A 1e9 margin on 1e9 paper: the paper clamps first, then the margins fit it.
        const huge = readPageSetup({ width: 1e9, marginLeft: 1e9, marginRight: 1e9 });
        expect(huge.width - huge.margin.left - huge.margin.right).toBeCloseTo(MIN_TEXT_MM, 9);
    });

    test('a page read back reads the same again, however far its margins shrank', () => {
        const lengths = [...PAPER_SIZES.flatMap(({ width, height }) => [width, height]), 50, 123.456, 558.8];
        const margins = [0, 0.1, 12.7, 19.05, 40.9, 151.3, 200, 1e9];
        for (const width of lengths) {
            for (const marginLeft of margins) {
                for (const marginRight of margins) {
                    const once = readPageSetup({
                        width,
                        height: width,
                        marginLeft,
                        marginRight,
                        marginTop: marginRight,
                    });
                    expect(readPageSetup(pageRecord(once))).toEqual(once);
                }
            }
        }
    });

    test('a landscape page is stored as a width above its height', () => {
        expect(readPageSetup({ width: 297, height: 210 })).toMatchObject({ width: 297, height: 210 });
        expect(readPageSetup({ width: 279.4, height: 215.9 })).toMatchObject({ width: 279.4, height: 215.9 });
    });

    test('restoring a version from before the page root restores the default page', () => {
        const old = new Y.Doc();
        old.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);

        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(old));
        const page = live.getMap(PAGE_ROOT);
        for (const [key, value] of Object.entries(pageRecord(LANDSCAPE))) page.set(key, value);
        expect(readPageSetup(page.toJSON())).toEqual(LANDSCAPE);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(old), EIGEN_DOC_TYPE_INFO.doc.yjsRoots);
        expect(readPageSetup(live.getMap(PAGE_ROOT).toJSON())).toEqual(DEFAULT_PAGE_SETUP);
        expect(live.getXmlFragment('default').length).toBe(1);
    });
});

describe('cm fields', () => {
    test('2.54 cm is 96 px, both ways, unrounded', () => {
        expect(mmToPx(25.4)).toBe(96);
        expect(pxToMm(96)).toBe(25.4);
        expect(mmToPx(10)).toBeCloseTo(37.7952756, 6);
        expect(pxToMm(300)).toBeCloseTo(79.375, 9);
    });

    test('cmText rounds mm to the given cm decimals and drops trailing zeros', () => {
        expect(cmText(pxToMm(300), 1)).toBe('7.9');
        expect(cmText(pxToMm(96), 1)).toBe('2.5');
        expect(cmText(100, 1)).toBe('10');
        expect(cmText(20, 2)).toBe('2');
        // Google shows 0.75 in as 1.91 cm.
        expect(cmText(19.05, 2)).toBe('1.91');
        expect(cmText(19.05, 1)).toBe('1.9');
    });

    test('readCm is the typed cm in mm, to 0.01 mm, and NaN for no number', () => {
        expect(readCm('1.91')).toBe(19.1);
        expect(readCm(' 7.5 ')).toBe(75);
        expect(readCm('2.54')).toBe(25.4);
        expect(readCm('')).toBeNaN();
        expect(readCm('  ')).toBeNaN();
        expect(readCm('abc')).toBeNaN();
        // A number field's value never holds a comma, so none is read as a decimal point.
        expect(readCm('7,5')).toBeNaN();
    });

    test('a width shown in cm and typed back lands within a px of where it was', () => {
        for (const px of [100, 200, 300, 333, 600]) {
            expect(Math.abs(mmToPx(readCm(cmText(pxToMm(px), 1))) - px)).toBeLessThan(2);
        }
    });
});
