import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import { collectMatches } from '../modules/searchReplace';
import { contextFactory } from './factories/context';

const OPTS = { matchCase: false, wholeWord: false, regex: false };

// Two tabs (Alpha/Beta). valueShowEs returns the raw `v` for plain text cells and the
// raw `v` for formatted numbers (A3 displays "€1,234.56", matches "1234.56").
function fixture(): Context {
    return contextFactory({
        currentSheetId: 'id_1',
        sheets: [
            {
                name: 'Alpha',
                id: 'id_1',
                order: 0,
                data: [
                    [{ v: 'cat', m: 'cat' }, { v: 'Category', m: 'Category' }, null, null],
                    [{ v: 'CAT', m: 'CAT' }, null, { v: 'the cat sat', m: 'the cat sat' }, null],
                    [{ v: 1234.56, m: '€1,234.56', ct: { fa: '€#,##0.00', t: 'n' } }, null, null, null],
                    [null, null, null, null],
                ],
            },
            {
                name: 'Beta',
                id: 'id_2',
                order: 1,
                data: [
                    [{ v: 'concat', m: 'concat' }, { v: 'Cat', m: 'Cat' }, null, null],
                    [null, null, null, null],
                ],
            },
        ],
    }) as Context;
}

describe('collectMatches', () => {
    it('substring-matches across every tab, tagged with sheet identity (display order, row-major)', () => {
        const res = collectMatches(fixture(), 'cat', OPTS);
        expect(res.map((m) => `${m.sheetName}!${m.cellPosition}`)).toEqual([
            'Alpha!A1',
            'Alpha!B1',
            'Alpha!A2',
            'Alpha!C2',
            'Beta!A1',
            'Beta!B1',
        ]);
        expect(res[0]).toMatchObject({ sheetId: 'id_1', r: 0, c: 0, value: 'cat' });
        expect(res[4]).toMatchObject({ sheetId: 'id_2', r: 0, c: 0 });
    });

    it('honours matchCase', () => {
        const res = collectMatches(fixture(), 'CAT', { ...OPTS, matchCase: true });
        expect(res.map((m) => `${m.sheetName}!${m.cellPosition}`)).toEqual(['Alpha!A2']);
    });

    it('whole-word is a real \\b boundary, not whole-cell (repairs the old whole-cell bug)', () => {
        const res = collectMatches(fixture(), 'cat', { ...OPTS, wholeWord: true });
        // "cat", "CAT", "cat" inside "the cat sat", and "Cat"; NOT "Category"/"concat"
        expect(res.map((m) => `${m.sheetName}!${m.cellPosition}`)).toEqual([
            'Alpha!A1',
            'Alpha!A2',
            'Alpha!C2',
            'Beta!B1',
        ]);
    });

    it('treats the query as a real regex only when regex is on', () => {
        expect(collectMatches(fixture(), 'c.t', OPTS)).toHaveLength(0); // literal "c.t" matches nothing
        const re = collectMatches(fixture(), 'c.t', { ...OPTS, regex: true });
        expect(re.length).toBeGreaterThanOrEqual(5);
    });

    it('matches the valueShowEs value — the raw v for formatted numbers, never the display string', () => {
        const hits = collectMatches(fixture(), '1234.56', OPTS);
        expect(hits.map((m) => `${m.sheetName}!${m.cellPosition}`)).toEqual(['Alpha!A3']);
        expect(hits[0]?.value).toBe('1234.56');
        expect(collectMatches(fixture(), '€1,234', OPTS)).toEqual([]);
    });

    it('returns nothing for an empty or invalid-regex query', () => {
        expect(collectMatches(fixture(), '', OPTS)).toEqual([]);
        expect(collectMatches(fixture(), '(', { ...OPTS, regex: true })).toEqual([]);
    });

    it('is pure — it does not move the selection', () => {
        const ctx = fixture();
        const before = ctx.selections;
        collectMatches(ctx, 'cat', OPTS);
        expect(ctx.selections).toBe(before);
    });
});
