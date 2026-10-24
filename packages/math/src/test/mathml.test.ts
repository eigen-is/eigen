import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex } from '../latex';
import { MATHML_NAMESPACE, readMathml, readMathmlLatex, writeMathml } from '../mathml';
import type { MathEnclosure, MathNode, MathRow } from '../tree';
import { MATH_LIMITS } from '../tree';
import type { MathXmlElement } from '../xml';
import { canonicalIssue } from './canonical';
import { FOREIGN_MATHML } from './fixtures/foreign-mathml';
import { el, htmlMath, letter, viaLatex, viaMathml, viaOmml } from './parse';

const math = (content: string) => el(`<math xmlns="${MATHML_NAMESPACE}">${content}</math>`);
const x: MathRow = [{ kind: 'identifier', text: 'x' }];
const element = (local: string, children: (string | object)[], attributes = {}): MathXmlElement => ({
    ns: MATHML_NAMESPACE,
    local,
    attributes,
    children,
});

describe('the typed LaTeX rides along as the annotation', () => {
    test.each(['a<b', 'x &amp; y', ']]>', '\\mathbb{R} 𝟘 😀', ' \\quad '])('%p', (latex) => {
        const written = el(writeMathml(x, latex));
        expect(readMathml(written)).toEqual(x);
        expect(readMathmlLatex(written)).toBe(latex);
    });

    test('an annotation XML cannot hold is an error, read or written, and the tree still reads', () => {
        for (const latex of ['a\u0001', '\uD800']) {
            const annotation = element('annotation', [latex], { encoding: 'application/x-tex' });
            const equation = element('math', [element('semantics', [element('mi', ['x']), annotation])]);
            expect(() => readMathmlLatex(equation)).toThrow(MathError);
            expect(readMathml(equation)).toEqual(x);
            expect(() => writeMathml(x, latex)).toThrow(MathError);
        }
    });

    test('no annotation is no LaTeX', () => {
        expect(readMathmlLatex(el(writeMathml(x)))).toBeUndefined();
    });

    test('the LaTeX reads on its own beside a tree past a bound', () => {
        let deep = element('mi', ['x']);
        for (let level = 0; level <= MATH_LIMITS.depth; level++) deep = element('mstyle', [deep]);
        const annotation = element('annotation', ['x'], { encoding: 'application/x-tex' });
        const equation = element('math', [element('semantics', [deep, annotation])]);
        expect(() => readMathml(equation)).toThrow(MathError);
        expect(readMathmlLatex(equation)).toBe('x');
        expect(readMathmlLatex(element('math', [annotation]))).toBeUndefined();
    });
});

