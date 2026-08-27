// The clipboard table this builds serialises each cell's style object into a
// `style="…"` attribute. That serializer is the same one the rich-text runs in
// modules/cell.ts use — it lived in both files, and only cell.ts's copy was ever
// hardened, so a colour authored by a collaborator could close the attribute here.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { rangeValueToHtml } from '../../../state/modules/selection';
import { contextFactory } from '../factories/context';

describe('state/modules/selection — rangeValueToHtml', () => {
    function styledContext(fc: string) {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [[{ v: 'x', m: 'x', fc }, null, null, null]];
        return ctx;
    }

    test('a style value cannot close its own attribute', () => {
        const html = rangeValueToHtml(styledContext('red" onload="alert(1)'), 'id_1', [
            { row: [0, 0], column: [0, 0] },
        ]);
        const styleValue = /<td[^>]*style="([^"]*)"/.exec(html ?? '')?.[1];
        expect(styleValue).toBeDefined();
        // What matters is that nothing escapes the quotes; the text left inside the
        // value is an inert CSS declaration.
        expect(styleValue).not.toMatch(/["<>]/);
    });

    test('a plain colour still serialises as CSS', () => {
        const html = rangeValueToHtml(styledContext('#ff0000'), 'id_1', [{ row: [0, 0], column: [0, 0] }]);
        expect(html).toContain('color:#ff0000;');
    });
});
