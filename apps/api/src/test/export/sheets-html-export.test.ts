import { describe, expect, test } from 'bun:test';
import {
    CHART_MAX_SIDE,
    DEFAULT_CHART_SERIES_STYLE,
    newSheetChartSpecParts,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type {
    Cell,
    CellBorderSides,
    ConditionalFormatRule,
    Sheet,
    SheetChart,
    SheetImage,
} from '@workspace/lib/sheets';

import {
    encodeSheetsSnapshot,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_FONT_SIZE,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '@workspace/lib/sheets';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { serializeFill } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { FONT_STACK_SANS } from '../../lib/document/font-stacks';
import { sanitizeExportHtml } from '../../lib/export/sanitize';
import {
    MAX_EXPORT_CELLS,
    PREVIEW_FLOATING_CELLS,
    PREVIEW_SHEET_BUDGET,
    renderSheetsHtml,
    renderSheetsPreviewHtml,
    sheetsHtmlDocument,
} from '../../lib/export/sheets/render';
import { renderEigensheetsExport } from '../../lib/export/sheets/transform';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import { rowsXml, xlsxFixture } from '../fixtures/xlsx';
import { NO_MEDIA } from '../setup';

// Build a Sheet with both `data` (matrix form, required by the CF engine) and `celldata`
// (sparse form, what the renderer iterates). The sheet Workbook keeps both
// projections in sync via its dataToCelldata/celldataToData transforms, so snapshots
// flushed by the FE editor carry both.
function makeSheet(cells: { r: number; c: number; v: Cell }[], rules?: ConditionalFormatRule[]): Sheet {
    const rows = cells.reduce((max, x) => Math.max(max, x.r), 0) + 1;
    const cols = cells.reduce((max, x) => Math.max(max, x.c), 0) + 1;
    const data: (Cell | null)[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    for (const { r, c, v } of cells) {
        data[r][c] = v;
    }
    return {
        name: 'Sheet1',
        celldata: cells.map(({ r, c, v }) => ({ r, c, v })),
        data,
        ...(rules ? { conditionalFormatRules: rules } : {}),
    };
}

type RenderOut = { html: string; css: string };

// Class names whose rule body contains the given declaration snippet.
function classesFor(out: RenderOut, snippet: string): string[] {
    const found: string[] = [];
    for (const m of out.css.matchAll(/\.(s\d+)\{([^}]*)\}/g)) {
        if (m[2].includes(snippet)) found.push(m[1]);
    }
    return found;
}

// How many elements reference the class in the rendered html.
function useCount(out: RenderOut, cls: string): number {
    return (out.html.match(new RegExp(`class="(?:sheet )?${cls}"`, 'g')) ?? []).length;
}

// A sheet's images as the editor stores them: a map by id, stacked in the order given.
function imagesOf(...images: Omit<SheetImage, 'index'>[]): Record<string, SheetImage> {
    return Object.fromEntries(images.map((image, i) => [image.id, { ...image, index: `a${i}` }]));
}

describe('Sheets HTML export — rich text', () => {
    test("a rich-text cell shows its runs' text", () => {
        const rich: Cell = { ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'Rich', bl: 1 }, { v: ' text' }] } };
        expect(renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: rich }])], NO_MEDIA, 'screen').html).toContain(
            '>Rich text<',
        );
    });
});

describe('Sheets HTML export — class-based styles', () => {
    test('emits zero inline style attributes; every style is a document class', () => {
        const sheet: Sheet = {
            ...makeSheet(
                [
                    { r: 0, c: 0, v: { v: 'styled', ff: 'Georgia', fc: '#ff0000', bg: '#0000ff', bl: 1 } },
                    { r: 0, c: 1, v: { v: 'rotated', rt: 45 } },
                    { r: 1, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                    { r: 1, c: 1, v: { v: 20, ct: { t: 'n', fa: 'General' } } },
                ],
                [{ type: 'dataBar', cellrange: [{ row: [1, 1], column: [0, 1] }], format: ['#638ec6'] }],
            ),
            hyperlink: { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).not.toContain('style="');
        // The moved base td style lives in the stylesheet exactly once.
        expect(out.css).toContain('td{overflow:hidden;white-space:nowrap;padding:1px 2px;line-height:0}');
    });

    test('identical cell styles dedupe into one class referenced by every cell', () => {
        const out = renderSheetsHtml(
            [
                makeSheet([
                    { r: 0, c: 0, v: { v: 'a', fc: '#ff0000' } },
                    { r: 0, c: 1, v: { v: 'b', fc: '#ff0000' } },
                    { r: 1, c: 0, v: { v: 'c', fc: '#00ff00' } },
                ]),
            ],
            NO_MEDIA,
            'screen',
        );
        const red = classesFor(out, 'color:#ff0000');
        const green = classesFor(out, 'color:#00ff00');
        expect(red.length).toBe(1);
        expect(green.length).toBe(1);
        expect(red[0]).not.toBe(green[0]);
        expect(useCount(out, red[0])).toBe(2);
        expect(useCount(out, green[0])).toBe(1);
    });

    test('a cell with no styling of its own gets no class attribute', () => {
        // (0,1) is inside the grid bounds but empty; with grid lines off it has no
        // declarations of its own — the shared td{} rule is all it needs.
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'a' } },
            { r: 0, c: 2, v: { v: 'b' } },
        ]);
        sheet.showGridLines = false;
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).toContain('<td></td>');
    });

    test('grid borders intern as a shared class when showGridLines is on', () => {
        const out = renderSheetsHtml(
            [
                makeSheet([
                    { r: 0, c: 0, v: { v: 'a' } },
                    { r: 0, c: 1, v: { v: 'b' } },
                ]),
            ],
            NO_MEDIA,
            'screen',
        );
        const grid = classesFor(out, 'border:1px solid #d4d4d4');
        expect(grid.length).toBe(1);
        expect(useCount(out, grid[0])).toBe(2);
    });

    test('row heights and column widths intern through the same registry', () => {
        // Two columns (120 + default) so the table's total width can't collide with
        // the col width snippet.
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'a' } },
            { r: 1, c: 1, v: { v: 'b' } },
        ]);
        sheet.config = { rowlen: { 0: 30, 1: 30 }, columnlen: { 0: 120 } };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        const height = classesFor(out, 'height:30px');
        expect(height.length).toBe(1);
        expect(out.html.match(new RegExp(`<tr class="${height[0]}">`, 'g'))?.length).toBe(2);
        const width = classesFor(out, 'width:120px');
        expect(width.length).toBe(1);
        expect(out.html).toContain(`<col class="${width[0]}">`);
    });

    // The editor hides a row or a column by its key, storing 0, as the xlsx import does.
    test('hidden rows and columns are left out of the table and its size', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'shown' } },
            { r: 1, c: 1, v: { v: 'hidden row' } },
            { r: 2, c: 2, v: { v: 'hidden column' } },
        ]);
        sheet.config = { rowhidden: { 1: 0 }, colhidden: { 2: 0 } };
        const { html } = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(html).toContain('>shown<');
        expect(html).not.toContain('hidden row');
        expect(html).not.toContain('hidden column');
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({
            width: 2 * SHEET_DEFAULT_COL_WIDTH,
            height: 2 * SHEET_DEFAULT_ROW_HEIGHT,
        });
    });

    test('the table style interns with real quotes around the body font stack', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])], NO_MEDIA, 'screen');
        const table = classesFor(out, 'border-collapse:collapse');
        expect(table.length).toBe(1);
        expect(out.css).toContain(`font-family:${FONT_STACK_SANS};`);
        expect(out.css).not.toContain('&quot;');
    });

    test('the inline table style carries the body font stack with entity quotes', () => {
        const { html } = renderSheetsPreviewHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])], NO_MEDIA);
        expect(html).toContain(`font-family:${FONT_STACK_SANS.replaceAll('"', '&quot;')};`);
    });

    // An unsized cell draws at the grid's default, in pt as the grid draws it.
    test('the table sets the grid default font size', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])], NO_MEDIA, 'screen');
        const table = classesFor(out, 'border-collapse:collapse');
        expect(classesFor(out, `font-size:${SHEET_DEFAULT_FONT_SIZE}pt;`)).toEqual(table);
    });

    // A peer can store any number, and the xlsx export holds a size to the same range.
    test("a font size is held to Excel's 1 to 409 points, and one that is not finite draws at the default", () => {
        const cellSize = (fs: number) => {
            const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x', fs } }])], NO_MEDIA, 'screen');
            return out.css.match(/\.s\d+\{font-size:([^;}]+)/)?.[1];
        };
        expect(cellSize(1e9)).toBe('409pt');
        expect(cellSize(-3)).toBe('1pt');
        expect(cellSize(Number.POSITIVE_INFINITY)).toBe(`${SHEET_DEFAULT_FONT_SIZE}pt`);
        expect(cellSize(Number.NaN)).toBe(`${SHEET_DEFAULT_FONT_SIZE}pt`);
        expect(cellSize(14)).toBe('14pt');
    });

    test('non-last sheets carry the page-break class next to .sheet', () => {
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'one' } }]), makeSheet([{ r: 0, c: 0, v: { v: 'two' } }])],
            NO_MEDIA,
            'screen',
        );
        const brk = classesFor(out, 'page-break-after:always');
        expect(brk.length).toBe(1);
        expect(out.html).toContain(`<div class="sheet ${brk[0]}">`);
        // The last sheet has no break.
        expect(out.html).toContain('<div class="sheet">');
    });

    test('a sheet of only an image ends its page too', () => {
        const pictured: Sheet = {
            ...makeSheet([]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 10, height: 10 }),
        };
        const media = new Map([['chart.png', 'data:image/png;base64,AA==']]);
        const out = renderSheetsHtml([pictured, makeSheet([{ r: 0, c: 0, v: { v: 'two' } }])], media, 'screen');
        const brk = classesFor(out, 'page-break-after:always');
        expect(out.html.startsWith(`<div class="sheet ${brk[0]}">`)).toBe(true);
    });

    test('the export document embeds the class rules in a body style element', () => {
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])],
            mediaUrls: NO_MEDIA,
            mode: 'screen',
            lost: () => {},
        });
        // The generated rules survive sanitization into the final document.
        expect(doc).toContain('border:1px solid #d4d4d4');
        expect(doc).toMatch(/<style>[^<]*td\{overflow:hidden/);
        expect(doc).toMatch(/class="s\d+"/);
    });

    test('a hostile url() in a cell background is stripped from the document CSS', () => {
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [makeSheet([{ r: 0, c: 0, v: { v: 'x', bg: 'url(http://evil.test/ssrf)' } }])],
            mediaUrls: NO_MEDIA,
            mode: 'screen',
            lost: () => {},
        });
        expect(doc).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    // Firefox fetches the @import of a data: SVG it loads as a mask, from the HTML download and the drive hero.
    test('a data: SVG mask in a cell background is stripped from the document and the preview', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://evil.test/i);</style></svg>';
        const bg = `red;mask:url(data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}#m)`;
        const sheets = [makeSheet([{ r: 0, c: 0, v: { v: 'x', bg } }])];
        const preview = sanitizeExportHtml(renderSheetsPreviewHtml(sheets, NO_MEDIA).html, { allowedRefs: new Set() });
        for (const html of [
            sheetsHtmlDocument({ title: 'T', sheets, mediaUrls: NO_MEDIA, mode: 'screen', lost: () => {} }),
            preview,
        ]) {
            expect(html).not.toContain('mask:');
        }
    });

    // Every value below is a schemaless CRDT string a collaborator (or a crafted xlsx)
    // can set. In a style attribute they were inert; in stylesheet text `</style>` ends
    // the element and whatever follows is live markup — DOMPurify keeps an
    // <svg><image href>, and a browser opening the HTML download fetches it.
    // Assert on the assembled, sanitized document: the pre-sanitize strings can't show
    // whether the breakout survived.
    const BREAKOUT = '1px}</style><svg><image href=http://169.254.169.254/latest/meta-data/></svg><style>.z{a:b';

    // The document keeps exactly two style elements — the embedded fonts and the class
    // rules. A third means the value closed the element and opened its own.
    function expectNoBreakout(doc: string): void {
        expect(doc).not.toMatch(/<svg/i);
        expect(doc).not.toMatch(/<image/i);
        expect(doc).not.toMatch(/url\(\s*['"]?https?:/i);
        expect(doc).not.toMatch(/@import/i);
        expect(doc.match(/<style>/g)?.length).toBe(2);
    }

    test('a hostile cell value cannot terminate the style element', () => {
        for (const cell of [
            { v: 'x', bg: BREAKOUT },
            { v: 'x', ff: BREAKOUT },
            { v: 'x', fc: BREAKOUT },
        ]) {
            expectNoBreakout(
                sheetsHtmlDocument({
                    title: 'T',
                    sheets: [makeSheet([{ r: 0, c: 0, v: cell }])],
                    mediaUrls: NO_MEDIA,
                    mode: 'screen',
                    lost: () => {},
                }),
            );
        }
    });

    test('hostile row/column dimensions cannot terminate the style element', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'x' } }]);
        sheet.config = {
            columnlen: { 0: BREAKOUT as unknown as number },
            rowlen: { 0: BREAKOUT as unknown as number },
        };
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'screen',
            lost: () => {},
        });
        expectNoBreakout(doc);
        // Non-numeric dimensions fall back to the defaults rather than concatenating —
        // the same coercion the page size applies for the @page rule.
        expect(doc).toContain(`width:${SHEET_DEFAULT_COL_WIDTH}px`);
        expect(doc).toContain(`height:${SHEET_DEFAULT_ROW_HEIGHT}px`);
        expect(doc).not.toContain('169.254.169.254');
    });

    test('a backslash or comment opener cannot swallow the rules that follow', () => {
        // `font-family:"Foo\"` escapes its own closing quote, and `red/*` opens a comment:
        // in one shared stylesheet either would eat every later rule, so one odd cell
        // would strip the styling off the rest of the workbook.
        for (const bad of ['Foo\\', 'Foo/*']) {
            const out = renderSheetsHtml(
                [
                    makeSheet([
                        { r: 0, c: 0, v: { v: 'a', ff: bad } },
                        { r: 0, c: 1, v: { v: 'b', bg: '#654321' } },
                    ]),
                ],
                NO_MEDIA,
                'screen',
            );
            expect(out.css).not.toContain('\\');
            expect(out.css).not.toContain('/*');
            // The later cell's rule is still its own reachable rule.
            expect(classesFor(out, 'background:#654321').length).toBe(1);
        }
    });
});

