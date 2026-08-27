import { describe, expect, test } from 'bun:test';
import { getInlineStringHTML } from '../../../state/modules/cell';
import type { CellMatrix } from '../../../state/types';
import { escapeHTMLTag } from '../../../state/utils';

// Cell text is a schemaless CRDT string — authored by any collaborator, or carried in
// from an uploaded xlsx — and it is written into the formula bar and the in-cell editor
// through innerHTML. escapeHTMLTag used to hand back anything starting with `<span` or
// `=` unescaped, which made a cell value a stored-XSS vector against every viewer,
// read-only included.
describe('state/utils — escapeHTMLTag', () => {
    test('escapes angle brackets', () => {
        expect(escapeHTMLTag('<img src=q onerror=alert(1)>')).toBe('&lt;img src=q onerror=alert(1)&gt;');
    });

    test('escapes a value that opens with a span tag', () => {
        expect(escapeHTMLTag('<span x><img src=q onerror=alert(1)>')).toBe(
            '&lt;span x&gt;&lt;img src=q onerror=alert(1)&gt;',
        );
    });

    test('escapes a value that opens with an equals sign', () => {
        expect(escapeHTMLTag('=<img src=q onerror=alert(1)>')).toBe('=&lt;img src=q onerror=alert(1)&gt;');
    });

    test('leaves a formula comparison readable', () => {
        // Escaped `<` renders back as `<` through innerHTML, so formulas still display right.
        expect(escapeHTMLTag('=A1<B1')).toBe('=A1&lt;B1');
    });

    test('passes non-strings through untouched', () => {
        expect(escapeHTMLTag(42 as unknown as string)).toBe(42 as unknown as string);
    });
});

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
