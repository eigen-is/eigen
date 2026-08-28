// Cell text is a schemaless CRDT string — authored by any collaborator, or carried
// in from an uploaded xlsx — and getInlineStringHTML writes it into the formula bar
// and the in-cell editor through innerHTML. The package used to guard those writes
// with its own escapeHTMLTag, which handed back anything starting with `<span` or
// `=` unescaped: a stored-XSS vector against every viewer, read-only included.
// escapeHtml itself is pinned in packages/lib/src/test/core/html.test.ts.

import { describe, expect, test } from 'bun:test';
import { unescapeHtml } from '@workspace/lib/html';
import { Window } from 'happy-dom';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { getCellValue, getFormulaHtml, getInlineStringHTML, updateCell } from '../../../state/modules/cell';
import { clearMeasureTextCache } from '../../../state/modules/text';
import type { CellMatrix, SheetConfig } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

// The auto-height tests below commit through a real editor element, and getTextSize falls
// back to a DOM span when a canvas reports no bounding box, so happy-dom is installed at
// module scope the way events/mouse-cell.test.ts does.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

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
        expect(html).toContain('sheet-formula-text-func');
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

// Committing multi-line text into a cell grows the row to fit it. The grown height has to
// land on the sheet's config — that is what calcRowColSize measures from and what syncs —
// or the row keeps its old height and the text stays clipped. Driving updateCell through
// produceWithPatches is what exposes a write that never lands.
describe('state/modules/cell — updateCell auto-height', () => {
    // Only `font` and `measureText` are read on the auto-height path.
    function measuringCanvas(): CanvasRenderingContext2D {
        const canvas = {
            font: '11px Arial',
            textAlign: 'start',
            textBaseline: 'top',
            measureText: (text: string) => ({
                width: text.length * 7,
                actualBoundingBoxAscent: 8,
                actualBoundingBoxDescent: 3,
            }),
        };
        return canvas as unknown as CanvasRenderingContext2D;
    }

    // The commit path handleGlobalEnter takes: the editor's text, newlines and all.
    function multilineInput(): HTMLDivElement {
        const input = win.document.createElement('div');
        input.innerHTML = 'line one\nline two\nline three';
        return input as unknown as HTMLDivElement;
    }

    function editContext(): Context {
        const config: SheetConfig = { columnlen: { 0: 40 } };
        const ctx = contextFactory({ config }) as Context;
        ctx.sheets[0].data = [
            [{ v: 'x', m: 'x', ct: { fa: 'General', t: 'g' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ];
        ctx.defaultrowlen = 19;
        ctx.defaultcollen = 73;
        return ctx;
    }

    test('the grown row height lands on the sheet the grid measures from', () => {
        clearMeasureTextCache();
        const [grown] = produceWithPatches(editContext(), (ctx: Context) => {
            updateCell(ctx, 0, 0, multilineInput(), undefined, measuringCanvas());
        });

        expect(grown.sheets[0].config?.rowlen?.[0]).toBeGreaterThan(19);
    });

    test('and still syncs, because the patch that survives filterPatch carries it', () => {
        clearMeasureTextCache();
        const base = editContext();
        const [grown, patches] = produceWithPatches(base, (ctx: Context) => {
            updateCell(ctx, 0, 0, multilineInput(), undefined, measuringCanvas());
        });

        const synced = applyPatches(base, filterPatch(patches));
        expect(synced.sheets[0].config?.rowlen?.[0]).toBe(grown.sheets[0].config?.rowlen?.[0]);
    });
});
