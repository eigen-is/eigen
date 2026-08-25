import { describe, expect, it } from 'bun:test';
import { buildSearchRegex } from '../../doc-search/build-search-regex';

const OPTS = { matchCase: false, wholeWord: false, regex: false };

describe('buildSearchRegex', () => {
    it('returns null for an empty query', () => {
        expect(buildSearchRegex('', OPTS)).toBeNull();
    });

    it('treats the query literally unless regex is on', () => {
        expect(buildSearchRegex('a.b', OPTS)?.test('axb')).toBe(false);
        expect(buildSearchRegex('a.b', OPTS)?.test('a.b')).toBe(true);
    });

    it('is case-insensitive by default and case-sensitive with matchCase', () => {
        expect(buildSearchRegex('cat', OPTS)?.test('CAT')).toBe(true);
        expect(buildSearchRegex('cat', { ...OPTS, matchCase: true })?.test('CAT')).toBe(false);
    });

    it('respects whole-word boundaries', () => {
        const re = buildSearchRegex('cat', { ...OPTS, wholeWord: true });
        expect(re?.test('the cat sat')).toBe(true);
        expect(re?.test('category')).toBe(false);
    });

    it('whole word escapes the literal before wrapping boundaries', () => {
        // The escaped literal must not let regex metachars leak past the \b wrapper.
        const re = buildSearchRegex('a.b', { ...OPTS, wholeWord: true });
        expect(re?.test('a.b')).toBe(true);
        expect(re?.test('axb')).toBe(false);
    });

    it('honours real regex when regex is on', () => {
        expect(buildSearchRegex('a.b', { ...OPTS, regex: true })?.test('axb')).toBe(true);
    });

    it('combines regex with whole-word boundaries', () => {
        const re = buildSearchRegex('ca.', { ...OPTS, regex: true, wholeWord: true });
        expect(re?.test('the cat sat')).toBe(true);
        expect(re?.test('scatter')).toBe(false);
    });

    it('returns null for an invalid user regex', () => {
        expect(buildSearchRegex('(', { ...OPTS, regex: true })).toBeNull();
    });

    it('always sets the global flag for iteration', () => {
        expect(buildSearchRegex('x', OPTS)?.flags).toContain('g');
    });
});
