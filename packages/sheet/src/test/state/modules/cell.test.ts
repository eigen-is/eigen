// Cell text is a schemaless CRDT string — authored by any collaborator, or carried
// in from an uploaded xlsx — and getInlineStringHTML writes it into the formula bar
// and the in-cell editor through innerHTML. The package used to guard those writes
// with its own escapeHTMLTag, which handed back anything starting with `<span` or
// `=` unescaped: a stored-XSS vector against every viewer, read-only included.
// escapeHtml itself is pinned in packages/lib/src/test/core/html.test.ts.

import { describe, expect, test } from 'bun:test';
import { unescapeHtml } from '@workspace/lib/html';
import { getCellValue, getFormulaHtml, getInlineStringHTML } from '../../../state/modules/cell';
import type { CellMatrix } from '../../../state/types';

describe('state/modules/cell — getInlineStringHTML', () => {
    function inlineCell(runs: { v: string; fc?: string }[]): CellMatrix {
        return [[{ ct: { t: 'inlineStr', fa: 'General', s: runs } }]] as unknown as CellMatrix;
    }

    test('escapes the text of each rich-text run', () => {
        const html = getInlineStringHTML(0, 0, inlineCell([{ v: '<img src=q onerror=alert(1)>' }]));
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=q onerror=alert(1)&gt;');
    });

    test('a style value cannot close its own attribute', () => {
        // `fc` comes from the cell, so a colour like `red' onload='alert(1)` would otherwise
        // end the style attribute and start an event handler. Stripping quotes leaves the
        // text inert inside the value; what matters is that nothing can escape the quotes.
        const html = getInlineStringHTML(0, 0, inlineCell([{ v: 'x', fc: "red' onload='alert(1)" }]));
        const styleValue = /style='([^']*)'/.exec(html)?.[1];
        expect(styleValue).toBeDefined();
        expect(styleValue).not.toMatch(/['"<>]/);
    });
});

// getCellValue returns the attribute it is asked for, and getFormulaHtml is where the
// formula becomes coloured spans. They were one function until a shipped regression:
// an escaping pass wrapped what read as a plain attribute read, and printed the markup
// at the user instead of rendering it.
describe('state/modules/cell — getCellValue / getFormulaHtml', () => {
    const formula = '=IFERROR((D37/E37),"No input yet")';
    const data = [
        [
            { f: formula, v: 'No input yet', m: 'No input yet' },
            { v: 42, m: '42' },
        ],
    ] as CellMatrix;

    test("getCellValue(…, 'f') returns the formula, not markup", () => {
        expect(getCellValue(0, 0, data, 'f')).toBe(formula);
    });

    test("getCellValue(…, 'f') is null on a cell with no formula, not its value", () => {
        expect(getCellValue(0, 1, data, 'f')).toBeNull();
    });

    test('getFormulaHtml renders the formula as coloured spans', () => {
        const html = getFormulaHtml(0, 0, data);
        expect(html).toStartWith('<span');
        expect(html).toContain('luckysheet-formula-text-func');
    });

    test('getFormulaHtml is null on a cell with no formula', () => {
        expect(getFormulaHtml(0, 1, data)).toBeNull();
    });

    test('its text content is the formula, so it renders unescaped safely', () => {
        const rendered = unescapeHtml(
            (getFormulaHtml(0, 0, data) as string).replace(/<span.*?>/g, '').replace(/<\/span>/g, ''),
        );
        expect(rendered).toBe(formula);
    });
});