describe('readMathml', () => {
    test('semantics reads its first child and the x-tex annotation, and skips the rest', () => {
        const sample =
            '<semantics><mrow><mi>x</mi><mo>=</mo><mn>2</mn></mrow>' +
            '<annotation-xml encoding="MathML-Content"><ci>y</ci></annotation-xml>' +
            '<annotation encoding="text/plain">z</annotation>' +
            '<annotation encoding="application/x-tex">x=2</annotation></semantics>';
        expect(readMathml(math(sample))).toEqual([
            { kind: 'identifier', text: 'x' },
            { kind: 'operator', text: '=' },
            { kind: 'number', text: '2' },
        ]);
        expect(readMathmlLatex(math(sample))).toBe('x=2');
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
        expect(readMathml(math(sample))).toEqual([
            { kind: 'scripts', base: x, sup: [{ kind: 'number', text: '2' }] },
            { kind: 'text', text: 'if ' },
        ]);
    });

    test('mmultiscripts keeps its postscripts under its prescripts, a pair after the first on an empty base', () => {
        const postscripts = '<mi>R</mi><mi>i</mi><none/><none/><mi>j</mi>';
        expect(readMathml(math(`<mmultiscripts>${postscripts}</mmultiscripts>`))).toEqual(readLatex('R_{i}{}^{j}'));
        expect(
            readMathml(math(`<mmultiscripts>${postscripts}<mprescripts/><mn>1</mn><none/></mmultiscripts>`)),
        ).toEqual(readLatex('\\prescript{}{1}{R_{i}{}^{j}}'));
        // The mmultiscripts read through, R and each empty pair after the first count, as an empty element does.
        const empty = (count: number) =>
            readMathml(math(`<mmultiscripts><mi>R</mi>${'<none/><none/>'.repeat(count + 1)}</mmultiscripts>`));
        expect(empty(MATH_LIMITS.size - 4)).toEqual(letter('R'));
        expect(() => empty(MATH_LIMITS.size - 3)).toThrow(MathError);
    });

    test('unknown elements, comments and processing instructions read as their content', () => {
        expect(readMathml(math('<mstyle><!--c--><mi>x<?pi y?></mi></mstyle>'))).toEqual(x);
    });

    test('a colour is #RRGGBB, #RGB, a CSS name or nothing; an unknown variant is none', () => {
        for (const [value, color] of [
            ['#00b050', '#00B050'],
            ['#f0A', '#FF00AA'],
            ['red', '#FF0000'],
            ['Navy', '#000080'],
        ]) {
            expect(readMathml(math(`<mi mathcolor="${value}">x</mi>`))).toEqual([
                { kind: 'identifier', text: 'x', color },
            ]);
        }
        for (const value of [
            'javascript:alert(1)',
            'rebeccapurple',
            'url(#a)',
            '#FF00001',
            ' #FF0000',
            '#GG0000',
            '',
        ]) {
            expect(readMathml(math(`<mi mathcolor="${value}">x</mi>`))).toEqual(x);
            expect(readMathml(math(`<mtext mathcolor="${value}">if</mtext>`))).toEqual([{ kind: 'text', text: 'if' }]);
        }
        expect(readMathml(math('<mi mathvariant="slanted">x</mi>'))).toEqual(x);
    });

    test('a character XML cannot hold is an error', () => {
        expect(() => readMathml(element('math', [element('mi', ['\uD800'])]))).toThrow(MathError);
    });

    // Whatever MathML comes in, the tree is canonical, so the docx trip and the stored trip keep it.
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
        const row = readMathml(math(content));
        expect(canonicalIssue(row)).toBeUndefined();
        expect(viaOmml(row)).toStrictEqual(row);
        expect(viaMathml(row)).toStrictEqual(row);
    });

    // A mark after a large operator makes a symbol of its own, so a scripted ∑̸ is no n-ary.
    test.each<MathNode>([
        { kind: 'limit', position: 'under', base: [{ kind: 'operator', text: '∑̸' }], limit: letter('x') },
        { kind: 'scripts', base: [{ kind: 'operator', text: '∑̸' }], sup: letter('x') },
        { kind: 'accent', accent: '̂', body: [{ kind: 'operator', text: '∑̸' }] },
    ])('a marked large operator in a base survives: %j', (node) => {
        expect(viaMathml([node])).toStrictEqual([node]);
    });

    test('Em spaces pair whether they come as characters or as mspace', () => {
        expect(readMathml(math('<mspace width="1em"/><mspace width="1em"/>'))).toEqual([
            { kind: 'space', width: 'qquad' },
        ]);
    });

    test('an equations cell splits at &, and a row without cells is one empty cell', () => {
        const equations =
            '<mtable displaystyle="true"><mtr><mtd><mi>x</mi><mo>&amp;</mo><mn>1</mn></mtd></mtr><mtr/></mtable>';
        expect(readMathml(math(equations))).toEqual([
            { kind: 'table', layout: 'equations', rows: [[x, [{ kind: 'number', text: '1' }]], [[]]] },
        ]);
    });

    test('an n-ary is a scripted operator from the large-operator table, or one marked largeop, then its body', () => {
        const i: MathRow = [{ kind: 'identifier', text: 'i' }];
        expect(
            readMathml(math('<mrow><munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover><mi>x</mi></mrow>')),
        ).toEqual([
            { kind: 'nary', operator: '∑', limits: 'under', sub: i, sup: [{ kind: 'identifier', text: 'n' }], body: x },
        ]);
        expect(readMathml(math('<msub><mo>∫</mo><mi>i</mi></msub><mi>x</mi>'))).toEqual([
            { kind: 'nary', operator: '∫', limits: 'side', sub: i, body: x },
        ]);
        expect(readMathml(math('<mrow><mo largeop="true">∑</mo><mi>x</mi></mrow>'))).toEqual([
            { kind: 'nary', operator: '∑', limits: 'under', body: x },
        ]);
        expect(readMathml(math('<mrow><msub><mo>+</mo><mi>i</mi></msub><mi>x</mi></mrow>'))).toEqual([
            { kind: 'scripts', base: [{ kind: 'operator', text: '+' }], sub: i },
            ...x,
        ]);
        expect(readMathml(math('<mrow><mo largeop="true">\u200B</mo><mi>x</mi></mrow>'))).toEqual(x);
    });

    test('an munderover outside an n-ary reads as a limit under inside a limit over', () => {
        expect(readMathml(math('<munderover><mi>x</mi><mi>a</mi><mi>b</mi></munderover>'))).toEqual([
            {
                kind: 'limit',
                position: 'over',
                base: [{ kind: 'limit', position: 'under', base: x, limit: letter('a') }],
                limit: letter('b'),
            },
        ]);
    });
});

