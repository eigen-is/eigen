import { describe, expect, test } from 'bun:test';
import { type ArrangeItem, arrangeBoundingBox, computeArrange } from './arrange';

function obj(id: string, x: number, y: number, width: number, height: number): ArrangeItem {
    return { id, x, y, width, height };
}

// A(10,10,100,40) B(200,80,60,100) C(50,300,200,20)
// bbox: minX=10 minY=10 maxX=260 maxY=320  cx=135 cy=165
const A = obj('a', 10, 10, 100, 40);
const B = obj('b', 200, 80, 60, 100);
const C = obj('c', 50, 300, 200, 20);

describe('arrangeBoundingBox', () => {
    test('min/max corners over the selection', () => {
        expect(arrangeBoundingBox([A, B, C])).toEqual({ minX: 10, minY: 10, maxX: 260, maxY: 320 });
    });
});

describe('computeArrange - align', () => {
    test('align-left → every x = minX', () => {
        expect(computeArrange([A, B, C], 'align-left')).toEqual([
            { id: 'a', x: 10 },
            { id: 'b', x: 10 },
            { id: 'c', x: 10 },
        ]);
    });

    test('align-right → x = maxX - w', () => {
        expect(computeArrange([A, B, C], 'align-right')).toEqual([
            { id: 'a', x: 160 },
            { id: 'b', x: 200 },
            { id: 'c', x: 60 },
        ]);
    });

    test('align-h-center → x = round(cx - w/2)', () => {
        expect(computeArrange([A, B, C], 'align-h-center')).toEqual([
            { id: 'a', x: 85 },
            { id: 'b', x: 105 },
            { id: 'c', x: 35 },
        ]);
    });

    test('align-top → every y = minY', () => {
        expect(computeArrange([A, B, C], 'align-top')).toEqual([
            { id: 'a', y: 10 },
            { id: 'b', y: 10 },
            { id: 'c', y: 10 },
        ]);
    });

    test('align-bottom → y = maxY - h', () => {
        expect(computeArrange([A, B, C], 'align-bottom')).toEqual([
            { id: 'a', y: 280 },
            { id: 'b', y: 220 },
            { id: 'c', y: 300 },
        ]);
    });

    test('align-v-center → y = round(cy - h/2)', () => {
        expect(computeArrange([A, B, C], 'align-v-center')).toEqual([
            { id: 'a', y: 145 },
            { id: 'b', y: 115 },
            { id: 'c', y: 155 },
        ]);
    });

    test('rounds to nearest integer', () => {
        const p = obj('p', 0, 0, 5, 10);
        const q = obj('q', 0, 0, 2, 10);
        expect(computeArrange([p, q], 'align-h-center')).toEqual([
            { id: 'p', x: 0 },
            { id: 'q', x: 2 },
        ]);
    });
});

describe('computeArrange - match size', () => {
    test('match-width → every width = max width, x/y untouched', () => {
        const objs = [obj('a', 0, 0, 100, 10), obj('b', 0, 0, 250, 10), obj('c', 0, 0, 80, 10)];
        expect(computeArrange(objs, 'match-width')).toEqual([
            { id: 'a', width: 250 },
            { id: 'b', width: 250 },
            { id: 'c', width: 250 },
        ]);
    });

    test('match-height → every height = max height', () => {
        const objs = [obj('a', 0, 0, 10, 40), obj('b', 0, 0, 10, 90)];
        expect(computeArrange(objs, 'match-height')).toEqual([
            { id: 'a', height: 90 },
            { id: 'b', height: 90 },
        ]);
    });
});

describe('computeArrange - distribute (equal gaps, endpoints fixed)', () => {
    test('distribute-h with 3 equal-size objects', () => {
        const objs = [obj('a', 0, 0, 100, 50), obj('b', 120, 0, 100, 50), obj('c', 400, 0, 100, 50)];
        expect(computeArrange(objs, 'distribute-h')).toEqual([{ id: 'b', x: 200 }]);
    });

    test('distribute-h with mixed sizes', () => {
        const objs = [obj('a', 0, 0, 100, 50), obj('b', 150, 0, 50, 50), obj('c', 500, 0, 100, 50)];
        expect(computeArrange(objs, 'distribute-h')).toEqual([{ id: 'b', x: 275 }]);
    });

    test('distribute-h with two interior objects', () => {
        const objs = [
            obj('a', 0, 0, 100, 50),
            obj('b', 200, 0, 100, 50),
            obj('c', 300, 0, 100, 50),
            obj('d', 900, 0, 100, 50),
        ];
        expect(computeArrange(objs, 'distribute-h')).toEqual([
            { id: 'b', x: 300 },
            { id: 'c', x: 600 },
        ]);
    });

    test('distribute-h with overlap → even negative gap, deterministic', () => {
        const objs = [obj('a', 0, 0, 100, 50), obj('b', 10, 0, 100, 50), obj('c', 20, 0, 100, 50)];
        expect(computeArrange(objs, 'distribute-h')).toEqual([{ id: 'b', x: 10 }]);
    });

    test('distribute-v with 3 objects', () => {
        const objs = [obj('a', 0, 0, 50, 100), obj('b', 0, 120, 50, 100), obj('c', 0, 400, 50, 100)];
        expect(computeArrange(objs, 'distribute-v')).toEqual([{ id: 'b', y: 200 }]);
    });

    test('distribute needs 3+ objects → [] for 2', () => {
        expect(computeArrange([A, B], 'distribute-h')).toEqual([]);
    });
});

describe('computeArrange - guards', () => {
    test('fewer than 2 objects → []', () => {
        expect(computeArrange([A], 'align-left')).toEqual([]);
        expect(computeArrange([], 'align-left')).toEqual([]);
    });
});
