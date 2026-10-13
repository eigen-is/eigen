import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE, writeOmml } from '../omml';
import { MATH_LIMITS, type MathRow } from '../tree';
import { elementsOf, type MathXmlElement } from '../xml';
import { canonicalIssue } from './canonical';
import { generateTree } from './generate';
import { el } from './parse';

const math = (content: string) => el(`<math xmlns="${MATHML_NAMESPACE}">${content}</math>`);
const x: MathRow = [{ kind: 'identifier', text: 'x' }];
const viaOmml = (row: MathRow) =>
    readOmml(
        elementsOf(el(`<root xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORDML_NAMESPACE}">${writeOmml(row)}</root>`))[0],
    );
const element = (local: string, children: (string | object)[], attributes = {}): MathXmlElement => ({
    ns: MATHML_NAMESPACE,
    local,
    attributes,
    children,
});

describe('C4: the typed LaTeX rides along as the annotation', () => {
    test.each(['a<b', 'x &amp; y', ']]>', '\\mathbb{R} 𝟘 😀', ' \\quad '])('%p', (latex) => {
        const written = readMathml(el(writeMathml(x, latex)));
        expect(written).toEqual({ row: x, latex });
    });

    test('an annotation XML cannot hold is an error, read or written', () => {
        for (const latex of ['a\u0001', '\uD800']) {
            const annotation = element('annotation', [latex], { encoding: 'application/x-tex' });
            expect(() =>
                readMathml(element('math', [element('semantics', [element('mi', ['x']), annotation])])),
            ).toThrow(MathError);
            expect(() => writeMathml(x, latex)).toThrow(MathError);
        }
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
        for (const value of ['red', 'javascript:alert(1)', '#F00', 'url(#a)', '#FF00001', ' #FF0000', '#GG0000', '']) {
            expect(readMathml(math(`<mi mathcolor="${value}">x</mi>`)).row).toEqual(x);
            expect(readMathml(math(`<mtext mathcolor="${value}">if</mtext>`)).row).toEqual([
                { kind: 'text', text: 'if' },
            ]);
        }
        expect(readMathml(math('<mi mathvariant="slanted">x</mi>')).row).toEqual(x);
    });

    test('a character XML cannot hold is an error', () => {
        expect(() => readMathml(element('math', [element('mi', ['\uD800'])]))).toThrow(MathError);
    });

    // A3: whatever MathML comes in, the tree is canonical, so the docx trip and the stored trip keep it.
    test.each([
        '<mspace width="1em"/><mspace width="1em"/>',
        '<mspace width="1em"/><mspace width="2em"/><mtext>\u2003</mtext>',
        '<mtable displaystyle="true"><mtr><mtd><mi>x</mi><mo>&amp;</mo><mn>1</mn></mtd></mtr></mtable>',
        '<mtable displaystyle="true"><mtr/></mtable>',
        '<mtable/>',
        '<mtable><mtr/><mtr><mtd/></mtr></mtable>',
        '<mrow><mo largeop="true">\u200B</mo><mi>x</mi></mrow>',
        '<mrow><mo largeop="true">  </mo><mi>x</mi></mrow>',
        '<mrow><munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover><mi>x</mi></mrow>',
        '<munderover><mi>x</mi><mi>a</mi><mi>b</mi></munderover>',
        '<mrow><msubsup><mo>∑</mo><mrow/><mrow/></msubsup><mi>x</mi></mrow>',
        '<mtext>a&#9;b&#10;</mtext><mtext>&#13;</mtext>',
        '<mtext>\u00A0</mtext><mtext mathcolor="#FF0000">\u00A0x</mtext>',
        '<mi mathcolor="#00ff00">x</mi><mi mathcolor="#00FF00">y</mi><mi mathcolor="red">z</mi>',
        '<mn>1</mn><mn>.</mn><mn>5</mn><mo>&amp;</mo>',
    ])('%p reads canonical and survives both trips', (content) => {
        const { row } = readMathml(math(content));
        expect(canonicalIssue(row)).toBeUndefined();
        expect(viaOmml(row)).toStrictEqual(row);
        expect(readMathml(el(writeMathml(row))).row).toStrictEqual(row);
    });

    test('Em spaces pair whether they come as characters or as mspace', () => {
        expect(readMathml(math('<mspace width="1em"/><mspace width="1em"/>')).row).toEqual([
            { kind: 'space', width: 'qquad' },
        ]);
    });

    test('an equations cell splits at &, and a row without cells is one empty cell', () => {
        const equations =
            '<mtable displaystyle="true"><mtr><mtd><mi>x</mi><mo>&amp;</mo><mn>1</mn></mtd></mtr><mtr/></mtable>';
        expect(readMathml(math(equations)).row).toEqual([
            { kind: 'table', layout: 'equations', rows: [[x, [{ kind: 'number', text: '1' }]], [[]]] },
        ]);
    });

    test('an n-ary is a scripted operator from the large-operator table, or one marked largeop, then its body', () => {
        const i: MathRow = [{ kind: 'identifier', text: 'i' }];
        expect(
            readMathml(math('<mrow><munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover><mi>x</mi></mrow>')).row,
        ).toEqual([
            { kind: 'nary', operator: '∑', limits: 'under', sub: i, sup: [{ kind: 'identifier', text: 'n' }], body: x },
        ]);
        expect(readMathml(math('<msub><mo>∫</mo><mi>i</mi></msub><mi>x</mi>')).row).toEqual([
            { kind: 'nary', operator: '∫', limits: 'side', sub: i, body: x },
        ]);
        expect(readMathml(math('<mrow><mo largeop="true">∑</mo><mi>x</mi></mrow>')).row).toEqual([
            { kind: 'nary', operator: '∑', limits: 'under', body: x },
        ]);
        expect(readMathml(math('<mrow><msub><mo>+</mo><mi>i</mi></msub><mi>x</mi></mrow>')).row).toEqual([
            { kind: 'scripts', base: [{ kind: 'operator', text: '+' }], sub: i },
            ...x,
        ]);
        expect(readMathml(math('<mrow><mo largeop="true">\u200B</mo><mi>x</mi></mrow>')).row).toEqual(x);
    });

    test('an munderover outside an n-ary reads as a limit under inside a limit over', () => {
        const letter = (text: string): MathRow => [{ kind: 'identifier', text }];
        expect(readMathml(math('<munderover><mi>x</mi><mi>a</mi><mi>b</mi></munderover>')).row).toEqual([
            {
                kind: 'limit',
                position: 'over',
                base: [{ kind: 'limit', position: 'under', base: x, limit: letter('a') }],
                limit: letter('b'),
            },
        ]);
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

    test('a large operator alone in a base is wrapped, so a script, limit, accent, line or brace never reads as an n-ary', () => {
        const sum: MathRow = [{ kind: 'operator', text: '∑' }];
        expect(writeMathml([{ kind: 'scripts', base: sum, sub: x }])).toContain(
            '<msub><mrow><mo>∑</mo></mrow><mi>x</mi></msub>',
        );
        for (const node of [
            { kind: 'scripts', base: sum, sub: x },
            { kind: 'limit', position: 'under', base: sum, limit: x },
            { kind: 'accent', accent: '\u0302', body: sum },
            { kind: 'line', position: 'over', body: sum },
            { kind: 'brace', char: '⏟', position: 'under', body: sum },
        ] satisfies MathRow) {
            const row: MathRow = [node, ...x];
            expect(readMathml(el(writeMathml(row))).row).toStrictEqual(row);
            expect(readMathml(el(writeMathml(row, 'tex'))).row).toStrictEqual(row);
        }
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