describe('Sheets HTML export — preview stays inline', () => {
    test('preview emits inline styles and no generated classes', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'p', fc: '#ff0000', ff: 'Georgia' } }]);
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).toContain('style="');
        expect(html).toContain('color:#ff0000');
        // Attribute context keeps the encoded font-family quotes.
        expect(html).toContain('font-family:&quot;Georgia&quot;');
        expect(html).not.toMatch(/class="s\d/);
    });
});

describe('Sheets HTML export — wrap text', () => {
    test('a wrapped number renders on one line and clips like an unwrapped one', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 28254.75, m: '28254.75', ct: { fa: 'General', t: 'g' }, f: '=A2*3', tb: '2' } },
            { r: 0, c: 1, v: { v: 45000, m: '2023-03-15', ct: { fa: 'yyyy-MM-dd', t: 'd' }, tb: '2' } },
            { r: 0, c: 2, v: { v: '28254.75', m: '28254.75', ct: { fa: 'General', t: 'n' }, tb: '2' } },
        ]);
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).not.toContain('pre-wrap');
    });

    test('wrapped text still wraps', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'abc defgh ij', ct: { fa: 'General', t: 'g' }, tb: '2' } }]);
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).toContain('white-space:pre-wrap');
    });

    // A table row grows to fit its content, so a cell of 6,000 lines would print 3,000 pages charged as one.
    test('a cell is clipped to its rows, as the editor clips it, so its text grows no row', () => {
        const text = 'one\ntwo\nthree';
        const sheet: Sheet = {
            ...makeSheet([
                { r: 0, c: 0, v: { v: text, m: text, tb: '2' } },
                { r: 1, c: 0, v: { v: 'merged', m: 'merged', mc: { r: 1, c: 0, rs: 2, cs: 1 } } },
                { r: 3, c: 0, v: { v: 'turned', m: 'turned', rt: 45 } },
            ]),
            config: { rowlen: { 2: 30 }, merge: { '1_0': { r: 1, c: 0, rs: 2, cs: 1 } } },
        };
        const clip = (height: number) => `max-height:${height}px;overflow:hidden">`;
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).toContain(`${clip(17)}one\ntwo\nthree</div>`);
        expect(html).toContain(`${clip(47)}merged</div>`);
        // A turned span is placed absolutely and grows no row, and a clip would cut it off.
        expect(html).not.toContain(`${clip(17)}<span`);
    });
});

describe('Sheets HTML export — conditional formatting', () => {
    test('sheet with no CF rules renders no position overlays', () => {
        const out = renderSheetsHtml(
            [
                makeSheet([
                    { r: 0, c: 0, v: { v: 'Hello', ct: { t: 's', fa: 'General' } } },
                    { r: 0, c: 1, v: { v: 42, ct: { t: 'n', fa: 'General' } } },
                ]),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.html).toContain('Hello');
        expect(out.html).toContain('42');
        // No conditional formatting → no CF-injected dataBar anchors.
        expect(out.css).not.toContain('position:relative');
        expect(out.css).not.toContain('position:absolute');
    });

    test('greaterThan rule applies cellColor as background on matching cells', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 5, ct: { t: 'n', fa: 'General' } } },
                        { r: 0, c: 1, v: { v: 50, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 0], column: [0, 1] }],
                            format: { textColor: '#ffffff', cellColor: '#ff8888' },
                            conditionName: 'greaterThan',
                            conditionRange: [],
                            conditionValue: [10],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        // Second cell (value 50, > 10) gets the CF colors.
        const cls = classesFor(out, 'background:#ff8888');
        expect(cls.length).toBe(1);
        expect(out.css).toContain('color:#ffffff');
        expect(useCount(out, cls[0])).toBe(1);
    });

    test('dataBar rule renders an absolutely-positioned bar div', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 20, ct: { t: 'n', fa: 'General' } } },
                        { r: 2, c: 0, v: { v: 30, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'dataBar',
                            cellrange: [{ row: [0, 2], column: [0, 0] }],
                            format: ['#638ec6'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        // Bar divs are positioned absolutely inside position:relative <td>s; each width is
        // proportional to the value, so the three bars produce three distinct classes.
        expect(classesFor(out, 'position:absolute').length).toBe(3);
        expect(classesFor(out, 'position:relative').length).toBeGreaterThan(0);
        expect(out.css).toContain('#638ec6');
        // Display text wrapped in a span with z-index above the bar, clipped to its row inside it.
        const zSpan = classesFor(out, 'z-index:1');
        expect(zSpan.length).toBe(1);
        expect(out.html).toMatch(new RegExp(`<span class="${zSpan[0]}"><div class="s\\d+">10</div></span>`));
    });

    test('colorGradation 2-color rule paints min/max cells with the configured stops', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 1, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'colorGradation',
                            cellrange: [{ row: [0, 1], column: [0, 0] }],
                            format: ['#00ff00', '#ff0000'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('background:#ff0000');
        expect(out.css).toContain('background:#00ff00');
    });

    test('colorGradation update on existing computeMap entry keeps the gradient color', () => {
        // Regression: the colorGradation if-arm used to read format.cellColor on an
        // array-shaped format, blanking the cell color when a prior rule had already
        // populated computeMap[`${r}_${c}`]. Two overlapping rules force that path —
        // greaterThan seeds the entry, then colorGradation must overwrite it with the
        // 2-color min stop (format[1]).
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [{ r: 0, c: 0, v: { v: 1, ct: { t: 'n', fa: 'General' } } }],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 0], column: [0, 0] }],
                            format: { cellColor: '#888888' },
                            conditionName: 'greaterThan',
                            conditionRange: [],
                            conditionValue: [0],
                        },
                        {
                            type: 'colorGradation',
                            cellrange: [{ row: [0, 0], column: [0, 0] }],
                            format: ['#00ff00', '#0000ff'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('background:#0000ff');
        expect(out.css).not.toContain('background:#888888');
    });

    test('dataBar with mixed positive/negative values uses red for the negative bar', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: -5, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'dataBar',
                            cellrange: [{ row: [0, 1], column: [0, 0] }],
                            format: ['#638ec6'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        // Negative bar is hardcoded red — matches canvas painter (canvas.ts ~line 1683).
        // Positive bar still uses the user-configured color.
        expect(out.css).toContain('#ff0000');
        expect(out.css).toContain('#638ec6');
    });

    test('formula rule with relative refs fires per-cell after anchor-relative shifting', () => {
        // 2x2 grid; CF formula `A1>10` is anchor-relative — each target cell evaluates the
        // formula with refs shifted from the anchor (0,0). Cells (0,1) and (1,0) hold values
        // > 10 so the rule fires; (0,0) and (1,1) hold ≤ 10 so it does not.
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 5, ct: { t: 'n', fa: 'General' } } },
                        { r: 0, c: 1, v: { v: 50, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 25, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 1, v: { v: 3, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 1], column: [0, 1] }],
                            format: { textColor: '#ffffff', cellColor: '#00aa00' },
                            conditionName: 'formula',
                            conditionRange: [],
                            conditionValue: ['A1>10'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        // Two cells fire — both share one interned class, referenced twice.
        const cls = classesFor(out, 'background:#00aa00');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(2);
        expect(out.css).toContain('color:#ffffff');
    });

    test('formula rule with absolute refs uses the anchor value for every target cell', () => {
        // `$A$1>10` — A1 is frozen, so all four cells in the range evaluate the same
        // condition (A1=15 > 10 → true → all four cells get the style).
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 15, ct: { t: 'n', fa: 'General' } } },
                        { r: 0, c: 1, v: { v: 1, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 1, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 1, v: { v: 1, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 1], column: [0, 1] }],
                            format: { textColor: '#000000', cellColor: '#ffaa00' },
                            conditionName: 'formula',
                            conditionRange: [],
                            conditionValue: ['$A$1>10'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        const cls = classesFor(out, 'background:#ffaa00');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(4);
    });

    test('formula rule using AND() across two columns shifts both refs together', () => {
        // Verifies the token-aware shift inside function calls — `=AND(A1>0, B1>0)` on a 2-row
        // range becomes `=AND(A2>0, B2>0)` for row 1. Only row 0 has both columns > 0.
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 5, ct: { t: 'n', fa: 'General' } } },
                        { r: 0, c: 1, v: { v: 5, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 5, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 1, v: { v: -5, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 1], column: [0, 0] }],
                            format: { textColor: '#000000', cellColor: '#88ccff' },
                            conditionName: 'formula',
                            conditionRange: [],
                            conditionValue: ['AND(A1>0, B1>0)'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        // Only the (0,0) cell satisfies; (1,0) reads A2/B2 where B2=-5 fails.
        const cls = classesFor(out, 'background:#88ccff');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(1);
    });
});

