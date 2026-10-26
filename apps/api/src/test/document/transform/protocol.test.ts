import { describe, expect, test } from 'bun:test';
import { lossCounter } from '../../../lib/document/transform/protocol';

describe('a loss counter', () => {
    test('counts each loss by its code, in the order the codes are first met', () => {
        const losses = lossCounter();
        losses.lost('charts-dropped');
        losses.lost('images-dropped');
        losses.lost('charts-dropped');
        expect(losses.warnings()).toEqual([
            { code: 'charts-dropped', count: 2 },
            { code: 'images-dropped', count: 1 },
        ]);
    });

    test('counts a loss with a source once per source', () => {
        const losses = lossCounter();
        const master = {};
        losses.lost('fills-simplified', master);
        losses.lost('fills-simplified', master);
        losses.lost('fills-simplified', {});
        expect(losses.warnings()).toEqual([{ code: 'fills-simplified', count: 2 }]);
    });

    test('nothing lost is no warning', () => {
        expect(lossCounter().warnings()).toEqual([]);
    });
});
