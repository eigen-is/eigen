import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { MATHML_NAMESPACE, readMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE } from '../omml';
import { MATH_LIMITS, type MathRow } from '../tree';
import type { MathXmlElement } from '../xml';
import { el, viaMathml, viaOmml } from './parse';

function nested(levels: number): MathRow {
    return levels === 1 ? [{ kind: 'identifier', text: 'x' }] : [{ kind: 'radical', body: nested(levels - 1) }];
}

describe('MATH_LIMITS', () => {
    test('the deepest admitted tree round-trips; one level more is an error', () => {
        const deepest = nested(MATH_LIMITS.depth);
        expect(viaMathml(deepest)).toStrictEqual(deepest);
        expect(viaOmml(deepest)).toStrictEqual(deepest);
        expect(() => viaMathml(nested(MATH_LIMITS.depth + 1))).toThrow(MathError);
        expect(() => viaOmml(nested(MATH_LIMITS.depth + 1))).toThrow(MathError);
    });

    test('characters count, so one long token is bounded too', () => {
        const long: MathRow = [{ kind: 'number', text: '1'.repeat(MATH_LIMITS.size) }];
        expect(() => viaMathml(long)).toThrow(MathError);
    });

    test('a long token is refused as its characters arrive, not after they are all held', () => {
        const element = (ns: string, local: string, children: (string | MathXmlElement)[]): MathXmlElement => ({
            ns,
            local,
            attributes: {},
            children,
        });
        const omml = element(OMML_NAMESPACE, 'oMath', [
            element(OMML_NAMESPACE, 'r', [element(OMML_NAMESPACE, 't', ['x'.repeat(20_000_000)])]),
        ]);
        const mathml = element(MATHML_NAMESPACE, 'math', [element(MATHML_NAMESPACE, 'mi', ['x'.repeat(30_000_000)])]);
        for (const read of [() => readOmml(omml), () => readMathml(mathml)]) {
            const start = performance.now();
            expect(read).toThrow(MathError);
            expect(performance.now() - start).toBeLessThan(200);
        }
    });

    test('elements a reader walks through count as levels, so deep wrappers end in MathError', () => {
        const depth = 5_000;
        const mathml = `<math xmlns="http://www.w3.org/1998/Math/MathML">${'<mstyle>'.repeat(depth)}<mi>x</mi>${'</mstyle>'.repeat(depth)}</math>`;
        expect(() => readMathml(el(mathml))).toThrow(MathError);
        const ins = `<m:oMath xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORDML_NAMESPACE}">${'<w:ins>'.repeat(depth)}<m:r><m:t>x</m:t></m:r>${'</w:ins>'.repeat(depth)}</m:oMath>`;
        expect(() => readOmml(el(ins))).toThrow(MathError);
    });

    test('whitespace costs linear time, so a forged run of spaces near the string cap reads at once', () => {
        const spaces = ' '.repeat(40_000);
        const omml = el(
            `<m:oMath xmlns:m="${OMML_NAMESPACE}"><m:d><m:dPr><m:begChr m:val="(${spaces}("/></m:dPr><m:e/></m:d></m:oMath>`,
        );
        const mathml = el(
            `<math xmlns="${MATHML_NAMESPACE}"><mrow><mo fence="true">(${spaces}(</mo><mo fence="true">)</mo></mrow></math>`,
        );
        for (const read of [() => readOmml(omml), () => readMathml(mathml)]) {
            const start = performance.now();
            read();
            expect(performance.now() - start).toBeLessThan(250);
        }
    });
});
