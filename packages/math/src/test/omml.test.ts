import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE, writeOmml } from '../omml';
import type { MathNode, MathRow } from '../tree';
import type { MathXmlElement } from '../xml';
import { canonicalIssue } from './canonical';
import { canonicalOmml, NORMALISATIONS } from './canonical-omml';
import { CORPUS, type CorpusEquation } from './corpus';
import { generateTree } from './generate';
import { el, parseWritten } from './parse';

const NAMESPACES = `xmlns:m="${OMML_NAMESPACE}" xmlns:w="${WORDML_NAMESPACE}"`;
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

const oMath = (content: string) => el(`<m:oMath ${NAMESPACES}>${content}</m:oMath>`);
const read = (content: string) => readOmml(oMath(content));
const run = (text: string, properties = '') => `<m:r>${properties}<m:t>${text}</m:t></m:r>`;

// ── C1: docx round trip ─────────────────────────────────────────────────────────────────────────────────────────

function expectRoundTrip(equation: CorpusEquation) {
    const original = el(equation.omml);
    const expected = NORMALISATIONS.reduce((row, normalisation) => normalisation.apply(row), canonicalOmml(original));
    expect(canonicalOmml(parseWritten(writeOmml(readOmml(original))))).toEqual(expected);
}

describe('C1: OMML → tree → OMML keeps what Word shows', () => {
    for (const equation of CORPUS) {
        test(`#${equation.i} ${equation.file}`, () => expectRoundTrip(equation));
    }

    test('each normalisation changes exactly the equations it lists', () => {
        for (const normalisation of NORMALISATIONS) {
            const changed = CORPUS.filter((equation) => {
                const canonical = canonicalOmml(el(equation.omml));
                return !Bun.deepEquals(normalisation.apply(canonical), canonical);
            }).map((equation) => equation.i);
            expect({ reason: normalisation.reason, changed }).toEqual({
                reason: normalisation.reason,
                changed: normalisation.indices,
            });
        }
    });

    test('the yardstick shows a separator only between parts', () => {
        const fence = (properties: string, parts: number) =>
            canonicalOmml(oMath(`<m:d>${properties}${`<m:e>${run('x')}</m:e>`.repeat(parts)}</m:d>`));
        const empty = '<m:dPr><m:sepChr m:val=""/></m:dPr>';
        expect(fence(empty, 1)).toEqual(fence('', 1));
        expect(fence(empty, 2)).not.toEqual(fence('', 2));
    });

    // The research prototype's misses that are in the fixture, so the loop above covers them; #146 and #151 are
    // Zenodo, checked locally (C7).
    test('the prototype misses are in the fixture', () => {
        expect([3, 87, 173, 174].filter((index) => !CORPUS.some((equation) => equation.i === index))).toEqual([]);
    });

    test('every fixture equation reads to a canonical tree', () => {
        for (const equation of CORPUS) {
            expect({ i: equation.i, issue: canonicalIssue(readOmml(el(equation.omml))) }).toEqual({
                i: equation.i,
                issue: undefined,
            });
        }
    });

    test('seeded canonical trees survive OMML unchanged', () => {
        for (let seed = 1; seed <= 1000; seed++) {
            const tree = generateTree(seed);
            expect({ seed, tree: readOmml(parseWritten(writeOmml(tree))) }).toStrictEqual({ seed, tree });
        }
    });
});

// ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('readOmml', () => {
    test('tokens follow the run style, not the run boundaries', () => {
        expect(read(run('sin', '<m:rPr><m:sty m:val="p"/></m:rPr>') + run('x'))).toEqual([
            { kind: 'identifier', text: 'sin' },
            { kind: 'identifier', text: 'x' },
        ]);
        expect(read(run('map'))).toEqual([
            { kind: 'identifier', text: 'm' },
            { kind: 'identifier', text: 'a' },
            { kind: 'identifier', text: 'p' },
        ]);
        expect(read(run('1') + run('2.') + run('5.6'))).toEqual([
            { kind: 'number', text: '12.5' },
            { kind: 'operator', text: '.' },
            { kind: 'number', text: '6' },
        ]);
        expect(
            read(run('x2', '<m:rPr><m:sty m:val="p"/></m:rPr>') + run('2', '<m:rPr><m:sty m:val="i"/></m:rPr>')),
        ).toEqual([
            { kind: 'identifier', text: 'x', variant: 'normal' },
            { kind: 'number', text: '2' },
            { kind: 'number', text: '2', variant: 'italic' },
        ]);
    });

    test('a style Word has no letter form for keeps what it can', () => {
        const style = (sty: string, scr: string) => `<m:rPr><m:scr m:val="${scr}"/><m:sty m:val="${sty}"/></m:rPr>`;
        expect(read(run('R', style('bi', 'double-struck')))).toEqual([
            { kind: 'identifier', text: 'R', variant: 'double-struck' },
        ]);
        expect(read(run('F', style('bi', 'fraktur')))).toEqual([
            { kind: 'identifier', text: 'F', variant: 'bold-fraktur' },
        ]);
        expect(read(run('A', style('i', 'sans-serif')))).toEqual([
            { kind: 'identifier', text: 'A', variant: 'sans-serif-italic' },
        ]);
    });

    test('Unicode alphanumerics fold to a letter and its variant', () => {
        expect(read(run('𝐯ℝℎ𝟎'))).toEqual([
            { kind: 'identifier', text: 'v', variant: 'bold' },
            { kind: 'identifier', text: 'R', variant: 'double-struck' },
            { kind: 'identifier', text: 'h' },
            { kind: 'number', text: '0', variant: 'bold' },
        ]);
    });

    test('spaces read as the space set; invisible operators go', () => {
        expect(read(run(' \u2009\u205F\u2004\u2003\u2003\u2003\u2003\u2003\u00A0'))).toEqual(
            (['normal', 'thin', 'medium', 'thick', 'qquad', 'qquad', 'quad', 'normal'] as const).map((width) => ({
                kind: 'space',
                width,
            })),
        );
        expect(read(run('a\u2061\u2062\u200Bb'))).toEqual([
            { kind: 'identifier', text: 'a' },
            { kind: 'identifier', text: 'b' },
        ]);
    });

    test('normal text keeps its spaces and merges across runs', () => {
        const normal = '<m:rPr><m:nor/></m:rPr>';
        expect(read(run('\u00A0if ', normal) + run('x\u00A0', normal))).toEqual([{ kind: 'text', text: ' if x ' }]);
        expect(read(run('a\u00A0b', normal))).toEqual([{ kind: 'text', text: 'a\u00A0b' }]);
    });

    test('text comes only from m:t; tracked deletions and moves away go', () => {
        const ins = (content: string) => `<w:ins w:id="1" w:author="a">${content}</w:ins>`;
        const del = (content: string) => `<w:del w:id="2" w:author="a">${content}</w:del>`;
        expect(
            read(
                `\n  <m:r>stray<m:t>a</m:t></m:r>\n` +
                    `<m:r>${ins('<m:rPr><m:sty m:val="p"/></m:rPr><m:t>b</m:t>')}</m:r>` +
                    `<m:r>${del('<m:t>c</m:t>')}</m:r>` +
                    `<w:moveFrom>${run('d')}</w:moveFrom><w:moveTo>${run('e')}</w:moveTo>${del(run('f'))}${ins(run('g'))}`,
            ),
        ).toEqual([
            { kind: 'identifier', text: 'a' },
            { kind: 'identifier', text: 'b', variant: 'normal' },
            { kind: 'identifier', text: 'e' },
            { kind: 'identifier', text: 'g' },
        ]);
    });

    test('an object whose control character is a tracked deletion goes whole', () => {
        const deleted = '<m:ctrlPr><w:del w:id="1" w:author="a"><w:rPr/></w:del></m:ctrlPr>';
        expect(
            read(
                `<m:d><m:dPr>${deleted}</m:dPr><m:e><m:r><w:del w:id="2" w:author="a"><m:t>x</m:t></w:del></m:r></m:e></m:d>` +
                    `<m:acc><m:accPr><m:ctrlPr><w:moveFrom w:id="3" w:author="a"/></m:ctrlPr></m:accPr><m:e/></m:acc>` +
                    `<m:d><m:dPr><m:ctrlPr><w:ins w:id="4" w:author="a"/></m:ctrlPr></m:dPr><m:e>${run('y')}</m:e></m:d>`,
            ),
        ).toEqual([
            { kind: 'fenced', open: '(', close: ')', separator: '', parts: [[{ kind: 'identifier', text: 'y' }]] },
        ]);
        const U: MathNode = { kind: 'identifier', text: 'U' };
        const fenced = (open: string, close: string, ...part: MathRow): MathNode => ({
            kind: 'fenced',
            open,
            close,
            separator: '',
            parts: [part],
        });
        // Word, after accepting the changes, shows Ū. and P(E[U])≠E[P(U)].
        expect(
            CORPUS.filter((equation) => [87, 89].includes(equation.i)).map((equation) => readOmml(el(equation.omml))),
        ).toEqual([
            [
                { kind: 'accent', accent: '\u0305', body: [U] },
                { kind: 'operator', text: '.' },
            ],
            [
                { kind: 'identifier', text: 'P' },
                fenced('(', ')', { kind: 'identifier', text: 'E' }, fenced('[', ']', U)),
                { kind: 'operator', text: '≠' },
                { kind: 'identifier', text: 'E' },
                fenced('[', ']', { kind: 'identifier', text: 'P' }, fenced('(', ')', U)),
                { kind: 'operator', text: '.' },
            ],
        ]);
    });

    test('mc:AlternateContent reads its fallback', () => {
        expect(
            read(
                `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="w14">${run('a')}</mc:Choice>` +
                    `<mc:Fallback>${run('b')}</mc:Fallback></mc:AlternateContent>`,
            ),
        ).toEqual([{ kind: 'identifier', text: 'b' }]);
    });

    test('on/off values read as Word does', () => {
        const rad = (degHide: string) =>
            read(`<m:rad><m:radPr>${degHide}</m:radPr><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>`);
        for (const on of [
            '<m:degHide/>',
            '<m:degHide m:val="1"/>',
            '<m:degHide m:val="on"/>',
            '<m:degHide m:val="true"/>',
        ]) {
            expect(rad(on)).toEqual([{ kind: 'radical', body: [{ kind: 'identifier', text: 'x' }] }]);
        }
        for (const off of ['', '<m:degHide m:val="0"/>', '<m:degHide m:val="off"/>', '<m:degHide m:val="false"/>']) {
            expect(rad(off)[0]).toHaveProperty('degree', [{ kind: 'number', text: '3' }]);
        }
    });

    test('a colour is six hex digits or nothing', () => {
        const colored = (value: string) => read(run('x', `<w:rPr><w:color w:val="${value}"/></w:rPr>`))[0];
        expect(colored('00b050')).toEqual({ kind: 'identifier', text: 'x', color: '#00B050' });
        expect(colored('000000')).toEqual({ kind: 'identifier', text: 'x', color: '#000000' });
        const text = (value: string) =>
            read(run('if', `<m:rPr><m:nor/></m:rPr><w:rPr><w:color w:val="${value}"/></w:rPr>`))[0];
        for (const value of [
            'auto',
            'red',
            '#FF0000',
            '0000FF&quot; onload=&quot;x',
            'FF00001',
            ' 00FF00',
            'GG0000',
            '',
        ]) {
            expect(colored(value)).toEqual({ kind: 'identifier', text: 'x' });
            expect(text(value)).toEqual({ kind: 'text', text: 'if' });
        }
    });

    test('defaults resolve on read', () => {
        expect(read(`<m:nary><m:sub/><m:sup/><m:e>${run('x')}</m:e></m:nary>`)).toEqual([
            { kind: 'nary', operator: '∫', limits: 'side', body: [{ kind: 'identifier', text: 'x' }] },
        ]);
        expect(read(`<m:d><m:e>${run('x')}</m:e></m:d>`)).toEqual([
            { kind: 'fenced', open: '(', close: ')', separator: '', parts: [[{ kind: 'identifier', text: 'x' }]] },
        ]);
        expect(
            read(`<m:acc><m:e>${run('x')}</m:e></m:acc><m:bar><m:e/></m:bar><m:groupChr><m:e/></m:groupChr>`),
        ).toEqual([
            { kind: 'accent', accent: '\u0302', body: [{ kind: 'identifier', text: 'x' }] },
            { kind: 'line', position: 'under', body: [] },
            { kind: 'brace', char: '⏟', position: 'under', body: [] },
        ]);
    });

    test('scripts with nothing in them read as their base; box and phantom as their content', () => {
        expect(read(`<m:sSub><m:e>${run('x')}</m:e><m:sub/></m:sSub><m:box><m:e>${run('y')}</m:e></m:box>`)).toEqual([
            { kind: 'identifier', text: 'x' },
            { kind: 'identifier', text: 'y' },
        ]);
        expect(read(`<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr><m:e>${run('z')}</m:e></m:phant>`)).toEqual([
            { kind: 'identifier', text: 'z' },
        ]);
    });

    test('an equation array splits its rows at & into cells', () => {
        expect(read(`<m:eqArr><m:e>${run('x&amp;=1')}</m:e><m:e>${run('y')}</m:e></m:eqArr>`)).toEqual([
            {
                kind: 'table',
                layout: 'equations',
                rows: [
                    [
                        [{ kind: 'identifier', text: 'x' }],
                        [
                            { kind: 'operator', text: '=' },
                            { kind: 'number', text: '1' },
                        ],
                    ],
                    [[{ kind: 'identifier', text: 'y' }]],
                ],
            },
        ]);
    });

    test('a table without rows, or a row without cells, reads as one empty cell', () => {
        for (const [omml, layout] of [
            ['<m:m/>', 'matrix'],
            ['<m:m><m:mr/></m:m>', 'matrix'],
            ['<m:eqArr/>', 'equations'],
        ] as const) {
            const row = read(omml);
            expect(row).toEqual([{ kind: 'table', layout, rows: [[[]]] }]);
            expect(writeOmml(row)).not.toMatch(/<m:m><\/m:m>|<m:mr><\/m:mr>|<m:eqArr><\/m:eqArr>/);
        }
    });

    test('a tab, CR or LF in text reads as a space', () => {
        const normal = '<m:rPr><m:nor/></m:rPr>';
        expect(read(`<m:r>${normal}<m:t xml:space="preserve">&#9;if&#13;a&#10;</m:t></m:r>`)).toEqual([
            { kind: 'text', text: ' if a ' },
        ]);
    });

    test('unknown elements, comments and processing instructions read as nothing more than their content', () => {
        expect(read(`<m:future>${run('a<!--c-->b<?pi x?>')}</m:future><!--c--><?pi y?>`)).toEqual([
            { kind: 'identifier', text: 'a' },
            { kind: 'identifier', text: 'b' },
        ]);
        // Bun's parser keeps comments and processing instructions as objects without `local`.
        const m = (local: string, children: (string | object)[]): MathXmlElement => ({
            ns: OMML_NAMESPACE,
            local,
            attributes: {},
            children,
        });
        expect(readOmml(m('oMath', [{ comment: 'c' }, m('r', [m('t', ['x', { target: 'pi', data: '' }])])]))).toEqual([
            { kind: 'identifier', text: 'x' },
        ]);
        expect(() => readOmml(m('oMath', [m('r', [m('t', ['\u0001'])])]))).toThrow(MathError);
    });
});

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('writeOmml', () => {
    test('writes one m:oMath and merges neighbours of one style into one run', () => {
        const row: MathRow = [
            { kind: 'identifier', text: 'x' },
            { kind: 'operator', text: '+' },
            { kind: 'number', text: '1' },
            { kind: 'identifier', text: 'sin' },
        ];
        expect(writeOmml(row)).toBe(
            '<m:oMath><m:r><m:t xml:space="preserve">x+1</m:t></m:r>' +
                '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">sin</m:t></m:r></m:oMath>',
        );
    });
});
