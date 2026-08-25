import { describe, expect, it } from 'bun:test';
import { applyPreserveCase } from '../../doc-search/preserve-case';

describe('applyPreserveCase', () => {
    it('keeps all-lowercase', () => {
        expect(applyPreserveCase('cat', 'dog')).toBe('dog');
    });
    it('mirrors ALL-UPPERCASE', () => {
        expect(applyPreserveCase('CAT', 'dog')).toBe('DOG');
    });
    it('mirrors Capitalised', () => {
        expect(applyPreserveCase('Cat', 'dog')).toBe('Dog');
    });
    it('leaves mixed case as the replacement was typed', () => {
        expect(applyPreserveCase('cAt', 'dog')).toBe('dog');
    });
    it('handles a single uppercase char', () => {
        expect(applyPreserveCase('A', 'x')).toBe('X');
    });
    // pinned: an all-non-letter match ("42") has no case, so the lowercase branch applies
    it('treats an all-non-letter match as lowercase', () => {
        expect(applyPreserveCase('42', 'Dog')).toBe('dog');
    });
});