const html = (content: string) => htmlMath(`<p><math>${content}</math></p>`);
const fenced = (open: string, close: string, separator: string, parts: MathRow[]): MathRow => [
    { kind: 'fenced', open, close, separator, parts },
];

describe('foreign MathML', () => {
    test.each(FOREIGN_MATHML)('$source: $expected', ({ mathml, latex, expected }) => {
        const read = readMathml(el(mathml));
        expect(read).toStrictEqual(readLatex(expected));
        expect(readMathmlLatex(el(mathml))).toBe(latex);
        expect(readMathml(htmlMath(`<p>${mathml}</p>`))).toStrictEqual(read);
        expect(canonicalIssue(read)).toBeUndefined();
        expect(viaMathml(read)).toStrictEqual(read);
        expect(viaOmml(read)).toStrictEqual(read);
        expect(viaLatex(read)).toStrictEqual(read);
    });

    test('math in an HTML DOM, prefixed or in no namespace, reads as MathML', () => {
        expect(readMathml(html('<mi>x</mi>'))).toEqual(x);
        expect(readMathml(htmlMath('<p><mml:math><mml:mi>x</mml:mi></mml:math></p>'))).toEqual(x);
        expect(readMathml(el('<math><mi>x</mi></math>'))).toEqual(x);
        expect(readMathml(el(`<mml:math xmlns:mml="${MATHML_NAMESPACE}"><mml:mi>x</mml:mi></mml:math>`))).toEqual(x);
        // A browser's HTML parser keeps the prefix in the local name.
        const xhtml = 'http://www.w3.org/1999/xhtml';
        const prefixed = (local: string, children: (string | object)[]) => ({
            ns: xhtml,
            local,
            attributes: {},
            children,
        });
        expect(readMathml(prefixed('mml:math', [prefixed('mml:mi', ['x'])]))).toEqual(x);
        // Another namespace's element still reads as its content.
        const svg = { ns: 'http://www.w3.org/2000/svg', local: 'mi', attributes: {}, children: ['x'] };
        expect(readMathml(element('math', [element('mn', ['1']), svg]))).toEqual([{ kind: 'number', text: '1' }]);
    });

    test('entities arrive decoded through the DOM', () => {
        expect(readMathml(html('<mi>&lambda;</mi><mo>&#x2212;</mo><mi>&#120582;</mi>'))).toEqual([
            { kind: 'identifier', text: 'λ' },
            { kind: 'operator', text: '−' },
            { kind: 'identifier', text: 'λ' },
        ]);
    });

    test('mfenced is a fenced row: ( ) and , by default, one separator for the tree', () => {
        const [a, b, c] = [letter('a'), letter('b'), letter('c')];
        expect(readMathml(math('<mfenced><mi>a</mi><mi>b</mi></mfenced>'))).toEqual(fenced('(', ')', ',', [a, b]));
        expect(readMathml(math('<mfenced open="[" close="" separators="; ,"><mi>a</mi></mfenced>'))).toEqual(
            fenced('[', '', '', [a]),
        );
        expect(readMathml(math('<mfenced separators=""><mi>a</mi><mi>b</mi></mfenced>'))).toEqual(
            fenced('(', ')', '', [[...a, ...b]]),
        );
        expect(
            readMathml(math('<mfenced separators=";,"><mi>a</mi><mrow><mi>b</mi></mrow><mi>c</mi></mfenced>')),
        ).toEqual(fenced('(', ')', ';', [a, b, c]));
        expect(readMathml(math('<mfenced/>'))).toEqual(fenced('(', ')', '', [[]]));
    });

    test('mstyle and every element pass mathvariant and mathcolor down; displaystyle and scriptlevel do nothing', () => {
        const sample =
            '<mstyle mathvariant="bold" mathcolor="red" displaystyle="true" scriptlevel="1"><mi>x</mi>' +
            '<mfrac><mn>1</mn><mi mathvariant="normal" mathcolor="#00f">y</mi></mfrac><mtext>if</mtext></mstyle>';
        expect(readMathml(math(sample))).toEqual([
            { kind: 'identifier', text: 'x', variant: 'bold', color: '#FF0000' },
            {
                kind: 'fraction',
                numerator: [{ kind: 'number', text: '1', variant: 'bold', color: '#FF0000' }],
                denominator: [{ kind: 'identifier', text: 'y', variant: 'normal', color: '#0000FF' }],
                line: 'bar',
            },
            { kind: 'text', text: 'if', color: '#FF0000' },
        ]);
        expect(readMathml(math('<mrow mathcolor="nope"><mi>x</mi></mrow>'))).toEqual(x);
    });

    test('maction reads its selected child, the first by default', () => {
        const action = (selection: string) => `<maction actiontype="toggle"${selection}><mi>a</mi><mi>b</mi></maction>`;
        expect(readMathml(math(action(' selection="2"')))).toEqual(letter('b'));
        for (const selection of ['', ' selection="3"', ' selection="x"']) {
            expect(readMathml(math(action(selection)))).toEqual(letter('a'));
        }
    });

    test('a zero linethickness is no line, in any unit', () => {
        for (const thickness of ['0', '0px', '0em', '0pt']) {
            expect(readMathml(math(`<mfrac linethickness="${thickness}"><mi>a</mi><mi>b</mi></mfrac>`))).toEqual([
                { kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'none' },
            ]);
        }
        expect(readMathml(math('<mfrac linethickness="1px"><mi>a</mi><mi>b</mi></mfrac>'))[0]).toMatchObject({
            line: 'bar',
        });
    });

    test('ms is text without quotes; mpadded and mphantom read as their content', () => {
        expect(readMathml(math('<ms lquote="«">a b</ms>'))).toEqual([{ kind: 'text', text: 'a b' }]);
        expect(readMathml(math('<mpadded width="+1em"><mi>x</mi></mpadded><mphantom><mn>1</mn></mphantom>'))).toEqual([
            ...x,
            { kind: 'number', text: '1' },
        ]);
    });

    test.each<[string, MathEnclosure[]]>([
        ['box', ['top', 'bottom', 'left', 'right']],
        ['roundedbox', ['top', 'bottom', 'left', 'right']],
        ['circle', ['top', 'bottom', 'left', 'right']],
        ['actuarial', ['top', 'right']],
        ['madruwb', ['bottom', 'right']],
        ['longdiv', ['top', 'left']],
        ['updiagonalstrike box', ['top', 'bottom', 'left', 'right', 'updiagonalstrike']],
        ['radical', []],
    ])('menclose notation %p draws the lines nearest it', (notation, lines) => {
        expect(readMathml(math(`<menclose notation="${notation}"><mi>x</mi></menclose>`))).toEqual([
            { kind: 'enclose', notation: lines, body: x },
        ]);
    });

    test('a space is the one nearest its em width', () => {
        const spaces =
            '<mspace width="0.167em"/><mspace width="0.222em"/><mspace width="0.278em"/><mspace width="0pt"/>';
        expect(readMathml(math(spaces))).toEqual([
            { kind: 'space', width: 'thin' },
            { kind: 'space', width: 'medium' },
            { kind: 'space', width: 'thick' },
        ]);
    });

    test('a scripted large operator takes the next element as its body, unless that is an operator or space', () => {
        const sum = '<munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover>';
        const nary = (body: MathRow): MathNode => ({
            kind: 'nary',
            operator: '∑',
            limits: 'under',
            sub: letter('i'),
            sup: letter('n'),
            body,
        });
        const plus: MathNode = { kind: 'operator', text: '+' };
        expect(readMathml(math(`<mi>y</mi><mo>=</mo>${sum}<mi>x</mi><mo>+</mo><mn>1</mn>`))).toEqual([
            ...letter('y'),
            { kind: 'operator', text: '=' },
            nary(x),
            plus,
            { kind: 'number', text: '1' },
        ]);
        // Temml wraps the operator in an mrow of its own.
        expect(readMathml(math(`<mrow><mrow>${sum}</mrow><mrow><mi>x</mi><mo>+</mo></mrow></mrow>`))).toEqual([
            nary([...x, plus]),
        ]);
        expect(readMathml(math(`${sum}<mo>+</mo><mi>x</mi>`))).toEqual([nary([]), plus, ...x]);
        expect(readMathml(math(`${sum}<mrow><mo>(</mo><mi>x</mi></mrow>`))).toEqual([
            nary([]),
            { kind: 'operator', text: '(' },
            ...x,
        ]);
        expect(readMathml(math(`<mfrac>${sum}<mn>2</mn></mfrac>`))).toEqual([
            { kind: 'fraction', numerator: [nary([])], denominator: [{ kind: 'number', text: '2' }], line: 'bar' },
        ]);
    });

    test('a name before U+2061 takes the next element as its body, unless that is an operator', () => {
        const sin: MathRow = [{ kind: 'identifier', text: 'sin' }];
        const fn = '<mi>sin</mi><mo>\u2061</mo>';
        expect(readMathml(math(`<mn>2</mn>${fn}<mi>x</mi>`))).toEqual([
            { kind: 'number', text: '2' },
            { kind: 'function', name: sin, body: x },
        ]);
        // Temml spaces the name from its body inside an mrow; KaTeX puts the U+2061 in the base of \lim's limit.
        expect(readMathml(math(`<mrow>${fn}<mspace width="0.1667em"/></mrow><mi>x</mi>`))).toEqual([
            { kind: 'function', name: sin, body: x },
        ]);
        const lim = '<munder><mrow><mi>lim</mi><mo>\u2061</mo></mrow><mi>n</mi></munder>';
        expect(readMathml(math(`${lim}<mi>x</mi>`))).toEqual([
            {
                kind: 'function',
                name: [
                    {
                        kind: 'limit',
                        position: 'under',
                        base: [{ kind: 'identifier', text: 'lim' }],
                        limit: letter('n'),
                    },
                ],
                body: x,
            },
        ]);
        expect(readMathml(math(`${fn}<mo>(</mo><mi>x</mi><mo>)</mo>`))).toEqual([
            ...sin,
            { kind: 'operator', text: '(' },
            ...x,
            { kind: 'operator', text: ')' },
        ]);
        expect(readMathml(math(fn))).toEqual(sin);
    });

    // KaTeX's shapes and Temml's, each against the tree readLatex makes of the formula.
    const sum = (index: string) => `<munder><mo>∑</mo><mi>${index}</mi></munder>`;
    const sin = '<mi>sin</mi><mo>\u2061</mo>';
    test.each<[string, string]>([
        // A body that is a function or an n-ary of its own reads whole.
        [`<msubsup><mo>∫</mo><mn>0</mn><mi>π</mi></msubsup>${sin}<mi>x</mi>`, '\\int_0^\\pi \\sin x'],
        [`${sum('i')}${sum('j')}<mi>a</mi>`, '\\sum_i\\sum_j a'],
        [`<mrow>${sum('i')}</mrow><mrow>${sum('j')}</mrow><mi>a</mi>`, '\\sum_i\\sum_j a'],
        [`${sin}${sin}<mi>x</mi>`, '\\sin\\sin x'],
        [
            `${sum('i')}<munder><mrow><mi>lim</mi><mo>\u2061</mo></mrow><mi>n</mi></munder><mi>x</mi>`,
            '\\sum_i\\lim_n x',
        ],
        [`${sum('i')}${sin}<mo>+</mo>`, '\\sum_i\\sin+'],
        // Only Temml's space after U+2061 is skipped; a space typed there stays.
        [`${sin}<mspace width="0.167em"/><mi>x</mi>`, '\\sin\\,x'],
        [`${sin}<mspace width="1em"/><mi>x</mi>`, '\\sin\\quad x'],
        [`<mrow>${sin}<mspace width="0.1667em"/></mrow><mspace width="1em"/><mi>x</mi>`, '\\sin\\quad x'],
        // A construct waits past its mrow's end only when it is all the mrow holds.
        [`<mrow><mi>a</mi><mo>+</mo>${sum('i')}</mrow><mi>x</mi>`, '{a+\\sum_i}x'],
        // An accent, line or brace over a large operator is no n-ary.
        ['<mover accent="true"><mo>∑</mo><mo>^</mo></mover><mi>x</mi>', '\\hat{\\sum} x'],
        ['<mover><mo>∑</mo><mo stretchy="false">ˆ</mo></mover><mi>x</mi>', '\\hat{\\sum} x'],
        ['<mover accent="true"><mo>∫</mo><mo stretchy="true">‾</mo></mover>', '\\overline{\\int}'],
        ['<munder><mo>∑</mo><mo stretchy="true">⏟</mo></munder><mi>x</mi>', '\\underbrace{\\sum} x'],
        // The first fence closes at the last only when the fences between balance.
        [
            '<mrow><mo fence="true">(</mo><mi>a</mi><mo fence="true">)</mo><mo>+</mo>' +
                '<mo fence="true">(</mo><mi>b</mi><mo fence="true">)</mo></mrow>',
            '(a)+(b)',
        ],
        [
            '<mrow><mo fence="true">(</mo><mi>a</mi><mo fence="true">|</mo><mi>b</mi><mo fence="true">)</mo></mrow>',
            '\\left(a|b\\right)',
        ],
    ])('%s reads as %s', (mathml, latex) => {
        expect(readMathml(math(mathml))).toStrictEqual(readLatex(latex));
    });

    test("an accent, line or brace says so, or its character does as MathML's operator dictionary has it", () => {
        const over = (script: string, attributes = '') =>
            readMathml(math(`<mover${attributes}><mi>x</mi>${script}</mover>`));
        for (const char of ['^', 'ˆ', '\u0302']) {
            expect(over(`<mo stretchy="false">${char}</mo>`)).toEqual([{ kind: 'accent', accent: '\u0302', body: x }]);
        }
        expect(over('<mo>→</mo>')).toEqual([{ kind: 'accent', accent: '\u20D7', body: x }]);
        expect(over('<mo>^</mo>', ' accent="false"')).toEqual([
            { kind: 'limit', position: 'over', base: x, limit: [{ kind: 'operator', text: '^' }] },
        ]);
        expect(over('<mo>^^</mo>')[0]).toMatchObject({ kind: 'limit' });
        expect(over('<mo accent="true">―</mo>')).toEqual([{ kind: 'line', position: 'over', body: x }]);
        expect(over('<mo>⏞</mo>')).toEqual([{ kind: 'brace', char: '⏞', position: 'over', body: x }]);
        expect(readMathml(math('<munder accentunder="true"><mi>x</mi><mo stretchy="true">‾</mo></munder>'))).toEqual([
            { kind: 'line', position: 'under', body: x },
        ]);
    });

    // Where a foreign shape meets Eigen's own, the writer marks its own.
    test.each<MathNode>([
        { kind: 'limit', position: 'over', base: x, limit: [{ kind: 'operator', text: '→' }] },
        { kind: 'limit', position: 'under', base: x, limit: [{ kind: 'operator', text: '⏟' }] },
        { kind: 'limit', position: 'over', base: x, limit: [{ kind: 'operator', text: '^' }] },
        { kind: 'function', name: letter('f'), body: [{ kind: 'space', width: 'thin' }] },
        { kind: 'function', name: letter('f'), body: [{ kind: 'operator', text: '+' }] },
        { kind: 'nary', operator: '∑', limits: 'under', sup: [{ kind: 'operator', text: '~' }], body: x },
    ])('%j survives the MathML trip', (node) => {
        expect(viaMathml([node])).toStrictEqual([node]);
    });
});

