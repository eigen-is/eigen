import { describe, expect, test } from 'bun:test';
import { MATH_LIMITS, MathError } from '../error';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import type { MathRow } from '../tree';
import { elementsOf, type MathXmlElement } from '../xml';
import { generateTree } from './generate';
import { el } from './parse';

const math = (content: string) => el(`<math xmlns="${MATHML_NAMESPACE}">${content}</math>`);
const x: MathRow = [{ kind: 'identifier', text: 'x' }];

describe('C4: the typed LaTeX rides along as the annotation', () => {
    test.each(['a<b', 'x &amp; y', ']]>', '\\mathbb{R} 𝟘 😀', ' \\quad '])('%p', (latex) => {
        const written = readMathml(el(writeMathml(x, latex)));
        expect(written).toEqual({ row: x, latex });
    });

    test('no annotation is no LaTeX', () => {
        expect(readMathml(el(writeMathml(x))).latex).toBeUndefined();
    });
});

describe('readMathml', () => {
    test('semantics reads its first child and the x-tex annotation, and skips the rest', () => {
        const sample =
            '<semantics><mrow><mi>x</mi><mo>=</mo><mn>2</mn></mrow>' +
            '<annotation-xml encoding="MathML-Content"><ci>y</ci></annotation-xml>' +
            '<annotation encoding="text/plain">z</annotation>' +
            '<annotation encoding="application/x-tex">x=2</annotation></semantics>';
        expect(readMathml(math(sample))).toEqual({
            row: [
                { kind: 'identifier', text: 'x' },
                { kind: 'operator', text: '=' },
                { kind: 'number', text: '2' },
            ],
            latex: 'x=2',
        });
    });

    test('pretty-printed MathML reads as the compact one', () => {
        const sample = `
            <mrow>
                <msup>
                    <mi>
                        x
                    </mi>
                    <mn> 2 </mn>
                </msup>
                <mtext>  if\u00A0 </mtext>
            </mrow>
        `;
        expect(readMathml(math(sample)).row).toEqual([
            { kind: 'scripts', base: x, sup: [{ kind: 'number', text: '2' }] },
            { kind: 'text', text: 'if ' },
        ]);
    });

    test('unknown elements, comments and processing instructions read as their content', () => {
        expect(readMathml(math('<mstyle><!--c--><mi>x<?pi y?></mi></mstyle>')).row).toEqual(x);
    });

    test('a colour is #RRGGBB or nothing; an unknown variant is none', () => {
        expect(readMathml(math('<mi mathcolor="#00b050">x</mi>')).row).toEqual([
            { kind: 'identifier', text: 'x', color: '#00B050' },
        ]);
        for (const value of ['red', 'javascript:alert(1)', '#F00', 'url(#a)']) {
            expect(readMathml(math(`<mi mathcolor="${value}">x</mi>`)).row).toEqual(x);
        }
        expect(readMathml(math('<mi mathvariant="slanted">x</mi>')).row).toEqual(x);
    });

    test('a character XML cannot hold is an error', () => {
        const element = (local: string, children: (string | object)[]): MathXmlElement => ({
            ns: MATHML_NAMESPACE,
            local,
            attributes: {},
            children,
        });
        expect(() => readMathml(element('math', [element('mi', ['\uD800'])]))).toThrow(MathError);
    });
});

describe('writeMathml', () => {
    test('variants are Unicode alphanumerics where they exist, else mathvariant', () => {
        const row: MathRow = [
            { kind: 'identifier', text: 'v', variant: 'bold' },
            { kind: 'identifier', text: 'R', variant: 'double-struck' },
            { kind: 'identifier', text: 'x', variant: 'normal' },
            { kind: 'number', text: '0', variant: 'bold-italic' },
            { kind: 'identifier', text: 'sin' },
        ];
        expect(writeMathml(row)).toBe(
            `<math xmlns="${MATHML_NAMESPACE}"><mi>𝐯</mi><mi>ℝ</mi><mi mathvariant="normal">x</mi>` +
                '<mn mathvariant="bold-italic">0</mn><mi>sin</mi></math>',
        );
    });

    test('a bare fence is unstretched; a fenced pair always writes both fences', () => {
        const row: MathRow = [
            { kind: 'operator', text: '(' },
            { kind: 'fenced', open: '', close: '}', separator: '', parts: [x] },
        ];
        expect(writeMathml(row)).toBe(
            `<math xmlns="${MATHML_NAMESPACE}"><mo stretchy="false">(</mo>` +
                '<mrow><mo fence="true"></mo><mi>x</mi><mo fence="true">}</mo></mrow></math>',
        );
    });

    test('text keeps its edge spaces as no-break spaces', () => {
        expect(writeMathml([{ kind: 'text', text: ' if ' }])).toContain('<mtext>\u00A0if\u00A0</mtext>');
    });

    test('a script on a plain large operator wraps the operator, so it never reads as an n-ary', () => {
        const row: MathRow = [{ kind: 'scripts', base: [{ kind: 'operator', text: '∑' }], sub: x }];
        expect(writeMathml(row)).toContain('<msub><mrow><mo>∑</mo></mrow><mi>x</mi></msub>');
        expect(readMathml(el(writeMathml(row))).row).toEqual(row);
    });

    test('never writes display', () => {
        expect(writeMathml(x)).not.toContain('display=');
    });

    test('refuses to write past the MathML cap', () => {
        const text = 'a'.repeat(MATH_LIMITS.mathmlLength);
        expect(() => writeMathml([{ kind: 'text', text }])).toThrow(MathError);
    });

    // C8, MathML half: whatever the tree holds, the output holds only the writer's elements and attributes.
    test('output holds only the writer’s elements and attributes', () => {
        const elements = new Set(
            'math semantics annotation mrow mi mn mo mtext mspace mfrac msqrt mroot msub msup msubsup mmultiscripts mprescripts none munder mover munderover menclose mtable mtr mtd'.split(
                ' ',
            ),
        );
        const attributes = new Set(
            'xmlns encoding mathvariant mathcolor stretchy fence separator largeop accent accentunder width linethickness bevelled notation displaystyle columnalign'.split(
                ' ',
            ),
        );
        const adversarial: MathRow = [
            { kind: 'text', text: '</mtext><script>alert(1)</script>"&]]>' },
            { kind: 'identifier', text: 'x', color: '" onclick="alert(1)' },
            { kind: 'text', text: 'javascript:alert(1)', color: 'red' },
            { kind: 'fenced', open: '<', close: '"', separator: '&', parts: [[], []] },
        ];
        for (const tree of [adversarial, ...Array.from({ length: 200 }, (_, seed) => generateTree(seed + 1))]) {
            const visit = (element: MathXmlElement) => {
                expect(element.ns).toBe(MATHML_NAMESPACE);
                expect(elements).toContain(element.local);
                for (const name of Object.keys(element.attributes)) expect(attributes).toContain(name);
                for (const child of elementsOf(element)) visit(child);
            };
            visit(el(writeMathml(tree, '</annotation><script>x</script>')));
        }
    });
});
