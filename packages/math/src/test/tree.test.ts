import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex, writeLatex } from '../latex';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE, writeOmml } from '../omml';
import { MATH_LIMITS, type MathNode, type MathRow, RowBuilder } from '../tree';
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
            expect(performance.now() - start).toBeLessThan(1_000);
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
        [
            'a superscript digit is a script on the token before it',
            'x²',
            '<mi>x</mi><mn>²</mn>',
            [{ kind: 'scripts', base: letter('x'), sup: [{ kind: 'number', text: '2' }] }],
        ],
        [
            'a run of script characters is one script, and a sub and a sup make one node',
            'x₁₂⁻¹',
            '<mi>x</mi><mn>₁₂</mn><mo>⁻</mo><mn>¹</mn>',
            [
                {
                    kind: 'scripts',
                    base: letter('x'),
                    sub: [{ kind: 'number', text: '12' }],
                    sup: [
                        { kind: 'operator', text: '−' },
                        { kind: 'number', text: '1' },
                    ],
                },
            ],
        ],
        [
            'a script with no token before it has an empty base',
            '⁽²⁾',
            '<mo>⁽</mo><mn>²</mn><mo>⁾</mo>',
            [
                {
                    kind: 'scripts',
                    base: [],
                    sup: [
                        { kind: 'operator', text: '(' },
                        { kind: 'number', text: '2' },
                        { kind: 'operator', text: ')' },
                    ],
                },
            ],
        ],
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

    // What a reader counts, so a node made from a character counts as the same node read from its elements.
    test.each<[string, (row: RowBuilder) => MathNode]>([
        [
            'e\u0301\u0308',
            (row) => {
                const inner = new RowBuilder(row.budget, 3);
                inner.chars('e', 'italic', 'normal', undefined);
                const outer = new RowBuilder(row.budget, 2);
                outer.node({ kind: 'accent', accent: '\u0301', body: inner.done() });
                return { kind: 'accent', accent: '\u0308', body: outer.done() };
            },
        ],
        [
            'x₁²',
            (row) => {
                const base = new RowBuilder(row.budget, 2);
                base.chars('x', 'italic', 'normal', undefined);
                const sub = new RowBuilder(row.budget, 2, 'optional');
                sub.chars('1', 'italic', 'normal', undefined);
                const sup = new RowBuilder(row.budget, 2, 'optional');
                sup.chars('2', 'italic', 'normal', undefined);
                return { kind: 'scripts', base: base.done(), sub: sub.done(), sup: sup.done() };
            },
        ],
    ])('%p counts as the node it makes', (text, build) => {
        const counted = (fill: (row: RowBuilder) => void) => {
            const budget = { size: 0 };
            const row = new RowBuilder(budget, 1);
            fill(row);
            row.done();
            return budget.size;
        };
        expect(counted((row) => row.chars(text, 'italic', 'normal', undefined))).toBe(
            counted((row) => row.node(build(row))),
        );
    });

    test.each<MathNode>([
        { kind: 'identifier', text: 'e\u0301' },
        { kind: 'operator', text: '\u0301' },
        { kind: 'operator', text: '=\u0338' },
        { kind: 'operator', text: '⊕\uFE0E' },
        { kind: 'operator', text: '²' },
        { kind: 'operator', text: '₋' },
        { kind: 'identifier', text: 'a\u0338b' },
    ])('canonicalIssue rejects %j', (node) => {
        expect(canonicalIssue([node])).toBeDefined();
    });
});

// TeX and Word draw a capital Greek letter upright, so that is its default.
describe('a capital Greek letter', () => {
    const upright: MathRow = [{ kind: 'identifier', text: 'Γ' }];
    const italic: MathRow = [{ kind: 'identifier', text: 'Γ', variant: 'italic' }];

    test('is upright unless italic is explicit, in every reader', () => {
        expect(readLatex('\\Gamma')).toStrictEqual(upright);
        expect(readLatex('\\mathrm{\\Gamma}')).toStrictEqual(upright);
        expect(readLatex('\\mathit{\\Gamma}')).toStrictEqual(italic);
        expect(
            readMathml(el(`<math xmlns="${MATHML_NAMESPACE}"><mi mathvariant="normal">Γ</mi></math>`)).row,
        ).toStrictEqual(upright);
        // MathML and Word draw a lone letter italic when nothing says otherwise.
        expect(readMathml(el(`<math xmlns="${MATHML_NAMESPACE}"><mi>Γ</mi></math>`)).row).toStrictEqual(italic);
        expect(readOmml(el(`<m:oMath xmlns:m="${OMML_NAMESPACE}"><m:r><m:t>Γ</m:t></m:r></m:oMath>`))).toStrictEqual(
            italic,
        );
        expect(canonicalIssue(upright)).toBeUndefined();
        expect(canonicalIssue(italic)).toBeUndefined();
        expect(canonicalIssue([{ kind: 'identifier', text: 'Γ', variant: 'normal' }])).toBeDefined();
    });

    test('is written as each format draws it, and reads back', () => {
        expect(writeMathml(upright)).toContain('<mi mathvariant="normal">Γ</mi>');
        expect(writeMathml(italic)).toContain('<mi>𝛤</mi>');
        expect(writeOmml(upright)).toContain('<m:sty m:val="p"/>');
        expect(writeOmml(italic)).toContain('<m:sty m:val="i"/>');
        expect(writeLatex(upright)).toBe('\\Gamma');
        expect(writeLatex(italic)).toBe('\\mathit{\\Gamma}');
        for (const row of [upright, italic]) {
            for (const via of [viaMathml, viaOmml, viaLatex]) expect(via(row)).toStrictEqual(row);
        }
    });
});