// Every reader counts the tree it makes, so an empty script or degree costs nothing the tree doesn't hold. An msub
// without scripts reads through, which counts one.
test.each<[string, MathRow, number]>([
    ['<msub><mi>x</mi><mrow/></msub>', x, 5],
    ['<mroot><mi>x</mi><mrow/></mroot>', [{ kind: 'radical', body: x }], 6],
    // An & in an equation's cell counts as the cell it starts, not as an operator.
    [
        '<mtable displaystyle="true"><mtr><mtd><mi>x</mi><mo>&amp;</mo></mtd></mtr></mtable>',
        [{ kind: 'table', layout: 'equations', rows: [[x, []]] }],
        8,
    ],
])('the largest tree reads with %p for every unit', (unit, read, size) => {
    const count = Math.floor((MATH_LIMITS.size - 1) / size);
    const row = Array.from({ length: count }, (): MathRow => [...read, { kind: 'operator', text: '+' }]).flat();
    expect(readMathml(math(`${unit}<mo>+</mo>`.repeat(count)))).toStrictEqual(row);
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
            expect(viaMathml(row)).toStrictEqual(row);
            expect(readMathml(el(writeMathml(row, 'tex')))).toStrictEqual(row);
        }
    });

    // LaTeX's cases: a { before a matrix alone, its columns aligned left with MathML's own cell spacing.
    test('a { before a matrix alone aligns its columns left; a matrix elsewhere and equations keep theirs', () => {
        const matrix: MathNode = { kind: 'table', layout: 'matrix', rows: [[x, x]] };
        const equations: MathNode = { kind: 'table', layout: 'equations', rows: [[x, x]] };
        const fenced = (table: MathNode, open = '{', close = ''): MathRow => [
            { kind: 'fenced', open, close, separator: '', parts: [[table]] },
        ];
        const cells = '<mtr><mtd><mi>x</mi></mtd><mtd><mi>x</mi></mtd></mtr>';
        expect(writeMathml(fenced(matrix))).toBe(
            `<math xmlns="${MATHML_NAMESPACE}"><mrow><mo fence="true">{</mo><mtable columnalign="left">${cells}</mtable>` +
                '<mo fence="true"></mo></mrow></math>',
        );
        expect(writeMathml(fenced(matrix, '(', ')'))).toContain(`<mtable>${cells}</mtable>`);
        expect(writeMathml([matrix])).toContain(`<mtable>${cells}</mtable>`);
        expect(writeMathml(fenced(equations))).toContain(
            `<mtable displaystyle="true" columnalign="right left">${cells}</mtable>`,
        );
        for (const row of [fenced(matrix), fenced(equations)]) {
            expect(viaMathml(row)).toStrictEqual(row);
            expect(viaOmml(row)).toStrictEqual(row);
        }
    });

    test('never writes display', () => {
        expect(writeMathml(x)).not.toContain('display=');
    });

    test('refuses to write past the MathML cap', () => {
        const text = 'a'.repeat(MATH_LIMITS.mathmlLength);
        expect(() => writeMathml([{ kind: 'text', text }])).toThrow(MathError);
    });
});
