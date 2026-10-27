import { describe, expect, test } from 'bun:test';
import { canvasTextValue, PROSE_CSS, proseValue } from '../../lib/document/prose-css';

describe('prose css — the lookup', () => {
    test('a rule answers with its value', () => {
        expect(proseValue('.eigen-prose h1', 'font-size')).toBe('1.75rem');
    });

    test('a comma-list rule answers for each of its selectors', () => {
        expect(proseValue('.eigen-prose h1', 'margin-top')).toBe('1.5em');
        expect(proseValue('.eigen-prose h6', 'margin-top')).toBe('1.5em');
        expect(proseValue('.eigen-prose td', 'padding')).toBe('0.4em 0.8em');
    });

    test("a selector's rules merge in source order", () => {
        expect(proseValue('.eigen-prose blockquote', 'border-left')).toBe('3px solid #d1d5db');
        expect(proseValue('.eigen-prose blockquote', 'margin-bottom')).toBe('1em');
    });

    // The page sets a --doc-* property only for a doc's own Normal, so what is read is Eigen's own look.
    test("a custom property answers with its fallback, and the sheet keeps the var() for a doc's Normal", () => {
        expect(proseValue('.eigen-prose', 'font-size')).toBe('11pt');
        expect(proseValue('.eigen-prose', 'font-family')).toBe('"Inter", system-ui, -apple-system, sans-serif');
        expect(proseValue('.eigen-prose p', 'margin-bottom')).toBe('11pt');
        expect(PROSE_CSS).toContain('font-size: var(--doc-font-size, 11pt)');
    });

    test('weights come from font-weights.css', () => {
        expect(proseValue('.eigen-prose strong', 'font-weight')).toBe('600');
    });

    test('a missing selector throws', () => {
        expect(() => proseValue('.eigen-prose h7', 'font-size')).toThrow();
    });

    test('a missing property throws', () => {
        expect(() => proseValue('.eigen-prose h5', 'font-size')).toThrow();
    });
});

