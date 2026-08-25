import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import { getFlowdata } from '../../state/context';
import { collectMatches, replaceAllMatches, replaceSearchMatch } from '../../state/modules/search-replace';
import { contextFactory } from './factories/context';

const OPTS = { matchCase: false, wholeWord: false, regex: false };

function cellV(ctx: Context, sheetId: string, r: number, c: number): unknown {
    return getFlowdata(ctx, sheetId)?.[r]?.[c]?.v;
}

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

describe('replaceAllMatches', () => {
    it('rewrites every occurrence in every matching cell across tabs and returns the count', () => {
        const ctx = fixture();
        const replaced = replaceAllMatches(ctx, 'cat', 'dog', OPTS, false);
        expect(replaced).toBe(6);
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('dog'); // "cat"
        expect(cellV(ctx, 'id_1', 0, 1)).toBe('dogegory'); // "Category" → "Cat" replaced literally with "dog"
        expect(cellV(ctx, 'id_1', 1, 0)).toBe('dog'); // "CAT"
        expect(cellV(ctx, 'id_1', 1, 2)).toBe('the dog sat'); // "the cat sat"
        expect(cellV(ctx, 'id_2', 0, 0)).toBe('condog'); // "concat"
        expect(cellV(ctx, 'id_2', 0, 1)).toBe('dog'); // "Cat"
        expect(collectMatches(ctx, 'cat', OPTS)).toEqual([]);
    });

    it('preserves case per matched run when preserveCase is on', () => {
        const ctx = fixture();
        replaceAllMatches(ctx, 'cat', 'dog', OPTS, true);
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('dog'); // cat → dog
        expect(cellV(ctx, 'id_1', 1, 0)).toBe('DOG'); // CAT → DOG
        expect(cellV(ctx, 'id_2', 0, 1)).toBe('Dog'); // Cat → Dog
        expect(cellV(ctx, 'id_1', 0, 1)).toBe('Dogegory'); // Category → Cat is Capitalised → Dog
    });

    it('inserts a $1 replacement literally (no capture-group expansion)', () => {
        const ctx = fixture();
        replaceAllMatches(ctx, 'cat', '$1', OPTS, false);
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('$1');
    });

    it('skips formula cells (whose computed value matched) and recomputes their dependents', () => {
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'Alpha',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 'cat', m: 'cat' },
                            { f: '=A1', v: 'cat', m: 'cat' },
                        ],
                    ],
                    calcChain: [{ r: 0, c: 1, id: 'id_1' }],
                },
            ],
        }) as Context;

        // Both A1 (raw "cat") and B1 (computed "cat") match, but only A1 is rewritten.
        const replaced = replaceAllMatches(ctx, 'cat', 'dog', OPTS, false);
        expect(replaced).toBe(1);
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('dog');
        // B1 keeps its formula; the recalc path recomputes it to the new A1 value.
        expect(getFlowdata(ctx, 'id_1')?.[0]?.[1]?.f).toBe('=A1');
        expect(cellV(ctx, 'id_1', 0, 1)).toBe('dog');
    });

    it('skips per-cell locked cells (checkCellIsLocked)', () => {
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'Alpha',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 'cat', m: 'cat', lo: 1 },
                            { v: 'cat', m: 'cat' },
                        ],
                    ],
                },
            ],
        }) as Context;

        const replaced = replaceAllMatches(ctx, 'cat', 'dog', OPTS, false);
        expect(replaced).toBe(1);
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('cat'); // locked — unchanged
        expect(cellV(ctx, 'id_1', 0, 1)).toBe('dog');
    });
});

describe('replaceSearchMatch', () => {
    it('rewrites every occurrence within the one targeted cell', () => {
        const ctx = fixture();
        const ok = replaceSearchMatch(ctx, { sheetId: 'id_1', r: 1, c: 2 }, 'cat', 'dog', OPTS, false);
        expect(ok).toBe(true);
        expect(cellV(ctx, 'id_1', 1, 2)).toBe('the dog sat');
        // other matches untouched
        expect(cellV(ctx, 'id_1', 0, 0)).toBe('cat');
    });

    it('no-ops on a cell whose value no longer matches (stale id)', () => {
        const ctx = fixture();
        const ok = replaceSearchMatch(ctx, { sheetId: 'id_2', r: 0, c: 0 }, 'dog', 'x', OPTS, false);
        expect(ok).toBe(false);
        expect(cellV(ctx, 'id_2', 0, 0)).toBe('concat');
    });
});