describe('Sheets HTML export — cell styling', () => {
    test('ff (font family) uses real quotes in the stylesheet and keeps later declarations', () => {
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'styled', ff: 'Georgia', fc: '#ff0000', bg: '#0000ff' } }])],
            NO_MEDIA,
            'screen',
        );
        const cls = classesFor(out, 'font-family:"Georgia",sans-serif');
        expect(cls.length).toBe(1);
        // Declarations after font-family must survive in the same rule.
        const rule = out.css.match(new RegExp(`\\.${cls[0]}\\{([^}]*)\\}`))?.[1] ?? '';
        expect(rule).toContain('color:#ff0000');
        expect(rule).toContain('background:#0000ff');
    });

    test('a font name containing & or an apostrophe survives into the stylesheet intact', () => {
        // CSS text never decodes entities, so HTML-escaping the name here would ask
        // WeasyPrint for a font called "Bell MT &amp; O'Neill".
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'x', ff: "Bell MT & O'Neill" } }])],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('font-family:"Bell MT & ONeill",sans-serif');
        expect(out.css).not.toContain('&amp;');
        expect(out.css).not.toContain('&#39;');
    });

    test('rt as a positive angle produces a CSS rotate anchored at bottom-left', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'up', rt: 45 } }])], NO_MEDIA, 'screen');
        // rt is CCW-positive (matches Excel/OOXML); CSS rotate is CW-positive — so the
        // emitted angle is the negation. Positive rt anchors at the cell's bottom-left;
        // the td gets `position:relative` so the span absolute-positions to that corner.
        expect(out.css).toContain('position:relative');
        expect(out.css).toContain('position:absolute;left:0;bottom:0');
        expect(out.css).toContain('transform-origin:left bottom');
        // translateX runs after rotate (CSS reads right-to-left), and equals
        // |sin(rt)|em — the same `textHeight * sin(rt)` left offset canvas uses.
        expect(out.css).toContain('transform:translateX(0.707em) rotate(-45deg)');
    });

    test('rt as a negative angle anchors the rotation at top-left', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'down', rt: -90 } }])], NO_MEDIA, 'screen');
        expect(out.css).toContain('position:relative');
        expect(out.css).toContain('position:absolute;left:0;top:0');
        expect(out.css).toContain('transform-origin:left top');
        // |sin(-90°)|em = 1.000em, exactly one line-height of compensation.
        expect(out.css).toContain('transform:translateX(1.000em) rotate(90deg)');
    });

    test('rotated cells skip ht/vt in favor of position:relative', () => {
        // The rotated span is absolutely-positioned in the cell, so emitting text-align
        // or vertical-align on the td has nothing to act on. Confirms we don't drag the
        // user's ht=center / vt=middle into a now-meaningless td-level declaration.
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'centered', rt: 45, ht: 0, vt: 0 } }])],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('position:relative');
        expect(out.css).not.toContain('text-align:center');
        expect(out.css).not.toContain('vertical-align:middle');
        expect(out.css).not.toContain('text-align:left');
    });

    test("a cell without an alignment of its own takes Excel's General, as the editor draws it: a number or date right, a boolean or error centered; text and a picked one keep theirs", () => {
        const css = (v: Cell) => renderSheetsHtml([makeSheet([{ r: 0, c: 0, v }])], NO_MEDIA, 'screen').css;
        expect(css({ v: 42, m: '42', ct: { fa: 'General', t: 'n' } })).toContain('text-align:right');
        expect(css({ v: 45000, m: '3/15/2023', ct: { fa: 'General', t: 'd' } })).toContain('text-align:right');
        expect(css({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } })).toContain('text-align:center');
        expect(css({ v: '#N/A', m: '#N/A', ct: { fa: 'General', t: 'e' } })).toContain('text-align:center');
        expect(css({ v: 42, m: '42', ht: 1 })).toContain('text-align:left');
        expect(css({ v: 'text', m: 'text' })).not.toContain('text-align');
    });

    test('an imported number without an alignment, horizontal="general" too, renders right; imported text keeps none', () => {
        const [sheet] = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 42],
                            ['B1', 7, 1],
                            ['C1', 'text'],
                        ]),
                    },
                ],
                styles: '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment horizontal="general"/></xf></cellXfs>',
            }),
        );
        const css = (v: Cell | null | undefined) =>
            v ? renderSheetsHtml([makeSheet([{ r: 0, c: 0, v }])], NO_MEDIA, 'screen').css : '';
        const [number, general, text] = (sheet?.celldata ?? []).map(({ v }) => v);
        expect([number?.ht, general?.ht]).toEqual([undefined, undefined]);
        expect(css(number)).toContain('text-align:right');
        expect(css(general)).toContain('text-align:right');
        expect(css(text)).not.toContain('text-align');
    });

    test('rt = "vertical" produces vertical writing-mode', () => {
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'stacked', rt: 'vertical' } }])],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('writing-mode:vertical-rl');
        expect(out.css).toContain('text-orientation:upright');
    });

    test('rt = 0 or unset emits no rotation wrapper', () => {
        const out = renderSheetsHtml(
            [
                makeSheet([
                    { r: 0, c: 0, v: { v: 'plain' } },
                    { r: 1, c: 0, v: { v: 'zero', rt: 0 } },
                ]),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).not.toContain('transform:');
        expect(out.css).not.toContain('writing-mode:vertical');
    });
});

describe('Sheets HTML export — hyperlinks', () => {
    test('webpage hyperlinks render as anchors with the href attribute-escaped', () => {
        const sheet: Sheet = {
            ...makeSheet([
                { r: 0, c: 0, v: { v: 'Jira ticket', m: 'Jira ticket' } },
                { r: 0, c: 1, v: { v: 'scheme-less' } },
            ]),
            hyperlink: {
                '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/browse?a=1&b=2' },
                '0_1': { linkType: 'webpage', linkAddress: 'example.com' },
            },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).toContain(
            '<a href="https://example.com/browse?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Jira ticket</a>',
        );
        // Scheme-less addresses get the same https:// resolution FE navigation uses.
        expect(out.html).toContain(
            '<a href="https://example.com" target="_blank" rel="noopener noreferrer">scheme-less</a>',
        );
    });

    test('blocked schemes and internal links stay plain text', () => {
        const sheet: Sheet = {
            ...makeSheet([
                { r: 0, c: 0, v: { v: 'click me' } },
                { r: 0, c: 1, v: { v: 'go to sheet' } },
                { r: 0, c: 2, v: { v: 'go to range' } },
            ]),
            hyperlink: {
                '0_0': { linkType: 'webpage', linkAddress: 'javascript:alert(1)' },
                // Internal links have no meaningful target in standalone HTML.
                '0_1': { linkType: 'sheet', linkAddress: 'Sheet2' },
                '0_2': { linkType: 'cellrange', linkAddress: 'Sheet2!B2' },
            },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).not.toContain('<a ');
        expect(out.html).not.toContain('javascript:');
        expect(out.html).toContain('click me');
        expect(out.html).toContain('go to sheet');
    });
});

// Cell colors come from the sheet snapshot (schemaless — a collaborator can set any string).
// In class mode they land in CSS text: they must not smuggle markup through the stylesheet
// or break out of their declaration block.
describe('Sheets HTML export — hostile values in CSS', () => {
    test('fc and bg cannot inject markup through the stylesheet', () => {
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'x', fc: 'red;"><script>alert(1)</script>', bg: 'blue">' } }])],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).not.toMatch(/script/i);
        expect(out.html).not.toMatch(/<script/i);
    });

    // A value that adds declarations of its own fetches nothing, so the sanitizer keeps it, in the HTML download and
    // the drive hero alike.
    test('a cell, rule, border or data bar color that is not a color is dropped, in the export and the preview', () => {
        const injected = 'red;position:fixed;inset:0';
        const numeric = { t: 'n', fa: 'General' };
        const sheet: Sheet = {
            ...makeSheet(
                [
                    { r: 0, c: 0, v: { v: 'x', fc: injected, bg: injected } },
                    { r: 1, c: 0, v: { v: 50, ct: numeric } },
                    { r: 2, c: 0, v: { v: 10, ct: numeric } },
                    { r: 3, c: 0, v: { v: 20, ct: numeric } },
                ],
                [
                    {
                        type: 'default',
                        cellrange: [{ row: [1, 1], column: [0, 0] }],
                        format: { textColor: injected, cellColor: injected },
                        conditionName: 'greaterThan',
                        conditionRange: [],
                        conditionValue: [10],
                    },
                    { type: 'dataBar', cellrange: [{ row: [2, 3], column: [0, 0] }], format: [injected] },
                    { type: 'dataBar', cellrange: [{ row: [2, 3], column: [0, 0] }], format: [injected, injected] },
                ],
            ),
            config: { borderInfo: { '0_0': { b: { style: 1, color: injected } } } },
        };
        for (const html of [
            renderSheetsHtml([sheet], NO_MEDIA, 'screen').css,
            renderSheetsPreviewHtml([sheet], NO_MEDIA).html,
        ]) {
            expect(html).not.toContain('position:fixed');
            expect(html).not.toContain('inset');
        }
    });

    // A peer can store any JSON where a color goes, and a color that is no string draws as none.
    test('a cell, rule, border or data bar color that is not a string is dropped, in the export and the preview', () => {
        const numeric = { t: 'n', fa: 'General' };
        const sheet: Sheet = {
            ...makeSheet(
                [
                    { r: 0, c: 0, v: JSON.parse('{"v":"x","fc":42,"bg":{"r":255}}') },
                    { r: 1, c: 0, v: { v: 50, ct: numeric } },
                    { r: 2, c: 0, v: { v: 10, ct: numeric } },
                    { r: 3, c: 0, v: { v: 20, ct: numeric } },
                ],
                JSON.parse(`[
                    {"type":"default","cellrange":[{"row":[1,1],"column":[0,0]}],"format":{"textColor":7,"cellColor":[1]},
                     "conditionName":"greaterThan","conditionRange":[],"conditionValue":[10]},
                    {"type":"dataBar","cellrange":[{"row":[2,3],"column":[0,0]}],"format":[5]},
                    {"type":"dataBar","cellrange":[{"row":[2,3],"column":[0,0]}],"format":[5,true]}
                ]`),
            ),
            config: { borderInfo: JSON.parse('{"0_0":{"b":{"style":1,"color":3}}}') },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).toContain('>x<');
        expect(out.css).not.toMatch(/color:(42|7|3)\b|background:\[/);
        expect(renderSheetsPreviewHtml([sheet], NO_MEDIA).html).toContain('>x<');
    });

    test.each(['#ff0000', '#F00', 'rgb(255, 0, 0)', 'rgba(0, 0, 255, 0.5)', 'transparent', 'red'])(
        'a cell keeps the color %s',
        (color) => {
            const out = renderSheetsHtml(
                [makeSheet([{ r: 0, c: 0, v: { v: 'x', fc: color, bg: color } }])],
                NO_MEDIA,
                'screen',
            );
            expect(classesFor(out, `color:${color};background:${color}`)).toHaveLength(1);
        },
    );

    // The engine writes a stop between the two as rgb(…).
    test('a colorGradation keeps the rgb() it computes', () => {
        const numeric = { t: 'n', fa: 'General' };
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 1, ct: numeric } },
                        { r: 1, c: 0, v: { v: 5, ct: numeric } },
                        { r: 2, c: 0, v: { v: 9, ct: numeric } },
                    ],
                    [
                        {
                            type: 'colorGradation',
                            cellrange: [{ row: [0, 2], column: [0, 0] }],
                            format: ['#00ff00', '#ff0000'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).toContain('background:rgb(128, 128, 0)');
    });

    test('braces in a hostile value cannot open or close CSS rule blocks', () => {
        const out = renderSheetsHtml(
            [makeSheet([{ r: 0, c: 0, v: { v: 'x', bg: 'red}td{display:none' } }])],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).not.toContain('{display:none');
        expect(out.css).not.toContain('td{display');
        // Every rule stays balanced: strip the well-formed rules and nothing may remain.
        expect(out.css.replace(/[^{}]*\{[^{}]*\}\n?/g, '')).toBe('');
    });

    test('escapes conditional-format colors', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [{ r: 0, c: 0, v: { v: 50, ct: { t: 'n', fa: 'General' } } }],
                    [
                        {
                            type: 'default',
                            cellrange: [{ row: [0, 0], column: [0, 0] }],
                            format: { textColor: '#ffffff', cellColor: 'red;"><script>alert(1)</script>' },
                            conditionName: 'greaterThan',
                            conditionRange: [],
                            conditionValue: [10],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).not.toMatch(/<script/i);
        expect(out.html).not.toMatch(/<script/i);
    });

    test('escapes border colors', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'x' } }]),
            config: { borderInfo: { '0_0': { b: { style: 1, color: 'red;"><script>x</script>' } } } },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.css).not.toMatch(/<script/i);
        expect(out.html).not.toMatch(/<script/i);
    });

    test('renders a bordered cell with CSS borders on its own sides', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'x' } }]),
            config: { borderInfo: { '0_0': { l: { style: 8, color: '#1a5fb4' }, b: { style: 1, color: '#ff0000' } } } },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        const [cls] = classesFor(out, 'border-left:2px solid #1a5fb4');
        expect(cls).toBeDefined();
        expect(classesFor(out, 'border-bottom:1px solid #ff0000')).toEqual([cls]);
        expect(out.css).not.toContain('border-top:');
        expect(out.css).not.toContain('border-right:');
        expect(useCount(out, cls)).toBe(1);
    });

    test('a merge draws the perimeter its constituents store on the master td', () => {
        const mc = { r: 0, c: 0, rs: 3, cs: 3 };
        const cells = [];
        for (let r = 0; r < 3; r += 1) {
            for (let c = 0; c < 3; c += 1) {
                cells.push({ r, c, v: r === 0 && c === 0 ? { v: 'x', mc } : { mc: { r: 0, c: 0 } } });
            }
        }
        const side = { style: 1, color: '#ff0000' };
        // What applyBorder's border-outside stores: each edge on the constituent that owns it.
        const sheet: Sheet = {
            ...makeSheet(cells),
            config: {
                merge: { '0_0': mc },
                borderInfo: {
                    '0_0': { t: side, l: side },
                    '0_1': { t: side },
                    '0_2': { t: side, r: side },
                    '1_0': { l: side },
                    '1_2': { r: side },
                    '2_0': { b: side, l: side },
                    '2_1': { b: side },
                    '2_2': { b: side, r: side },
                },
            },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        const [cls] = classesFor(out, 'border-top:1px solid #ff0000');
        expect(cls).toBeDefined();
        for (const edge of ['left', 'right', 'bottom']) {
            expect(classesFor(out, `border-${edge}:1px solid #ff0000`)).toEqual([cls]);
        }
        expect(out.html).toMatch(new RegExp(`<td[^>]*colspan="3"[^>]*class="(?:sheet )?${cls}"`));
    });

    test('escapes dataBar colors', () => {
        const out = renderSheetsHtml(
            [
                makeSheet(
                    [
                        { r: 0, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                        { r: 1, c: 0, v: { v: 20, ct: { t: 'n', fa: 'General' } } },
                    ],
                    [
                        {
                            type: 'dataBar',
                            cellrange: [{ row: [0, 1], column: [0, 0] }],
                            format: ['red;"><script>x</script>'],
                        },
                    ],
                ),
            ],
            NO_MEDIA,
            'screen',
        );
        expect(out.css).not.toMatch(/<script/i);
        expect(out.html).not.toMatch(/<script/i);
    });
});

