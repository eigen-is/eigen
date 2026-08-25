import { describe, expect, test } from 'bun:test';
import type { Cell, ConditionalFormatRule, Sheet } from '@workspace/lib/sheets';
import {
    getSheetContentSize,
    renderSheetsExportDocument,
    renderSheetsHtml,
    renderSheetsPreviewHtml,
} from '../../lib/export/sheets/render';

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
        const out = renderSheetsHtml([sheet]);
        expect(out.html).not.toContain('style="');
        // The moved base td style lives in the stylesheet exactly once.
        expect(out.css).toContain('td{overflow:hidden;white-space:nowrap;padding:1px 2px}');
    });

    test('identical cell styles dedupe into one class referenced by every cell', () => {
        const out = renderSheetsHtml([
            makeSheet([
                { r: 0, c: 0, v: { v: 'a', fc: '#ff0000' } },
                { r: 0, c: 1, v: { v: 'b', fc: '#ff0000' } },
                { r: 1, c: 0, v: { v: 'c', fc: '#00ff00' } },
            ]),
        ]);
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
        const out = renderSheetsHtml([sheet]);
        expect(out.html).toContain('<td></td>');
    });

    test('grid borders intern as a shared class when showGridLines is on', () => {
        const out = renderSheetsHtml([
            makeSheet([
                { r: 0, c: 0, v: { v: 'a' } },
                { r: 0, c: 1, v: { v: 'b' } },
            ]),
        ]);
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
        const out = renderSheetsHtml([sheet]);
        const height = classesFor(out, 'height:30px');
        expect(height.length).toBe(1);
        expect(out.html.match(new RegExp(`<tr class="${height[0]}">`, 'g'))?.length).toBe(2);
        const width = classesFor(out, 'width:120px');
        expect(width.length).toBe(1);
        expect(out.html).toContain(`<col class="${width[0]}">`);
    });

    test('the table style interns with real quotes around the font family', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])]);
        const table = classesFor(out, 'border-collapse:collapse');
        expect(table.length).toBe(1);
        expect(out.css).toContain('font-family:"Inter",system-ui,sans-serif');
        expect(out.css).not.toContain('&quot;');
    });

    test('non-last sheets carry the page-break class next to .sheet', () => {
        const out = renderSheetsHtml([
            makeSheet([{ r: 0, c: 0, v: { v: 'one' } }]),
            makeSheet([{ r: 0, c: 0, v: { v: 'two' } }]),
        ]);
        const brk = classesFor(out, 'page-break-after:always');
        expect(brk.length).toBe(1);
        expect(out.html).toContain(`<div class="sheet ${brk[0]}">`);
        // The last sheet has no break.
        expect(out.html).toContain('<div class="sheet">');
    });

    test('the export document embeds the class rules in a body style element', () => {
        const doc = renderSheetsExportDocument([makeSheet([{ r: 0, c: 0, v: { v: 'x' } }])], 'T');
        // The generated rules survive sanitization into the final document.
        expect(doc).toContain('border:1px solid #d4d4d4');
        expect(doc).toMatch(/<style>[^<]*td\{overflow:hidden/);
        expect(doc).toMatch(/class="s\d+"/);
    });

    test('a hostile url() in a cell background is stripped from the document CSS', () => {
        const doc = renderSheetsExportDocument(
            [makeSheet([{ r: 0, c: 0, v: { v: 'x', bg: 'url(http://evil.test/ssrf)' } }])],
            'T',
        );
        expect(doc).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    // Every value below is a schemaless CRDT string a collaborator (or a crafted xlsx)
    // can set. In a style attribute they were inert; in stylesheet text `</style>` ends
    // the element and whatever follows is live markup — DOMPurify keeps an
    // <svg><image href>, and WeasyPrint fetches it server-side while rendering the PDF.
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
            expectNoBreakout(renderSheetsExportDocument([makeSheet([{ r: 0, c: 0, v: cell }])], 'T'));
        }
    });

    test('hostile row/column dimensions cannot terminate the style element', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'x' } }]);
        sheet.config = {
            columnlen: { 0: BREAKOUT as unknown as number },
            rowlen: { 0: BREAKOUT as unknown as number },
        };
        const doc = renderSheetsExportDocument([sheet], 'T');
        expectNoBreakout(doc);
        // Non-numeric dimensions fall back to the defaults rather than concatenating —
        // the same coercion getSheetContentSize applies for the @page rule.
        expect(doc).toContain('width:73px');
        expect(doc).toContain('height:19px');
        expect(doc).not.toContain('169.254.169.254');
    });

    test('a backslash or comment opener cannot swallow the rules that follow', () => {
        // `font-family:"Foo\"` escapes its own closing quote, and `red/*` opens a comment:
        // in one shared stylesheet either would eat every later rule, so one odd cell
        // would strip the styling off the rest of the workbook.
        for (const bad of ['Foo\\', 'Foo/*']) {
            const out = renderSheetsHtml([
                makeSheet([
                    { r: 0, c: 0, v: { v: 'a', ff: bad } },
                    { r: 0, c: 1, v: { v: 'b', bg: '#654321' } },
                ]),
            ]);
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
        const { html } = renderSheetsPreviewHtml([sheet]);
        expect(html).toContain('style="');
        expect(html).toContain('color:#ff0000');
        // Attribute context keeps the encoded font-family quotes.
        expect(html).toContain('font-family:&quot;Georgia&quot;');
        expect(html).not.toMatch(/class="s\d/);
    });
});

