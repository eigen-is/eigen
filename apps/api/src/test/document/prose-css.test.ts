import { describe, expect, test } from 'bun:test';
import { PROSE_CSS, proseValue } from '../../lib/document/prose-css';

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