describe('Sheets export — content size (@page)', () => {
    test('non-numeric dimensions fall back to the defaults instead of concatenating', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'a', ct: { t: 's', fa: 'General' } } },
            { r: 1, c: 1, v: { v: 'b', ct: { t: 's', fa: 'General' } } },
        ]);
        // The dimension maps are schemaless at the Yjs boundary — a collaborator can store strings.
        sheet.config = {
            columnlen: { 0: '50;}@page{' as unknown as number, 1: 100 },
            rowlen: { 0: 25, 1: 'abc' as unknown as number },
        };
        // Pre-coercion this summed to the string "050;}@page{100", headed for the <head> @page CSS.
        // Bad column → SHEET_DEFAULT_COL_WIDTH, bad row → SHEET_DEFAULT_ROW_HEIGHT.
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({
            width: SHEET_DEFAULT_COL_WIDTH + 100,
            height: 25 + SHEET_DEFAULT_ROW_HEIGHT,
        });
    });

    test("an unsized column or row takes the sheet's own default, in the grid, the page and the overlay", () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 2, c: 1, v: { v: 'grid' } }]),
            defaultColWidth: 64,
            defaultRowHeight: 17,
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 100, y: 60, width: 10, height: 10 }),
        };
        const out = renderSheetsHtml([sheet], new Map([['chart.png', 'data:image/png;base64,']]), 'screen');
        expect(out.css).toContain('{width:64px}');
        expect(out.css).toContain('{height:17px}');
        // One column and two rows sit left of and above the table.
        expect(classesFor(out, 'left:36px;top:26px')).toHaveLength(1);
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({ width: 64, height: 36 });
    });

    test('the PDF page of a huge sheet is capped at the PDF page limit', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'wide' } }]);
        // The longest track a sheet can have is one page side, so the margins would take the page past the limit.
        sheet.config = { columnlen: { 0: 19_200 }, rowlen: { 0: 19_200 } };
        const html = sheetsHtmlDocument({
            title: 'Huge',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
        expect(html).toContain('@page { size: 19200px 19200px; margin: 40px; }');
    });

    test('an image parked past the used range is measured too', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 400, y: 200, width: 100, height: 50 }),
        };
        // The overlay draws at the absolute grid coordinate, so the page has to reach the
        // image's far edge — the one default-sized cell is not what bounds this sheet.
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({ width: 500, height: 250 });
    });

    // The page covers the box an object turns into: a 400 × 100 chart at 90° stands 100 wide and 400 tall about
    // the same center, (300, 250).
    test('a rotated object is measured by its turned box', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]),
            images: imagesOf({
                id: 'img_1',
                mediaName: 'chart.png',
                x: 100,
                y: 200,
                width: 400,
                height: 100,
                angle: 90,
            }),
        };
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({ width: 350, height: 450 });
    });

    // A 100 × 500 image at A1 turned 90° covers -200 to 300 across: the page has no headers to tuck the left part
    // under, so the object moves right until it starts on the page, and the page reaches its far side.
    test('an object turned past A1 moves back onto the page', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 100, height: 500, angle: 90 }),
        };
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({ width: 500, height: 300 });
        const out = renderSheetsHtml([sheet], new Map([['chart.png', 'data:image/png;base64,AA==']]), 'screen');
        expect(classesFor(out, 'left:200px;top:0px;width:100px;height:500px')).toHaveLength(1);
    });

    test('image extents are measured in the same offset space as the grid', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 2, c: 1, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 300, y: 100, width: 10, height: 10 }),
        };
        // Two default rows and one default column sit above/left of the table.
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({
            width: 300 + 10 - SHEET_DEFAULT_COL_WIDTH,
            height: 100 + 10 - 2 * SHEET_DEFAULT_ROW_HEIGHT,
        });
    });
});

