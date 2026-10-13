import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { restoreYjsDoc } from '../../../core/collab/yjs-utils';
import type { PageSetup } from '../../../docs/eigendoc';
import {
    DEFAULT_PAGE_SETUP,
    MIN_TEXT_MM,
    matchPaperSize,
    PAGE_ROOT,
    PAPER_SIZES,
    pageBoxStyle,
    pagePx,
    pageRecord,
    pageStylesheet,
    pageTwips,
    readPageSetup,
} from '../../../docs/eigendoc';
import { EIGEN_DOC_TYPE_INFO } from '../../../types/drive';

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
        });
        expect(readPageSetup(pageRecord(LANDSCAPE))).toEqual(LANDSCAPE);
        const letter: PageSetup = {
            width: 215.9,
            height: 279.4,
            margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
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

    test("the paper is kept between 5 cm and 55.88 cm, Word's 22 inches", () => {
        expect(readPageSetup({ width: 1e9, height: 1, marginTop: 0, marginBottom: 0 })).toMatchObject({
            width: 558.8,
            height: 50,
        });
        expect(readPageSetup({ width: -1e9, height: 1e9 })).toMatchObject({ width: 50, height: 558.8 });
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
