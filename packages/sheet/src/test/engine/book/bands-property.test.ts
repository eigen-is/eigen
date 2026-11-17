import { describe, expect, test } from 'bun:test';
import { fuzzBands } from './bands-fuzz';

// The longer runs are done by hand: the same function from a scratch script, under Bun and Node.
describe('engine/book/bands — law 6: the bands are the plain grid’s bands on every path', () => {
    for (const seed of [7, 11, 2026, 99991]) {
        test(`random ops with their inverses, seed ${seed}`, () => {
            const counts = fuzzBands(seed, 3000);
            expect(counts.undone).toBeGreaterThan(800);
            expect(counts.refused).toBeGreaterThan(0);
            expect(Object.keys(counts.ops).length).toBe(14);
            expect(counts.mostBands).toBeGreaterThan(5);
        });
    }
});
