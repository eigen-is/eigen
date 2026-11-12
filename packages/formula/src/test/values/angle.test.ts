import { describe, expect, test } from 'bun:test';
import { cosine, sine, tangent } from '../../values/angle';

// Equal in the 12 digits a recorded answer is held to.
function digits12(n: number): number {
    return Number(n.toPrecision(12));
}

describe('sine, cosine and tangent', () => {
    test.each([
        [0, 0, 1, 0],
        [1, 0.841470984807897, 0.54030230586814, 1.5574077246549],
        [-2.5, -0.598472144103957, -0.801143615546934, 0.74702229723866],
        [10, -0.54402111088937, -0.839071529076452, 0.648360827459087],
        [1e5, 0.0357487979720181, -0.999360807438212, -0.0357716629529004],
        [1e8, 0.931639027110306, -0.363385089354203, -2.56377890674047],
    ])('of %p are %p, %p and %p', (angle, sin, cos, tan) => {
        expect(digits12(sine(angle))).toBe(digits12(sin));
        expect(digits12(cosine(angle))).toBe(digits12(cos));
        expect(digits12(tangent(angle))).toBe(digits12(tan));
    });

    test('next to a zero they answer what Excel does, which measures the turn by a pi that is a little long', () => {
        expect(digits12(sine(Math.PI))).toBe(1.22514845491e-16);
        expect(digits12(sine(-Math.PI))).toBe(-1.22514845491e-16);
        expect(digits12(cosine(Math.PI / 2))).toBe(6.12574227454e-17);
        expect(digits12(cosine((3 * Math.PI) / 2))).toBe(-1.83772268236e-16);
        expect(digits12(tangent(Math.PI))).toBe(-1.22514845491e-16);
        expect(digits12(tangent(Math.PI / 2))).toBe(1.63245522776e16);
        expect(digits12(tangent((3 * Math.PI) / 2))).toBe(5.44151742587e15);
        expect(sine(Math.PI / 2)).toBe(1);
        expect(cosine(Math.PI)).toBe(-1);
    });

    test('from 2^27 on there is no answer', () => {
        for (const angle of [2 ** 27, -(2 ** 27), 1e10, -1e10, 1e300]) {
            expect(sine(angle)).toBeNaN();
            expect(cosine(angle)).toBeNaN();
            expect(tangent(angle)).toBeNaN();
        }
        expect(sine(2 ** 27 - 1)).not.toBeNaN();
    });
});
