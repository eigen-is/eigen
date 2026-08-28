import { describe, expect, test } from 'bun:test';
import { unescapeHtml } from '@workspace/lib/html';
import { functionHTMLGenerate } from '../../../state/modules/formula-editor';

// The formula bar and the in-cell editor render this output through innerHTML, and a
// cell's `f` text is a schemaless CRDT string — any collaborator can author one, and an
// xlsx import carries one in. Tokens were interpolated into spans raw, so markup in a
// formula reached the DOM as markup.
describe('state/formula-editor — functionHTMLGenerate', () => {
    test('escapes markup in formula text', () => {
        const html = functionHTMLGenerate('=<img src=q onerror=alert(1)>');
        expect(html).not.toContain('<img');
    });

    test('escapes markup inside a quoted string argument', () => {
        const html = functionHTMLGenerate('=CONCAT("<img src=q onerror=alert(1)>")');
        expect(html).not.toContain('<img');
    });

    test('still colours a plain formula', () => {
        const html = functionHTMLGenerate('=SUM(A1:A3)');
        expect(html).toContain('sheet-formula-text-func');
        expect(html).toContain('SUM');
    });

    test('renders comparison and concat operators readably', () => {
        // `<` and `&` are real formula operators; escaped, innerHTML renders them back.
        const html = functionHTMLGenerate('=IF(A1<B1,A1&"x",0)');
        expect(html).toContain('&lt;');
        expect(html).toContain('&amp;');
    });

    test('passes a non-formula through untouched', () => {
        expect(functionHTMLGenerate('plain text')).toBe('plain text');
    });
});

// The formula editor restores the caret by stripping the spans off this HTML, splitting on
// `</span>`, and using the segment lengths as offsets into the rendered text nodes. Escaped
// tokens are longer as markup than on screen, so the decoded segments — not the raw ones —
// have to add back up to the formula.
describe('state/formula-editor — generated HTML measures like its rendered text', () => {
    for (const formula of ['=A1&B1', '=A1<B1', '=IF(A1<>2,1,0)', '=A1>=5', '=CONCAT("a&b")']) {
        test(`${formula} decodes back to itself`, () => {
            const html = functionHTMLGenerate(formula);
            const segments = html
                .replace(/<span.*?>/g, '')
                .split('</span>')
                .map(unescapeHtml);
            expect(segments.join('')).toBe(formula);
        });
    }
});