describe('Sheets HTML export — conditional formatting', () => {
    test('sheet with no CF rules renders no position overlays', () => {
        const out = renderSheetsHtml([
            makeSheet([
                { r: 0, c: 0, v: { v: 'Hello', ct: { t: 's', fa: 'General' } } },
                { r: 0, c: 1, v: { v: 42, ct: { t: 'n', fa: 'General' } } },
            ]),
        ]);
        expect(out.html).toContain('Hello');
        expect(out.html).toContain('42');
        // No conditional formatting → no CF-injected dataBar anchors.
        expect(out.css).not.toContain('position:relative');
        expect(out.css).not.toContain('position:absolute');
    });

    test('greaterThan rule applies cellColor as background on matching cells', () => {
        const out = renderSheetsHtml([
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
        ]);
        // Second cell (value 50, > 10) gets the CF colors.
        const cls = classesFor(out, 'background:#ff8888');
        expect(cls.length).toBe(1);
        expect(out.css).toContain('color:#ffffff');
        expect(useCount(out, cls[0])).toBe(1);
    });

    test('dataBar rule renders an absolutely-positioned bar div', () => {
        const out = renderSheetsHtml([
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
        ]);
        // Bar divs are positioned absolutely inside position:relative <td>s; each width is
        // proportional to the value, so the three bars produce three distinct classes.
        expect(classesFor(out, 'position:absolute').length).toBe(3);
        expect(classesFor(out, 'position:relative').length).toBeGreaterThan(0);
        expect(out.css).toContain('#638ec6');
        // Display text wrapped in a span with z-index above the bar.
        const zSpan = classesFor(out, 'z-index:1');
        expect(zSpan.length).toBe(1);
        expect(out.html).toContain(`<span class="${zSpan[0]}">10</span>`);
    });

    test('colorGradation 2-color rule paints min/max cells with the configured stops', () => {
        const out = renderSheetsHtml([
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
        ]);
        expect(out.css).toContain('background:#ff0000');
        expect(out.css).toContain('background:#00ff00');
    });

    test('colorGradation update on existing computeMap entry keeps the gradient color', () => {
        // Regression: the colorGradation if-arm used to read format.cellColor on an
        // array-shaped format, blanking the cell color when a prior rule had already
        // populated computeMap[`${r}_${c}`]. Two overlapping rules force that path —
        // greaterThan seeds the entry, then colorGradation must overwrite it with the
        // 2-color min stop (format[1]).
        const out = renderSheetsHtml([
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
        ]);
        expect(out.css).toContain('background:#0000ff');
        expect(out.css).not.toContain('background:#888888');
    });

    test('dataBar with mixed positive/negative values uses red for the negative bar', () => {
        const out = renderSheetsHtml([
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
        ]);
        // Negative bar is hardcoded red — matches canvas painter (canvas.ts ~line 1683).
        // Positive bar still uses the user-configured color.
        expect(out.css).toContain('#ff0000');
        expect(out.css).toContain('#638ec6');
    });

    test('formula rule with relative refs fires per-cell after anchor-relative shifting', () => {
        // 2x2 grid; CF formula `A1>10` is anchor-relative — each target cell evaluates the
        // formula with refs shifted from the anchor (0,0). Cells (0,1) and (1,0) hold values
        // > 10 so the rule fires; (0,0) and (1,1) hold ≤ 10 so it does not.
        const out = renderSheetsHtml([
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
        ]);
        // Two cells fire — both share one interned class, referenced twice.
        const cls = classesFor(out, 'background:#00aa00');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(2);
        expect(out.css).toContain('color:#ffffff');
    });

    test('formula rule with absolute refs uses the anchor value for every target cell', () => {
        // `$A$1>10` — A1 is frozen, so all four cells in the range evaluate the same
        // condition (A1=15 > 10 → true → all four cells get the style).
        const out = renderSheetsHtml([
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
        ]);
        const cls = classesFor(out, 'background:#ffaa00');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(4);
    });

    test('formula rule using AND() across two columns shifts both refs together', () => {
        // Verifies the token-aware shift inside function calls — `=AND(A1>0, B1>0)` on a 2-row
        // range becomes `=AND(A2>0, B2>0)` for row 1. Only row 0 has both columns > 0.
        const out = renderSheetsHtml([
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
        ]);
        // Only the (0,0) cell satisfies; (1,0) reads A2/B2 where B2=-5 fails.
        const cls = classesFor(out, 'background:#88ccff');
        expect(cls.length).toBe(1);
        expect(useCount(out, cls[0])).toBe(1);
    });
});

