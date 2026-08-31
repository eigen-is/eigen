import { describe, expect, test } from 'bun:test';
import {
    arrowShapeFields,
    arrowShapeOf,
    DEFAULT_ELEMENT_PROPS,
    parseFixedSegments,
    serializeFixedSegments,
    type VectorArrowElement,
} from '../../vector/types';

const arrow = (over: Partial<VectorArrowElement>): VectorArrowElement =>
    ({
        ...DEFAULT_ELEMENT_PROPS,
        id: 'a',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        angle: 0,
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
        ...over,
    }) as VectorArrowElement;

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
    test('round-trips valid axis-aligned segments', () => {
        const s = '[{"start":[10,0],"end":[10,50]},{"start":[0,20],"end":[30,20]}]';
        expect(serializeFixedSegments(parseFixedSegments(s))).toBe(s);
    });

    test("'' ⇒ no segments, and empty array serializes back to ''", () => {
        expect(parseFixedSegments('')).toEqual([]);
        expect(serializeFixedSegments([])).toBe('');
    });

    test('drops garbage: non-JSON, non-array, non-axis-aligned and degenerate entries', () => {
        expect(parseFixedSegments('not json')).toEqual([]);
        expect(parseFixedSegments('{"start":[0,0]}')).toEqual([]);
        // Diagonal (neither x nor y shared) and zero-length (both shared) are rejected; the valid one stays.
        expect(
            parseFixedSegments('[{"start":[0,0],"end":[5,5]},{"start":[1,1],"end":[1,1]},{"start":[2,0],"end":[2,9]}]'),
        ).toEqual([{ start: [2, 0], end: [2, 9] }]);
    });
});
