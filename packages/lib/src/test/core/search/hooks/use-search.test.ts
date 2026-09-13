import { describe, expect, test } from 'bun:test';
import { isSearchQueryEnabled } from '../../../../core/search/hooks/use-search';

const base = { ownerId: 'owner-1', q: '' };

describe('isSearchQueryEnabled', () => {
    test('a lone from: or to: filter is a query on its own', () => {
        expect(isSearchQueryEnabled({ ...base, from: 'alice@test.eigen.is' })).toBe(true);
        expect(isSearchQueryEnabled({ ...base, to: 'bob@test.eigen.is' })).toBe(true);
    });

    test('typed text alone runs, nothing at all does not', () => {
        expect(isSearchQueryEnabled({ ...base, q: 'invoice' })).toBe(true);
        expect(isSearchQueryEnabled(base)).toBe(false);
    });

    test('the caller can still switch the query off, and an unresolved owner blocks it', () => {
        expect(isSearchQueryEnabled({ ...base, from: 'alice@test.eigen.is', enabled: false })).toBe(false);
        expect(isSearchQueryEnabled({ ...base, ownerId: '', q: 'invoice' })).toBe(false);
    });
});
