import { describe, expect, test } from 'bun:test';
import { PROSE_CSS, proseValue } from '../../lib/export/doc/prose-css';

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
});
