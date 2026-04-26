import { describe, expect, test } from 'bun:test';
import type { Cell, Sheet } from '@workspace/lib/sheets';
import { renderSheetsHtml } from '../lib/export/sheets/html';

// Build a Sheet with both `data` (matrix form, required by the CF engine) and `celldata`
// (sparse form, what the renderer iterates). Snapshots in production carry both — see
// dataToCelldata in apps/api/src/lib/export/sheets/content.ts.
function makeSheet(cells: { r: number; c: number; v: Cell }[], rules?: unknown[]): Sheet {
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
        ...(rules ? { luckysheet_conditionformat_save: rules } : {}),
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
});
