import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE } from '../omml';
import { MATH_ENCLOSURES, MATH_LIMITS, type MathRow } from '../tree';
import { el, viaOmml } from './parse';

const viaMathml = (row: MathRow) => readMathml(el(writeMathml(row))).row;

function nested(levels: number): MathRow {
    return levels === 1 ? [{ kind: 'identifier', text: 'x' }] : [{ kind: 'radical', body: nested(levels - 1) }];
}

// The costliest unit MathML writes: an enclose drawing every line, around an empty row (a node and a row).
function widest(units: number): MathRow {
    return Array.from({ length: Math.floor((units - 1) / 2) }, () => ({
        kind: 'enclose',
        notation: [...MATH_ENCLOSURES],
        body: [],
    }));
}

describe('MATH_LIMITS', () => {
    test('the deepest admitted tree round-trips; one level more is an error', () => {
        const deepest = nested(MATH_LIMITS.depth);
        expect(viaMathml(deepest)).toStrictEqual(deepest);
        expect(viaOmml(deepest)).toStrictEqual(deepest);
        expect(() => viaMathml(nested(MATH_LIMITS.depth + 1))).toThrow(MathError);
        expect(() => viaOmml(nested(MATH_LIMITS.depth + 1))).toThrow(MathError);
    });

    test('the largest admitted tree fits the MathML cap and round-trips; one unit more is an error', () => {
        const largest = widest(MATH_LIMITS.size);
        expect(writeMathml(largest).length).toBeLessThanOrEqual(MATH_LIMITS.mathmlLength);
        expect(viaMathml(largest)).toStrictEqual(largest);
        expect(viaOmml(largest)).toStrictEqual(largest);
        expect(() => viaMathml(widest(MATH_LIMITS.size + 2))).toThrow(MathError);
    });

    test('characters count, so one long token is bounded too', () => {
        const long: MathRow = [{ kind: 'number', text: '1'.repeat(MATH_LIMITS.size) }];
        expect(() => viaMathml(long)).toThrow(MathError);
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
