import { describe, expect, test } from 'bun:test';
import { escapeHtml } from '@workspace/lib/html';
import { getInlineStringHTML } from '../../../state/modules/cell';
import type { CellMatrix } from '../../../state/types';

// Cell text is a schemaless CRDT string — authored by any collaborator, or carried in
// from an uploaded xlsx — and it is written into the formula bar and the in-cell editor
// through innerHTML. The sheet package used to guard those writes with its own
// escapeHTMLTag, which handed back anything starting with `<span` or `=` unescaped —
// a stored-XSS vector against every viewer, read-only included. The seams use the shared
// escapeHtml now, so these cases are pinned against the primitive the whole repo shares.
describe('sheet innerHTML seams — escapeHtml', () => {
    test('escapes angle brackets', () => {
        expect(escapeHtml('<img src=q onerror=alert(1)>')).toBe('&lt;img src=q onerror=alert(1)&gt;');
    });

    test('escapes a value that opens with a span tag', () => {
        expect(escapeHtml('<span x><img src=q onerror=alert(1)>')).toBe(
            '&lt;span x&gt;&lt;img src=q onerror=alert(1)&gt;',
        );
    });

    test('escapes a value that opens with an equals sign', () => {
        expect(escapeHtml('=<img src=q onerror=alert(1)>')).toBe('=&lt;img src=q onerror=alert(1)&gt;');
    });

    test('leaves a formula comparison readable', () => {
        // Escaped `<` renders back as `<` through innerHTML, so formulas still display right.
        expect(escapeHtml('=A1<B1')).toBe('=A1&lt;B1');
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
