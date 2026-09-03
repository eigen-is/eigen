import { describe, expect, test } from 'bun:test';
import {
    arrowShapeFields,
    arrowShapeOf,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    parseFixedSegments,
    serializeFixedSegments,
    type VectorArrowElement,
} from '../../vector/types';

const arrow = (over: Partial<VectorArrowElement>): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'a',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    roughness: 1,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    elbow: false,
    fixedSegments: '',
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding: '',
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    labelWidth: 0,
    points: '[[0,0],[10,10]]',
    ...over,
});

describe('arrowShapeFields', () => {
    test("'elbow' sets only the flag — roundness is the elbow's CORNER style (a separate Edges row), never touched", () => {
        const fields = arrowShapeFields('elbow');
        expect(fields.elbow).toBe(true);
        expect('roundness' in fields).toBe(false);
    });

    test("'curved'/'sharp' clear the flag and pick the shaft roundness", () => {
        expect(arrowShapeFields('curved')).toEqual({ elbow: false, roundness: 'round' });
        expect(arrowShapeFields('sharp')).toEqual({ elbow: false, roundness: 'sharp' });
    });

    test('to-elbow conversion preserves the element roundness (round corners survive the switch)', () => {
        const roundArrow = arrow({ roundness: 'round' });
        const next = { ...roundArrow, ...arrowShapeFields('elbow') };
        expect(next.elbow).toBe(true);
        expect(next.roundness).toBe('round');
        expect(arrowShapeOf(next)).toBe('elbow');
    });
});

describe('parseFixedSegments / serializeFixedSegments', () => {
    test('round-trips a valid envelope (index + axis-aligned segments + flags)', () => {
        const s =
            '{"segments":[{"index":2,"start":[10,0],"end":[10,50]},{"index":4,"start":[0,20],"end":[30,20]}],"startIsSpecial":true,"endIsSpecial":false}';
        expect(serializeFixedSegments(parseFixedSegments(s))).toBe(s);
    });

    test("'' ⇒ no pins, and an empty envelope serializes back to ''", () => {
        expect(parseFixedSegments('')).toEqual({ segments: [], startIsSpecial: false, endIsSpecial: false });
        expect(serializeFixedSegments({ segments: [], startIsSpecial: false, endIsSpecial: false })).toBe('');
    });

    test('drops garbage: non-JSON, legacy bare arrays, and diagonal/degenerate/indexless entries', () => {
        expect(parseFixedSegments('not json').segments).toEqual([]);
        // Legacy index-less array form (the old geometric keying) is dropped wholesale.
        expect(parseFixedSegments('[{"start":[0,0],"end":[0,5]}]').segments).toEqual([]);
        // Diagonal, zero-length and index-less entries rejected; the valid one stays.
        expect(
            parseFixedSegments(
                '{"segments":[{"index":2,"start":[0,0],"end":[5,5]},{"index":3,"start":[1,1],"end":[1,1]},{"start":[2,0],"end":[2,9]},{"index":5,"start":[2,0],"end":[2,9]}]}',
            ).segments,
        ).toEqual([{ index: 5, start: [2, 0], end: [2, 9] }]);
    });
});

// Both creation paths (use-vector-doc's elementDefaults, use-drawing-tools' arrowElement) spread
// DEFAULT_ARROW_PROPS last, so this IS the shipped default: a new arrow draws curved, like
// Excalidraw. Lines and freedraw stay sharp, and the read fallback stays sharp so stored arrows
// keep their meaning.
test('a new arrow is curved by default', () => {
    expect(arrowShapeOf(arrow({ ...DEFAULT_ARROW_PROPS }))).toBe('curved');
});