// A floating image is a media reference (docs/MEDIA-REFERENCES.md): the stored name is
// resolved to a src by the caller — a data: URI for an export, a preview URL for a preview.
describe('Sheets HTML export — floating images', () => {
    const PIXEL =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const MEDIA = new Map([['chart.png', PIXEL]]);

    function withImages(images: Omit<SheetImage, 'index'>[]): Sheet {
        return { ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]), images: imagesOf(...images) };
    }

    test('renders each image absolutely positioned over the grid at its stored geometry', () => {
        const out = renderSheetsHtml(
            [withImages([{ id: 'img_1', mediaName: 'chart.png', x: 120, y: 40, width: 200, height: 150 }])],
            MEDIA,
            'screen',
        );
        // The box reaches the image's far corner, so the next sheet starts below it.
        const [wrapper] = classesFor(out, 'position:relative;width:320px;min-height:190px');
        expect(useCount(out, wrapper)).toBe(1);
        const [image] = classesFor(out, 'left:120px;top:40px;width:200px;height:150px');
        expect(image).toBeDefined();
        expect(out.html).toContain(`<img class="${image}" src="${PIXEL}" alt="">`);
    });

    test('a rotated image carries the same center-origin rotation the editor paints', () => {
        const out = renderSheetsHtml(
            [withImages([{ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 10, height: 10, angle: 30 }])],
            MEDIA,
            'screen',
        );
        expect(classesFor(out, 'transform:rotate(30deg);transform-origin:center center')).toHaveLength(1);
    });

    // Geometry is schemaless at the Yjs boundary: a peer can store a string, which reaches the CSS as its number only.
    test('a stored string draws as its number and an angle that is no number draws unrotated', () => {
        const stored = JSON.parse('{"x":"12","y":"8","width":"40","height":"30","angle":"red;position:fixed"}');
        const out = renderSheetsHtml(
            [withImages([{ id: 'img_1', mediaName: 'chart.png', ...stored }])],
            MEDIA,
            'screen',
        );
        expect(classesFor(out, 'left:12px;top:8px;width:40px;height:30px')).toHaveLength(1);
        expect(out.css).not.toContain('rotate(');
        expect(out.css).not.toContain('position:fixed');
    });

    test('an image whose name resolves to nothing renders nothing', () => {
        const out = renderSheetsHtml(
            [withImages([{ id: 'img_1', mediaName: 'pending:abc', x: 0, y: 0, width: 10, height: 10 }])],
            MEDIA,
            'screen',
        );
        expect(out.html).not.toContain('<img');
        expect(classesFor(out, 'position:relative;width:')).toHaveLength(0);
    });

    test('an image on an otherwise blank sheet still renders', () => {
        const sheet: Sheet = {
            name: 'Blank',
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 5, y: 5, width: 10, height: 10 }),
        };
        expect(renderSheetsHtml([sheet], MEDIA, 'screen').html).toContain('<img');
    });

    test('the overlay is offset by the rows and columns before the used range', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 2, c: 1, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 100, y: 60, width: 10, height: 10 }),
        };
        // Two default rows and one default column sit above/left of the table.
        const out = renderSheetsHtml([sheet], MEDIA, 'screen');
        const left = 100 - SHEET_DEFAULT_COL_WIDTH;
        const top = 60 - 2 * SHEET_DEFAULT_ROW_HEIGHT;
        expect(classesFor(out, `left:${left}px;top:${top}px`)).toHaveLength(1);
    });

    test('an image anchored above the used range pulls the window up instead of going negative', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 4, c: 2, v: { v: 'C5' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 160, height: 60 }),
        };
        const out = renderSheetsHtml([sheet], MEDIA, 'screen');
        // The window starts at A1 now, so the overlay draws at the stored geometry...
        expect(classesFor(out, 'left:0px;top:0px;width:160px;height:60px')).toHaveLength(1);
        // ...and the page spans the empty rows and columns the image sits over.
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({
            width: 3 * SHEET_DEFAULT_COL_WIDTH,
            height: 5 * SHEET_DEFAULT_ROW_HEIGHT,
        });
    });

    // A box turned past A1 moves back onto the page, and its bounds can come out a few ulps below 0.
    test('an image turned past A1 opens no row or column before A1', () => {
        for (const angle of [30, 45, 60, 135]) {
            const sheet: Sheet = {
                ...makeSheet([{ r: 2, c: 2, v: { v: 'C3', m: 'C3' } }]),
                images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 200, height: 100, angle }),
            };
            const out = renderSheetsHtml([sheet], MEDIA, 'screen');
            expect(out.html.match(/<col /g)).toHaveLength(3);
            expect(out.html.match(/<tr /g)).toHaveLength(3);
        }
    });

    // The editor and the import write whole pixels, so a length under one is no size a sheet has.
    test('a track size under a pixel draws as the default, so a turned image at A1 still finds its cells', () => {
        for (const tiny of [0.5, 1e-20, 1e-300]) {
            const sheet: Sheet = {
                ...makeSheet([{ r: 2, c: 2, v: { v: 'C3', m: 'C3' } }]),
                defaultColWidth: tiny,
                defaultRowHeight: tiny,
                images: imagesOf({
                    id: 'img_1',
                    mediaName: 'chart.png',
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 100,
                    angle: 45,
                }),
            };
            const out = renderSheetsHtml([sheet], MEDIA, 'screen');
            expect(out.html).toContain('>C3<');
            expect(out.html.match(/<col /g)).toHaveLength(3);
            expect(classesFor(out, `width:${SHEET_DEFAULT_COL_WIDTH}px`)).toHaveLength(1);
            expect(classesFor(out, `height:${SHEET_DEFAULT_ROW_HEIGHT}px`)).toHaveLength(1);
        }
    });

    test('a workbook without floating images emits the bare table it always did', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }])], MEDIA, 'screen');
        expect(out.html).not.toContain('position:relative;width:');
        expect(out.html).toMatch(/<div class="sheet">\n<table /);
    });

    test('the embedded data: URI survives the document sanitizer', () => {
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [withImages([{ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 10, height: 10 }])],
            mediaUrls: MEDIA,
            mode: 'screen',
            lost: () => {},
        });
        expect(doc).toContain(`src="${PIXEL}"`);
    });

    test('the preview drops an image parked outside the window it renders', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 5000, y: 0, width: 100, height: 100 }),
        };
        // The preview box is the clipped grid; an image far right of it would stretch the
        // fragment's scroll width and collapse the thumbnail that scales by it.
        expect(renderSheetsPreviewHtml([sheet], MEDIA).html).not.toContain('<img');
        // The full export still draws it — getSheetContentSize sizes the page to reach it.
        expect(renderSheetsHtml([sheet], MEDIA, 'screen').html).toContain('<img');
    });

    test('the preview keeps an image that only overhangs its window', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'grid' } }]),
            images: imagesOf({ id: 'img_1', mediaName: 'chart.png', x: 50, y: 0, width: 400, height: 10 }),
        };
        expect(renderSheetsPreviewHtml([sheet], MEDIA).html).toContain('<img');
    });

    test('a preview URL survives only while it is the resolved one', () => {
        // The preview arm embeds http(s) URLs, which the sanitizer strips unless the caller
        // allow-lists them — renderEigensheetsPreviewBody passes exactly the prepared map.
        const url = 'http://api.test/drive/o/m/file/f1/preview';
        const { html } = renderSheetsPreviewHtml(
            [withImages([{ id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 10, height: 10 }])],
            new Map([['chart.png', url]]),
        );
        expect(html).toContain(`src="${url}"`);
        expect(sanitizeExportHtml(html, { allowedRefs: new Set([url]) })).toContain(url);
        expect(sanitizeExportHtml(html)).not.toContain(url);
    });

    // Every tag repeats the whole data: URI, so 1,000 entries over one 1 MB picture built a 1 GB document.
    test('images spend the cell cap with the bytes their tags write, and one the cap leaves out is counted', () => {
        const picture = `data:image/png;base64,${'A'.repeat(1_000_000)}`;
        const images = Array.from({ length: 100 }, (_, i) => ({
            id: `img_${i}`,
            mediaName: 'photo.png',
            x: i,
            y: 0,
            width: 10,
            height: 10,
        }));
        const lost: string[] = [];
        const html = sheetsHtmlDocument({
            title: 'Photos',
            sheets: [withImages(images)],
            mediaUrls: new Map([['photo.png', picture]]),
            mode: 'pdf',
            lost: (code) => lost.push(code),
        });
        const drawn = html.match(/<img /g)?.length ?? 0;
        expect(drawn).toBeGreaterThan(0);
        expect(drawn).toBeLessThan(100);
        expect(html.length).toBeLessThan(20_000_000);
        expect(lost).toEqual(Array(100 - drawn).fill('images-dropped'));
    });
});

// A chart draws as the painter's inline SVG in the same overlay, its range read from the materialized sheets.
describe('Sheets HTML export — charts', () => {
    const cells = [
        { r: 0, c: 0, v: { v: 'Team', m: 'Team' } },
        { r: 0, c: 1, v: { v: 'Points', m: 'Points' } },
        { r: 1, c: 0, v: { v: 'Ajax', m: 'Ajax' } },
        { r: 1, c: 1, v: { v: 42, m: '42' } },
        { r: 2, c: 0, v: { v: 'PSV', m: 'PSV' } },
        { r: 2, c: 1, v: { v: 65, m: '65' } },
    ];
    const ref = (sheetId: string, row: [number, number], column: [number, number]): CellRangeRef => ({
        sheetId,
        row,
        column,
    });

    function chartOn(sheetId: string, box = { x: 120, y: 40, width: 400, height: 300 }): SheetChart {
        const spec = sampleChartSpec('column');
        return {
            id: 'c1',
            index: 'a0',
            ...box,
            ...newSheetChartSpecParts({
                ...spec,
                title: { text: 'Points scored' },
                series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
                data: {
                    source: 'range',
                    categories: ref(sheetId, [1, 2], [0, 0]),
                    series: [
                        {
                            id: 's-1',
                            name: ref(sheetId, [0, 0], [1, 1]),
                            values: ref(sheetId, [1, 2], [1, 1]),
                        },
                    ],
                },
            }),
        };
    }

    // The table holds the same strings, so labels are looked for inside the svg.
    const svgOf = (html: string) => html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));

    const sheetWithChart = (): Sheet => ({ ...makeSheet(cells), id: 'data', charts: { c1: chartOn('data') } });

    test('draws each chart as inline SVG at its stored box, with the labels its cells hold', () => {
        const out = renderSheetsHtml([sheetWithChart()], NO_MEDIA, 'screen');
        const [box] = classesFor(out, 'position:absolute;left:120px;top:40px;width:400px;height:300px;background:#fff');
        expect(box).toBeDefined();
        expect(out.html).toContain(
            `<div class="${box}"><svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"`,
        );
        for (const label of ['>Points scored<', '>Ajax<', '>PSV<', '>Points<'])
            expect(svgOf(out.html)).toContain(label);
    });

    test('a chart reads its range from another sheet', () => {
        const chartSheet: Sheet = {
            name: 'Charts',
            id: 'charts',
            charts: { c1: chartOn('data', { x: 0, y: 0, width: 300, height: 200 }) },
        };
        const out = renderSheetsHtml(
            [chartSheet, { ...makeSheet(cells), id: 'data', name: 'Data' }],
            NO_MEDIA,
            'screen',
        );
        expect(svgOf(out.html)).toContain('>Ajax<');
    });

    test('the page reaches a chart parked past the used range', () => {
        const sheet: Sheet = {
            ...sheetWithChart(),
            charts: { c1: chartOn('data', { x: 600, y: 300, width: 100, height: 50 }) },
        };
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size).toEqual({ width: 700, height: 350 });
    });

    // A peer or a file can store any number; at a trillion px the painter overflows its stack.
    test('a stored box past the max side or off the grid draws at the max, its corner on the grid', () => {
        const sheet: Sheet = {
            ...sheetWithChart(),
            charts: { c1: chartOn('data', { x: 9.4e11, y: 40, width: 9.4e11, height: 9.4e11 }) },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.html).toContain(`width="${CHART_MAX_SIDE}" height="${CHART_MAX_SIDE}"`);
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').size.width).toBe(
            REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH + CHART_MAX_SIDE,
        );
    });

    // One paint order for both kinds, as the editor stacks them.
    test('an image and a chart stack by their shared index', () => {
        const image = { id: 'img_1', mediaName: 'chart.png', x: 0, y: 0, width: 10, height: 10 };
        const media = new Map([['chart.png', 'data:image/png;base64,']]);
        const drawn = (index: string) => {
            const sheet: Sheet = { ...sheetWithChart(), images: { img_1: { ...image, index } } };
            const { html } = renderSheetsHtml([sheet], media, 'screen');
            return html.indexOf('<img') > html.indexOf('<svg') ? 'image on top' : 'chart on top';
        };
        expect(drawn('a1')).toBe('image on top');
        expect(drawn('Zz')).toBe('chart on top');
    });

    test('a rotated chart turns about its center as an image does', () => {
        const sheet: Sheet = { ...sheetWithChart(), charts: { c1: { ...chartOn('data'), angle: 90 } } };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(classesFor(out, 'background:#fff;transform:rotate(90deg);transform-origin:center center')).toHaveLength(
            1,
        );
    });

    test('the chart survives the document sanitizer', () => {
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [sheetWithChart()],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
        expect(svgOf(doc)).toContain('>Ajax<');
        expect(svgOf(doc)).toContain('<path d="M0 0 L');
    });

    test('a chart draws the look it stores, its hatch clipped to each bar, through the sanitizer', () => {
        const fill = serializeFill({ type: 'solid', color: 'transparent', style: 'zigzag' });
        const sheet: Sheet = {
            ...sheetWithChart(),
            charts: { c1: { ...chartOn('data'), fill, color: '#334455', roughness: 1, seed: 7 } },
        };
        const doc = sheetsHtmlDocument({
            title: 'T',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: () => {},
        });
        expect(svgOf(doc)).toContain('<clipPath id="');
        expect(svgOf(doc)).toContain('<g clip-path="url(#');
        expect(svgOf(doc)).toContain('fill="#334455"');
        expect(svgOf(renderSheetsHtml([sheetWithChart()], NO_MEDIA, 'screen').html)).not.toContain('<clipPath');
    });

    test('charts spend the cell cap with the points they draw, and one the cap leaves out is counted', () => {
        const points = 2000;
        const numbers = Array.from({ length: points }, (_, r) => ({ r, c: 0, v: { v: r, m: String(r) } }));
        const charts: Record<string, SheetChart> = {};
        for (let i = 0; i < 200; i++) {
            const chart = chartOn('data', { x: 0, y: 0, width: 200, height: 100 });
            const spec = sampleChartSpec('line');
            charts[`c${i}`] = {
                ...chart,
                id: `c${i}`,
                index: `a${String(i).padStart(3, '0')}`,
                ...newSheetChartSpecParts({
                    ...spec,
                    data: {
                        source: 'range',
                        categories: null,
                        series: [{ id: 's-1', name: 'n', values: ref('data', [0, points - 1], [0, 0]) }],
                    },
                }),
            };
        }
        const sheet: Sheet = { ...makeSheet(numbers), id: 'data', charts };
        const lost: string[] = [];
        const html = sheetsHtmlDocument({
            title: 'Charts',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'screen',
            lost: (code) => lost.push(code),
        });
        const drawn = html.match(/<svg /g)?.length ?? 0;
        expect(drawn).toBeGreaterThan(0);
        expect(drawn).toBeLessThan(200);
        expect(lost).toEqual(Array(200 - drawn).fill('charts-dropped'));
        // The preview's charts spend an allowance of their own, and it says it left some out. The export's cap drew
        // 99 here, 22 MB that the preview's byte guard threw away whole.
        const preview = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        const fit = Math.floor(PREVIEW_FLOATING_CELLS / (500 + points));
        expect(fit).toBeGreaterThan(0);
        expect(preview.html.match(/<svg /g)).toHaveLength(fit);
        expect(preview.truncated).toBe(true);
    }, 60_000);

    test('a preview whose window spends all its cells still draws its first chart', () => {
        const { maxRows, maxCols, maxCells } = PREVIEW_SHEET_BUDGET;
        const cells = Array.from({ length: maxRows * maxCols }, (_, i) => ({
            r: Math.floor(i / maxCols),
            c: i % maxCols,
            v: { v: i, m: String(i) },
        }));
        expect(cells).toHaveLength(maxCells);
        const sheet: Sheet = { ...makeSheet(cells), id: 'data', charts: { c1: chartOn('data') } };
        expect(renderSheetsPreviewHtml([sheet], NO_MEDIA).html.match(/<svg /g)).toHaveLength(1);
    });
});

