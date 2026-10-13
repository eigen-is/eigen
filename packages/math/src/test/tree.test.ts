import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex } from '../latex';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE } from '../omml';
import { MATH_LIMITS, type MathNode, type MathRow } from '../tree';
import type { MathXmlElement } from '../xml';
import { canonicalIssue } from './canonical';
import { el, letter, viaLatex, viaMathml, viaOmml } from './parse';

function nested(levels: number, text = 'x'): MathRow {
    return levels === 1 ? [{ kind: 'identifier', text }] : [{ kind: 'radical', body: nested(levels - 1, text) }];
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

// The same characters as Word's run text, as MathML token text and as typed LaTeX.
function readEach(text: string, mathml: string): MathRow[] {
    return [
        readOmml(el(`<m:oMath xmlns:m="${OMML_NAMESPACE}"><m:r><m:t>${text}</m:t></m:r></m:oMath>`)),
        readMathml(el(`<math xmlns="${MATHML_NAMESPACE}">${mathml}</math>`)).row,
        readLatex(text),
    ];
}

describe('RowBuilder', () => {
    test.each<[string, string, string, MathRow]>([
        [
            'an accent mark is an accent over its base',
            'e\u0301',
            '<mi>e\u0301</mi>',
            [{ kind: 'accent', accent: '\u0301', body: letter('e') }],
        ],
        [
            'accent marks nest, inside out',
            'e\u0301\u0308',
            '<mi>e\u0301\u0308</mi>',
            [{ kind: 'accent', accent: '\u0308', body: [{ kind: 'accent', accent: '\u0301', body: letter('e') }] }],
        ],
        [
            'another mark stays with its base',
            'a\u0338b',
            '<mi>a\u0338</mi><mi>b</mi>',
            [{ kind: 'identifier', text: 'a\u0338' }, ...letter('b')],
        ],
        [
            'a base and its mark compose where Unicode composes them',
            '=\u0338',
            '<mo>=\u0338</mo>',
            [{ kind: 'operator', text: '≠' }],
        ],
        ['a mark on nothing is dropped', '\u0301x', '<mo>\u0301</mo><mi>x</mi>', letter('x')],
        ['a variation selector is dropped', '⊕\uFE0E', '<mo>⊕\uFE0E</mo>', [{ kind: 'operator', text: '⊕' }]],
    ])('%s', (_, text, mathml, row) => {
        for (const read of readEach(text, mathml)) {
            expect(read).toStrictEqual(row);
            expect(canonicalIssue(read)).toBeUndefined();
        }
    });

    test('a marked character is a token of its own, and every writer writes it back', () => {
        const rows: MathRow[] = [
            [{ kind: 'identifier', text: 'a\u0338' }],
            [{ kind: 'identifier', text: 'a\u0338', variant: 'bold' }],
            [
                { kind: 'identifier', text: 'si' },
                { kind: 'identifier', text: 'n\u0338', variant: 'normal' },
            ],
            [{ kind: 'operator', text: '⩽\u0338' }],
            [
                { kind: 'number', text: '1' },
                { kind: 'operator', text: '2\u0338' },
            ],
        ];
        for (const row of rows) {
            expect(canonicalIssue(row)).toBeUndefined();
            for (const via of [viaMathml, viaOmml, viaLatex]) expect(via(row)).toStrictEqual(row);
        }
    });

    test('the accent a mark makes is a level, so at the deepest row it is an error', () => {
        const accented: MathRow = [{ kind: 'accent', accent: '\u0301', body: letter('e') }];
        const deepest = (levels: number): MathRow =>
            levels === 1 ? accented : [{ kind: 'radical', body: deepest(levels - 1) }];
        expect(readMathml(el(writeMathml(nested(MATH_LIMITS.depth - 1, 'e\u0301')))).row).toStrictEqual(
            deepest(MATH_LIMITS.depth - 1),
        );
        expect(() => readMathml(el(writeMathml(nested(MATH_LIMITS.depth, 'e\u0301'))))).toThrow(MathError);
    });

    test.each<MathNode>([
        { kind: 'identifier', text: 'e\u0301' },
        { kind: 'operator', text: '\u0301' },
        { kind: 'operator', text: '=\u0338' },
        { kind: 'operator', text: '⊕\uFE0E' },
        { kind: 'identifier', text: 'a\u0338b' },
    ])('canonicalIssue rejects %j', (node) => {
        expect(canonicalIssue([node])).toBeDefined();
    });
});