// A mail or chat editor takes eigen-prose.css too, and its sent HTML numbers a nested list 1. 1. 1.
describe("prose css — Docs' own rules", () => {
    test("the depth numbering and the lists that contain their floats are only Docs'", () => {
        expect(proseValue('.eigen-doc ol ol', 'list-style-type')).toBe('lower-alpha');
        expect(proseValue('.eigen-doc ol ol ol', 'list-style-type')).toBe('lower-roman');
        expect(proseValue('.eigen-doc ul', 'display')).toBe('flow-root');
        expect(PROSE_CSS).not.toMatch(/\.(eigen-prose|tiptap) ol ol[^{]*\{[^}]*list-style-type/);
        expect(PROSE_CSS).not.toMatch(/\.(eigen-prose|tiptap) (ul|ol)[^{]*\{[^}]*flow-root;/);
    });

    // A figure in front of or behind the text counts its offsets from its paragraph's box, in one of two layers.
    test('a paragraph places its positioned figures, in front of the text or behind it, only in Docs', () => {
        for (const block of ['p', 'h1', 'h6']) expect(proseValue(`.eigen-doc ${block}`, 'position')).toBe('relative');
        for (const layout of ['front', 'behind']) {
            const figure = `.eigen-doc .figure[data-layout="${layout}"]`;
            expect(proseValue(figure, 'position')).toBe('absolute');
            expect(proseValue(figure, 'margin')).toBe('0');
            expect(proseValue(figure, 'display')).toBe('block');
            expect(proseValue(`${figure} .figcaption`, 'display')).toBe('none');
        }
        expect(proseValue('.eigen-doc .figure[data-layout="front"]', 'z-index')).toBe('1');
        expect(proseValue('.eigen-doc .figure[data-layout="behind"]', 'z-index')).toBe('-1');
        expect(PROSE_CSS).not.toMatch(
            /\.(eigen-prose|tiptap) [^{]*(data-layout="(front|behind)"|\bp\b)[^{]*\{[^}]*position:/,
        );
    });
});

// A text box sits inline in its anchor paragraph, which may be a heading or a centred, indented one: it draws in the
// doc's Normal whatever holds it, its paragraphs in one look open or closed.
describe('prose css — the text box', () => {
    const BOX = '.eigen-doc .text-box';

    test('is a column at its own size, its text aligned by its vertical alignment, only in Docs', () => {
        expect(proseValue(BOX, 'display')).toBe('flex');
        expect(proseValue(BOX, 'flex-direction')).toBe('column');
        expect(proseValue(BOX, 'box-sizing')).toBe('border-box');
        expect(proseValue(`${BOX}[data-vertical-align="middle"]`, 'justify-content')).toBe('center');
        expect(proseValue(`${BOX}[data-vertical-align="bottom"]`, 'justify-content')).toBe('flex-end');
        expect(PROSE_CSS).not.toMatch(/\.(eigen-prose|tiptap) \.text-box[^{]*\{[^}]*display: flex/);
    });

    test("resets every look it would inherit from a heading or a centred, indented paragraph to the Normal's", () => {
        // The Normal's own properties, read at Eigen's fallbacks; the sheet keeps the var() for a doc's Normal.
        expect(proseValue(BOX, 'font-family')).toBe(proseValue('.eigen-prose', 'font-family'));
        expect(proseValue(BOX, 'font-size')).toBe('11pt');
        expect(proseValue(BOX, 'color')).toBe('#1a1a2e');
        expect(PROSE_CSS).toMatch(/\.eigen-doc \.text-box \{[^}]*font-size: var\(--doc-font-size, 11pt\)/);
        expect(proseValue(BOX, 'font-weight')).toBe('400');
        expect(proseValue(BOX, 'font-style')).toBe('normal');
        expect(proseValue(BOX, 'letter-spacing')).toBe('normal');
        expect(proseValue(BOX, 'text-align')).toBe('start');
        expect(proseValue(BOX, 'text-indent')).toBe('0');
        expect(proseValue(BOX, 'line-height')).toBe('1.5');
    });

    test("the live editor's <p> and a closed box's span draw alike, and the box owns their spacing", () => {
        const paragraphs = `${BOX} :is(p, [data-type="text-box-paragraph"])`;
        expect(proseValue(paragraphs, 'display')).toBe('block');
        expect(proseValue(paragraphs, 'line-height')).toBe(proseValue('.eigen-prose p', 'line-height'));
        expect(proseValue(paragraphs, 'margin-top')).toBe('0');
        for (const spacing of [
            '.eigen-prose :is(li, blockquote, td, th, .text-box) p',
            '.eigen-prose .text-box [data-type="text-box-paragraph"]',
        ]) {
            expect(proseValue(spacing, 'margin-bottom')).toBe('0 !important');
            expect(proseValue(spacing, 'padding-top')).toBe('0 !important');
        }
        expect(proseValue(`${BOX} .tiptap`, 'min-height')).toBe('0');
    });
});

describe('canvas text css — the lookup', () => {
    test('the first rule, under the header comment, answers', () => {
        expect(canvasTextValue('.eigen-canvas-text p', 'margin')).toBe('0');
    });

    test('a sibling selector answers', () => {
        expect(canvasTextValue('.eigen-canvas-text p + p', 'margin-top')).toBe('0.5em');
    });

    test('a missing property throws', () => {
        expect(() => canvasTextValue('.eigen-canvas-text blockquote', 'margin-top')).toThrow();
    });
});

describe('prose css — the flattened sheet', () => {
    test('no comment reaches a selector', () => {
        const selectors = [...PROSE_CSS.matchAll(/([^{}]*)\{/g)].map(([, selector]) => selector);
        expect(selectors.length).toBeGreaterThan(50);
        for (const selector of selectors) expect(selector).not.toContain('/*');
    });

    test('every item of a nested comma list carries the parent', () => {
        expect(PROSE_CSS).toContain('.eigen-prose th, .eigen-prose td {');
    });

    test('no selector holds a declaration', () => {
        const selectors = [...PROSE_CSS.matchAll(/([^{}]*)\{/g)].map(([, selector]) => selector.trim());
        for (const selector of selectors.filter((item) => !item.startsWith('@'))) {
            expect(selector).not.toContain(';');
            expect(selector).not.toMatch(/:\s/);
        }
    });

    test('a block keeps its own declarations before, between and after its nested rules', () => {
        expect(proseValue('.tiptap', 'outline')).toBe('none');
        expect(proseValue('.tiptap', 'min-height')).toBe('100%');
        expect(proseValue('.tiptap', 'white-space')).toBe('break-spaces');
        expect(proseValue('.tiptap p', 'margin')).toBe('0');
    });
});