describe('Sheets HTML export — the cell cap', () => {
    const tds = (html: string) => html.match(/<td/g)?.length ?? 0;
    const cols = (html: string) => html.match(/<col /g)?.length ?? 0;
    const trs = (html: string) => html.match(/<tr /g)?.length ?? 0;

    test('a wide sheet keeps every row and the columns from the left that fit with them', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'top left' } },
            { r: 263, c: 0, v: { v: 'last row' } },
            { r: 0, c: 14_702, v: { v: 'far right' } },
        ]);
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([sheet]);
        expect(trs(out.html)).toBe(264);
        expect(cols(out.html)).toBe(946);
        expect(tds(out.html)).toBe(264 * 946);
        expect(out.html).toContain('>last row<');
        expect(out.html).not.toContain('>far right<');
        expect(out.size).toEqual({ width: 946 * SHEET_DEFAULT_COL_WIDTH, height: 264 * SHEET_DEFAULT_ROW_HEIGHT });
    }, 30_000);

    test('a PDF keeps the columns one page holds, as the page cuts off the rest', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'top left' } },
            { r: 263, c: 0, v: { v: 'last row' } },
            { r: 0, c: 14_702, v: { v: 'far right' } },
        ]);
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'pdf');
        expect(out.cut).toEqual([sheet]);
        expect(trs(out.html)).toBe(264);
        expect(cols(out.html)).toBe(192);
        expect(out.size.width).toBe(192 * SHEET_DEFAULT_COL_WIDTH);
    }, 30_000);

    test('a sheet taller than the cap keeps its one column and the rows that fit', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'top' } },
            { r: 299_999, c: 0, v: { v: 'bottom' } },
        ]);
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([sheet]);
        expect(cols(out.html)).toBe(1);
        expect(trs(out.html)).toBe(MAX_EXPORT_CELLS);
        expect(out.html).toContain('>top<');
        expect(out.html).not.toContain('>bottom<');
    }, 30_000);

    test('a border key at XFD1048576 cuts the walk to the cap, one PDF page of columns, quickly', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'top left' } }]),
            config: {
                borderInfo: {
                    [`${REFERENCE_ROW_COUNT - 1}_${REFERENCE_COLUMN_COUNT - 1}`]: { b: { style: 1, color: '#000' } },
                },
            },
        };
        const started = performance.now();
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(performance.now() - started).toBeLessThan(10_000);
        expect(out.cut).toEqual([sheet]);
        expect(out.html).toContain('>top left<');
        expect(cols(out.html)).toBe(192);
        expect(trs(out.html)).toBe(1302);
        expect(tds(out.html)).toBe(192 * 1302);
    }, 30_000);

    test("a merge to XFD1048576 exports cut to the cap, its span with it, and the export's warning says so", async () => {
        const sheet: Sheet = {
            id: 'sheet-1',
            name: 'Sheet1',
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: 'merged', m: 'merged' } }],
            config: { merge: { '0_0': { r: 0, c: 0, rs: REFERENCE_ROW_COUNT, cs: REFERENCE_COLUMN_COUNT } } },
        };
        const doc = new Y.Doc();
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot([sheet], { computed: true }));
        const started = performance.now();
        const exported = await renderEigensheetsExport(doc, 'html', 'Forged', async () => []);
        expect(performance.now() - started).toBeLessThan(10_000);
        expect(exported.warnings).toEqual([{ code: 'sheets-cut', count: 1 }]);
        const html = new TextDecoder().decode(exported.data);
        expect(html).toContain('colspan="192"');
        expect(html).toContain('rowspan="1302"');
        expect(cols(html)).toBe(192);
        expect(tds(html)).toBe(1);
    }, 30_000);

    test('a sheet of a million rows keeps its ten columns and the rows that fit', () => {
        const sheet: Sheet = {
            id: 'tall',
            name: 'Tall',
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: 'top left' } },
                { r: 999_999, c: 9, v: { v: 'bottom right' } },
            ],
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([sheet]);
        expect(cols(out.html)).toBe(10);
        expect(trs(out.html)).toBe(25_000);
    }, 30_000);

    test('a sheet too tall for its columns keeps one PDF page of them and the rows that fit', () => {
        const sheet: Sheet = {
            id: 'big',
            name: 'Big',
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: 'top left' } },
                { r: 1999, c: 499, v: { v: 'bottom right' } },
            ],
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([sheet]);
        expect(cols(out.html)).toBe(192);
        expect(trs(out.html)).toBe(1302);
    }, 30_000);

    test('a sheet left fewer cells than its rows keeps all its columns and the rows that fit', () => {
        const grid = (name: string, rows: number, columns: number): Sheet => ({
            id: name,
            name,
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: name } },
                { r: rows - 1, c: columns - 1, v: { v: name } },
            ],
        });
        // 3,089 rows of 80 columns spend 247,120 cells and leave 2,880.
        const first = grid('first', 3089, 80);
        const second = grid('second', 3925, 20);
        const out = renderSheetsHtml([first, second], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([second]);
        const [firstHtml, secondHtml] = out.html.split('<div class="sheet').slice(1);
        expect(trs(firstHtml)).toBe(3089);
        expect(cols(secondHtml)).toBe(20);
        expect(trs(secondHtml)).toBe(144);
    }, 30_000);

    test('a sheet of exactly the cap is not cut, and one more row cuts a column', () => {
        const grid = (rows: number) =>
            makeSheet([
                { r: 0, c: 0, v: { v: 'top left' } },
                { r: rows - 1, c: 499, v: { v: 'bottom right' } },
            ]);
        const exact = renderSheetsHtml([grid(500)], NO_MEDIA, 'screen');
        expect(exact.cut).toEqual([]);
        expect(tds(exact.html)).toBe(MAX_EXPORT_CELLS);
        const over = renderSheetsHtml([grid(501)], NO_MEDIA, 'screen');
        expect(over.cut).toHaveLength(1);
        expect(trs(over.html)).toBe(501);
        expect(cols(over.html)).toBe(499);
    }, 30_000);

    test('a row whose every column is hidden still counts against the cap, though it prints nothing', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'hidden' } }]),
            config: { colhidden: { 0: 0 }, merge: { '0_0': { r: 0, c: 0, rs: REFERENCE_ROW_COUNT, cs: 1 } } },
        };
        const next = makeSheet([{ r: 0, c: 0, v: { v: 'next' } }]);
        const out = renderSheetsHtml([sheet, next], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([sheet]);
        expect(out.leftOut).toEqual([next]);
        expect(out.html).toBe('');
    }, 30_000);

    test("a border key past Excel's grid sizes the PDF page from the kept window, quickly", () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'top left' } }]),
            config: { borderInfo: { '10000000000_0': { b: { style: 1, color: '#000' } } } },
        };
        const started = performance.now();
        const lost: string[] = [];
        const html = sheetsHtmlDocument({
            title: 'Far',
            sheets: [sheet],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: (code) => lost.push(code),
        });
        // It renders the cap's 250,000 rows, about 14 s on a loaded CI runner; the span walk it guards took 119 s.
        expect(performance.now() - started).toBeLessThan(60_000);
        expect(lost).toEqual(['sheets-cut']);
        expect(trs(html)).toBe(MAX_EXPORT_CELLS);
        const lone = { ...sheet, config: { borderInfo: { '10000000000_0': { b: { style: 1, color: '#000' } } } } };
        expect(renderSheetsHtml([{ ...lone, celldata: [], data: [] }], NO_MEDIA, 'screen')).toMatchObject({
            cut: [],
            size: { width: 0, height: 0 },
        });
    }, 90_000);

    test('the cap is spent across the sheets in tab order, and a sheet with too little left is left out', async () => {
        const forged = (id: string): Sheet => ({
            id,
            name: id,
            order: Number(id.slice(1)),
            celldata: [{ r: 0, c: 0, v: { v: id, m: id } }],
            config: {
                borderInfo: {
                    [`${REFERENCE_ROW_COUNT - 1}_${REFERENCE_COLUMN_COUNT - 1}`]: { b: { style: 1, color: '#000' } },
                },
            },
        });
        const sheets = [forged('s0'), forged('s1'), forged('s2')];
        const out = renderSheetsHtml(sheets, NO_MEDIA, 'screen');
        // The first sheet leaves 16 cells, too few for one row of the next.
        expect(out.cut).toEqual([sheets[0]]);
        expect(out.leftOut).toEqual([sheets[1], sheets[2]]);
        expect(out.html.split('<div class="sheet')).toHaveLength(2);
        expect(classesFor(out, 'page-break-after:always')).toEqual([]);
        expect(tds(out.html)).toBe(192 * 1302);
        expect(out.html).toContain('>s0<');
        expect(out.html).not.toContain('>s1<');
        const doc = new Y.Doc();
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: true }));
        const exported = await renderEigensheetsExport(doc, 'html', 'Forged', async () => []);
        expect(exported.warnings).toEqual([
            { code: 'sheets-cut', count: 1 },
            { code: 'sheets-left-out', count: 2 },
        ]);
    }, 30_000);

    test('the PDF page fits the sheets the export keeps, not one it left out', () => {
        const tall: Sheet = {
            id: 'tall',
            name: 'Tall',
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: 'top' } },
                { r: MAX_EXPORT_CELLS - 1, c: 0, v: { v: 'bottom' } },
            ],
        };
        const wide: Sheet = {
            id: 'wide',
            name: 'Wide',
            order: 1,
            celldata: [{ r: 0, c: 0, v: { v: 'wide' } }],
            config: { columnlen: { 0: 5000 } },
        };
        const lost: string[] = [];
        const html = sheetsHtmlDocument({
            title: 'Two',
            sheets: [tall, wide],
            mediaUrls: NO_MEDIA,
            mode: 'pdf',
            lost: (code) => lost.push(code),
        });
        expect(lost).toEqual(['sheets-left-out']);
        expect(html).toContain('@page { size: 200px 19200px; margin: 40px; }');
        expect(html).not.toContain('>wide<');
    }, 30_000);

    test('a later sheet gets what the earlier ones left, columns first', () => {
        const grid = (name: string, rows: number) =>
            ({
                ...makeSheet([
                    { r: 0, c: 0, v: { v: name } },
                    { r: rows - 1, c: 499, v: { v: name } },
                ]),
                name,
            }) satisfies Sheet;
        const first = grid('first', 400);
        const second = grid('second', 200);
        const out = renderSheetsHtml([first, second], NO_MEDIA, 'screen');
        expect(out.cut).toEqual([second]);
        const [, secondHtml] = out.html.split('<div class="sheet').slice(1);
        expect(trs(secondHtml)).toBe(200);
        expect(cols(secondHtml)).toBe(250);
    }, 30_000);

    test('in a PDF each sheet that draws costs a page of cells, so a workbook of tiny sheets is cut', () => {
        const tiny = (i: number): Sheet => ({
            id: `s${i}`,
            name: `S${i}`,
            order: i,
            celldata: [{ r: 0, c: 0, v: { v: i, m: String(i) } }],
        });
        const blank: Sheet = { id: 'blank', name: 'Blank', order: 2005, celldata: [] };
        const sheets = [...Array.from({ length: 2005 }, (_, i) => tiny(i)), blank];
        const exported = (mode: 'pdf' | 'screen') => {
            const lost: string[] = [];
            const html = sheetsHtmlDocument({
                title: 'Tiny',
                sheets,
                mediaUrls: NO_MEDIA,
                mode,
                lost: (code) => lost.push(code),
            });
            return { html, lost };
        };
        // The PDF prints the first 2,000, and the blank sheet, which takes no page, is not counted.
        const pdf = exported('pdf');
        expect(pdf.lost).toEqual(Array(5).fill('sheets-left-out'));
        expect(tds(pdf.html)).toBe(2000);
        expect(pdf.html).toContain('>1999<');
        expect(pdf.html).not.toContain('>2000<');
        // The HTML download has no pages to pay for, so it keeps every sheet.
        const screen = exported('screen');
        expect(screen.lost).toEqual([]);
        expect(tds(screen.html)).toBe(2005);
    }, 30_000);

    // A row starts the next page when it doesn't fit what is left of one, so a row taller than half a page prints a
    // page of its own.
    test('in a PDF a sheet costs a page of cells for each page it prints, so tall rows are cut to the pages the cap holds', () => {
        const tall = (id: string, rowHeight: number): Sheet => ({
            id,
            name: id,
            order: 0,
            defaultRowHeight: rowHeight,
            celldata: [
                { r: 0, c: 0, v: { v: 'first', m: 'first' } },
                { r: 3999, c: 0, v: { v: 'last', m: 'last' } },
            ],
        });
        const next: Sheet = {
            id: 'next',
            name: 'next',
            order: 1,
            celldata: [{ r: 0, c: 0, v: { v: 'next', m: 'next' } }],
        };
        for (const height of [19_200, 10_000]) {
            const pdf = renderSheetsHtml([tall('tall', height), next], NO_MEDIA, 'pdf');
            expect(trs(pdf.html)).toBe(2000);
            expect(pdf.cut.map((sheet) => sheet.id)).toEqual(['tall']);
            expect(pdf.leftOut).toEqual([next]);
            // The HTML download has no pages to pay for.
            expect(trs(renderSheetsHtml([tall('tall', height), next], NO_MEDIA, 'screen').html)).toBe(4001);
        }
        // Two rows of 9,000 px share a page, so 4,000 of them print on the 2,000 pages the cap holds.
        const shared = renderSheetsHtml([tall('shared', 9000)], NO_MEDIA, 'pdf');
        expect(trs(shared.html)).toBe(4000);
        expect(shared.cut).toEqual([]);
    }, 30_000);

    test('in a PDF an image parked far below the cells costs the pages it stretches the sheet over', () => {
        const parked = (id: string): Sheet => ({
            id,
            name: id,
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: id, m: id } }],
            images: imagesOf({ id: 'img', mediaName: 'm', x: 0, y: 30_000_000, width: 10, height: 10 }),
        });
        // Clamped to the bottom of Excel's grid, each image stretches its sheet over 1,097 pages.
        const pdf = renderSheetsHtml([parked('a'), parked('b')], NO_MEDIA, 'pdf');
        expect(pdf.leftOut.map((sheet) => sheet.id)).toEqual(['b']);
        expect(renderSheetsHtml([parked('a'), parked('b')], NO_MEDIA, 'screen').leftOut).toEqual([]);
    }, 30_000);

    test('a sheet under the cap is not cut and carries no warning', async () => {
        const sheet: Sheet = { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [{ r: 0, c: 0, v: { v: 'x' } }] };
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').cut).toEqual([]);
        const doc = new Y.Doc();
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot([sheet], { computed: true }));
        expect((await renderEigensheetsExport(doc, 'html', 'Small', async () => [])).warnings).toEqual([]);
    });
});

