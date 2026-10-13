// The clipboard table this builds serializes each cell's style object into a
// `style="…"` attribute. That serializer is the same one the rich-text runs in
// modules/cell.ts use — it lived in both files, and only cell.ts's copy was ever
// hardened, so a color authored by a collaborator could close the attribute here.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { consumePendingCopy } from '../../../state/modules/clipboard';
import { copy, rangeValueToClipboard } from '../../../state/modules/selection';
import { contextFactory } from '../factories/context';

describe('state/modules/selection — rangeValueToClipboard', () => {
    function styledContext(fc: string) {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [[{ v: 'x', m: 'x', fc }, null, null, null]];
        return ctx;
    }

    test('a style value cannot close its own attribute', () => {
        const html = rangeValueToClipboard(styledContext('red" onload="alert(1)'), 'id_1', [
            { row: [0, 0], column: [0, 0] },
        ])?.html;
        const styleValue = /<td[^>]*style="([^"]*)"/.exec(html ?? '')?.[1];
        expect(styleValue).toBeDefined();
        // What matters is that nothing escapes the quotes; the text left inside the
        // value is an inert CSS declaration.
        expect(styleValue).not.toMatch(/["<>]/);
    });

    test('a plain colour still serialises as CSS', () => {
        const html = rangeValueToClipboard(styledContext('#ff0000'), 'id_1', [{ row: [0, 0], column: [0, 0] }])?.html;
        expect(html).toContain('color:#ff0000;');
    });
});

// text/plain is what a paste outside a spreadsheet reads (a chart's Edit data grid, a text editor),
// so it carries the grid as Google writes it: tabs between cells, newlines between rows.
describe('state/modules/selection — copy', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    (globalThis as any).sessionStorage ??= { setItem: () => {} };

    test('writes the selected cells as TSV on text/plain', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [
            [{ v: 'Month', m: 'Month' }, { v: 'North', m: 'North' }, null, null],
            [{ v: 'Jan', m: 'Jan' }, { v: 10, m: '10', ct: { fa: 'General', t: 'n' } }, null, null],
            [{ v: 'two\nlines', m: 'two\nlines' }, null, null, null],
        ];
        ctx.selections = [{ row: [0, 2], column: [0, 1], row_focus: 0, column_focus: 0 }];
        copy(ctx);
        expect(consumePendingCopy()?.plainText).toBe('Month\tNorth\nJan\t10\n"two\nlines"\t');
    });

    // The Eigen text item is read as text, not parsed as TSV, so it carries no quotes; a quote inside a cell
    // isn't quoted on text/plain either, as Google writes it.
    test('the Eigen text item carries the cells unquoted', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [
            [{ v: '12" pizza', m: '12" pizza' }, { v: '"Hi"', m: '"Hi"' }, null, null],
            [{ v: 'two\nlines', m: 'two\nlines' }, null, null, null],
        ];
        ctx.selections = [{ row: [0, 1], column: [0, 1], row_focus: 0, column_focus: 0 }];
        copy(ctx);
        const pending = consumePendingCopy();
        expect(pending?.plainText).toBe('12" pizza\t"""Hi"""\n"two\nlines"\t');
        expect(pending?.cellText).toBe('12" pizza\t"Hi"\ntwo\nlines\t');
    });
});
