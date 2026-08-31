import { describe, expect, test } from 'bun:test';
import { arrowShapeFields, arrowShapeOf, DEFAULT_ELEMENT_PROPS, type VectorArrowElement } from '../../vector/types';

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