// Forged keys a peer can write into a snapshot: each must cost what the window renders, not what the key names.
describe('Sheets HTML export — the window over forged keys', () => {
    const tds = (html: string) => html.match(/<td/g)?.length ?? 0;
    const cols = (html: string) => html.match(/<col /g)?.length ?? 0;
    const trs = (html: string) => html.match(/<tr /g)?.length ?? 0;
    const border = { b: { style: 1, color: '#000' } };
    const farCorner = `${REFERENCE_ROW_COUNT - 1}_${REFERENCE_COLUMN_COUNT - 1}`;
    const topLeft = (config: Sheet['config'], id = 'sheet'): Sheet => ({
        id,
        name: id,
        order: 0,
        celldata: [{ r: 0, c: 0, v: { v: 'top left', m: 'top left' } }],
        config,
    });
    const timed = <T>(run: () => T): { out: T; ms: number } => {
        const started = performance.now();
        const out = run();
        return { out, ms: performance.now() - started };
    };

    test('a border key or a merge far above the grid is dropped, and A1 renders alone', () => {
        for (const config of [
            { borderInfo: { '-1000000000_0': border } },
            { merge: { '0_0': { r: -1_000_000_000, c: 0, rs: 1, cs: 1 } } },
        ]) {
            const { out, ms } = timed(() => renderSheetsHtml([topLeft(config)], NO_MEDIA, 'screen'));
            expect(ms).toBeLessThan(2_000);
            expect(out.cut).toEqual([]);
            expect(trs(out.html)).toBe(1);
            expect(out.html).toContain('>top left<');
        }
    }, 30_000);

    test('a rule whose range starts far above the grid is clipped to the window before it is evaluated', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const sheet = makeSheet(
            [{ r: 0, c: 0, v: cell }],
            [
                {
                    type: 'default',
                    cellrange: [{ row: [-50_000_000, 0], column: [0, 0] }],
                    format: { textColor: '#ff0000', cellColor: '#00ff00' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: [1],
                },
            ],
        );
        const { out, ms } = timed(() => renderSheetsHtml([sheet], NO_MEDIA, 'screen'));
        expect(ms).toBeLessThan(2_000);
        expect(classesFor(out, 'background:#00ff00')).toHaveLength(1);
    }, 30_000);

    test('a sheet whose every row is hidden still spends a cell for each column it keeps', () => {
        const sheets = Array.from({ length: 20 }, (_, i) =>
            topLeft({ rowhidden: { 0: 0 }, borderInfo: { [`0_${REFERENCE_COLUMN_COUNT - 1}`]: border } }, `s${i}`),
        );
        const { out, ms } = timed(() => renderSheetsHtml(sheets, NO_MEDIA, 'screen'));
        expect(ms).toBeLessThan(2_000);
        // Fifteen sheets keep all 16,384 columns, the sixteenth the 4,240 cells left, and the rest are left out. None
        // of them prints.
        expect(out.html).toBe('');
        expect(out.cut).toEqual([sheets[15]]);
        expect(out.leftOut).toEqual(sheets.slice(16));
    }, 30_000);

    test('merges that overlap an earlier one are dropped before the border fold', () => {
        const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
        for (let i = 0; i < 500; i++)
            merge[`${i}_0`] = { r: i, c: 0, rs: REFERENCE_ROW_COUNT, cs: REFERENCE_COLUMN_COUNT };
        const { out, ms } = timed(() =>
            renderSheetsHtml([topLeft({ merge, borderInfo: { '0_0': border } })], NO_MEDIA, 'screen'),
        );
        expect(ms).toBeLessThan(2_000);
        expect(tds(out.html)).toBe(1);
        expect(out.html).toContain('colspan="192"');
        expect(out.html).toContain('rowspan="1302"');
    }, 30_000);

    test('a hundred thousand merges across the full width cost no walk over the columns each one spans', () => {
        const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {
            first: { r: 0, c: REFERENCE_COLUMN_COUNT - 1, rs: 2, cs: 1 },
        };
        for (let i = 0; i < 100_000; i++) merge[`m${i}`] = { r: 1, c: 0, rs: 1, cs: REFERENCE_COLUMN_COUNT };
        const { out, ms } = timed(() => renderSheetsHtml([topLeft({ merge })], NO_MEDIA, 'screen'));
        expect(ms).toBeLessThan(1_000);
        // Every full-width merge overlaps the first one's last column, so only that one is kept.
        expect(out.html).toContain('<td rowspan="2" class=');
        expect(out.html).not.toContain('colspan');
        expect(tds(out.html)).toBe(2 * REFERENCE_COLUMN_COUNT - 1);
    }, 30_000);

    test('a merge that overlaps one kept before it in reading order is dropped, and one clear of them is kept', () => {
        const sheet = topLeft({
            merge: {
                tall: { r: 0, c: 2, rs: 3, cs: 1 },
                acrossTall: { r: 1, c: 0, rs: 1, cs: 5 },
                beside: { r: 2, c: 0, rs: 1, cs: 2 },
                below: { r: 3, c: 0, rs: 1, cs: 5 },
                sameAnchor: { r: 3, c: 0, rs: 1, cs: 1 },
            },
        });
        const rowsOf = (html: string) =>
            html
                .match(/<tr [^>]*>.*?<\/tr>/g)
                ?.map((tr) => tr.match(/<td[^>]*>/g)?.map((td) => td.replace(/ class="s\d+"/, '')));
        expect(rowsOf(renderSheetsHtml([sheet], NO_MEDIA, 'screen').html)).toEqual([
            ['<td>', '<td>', '<td rowspan="3">', '<td>', '<td>'],
            ['<td>', '<td>', '<td>', '<td>'],
            ['<td colspan="2">', '<td>', '<td>'],
            ['<td colspan="5">'],
        ]);
    });

    test('a merge whose edge row or column is hidden still draws its four outer borders', () => {
        const side = { style: 1, color: '#000000' };
        const borderInfo: Record<string, CellBorderSides> = {};
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 2; c++) {
                borderInfo[`${r}_${c}`] = {
                    ...(r === 0 && { t: side }),
                    ...(r === 2 && { b: side }),
                    ...(c === 0 && { l: side }),
                    ...(c === 1 && { r: side }),
                };
            }
        }
        const box = (hidden: Sheet['config']): Sheet => ({
            id: 'box',
            name: 'Box',
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: 'm', m: 'm' } },
                { r: 4, c: 3, v: { v: 'z', m: 'z' } },
            ],
            config: { merge: { '0_0': { r: 0, c: 0, rs: 3, cs: 2 } }, borderInfo, ...hidden },
        });
        const hiddens: Sheet['config'][] = [
            {},
            { rowhidden: { 2: 0 } },
            { colhidden: { 1: 0 } },
            { rowhidden: { 0: 0 } },
        ];
        for (const hidden of hiddens) {
            const out = renderSheetsHtml([box(hidden)], NO_MEDIA, 'screen');
            const cls = out.html.match(/<td[^>]*class="(s\d+)"[^>]*><div[^>]*>m</)?.[1];
            const declarations = out.css.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))?.[1].split(';');
            expect(declarations?.filter((d) => d.startsWith('border-')).sort()).toEqual([
                'border-bottom:1px solid #000000',
                'border-left:1px solid #000000',
                'border-right:1px solid #000000',
                'border-top:1px solid #000000',
            ]);
        }
    });

    test('a null rule, a rule with no ranges, or a range with no rows, is dropped and the export still renders', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const valid: ConditionalFormatRule = {
            type: 'default',
            cellrange: [{ row: [0, 0], column: [0, 0] }],
            format: { cellColor: '#00ff00' },
            conditionName: 'greaterThan',
            conditionRange: [],
            conditionValue: [1],
        };
        const { cellrange: _, ...noRanges } = valid;
        const forged = [
            null,
            noRanges,
            { ...valid, cellrange: [{ row: null, column: [0, 0] }] },
            { ...valid, cellrange: [null] },
        ];
        // A peer's values reach the export untyped, as JSON.parse returns them.
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: cell }]),
            conditionalFormatRules: JSON.parse(JSON.stringify([...forged, valid])),
        };
        const nullMerge: Sheet = JSON.parse(JSON.stringify({ ...sheet, config: { merge: { '0_0': null } } }));
        const out = renderSheetsHtml([nullMerge], NO_MEDIA, 'screen');
        expect(classesFor(out, 'background:#00ff00')).toHaveLength(1);
        expect(renderSheetsPreviewHtml([sheet], NO_MEDIA).html).toContain('background:#00ff00');
    });

    test('a rule whose values, looks or colors a peer forged is dropped, and the export and the preview still render', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const at = [{ row: [5, 6], column: [0, 0] }];
        const red = { cellColor: '#ff0000' };
        // As a peer's update arrives: JSON no type checked. The formula rule starts above the window, so its anchor moves.
        const forged = JSON.parse(
            JSON.stringify([
                {
                    type: 'default',
                    conditionName: 'formula',
                    cellrange: [{ row: [0, 10], column: [0, 0] }],
                    format: red,
                    conditionValue: null,
                },
                { type: 'default', conditionName: 'greaterThan', cellrange: at, format: red },
                { type: 'default', conditionName: 'greaterThan', cellrange: at, conditionValue: [1] },
                { type: 'default', conditionName: 'equal', cellrange: at, format: red, conditionValue: [null] },
                { type: 'dataBar', cellrange: at },
                { type: 'colorGradation', cellrange: at, format: ['red', 'blue'] },
                {
                    type: 'default',
                    conditionName: 'greaterThan',
                    cellrange: [{ row: [6, 5], column: [0, 0] }],
                    format: red,
                    conditionValue: [1],
                },
            ]),
        );
        const valid: ConditionalFormatRule = {
            type: 'default',
            cellrange: [{ row: [5, 6], column: [0, 0] }],
            format: { cellColor: '#00ff00' },
            conditionName: 'greaterThan',
            conditionRange: [],
            conditionValue: [1],
        };
        const sheet = makeSheet(
            [
                { r: 5, c: 0, v: cell },
                { r: 6, c: 0, v: cell },
            ],
            [...forged, valid],
        );
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(classesFor(out, 'background:#00ff00')).toHaveLength(1);
        expect(out.css).not.toContain('#ff0000');
        expect(renderSheetsPreviewHtml([sheet], NO_MEDIA).html).toContain('background:#00ff00');
    });

    test('a merge marker, a track map or an image a peer stored as no object is skipped, and the export and the preview still render', () => {
        for (const config of [{ rowlen: 5 }, { rowhidden: 'abc' }, { columnlen: true }, { colhidden: 7 }]) {
            const sheet: Sheet = JSON.parse(
                JSON.stringify({
                    id: 'forged',
                    name: 'forged',
                    order: 0,
                    celldata: [
                        { r: 0, c: 0, v: { mc: 1 } },
                        { r: 0, c: 1, v: { mc: 'x' } },
                        { r: 1, c: 0, v: { v: 'kept', m: 'kept' } },
                    ],
                    config,
                    images: { a: null },
                    charts: { b: 7 },
                }),
            );
            expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').html).toContain('>kept<');
            expect(renderSheetsHtml([sheet], NO_MEDIA, 'pdf').html).toContain('>kept<');
            expect(renderSheetsPreviewHtml([sheet], NO_MEDIA).html).toContain('>kept<');
        }
    });

    // The editor stores an empty list for a rule that takes no value, and the evaluator reads the first one.
    test('a date rule with no value draws nothing and fails nothing', () => {
        const date = { v: 46_000, m: '2025-12-09', ct: { fa: 'yyyy-mm-dd', t: 'd' } };
        const rule: ConditionalFormatRule = {
            type: 'default',
            cellrange: [{ row: [0, 0], column: [0, 0] }],
            format: { cellColor: '#ff0000' },
            conditionName: 'occurrenceDate',
            conditionRange: [],
            conditionValue: [],
        };
        const sheet = makeSheet([{ r: 0, c: 0, v: date }], [rule]);
        expect(renderSheetsHtml([sheet], NO_MEDIA, 'screen').html).toContain('>2025-12-09<');
    });

    test('a sheet whose every row or every column is hidden prints no page, as a blank one prints none', () => {
        const shown = topLeft(undefined, 'shown');
        const rows = topLeft({ rowhidden: { 0: 0 } }, 'rows');
        const columns = topLeft({ colhidden: { 0: 0 } }, 'columns');
        const out = renderSheetsHtml([rows, shown, columns], NO_MEDIA, 'pdf');
        expect(out.html).toBe(renderSheetsHtml([shown], NO_MEDIA, 'pdf').html);
    });

    test('an empty tab between two others adds no page', () => {
        const tab = (id: string, cells: Sheet['celldata']): Sheet => ({ id, name: id, order: 0, celldata: cells });
        const a = tab('a', [{ r: 0, c: 0, v: { v: 'a', m: 'a' } }]);
        const c = tab('c', [{ r: 0, c: 0, v: { v: 'c', m: 'c' } }]);
        expect(renderSheetsHtml([a, tab('empty', []), c], NO_MEDIA, 'screen')).toEqual(
            renderSheetsHtml([a, c], NO_MEDIA, 'screen'),
        );
    });

    test('merges right of the window cost nothing per rendered cell', () => {
        const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
        for (let i = 0; i < 10_000; i++) merge[`0_${1000 + i}`] = { r: 0, c: 1000 + i, rs: REFERENCE_ROW_COUNT, cs: 1 };
        const { out, ms } = timed(() => renderSheetsHtml([topLeft({ merge })], NO_MEDIA, 'screen'));
        expect(ms).toBeLessThan(2_000);
        expect(cols(out.html)).toBe(192);
        expect(trs(out.html)).toBe(1302);
        expect(out.html).not.toContain('colspan');
    }, 30_000);

    test('a merge over many hidden rows expands only over the rows that show', () => {
        const rowhidden = Object.fromEntries(Array.from({ length: 2000 }, (_, r) => [r, 0]));
        const merge = { '0_0': { r: 0, c: 0, rs: 2001, cs: REFERENCE_COLUMN_COUNT } };
        const { out, ms } = timed(() =>
            renderSheetsHtml([topLeft({ rowhidden, merge, borderInfo: { '0_0': border } })], NO_MEDIA, 'screen'),
        );
        expect(ms).toBeLessThan(2_000);
        expect(trs(out.html)).toBe(1);
        expect(tds(out.html)).toBe(1);
        expect(out.html).toContain(`colspan="${REFERENCE_COLUMN_COUNT}"`);
        expect(out.html).toContain('>top left<');
    }, 30_000);

    test('sheets the cap leaves out cost no walk over their rows', () => {
        const sheets = Array.from({ length: 300 }, (_, i) =>
            topLeft({ rowhidden: { 5: 0 }, colhidden: { 5: 0 }, borderInfo: { [farCorner]: border } }, `s${i}`),
        );
        const { out, ms } = timed(() => renderSheetsHtml(sheets, NO_MEDIA, 'screen'));
        expect(ms).toBeLessThan(2_000);
        expect(out.cut).toEqual([sheets[0]]);
        expect(out.leftOut).toHaveLength(299);
    }, 30_000);

    // Each read of a track map, by key or by enumerating it, is counted.
    test('a track map is read no more than its keys, however far the first cell is, and not at all once the cap is spent', () => {
        let reads = 0;
        const counted = (map: Record<string, number>) =>
            new Proxy(map, {
                get: (target, key) => {
                    reads++;
                    return Reflect.get(target, key);
                },
                ownKeys: (target) => {
                    reads++;
                    return Reflect.ownKeys(target);
                },
            });
        const far = (id: string): Sheet => ({
            id,
            name: id,
            order: 0,
            config: {
                borderInfo: { '65535_8191': border },
                rowlen: counted({}),
                rowhidden: counted({ 0: 0 }),
                columnlen: counted({}),
                colhidden: counted({}),
            },
        });
        const kept = renderSheetsHtml([far('kept')], NO_MEDIA, 'screen');
        expect(tds(kept.html)).toBe(1);
        expect(reads).toBeLessThan(100);

        reads = 0;
        const spender = topLeft({ borderInfo: { '1249_199': border } }, 'spender');
        const out = renderSheetsHtml(
            [spender, ...Array.from({ length: 20 }, (_, i) => far(`s${i}`))],
            NO_MEDIA,
            'screen',
        );
        expect(out.leftOut).toHaveLength(20);
        expect(reads).toBe(0);
    }, 30_000);

    test("a merge's span counts the rows and columns that show, so it matches the colgroup", () => {
        const sheet: Sheet = {
            id: 'spans',
            name: 'Spans',
            order: 0,
            celldata: [
                { r: 0, c: 0, v: { v: 'merged', m: 'merged' } },
                { r: 0, c: 3, v: { v: 'after', m: 'after' } },
            ],
            config: { colhidden: { 1: 0 }, rowhidden: { 1: 0 }, merge: { '0_0': { r: 0, c: 0, rs: 3, cs: 3 } } },
        };
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(cols(out.html)).toBe(3);
        expect(out.html).toContain('colspan="2" rowspan="2"');
        expect(out.html).toContain('>after<');

        const cut = topLeft({
            colhidden: { 1: 0 },
            merge: { '0_0': { r: 0, c: 0, rs: REFERENCE_ROW_COUNT, cs: REFERENCE_COLUMN_COUNT } },
        });
        const cutOut = renderSheetsHtml([cut], NO_MEDIA, 'screen');
        expect(cutOut.html).toContain(`colspan="${cols(cutOut.html)}"`);

        // A merge whose first row is hidden draws its text on the first row that shows.
        const hiddenFirst = topLeft({ rowhidden: { 0: 0 }, merge: { '0_0': { r: 0, c: 0, rs: 3, cs: 2 } } });
        const hiddenOut = renderSheetsHtml([hiddenFirst], NO_MEDIA, 'screen');
        expect(trs(hiddenOut.html)).toBe(2);
        expect(hiddenOut.html).toContain('<td colspan="2" rowspan="2" class=');
        expect(hiddenOut.html).toContain('>top left<');
    }, 30_000);

    test('a negative or absurd column width or row height draws as the default, and the page fits what is drawn', () => {
        const sheet = topLeft({
            columnlen: { 0: -1_000_000_000, 1: Number.POSITIVE_INFINITY },
            rowlen: { 0: -5 },
            borderInfo: { [farCorner]: border },
        });
        const out = renderSheetsHtml([sheet], NO_MEDIA, 'screen');
        expect(cols(out.html)).toBe(192);
        expect(out.size).toEqual({ width: 192 * SHEET_DEFAULT_COL_WIDTH, height: 1302 * SHEET_DEFAULT_ROW_HEIGHT });
        expect(classesFor(out, `width:${SHEET_DEFAULT_COL_WIDTH}px`)).toHaveLength(1);
        expect(out.html).not.toContain('-1000000000');
    }, 30_000);
});
