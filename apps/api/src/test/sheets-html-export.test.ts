import { describe, expect, test } from 'bun:test';
import type { Cell, ConditionalFormatRule, Sheet } from '@workspace/lib/sheets';
import { getSheetContentSize, renderSheetsHtml } from '../lib/export/sheets/render';

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

describe('Sheets HTML export — conditional formatting', () => {
    test('sheet with no CF rules renders unchanged', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'Hello', ct: { t: 's', fa: 'General' } } },
            { r: 0, c: 1, v: { v: 42, ct: { t: 'n', fa: 'General' } } },
        ]);
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('Hello');
        expect(html).toContain('42');
        // No conditional formatting → no CF-injected dataBar anchors. Match inline-style
        // attributes specifically so unrelated future uses of `position:` don't trip this.
        expect(html).not.toMatch(/style="[^"]*position:relative/);
        expect(html).not.toMatch(/style="[^"]*position:absolute/);
    });

    test('greaterThan rule applies cellColor as background on matching cells', () => {
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        // Second cell (value 50, > 10) gets the CF colors. Inline style is concatenated, no spaces
        // between properties — match the generated form.
        expect(html).toContain('background:#ff8888');
        expect(html).toContain('color:#ffffff');
    });

    test('dataBar rule renders an absolutely-positioned bar div', () => {
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        // Bar div is positioned absolutely inside a position:relative <td>.
        expect(html).toContain('position:relative');
        expect(html).toContain('position:absolute');
        expect(html).toContain('#638ec6');
        // Display text wrapped in a span with z-index above the bar.
        expect(html).toMatch(/<span style="position:relative;z-index:1">10<\/span>/);
    });

    test('colorGradation 2-color rule paints min/max cells with the configured stops', () => {
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('background:#ff0000');
        expect(html).toContain('background:#00ff00');
    });

    test('colorGradation update on existing computeMap entry keeps the gradient color', () => {
        // Regression: the colorGradation if-arm used to read format.cellColor on an
        // array-shaped format, blanking the cell color when a prior rule had already
        // populated computeMap[`${r}_${c}`]. Two overlapping rules force that path —
        // greaterThan seeds the entry, then colorGradation must overwrite it with the
        // 2-color min stop (format[1]).
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('background:#0000ff');
        expect(html).not.toContain('background:#888888');
    });

    test('dataBar with mixed positive/negative values uses red for the negative bar', () => {
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        // Negative bar is hardcoded red — matches canvas painter (canvas.ts ~line 1683).
        // Positive bar still uses the user-configured color.
        expect(html).toContain('#ff0000');
        expect(html).toContain('#638ec6');
    });

    test('formula rule with relative refs fires per-cell after anchor-relative shifting', () => {
        // 2x2 grid; CF formula `A1>10` is anchor-relative — each target cell evaluates the
        // formula with refs shifted from the anchor (0,0). Cells (0,1) and (1,0) hold values
        // > 10 so the rule fires; (0,0) and (1,1) hold ≤ 10 so it does not.
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        // Two cells fire — match the green cellColor twice in the output.
        const matches = html.match(/background:#00aa00/g) ?? [];
        expect(matches.length).toBe(2);
        expect(html).toContain('color:#ffffff');
    });

    test('formula rule with absolute refs uses the anchor value for every target cell', () => {
        // `$A$1>10` — A1 is frozen, so all four cells in the range evaluate the same
        // condition (A1=15 > 10 → true → all four cells get the style).
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        const matches = html.match(/background:#ffaa00/g) ?? [];
        expect(matches.length).toBe(4);
    });

    test('formula rule using AND() across two columns shifts both refs together', () => {
        // Verifies the token-aware shift inside function calls — `=AND(A1>0, B1>0)` on a 2-row
        // range becomes `=AND(A2>0, B2>0)` for row 1. Only row 0 has both columns > 0.
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        // Only the (0,0) cell satisfies; (1,0) reads A2/B2 where B2=-5 fails.
        const matches = html.match(/background:#88ccff/g) ?? [];
        expect(matches.length).toBe(1);
    });
});

describe('Sheets HTML export — cell styling', () => {
    test('ff (font family) is HTML-escaped so it does not break the style attribute', () => {
        // Regression: emitting `font-family:"Georgia"` with literal quotes inside the
        // style="..." attribute closed the attribute early, dropping every later
        // declaration (color, background, etc.). The fix encodes the quotes as &quot;.
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'styled', ff: 'Georgia', fc: '#ff0000', bg: '#0000ff' } }]);
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('font-family:&quot;Georgia&quot;');
        // The crucial assertion: declarations after font-family must survive.
        expect(html).toContain('color:#ff0000');
        expect(html).toContain('background:#0000ff');
        // No raw double-quote inside a font-family declaration.
        expect(html).not.toMatch(/font-family:"[^&]/);
    });

    test('rt as a positive angle produces a CSS rotate anchored at bottom-left', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'up', rt: 45 } }]);
        const html = renderSheetsHtml([sheet]);
        // rt is CCW-positive (matches Excel/OOXML); CSS rotate is CW-positive — so the
        // emitted angle is the negation. Positive rt anchors at the cell's bottom-left;
        // the td gets `position:relative` so the span absolute-positions to that corner.
        expect(html).toContain('position:relative');
        expect(html).toContain('position:absolute;left:0;bottom:0');
        expect(html).toContain('transform-origin:left bottom');
        // translateX runs after rotate (CSS reads right-to-left), and equals
        // |sin(rt)|em — the same `textHeight * sin(rt)` left offset canvas uses.
        expect(html).toContain('transform:translateX(0.707em) rotate(-45deg)');
    });

    test('rt as a negative angle anchors the rotation at top-left', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'down', rt: -90 } }]);
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('position:relative');
        expect(html).toContain('position:absolute;left:0;top:0');
        expect(html).toContain('transform-origin:left top');
        // |sin(-90°)|em = 1.000em, exactly one line-height of compensation.
        expect(html).toContain('transform:translateX(1.000em) rotate(90deg)');
    });

    test('rotated cells skip ht/vt in favour of position:relative', () => {
        // The rotated span is absolutely-positioned in the cell, so emitting text-align
        // or vertical-align on the td has nothing to act on. Confirms we don't drag the
        // user's ht=center / vt=middle into a now-meaningless td-level declaration.
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'centered', rt: 45, ht: 0, vt: 0 } }]);
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('position:relative');
        expect(html).not.toContain('text-align:center');
        expect(html).not.toContain('vertical-align:middle');
        expect(html).not.toContain('text-align:left');
    });

    test('rt = "vertical" produces vertical writing-mode', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'stacked', rt: 'vertical' } }]);
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain('writing-mode:vertical-rl');
        expect(html).toContain('text-orientation:upright');
    });

    test('rt = 0 or unset emits no rotation wrapper', () => {
        const sheet = makeSheet([
            { r: 0, c: 0, v: { v: 'plain' } },
            { r: 1, c: 0, v: { v: 'zero', rt: 0 } },
        ]);
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toContain('transform:rotate');
        expect(html).not.toContain('writing-mode:vertical');
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
        const html = renderSheetsHtml([sheet]);
        expect(html).toContain(
            '<a href="https://example.com/browse?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Jira ticket</a>',
        );
        // Scheme-less addresses get the same https:// resolution FE navigation uses.
        expect(html).toContain(
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
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toContain('<a ');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('click me');
        expect(html).toContain('go to sheet');
    });
});

// Cell colors come from the sheet snapshot (schemaless — a collaborator can set any string).
// Like the font-family case above, they must not break out of the style="…" attribute.
describe('Sheets HTML export — color escaping', () => {
    test('escapes fc and bg so they cannot break out of the style attribute', () => {
        const sheet = makeSheet([{ r: 0, c: 0, v: { v: 'x', fc: 'red;"><script>alert(1)</script>', bg: 'blue">' } }]);
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&lt;script');
        expect(html).toContain('&quot;');
    });

    test('escapes conditional-format colors', () => {
        const sheet = makeSheet(
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
        );
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
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
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
    });

    test('escapes dataBar colors', () => {
        const sheet = makeSheet(
            [
                { r: 0, c: 0, v: { v: 10, ct: { t: 'n', fa: 'General' } } },
                { r: 1, c: 0, v: { v: 20, ct: { t: 'n', fa: 'General' } } },
            ],
            [{ type: 'dataBar', cellrange: [{ row: [0, 1], column: [0, 0] }], format: ['red;"><script>x</script>'] }],
        );
        const html = renderSheetsHtml([sheet]);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
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
