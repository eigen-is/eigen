import { describe, expect, test } from 'bun:test';
import { actionBoosts, structuralMatchQuality } from '../../../core/command-palette/rank';

describe('structuralMatchQuality', () => {
    test('exact title match (case-insensitive) is "exact"', () => {
        expect(structuralMatchQuality('q4 budget', 'Q4 Budget')).toBe('exact');
    });

    test('the query is a title prefix', () => {
        expect(structuralMatchQuality('q4', 'Q4 Budget Review')).toBe('title-prefix');
    });

    test('every query token appears in the title (in any order)', () => {
        expect(structuralMatchQuality('budget review', 'Q4 Budget Review')).toBe('all-tokens-in-title');
        expect(structuralMatchQuality('review budget', 'Q4 Budget Review')).toBe('all-tokens-in-title');
    });

    test('no match returns null', () => {
        expect(structuralMatchQuality('xyz', 'Q4 Budget Review')).toBeNull();
        expect(structuralMatchQuality('budget xyz', 'Q4 Budget Review')).toBeNull();
    });

    test('empty query returns null', () => {
        expect(structuralMatchQuality('', 'Q4 Budget')).toBeNull();
        expect(structuralMatchQuality('   ', 'Q4 Budget')).toBeNull();
    });
});

describe('actionBoosts', () => {
    test('title-starts-with beats title-contains beats keyword-only', () => {
        const startsWith = actionBoosts('new', { title: 'New document', keywords: [] });
        const contains = actionBoosts('document', { title: 'New document', keywords: [] });
        const keyword = actionBoosts('compose', { title: 'New document', keywords: ['compose'] });
        const none = actionBoosts('xyz', { title: 'New document', keywords: [] });
        expect(startsWith).toBeGreaterThan(contains);
        expect(contains).toBeGreaterThan(keyword);
        expect(keyword).toBeGreaterThan(none);
        expect(none).toBe(0);
    });

    test('empty query returns 0', () => {
        expect(actionBoosts('', { title: 'New document', keywords: [] })).toBe(0);
    });
});
