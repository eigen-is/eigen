import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { functionHTMLGenerate } from '../../../state/modules/formula-editor';

installHappyDom();

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

    test('still colors a plain formula', () => {
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

// The editor puts the caret back as an offset into its whole text after a rebuild, so the
// spans must render exactly the typed formula, escaped tokens included.
describe('state/formula-editor — generated HTML measures like its rendered text', () => {
    for (const formula of ['=A1&B1', '=A1<B1', '=IF(A1<>2,1,0)', '=A1>=5', '=CONCAT("a&b")', '=A1  + B1 ']) {
        test(`${formula} renders as itself`, () => {
            const rendered = document.createElement('div');
            rendered.innerHTML = functionHTMLGenerate(formula);
            expect(rendered.textContent).toBe(formula);
        });
    }
});

describe('state/formula-editor — reference colors', () => {
    test('every reference in a long formula gets a color', () => {
        const refs = Array.from({ length: 50 }, (_, i) => `A${i + 1}`);
        const html = functionHTMLGenerate(`=SUM(${refs.join(',')})`);
        const colors = [...html.matchAll(/rangeindex="\d+" dir="auto" style="color:([^;]*);"/g)].map((m) => m[1]);
        expect(colors).toHaveLength(50);
        expect(colors.every((c) => c?.startsWith('#'))).toBe(true);
    });
});