describe('Sheets HTML export — cell styling', () => {
    test('ff (font family) uses real quotes in the stylesheet and keeps later declarations', () => {
        const out = renderSheetsHtml([
            makeSheet([{ r: 0, c: 0, v: { v: 'styled', ff: 'Georgia', fc: '#ff0000', bg: '#0000ff' } }]),
        ]);
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
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x', ff: "Bell MT & O'Neill" } }])]);
        expect(out.css).toContain('font-family:"Bell MT & ONeill",sans-serif');
        expect(out.css).not.toContain('&amp;');
        expect(out.css).not.toContain('&#39;');
    });

    test('rt as a positive angle produces a CSS rotate anchored at bottom-left', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'up', rt: 45 } }])]);
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
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'down', rt: -90 } }])]);
        expect(out.css).toContain('position:relative');
        expect(out.css).toContain('position:absolute;left:0;top:0');
        expect(out.css).toContain('transform-origin:left top');
        // |sin(-90°)|em = 1.000em, exactly one line-height of compensation.
        expect(out.css).toContain('transform:translateX(1.000em) rotate(90deg)');
    });

    test('rotated cells skip ht/vt in favour of position:relative', () => {
        // The rotated span is absolutely-positioned in the cell, so emitting text-align
        // or vertical-align on the td has nothing to act on. Confirms we don't drag the
        // user's ht=center / vt=middle into a now-meaningless td-level declaration.
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'centered', rt: 45, ht: 0, vt: 0 } }])]);
        expect(out.css).toContain('position:relative');
        expect(out.css).not.toContain('text-align:center');
        expect(out.css).not.toContain('vertical-align:middle');
        expect(out.css).not.toContain('text-align:left');
    });

    test('rt = "vertical" produces vertical writing-mode', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'stacked', rt: 'vertical' } }])]);
        expect(out.css).toContain('writing-mode:vertical-rl');
        expect(out.css).toContain('text-orientation:upright');
    });

    test('rt = 0 or unset emits no rotation wrapper', () => {
        const out = renderSheetsHtml([
            makeSheet([
                { r: 0, c: 0, v: { v: 'plain' } },
                { r: 1, c: 0, v: { v: 'zero', rt: 0 } },
            ]),
        ]);
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
        const out = renderSheetsHtml([sheet]);
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
        const out = renderSheetsHtml([sheet]);
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
    test('escapes fc and bg so they cannot inject markup through the stylesheet', () => {
        const out = renderSheetsHtml([
            makeSheet([{ r: 0, c: 0, v: { v: 'x', fc: 'red;"><script>alert(1)</script>', bg: 'blue">' } }]),
        ]);
        expect(out.css).not.toMatch(/<script/i);
        expect(out.css).toContain('&lt;script');
        expect(out.html).not.toMatch(/<script/i);
    });

    test('braces in a hostile value cannot open or close CSS rule blocks', () => {
        const out = renderSheetsHtml([makeSheet([{ r: 0, c: 0, v: { v: 'x', bg: 'red}td{display:none' } }])]);
        expect(out.css).not.toContain('{display:none');
        expect(out.css).not.toContain('td{display');
        // Every rule stays balanced: strip the well-formed rules and nothing may remain.
        expect(out.css.replace(/[^{}]*\{[^{}]*\}\n?/g, '')).toBe('');
    });

    test('escapes conditional-format colors', () => {
        const out = renderSheetsHtml([
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
        ]);
        expect(out.css).not.toMatch(/<script/i);
        expect(out.html).not.toMatch(/<script/i);
    });

    test('escapes border colors', () => {
        const sheet: Sheet = {
            ...makeSheet([{ r: 0, c: 0, v: { v: 'x' } }]),
            config: {
                borderInfo: [
                    {
                        rangeType: 'cell',
                        value: { row_index: 0, col_index: 0, b: { style: 1, color: 'red;"><script>x</script>' } },
                    },
                ],
            },
        };
        const out = renderSheetsHtml([sheet]);
        expect(out.css).not.toMatch(/<script/i);
        expect(out.html).not.toMatch(/<script/i);
    });

    test('escapes dataBar colors', () => {
        const out = renderSheetsHtml([
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
        ]);
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
        // Bad column → DEFAULT_COL_WIDTH (73), bad row → DEFAULT_ROW_HEIGHT (19).
        expect(getSheetContentSize(sheet)).toEqual({ width: 73 + 100, height: 25 + 19 });
    });
});
