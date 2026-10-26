import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex, writeLatex } from '../latex';
import type { LatexCommand } from '../latex-commands';
import { LATEX_COMMANDS } from '../latex-commands';
import { readMathml, readMathmlLatex, writeMathml } from '../mathml';
import { ACCENTS, LARGE_OPERATORS, naryLimits } from '../notation';
import { readOmml } from '../omml';
import type { MathNode, MathRow } from '../tree';
import { MATH_ENCLOSURES, MATH_LIMITS, MATH_SPACES, MATH_VARIANTS } from '../tree';
import { canonicalIssue } from './canonical';
import { CORPUS } from './corpus';
import { LATEX_FORMULAS } from './fixtures/latex-formulas';
import { generateTree, seedChunks } from './generate';
import { LOSSES } from './latex-losses';
import { el, letter, viaLatex, viaMathml, viaOmml } from './parse';

const x = letter('x');
const one: MathRow = [{ kind: 'number', text: '1' }];
const two: MathRow = [{ kind: 'number', text: '2' }];
const prime: MathNode = { kind: 'operator', text: '′' };

function thrown(read: () => unknown): MathError | undefined {
    try {
        read();
    } catch (error) {
        if (error instanceof MathError) return error;
        throw error;
    }
    return undefined;
}

// What LaTeX has a command for, read from the table.
const commands = (kind: LatexCommand['kind']) =>
    [...LATEX_COMMANDS.values()].filter((command) => command.kind === kind);
const ACCENT_COMMANDS = new Set(commands('accent').map((command) => command.kind === 'accent' && command.accent));
const BRACE_COMMANDS = new Set(
    commands('brace').map((command) => command.kind === 'brace' && command.char + command.position),
);
const DELIMITER_COMMANDS = new Set([
    ...'()[]|/',
    '',
    ...commands('symbol').flatMap((command) =>
        command.kind === 'symbol' && command.class === 'delimiter' ? [command.char] : [],
    ),
]);

// What LaTeX loses: a picture LaTeX has no command for is swapped for one it has, so the seeded trees stay comparable.
const withoutLosses = (row: MathRow): MathRow =>
    JSON.parse(JSON.stringify(row), (_, node) => {
        switch (node?.kind) {
            case 'fraction':
                return node.line === 'skewed' ? { ...node, line: 'bar' } : node;
            case 'brace':
                return BRACE_COMMANDS.has(node.char + node.position)
                    ? node
                    : { ...node, char: node.position === 'over' ? '⏞' : '⏟' };
            // An accent outside the table is \overset of its mark; one in the table without a command is lost.
            case 'accent':
                return ACCENT_COMMANDS.has(node.accent) || !ACCENTS.has(node.accent)
                    ? node
                    : { ...node, accent: '\u0302' };
            case 'nary':
                if (LARGE_OPERATORS.has(node.operator)) return node;
                return { ...node, operator: '∑', limits: node.sub || node.sup ? node.limits : naryLimits('∑') };
            case 'fenced': {
                const fence = (char: string, fallback: string) => (DELIMITER_COMMANDS.has(char) ? char : fallback);
                const separator = node.parts.length > 1 ? fence(node.separator, '|') : '';
                return { ...node, open: fence(node.open, '('), close: fence(node.close, ')'), separator };
            }
            default:
                return node;
        }
    });

function expected(index: number, tree: MathRow): MathRow {
    return LOSSES.reduce((row, loss) => (loss.indices.includes(index) ? loss.apply(row) : row), tree);
}

describe('tree → LaTeX → tree is the identity, but for the listed losses', () => {
    for (const equation of CORPUS) {
        test(`fixture #${equation.i}`, () => {
            const tree = readOmml(el(equation.omml));
            const read = viaLatex(tree);
            expect(read).toStrictEqual(expected(equation.i, tree));
            expect(canonicalIssue(read)).toBeUndefined();
        });
    }

    test('each loss changes exactly the equations it lists', () => {
        for (const loss of LOSSES) {
            const changed = CORPUS.filter((equation) => {
                const tree = readOmml(el(equation.omml));
                return JSON.stringify(loss.apply(tree)) !== JSON.stringify(tree);
            }).map((equation) => equation.i);
            expect({ reason: loss.reason, changed }).toEqual({ reason: loss.reason, changed: loss.indices });
        }
    });

    // KaTeX rejects a raw U+0338, so every slash is \not.
    test.each(seedChunks(10_000))(
        'seeded canonical trees %i to %i, with the pictures LaTeX lacks swapped out',
        (first, last) => {
            for (let seed = first; seed <= last; seed++) {
                const tree = withoutLosses(generateTree(seed));
                expect({ seed, issue: canonicalIssue(tree) }).toEqual({ seed, issue: undefined });
                const latex = writeLatex(tree);
                expect({ seed, tree: readLatex(latex), slash: latex.includes('\u0338') }).toStrictEqual({
                    seed,
                    tree,
                    slash: false,
                });
            }
        },
    );

    test.each<[string, MathRow]>([
        [
            'a brace under an empty label',
            [
                {
                    kind: 'limit',
                    position: 'over',
                    base: [{ kind: 'brace', char: '⏞', position: 'over', body: x }],
                    limit: [],
                },
            ],
        ],
        [
            'a function named by a limit with nothing under it',
            [
                {
                    kind: 'function',
                    name: [
                        { kind: 'limit', position: 'under', base: [{ kind: 'identifier', text: 'lim' }], limit: [] },
                    ],
                    body: x,
                },
            ],
        ],
        [
            'a matrix in a fenced row without fences',
            [
                {
                    kind: 'fenced',
                    open: '',
                    close: '',
                    separator: '',
                    parts: [[{ kind: 'table', layout: 'matrix', rows: [[x]] }]],
                },
            ],
        ],
        [
            'equations in a fenced row without fences',
            [
                {
                    kind: 'fenced',
                    open: '',
                    close: '',
                    separator: '',
                    parts: [[{ kind: 'table', layout: 'equations', rows: [[x]] }]],
                },
            ],
        ],
        [
            'a function with scripts beside a limit name',
            [
                {
                    kind: 'function',
                    name: [{ kind: 'scripts', base: [{ kind: 'identifier', text: 'lim' }], sub: x }],
                    body: x,
                },
            ],
        ],
        ['a table ending in an empty row', [{ kind: 'table', layout: 'matrix', rows: [[x], [[]]] }]],
        [
            'a row that starts with a bracket',
            [{ kind: 'table', layout: 'matrix', rows: [[x], [[{ kind: 'operator', text: '[' }, ...x]]] }],
        ],
        [
            'a function of a number',
            [
                {
                    kind: 'function',
                    name: [{ kind: 'identifier', text: 'sin' }],
                    body: [{ kind: 'number', text: '3.5' }],
                },
            ],
        ],
    ])('%s', (_, tree) => {
        expect(viaLatex(tree)).toStrictEqual(tree);
    });

    test('each loss keeps the picture: a lossy tree still reads, canonical, and its LaTeX is stable', () => {
        const lossy: MathRow = [
            { kind: 'fraction', numerator: x, denominator: letter('y'), line: 'skewed' },
            { kind: 'brace', char: '→', position: 'over', body: x },
            { kind: 'nary', operator: '⋆', limits: 'under', sub: letter('i'), body: x },
            { kind: 'fenced', open: '⟪', close: '⟫', separator: '', parts: [x] },
            { kind: 'fenced', open: '(', close: ')', separator: ',', parts: [x, letter('y')] },
        ];
        for (const node of lossy) {
            const read = viaLatex([node]);
            expect(canonicalIssue(read)).toBeUndefined();
            expect(read).not.toStrictEqual([node]);
            expect(writeLatex(viaLatex(read))).toBe(writeLatex(read));
        }
    });

    // A fenced row with fences no command draws reads back as its characters, two parts more each.
    test('a lossy tree may read back larger, so at the size bound its LaTeX is past it', () => {
        const units = Math.floor((MATH_LIMITS.size - 1) / 2);
        const fences = Array.from(
            { length: units },
            (): MathNode => ({ kind: 'fenced', open: '"', close: '"', separator: '', parts: [[]] }),
        );
        expect(viaMathml(fences)).toStrictEqual(fences);
        expect(() => viaLatex(fences)).toThrow(MathError);
    });
});

describe('the 45 formulas of the storage study', () => {
    for (const [index, latex] of LATEX_FORMULAS.entries()) {
        test(`#${index + 1} ${latex}`, () => {
            const tree = readLatex(latex);
            expect(canonicalIssue(tree)).toBeUndefined();
            expect(viaLatex(tree)).toStrictEqual(tree);
            const written = el(writeMathml(tree, latex));
            expect(readMathml(written)).toStrictEqual(tree);
            expect(readMathmlLatex(written)).toBe(latex);
        });
    }
});

describe('readLatex', () => {
    test.each<[string, MathRow]>([
        ['\\frac{a}{b}', [{ kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'bar' }]],
        [
            '\\sum_{i=1}^n x',
            [
                {
                    kind: 'nary',
                    operator: '∑',
                    limits: 'under',
                    sub: [...letter('i'), { kind: 'operator', text: '=' }, { kind: 'number', text: '1' }],
                    sup: letter('n'),
                    body: x,
                },
            ],
        ],
        [
            '\\int\\limits_0 x',
            [{ kind: 'nary', operator: '∫', limits: 'under', sub: [{ kind: 'number', text: '0' }], body: x }],
        ],
        ['\\left( x \\right)', [{ kind: 'fenced', open: '(', close: ')', separator: '', parts: [x] }]],
        [
            '\\left. x \\middle| y \\right\\rangle',
            [{ kind: 'fenced', open: '', close: '⟩', separator: '|', parts: [x, letter('y')] }],
        ],
        [
            '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '',
                    parts: [
                        [
                            {
                                kind: 'table',
                                layout: 'matrix',
                                rows: [
                                    [letter('a'), letter('b')],
                                    [letter('c'), letter('d')],
                                ],
                            },
                        ],
                    ],
                },
            ],
        ],
        ['\\sin x', [{ kind: 'function', name: [{ kind: 'identifier', text: 'sin' }], body: x }]],
        [
            '\\sin(x)',
            [
                { kind: 'identifier', text: 'sin' },
                { kind: 'operator', text: '(' },
                ...x,
                { kind: 'operator', text: ')' },
            ],
        ],
        [
            '\\lim_{n} a',
            [
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
                    body: letter('a'),
                },
            ],
        ],
        ["x'", [...x, { kind: 'operator', text: '′' }]],
        [
            '{}_{6}^{14}C',
            [
                {
                    kind: 'scripts',
                    base: [],
                    sub: [{ kind: 'number', text: '6' }],
                    sup: [{ kind: 'number', text: '14' }],
                },
                ...letter('C'),
            ],
        ],
        [
            '\\prescript{14}{6}{C}',
            [
                {
                    kind: 'scripts',
                    base: letter('C'),
                    sub: [{ kind: 'number', text: '6' }],
                    sup: [{ kind: 'number', text: '14' }],
                    pre: true,
                },
            ],
        ],
        ['x % a comment\n  + 1', [...x, { kind: 'operator', text: '+' }, { kind: 'number', text: '1' }]],
        ['a~b', [...letter('a'), { kind: 'space', width: 'normal' }, ...letter('b')]],
        ['{\\displaystyle x}', x],
        ['\\color{red}{x}', [{ kind: 'identifier', text: 'x', color: '#FF0000' }]],
        ['\\textcolor{#ff0000}{x}', [{ kind: 'identifier', text: 'x', color: '#FF0000' }]],
        [
            '\\mathrm{sin}\\,\\mathrm{x}',
            [
                { kind: 'identifier', text: 'sin' },
                { kind: 'space', width: 'thin' },
                { kind: 'identifier', text: 'x', variant: 'normal' },
            ],
        ],
        [
            '\\mathbf{v} 𝐯',
            [
                { kind: 'identifier', text: 'v', variant: 'bold' },
                { kind: 'identifier', text: 'v', variant: 'bold' },
            ],
        ],
        ['12.5{3}', [{ kind: 'number', text: '12.53' }]],
        [
            '\\frac12',
            [
                {
                    kind: 'fraction',
                    numerator: [{ kind: 'number', text: '1' }],
                    denominator: [{ kind: 'number', text: '2' }],
                    line: 'bar',
                },
            ],
        ],
        ['\\text{ if  x~}', [{ kind: 'text', text: ' if x ' }]],
        ['\\text{a\\%\\ \\ b\\textbackslash{}}', [{ kind: 'text', text: 'a%  b\\' }]],
        [
            '\\binom{n}{k}',
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '',
                    parts: [[{ kind: 'fraction', numerator: letter('n'), denominator: letter('k'), line: 'none' }]],
                },
            ],
        ],
        [
            '\\genfrac{}{}{0pt}{}{a}{b}',
            [{ kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'none' }],
        ],
        [
            '\\genfrac{}{}{0.0em}{}{a}{b}',
            [{ kind: 'fraction', numerator: letter('a'), denominator: letter('b'), line: 'none' }],
        ],
        ['{\\sum}_i', [{ kind: 'scripts', base: [{ kind: 'operator', text: '∑' }], sub: letter('i') }]],
        [
            '\\overbrace{x}^{n}',
            [
                {
                    kind: 'limit',
                    position: 'over',
                    base: [{ kind: 'brace', char: '⏞', position: 'over', body: x }],
                    limit: letter('n'),
                },
            ],
        ],
        ['\\sqrt[3]{x}', [{ kind: 'radical', body: x, degree: [{ kind: 'number', text: '3' }] }]],
        ['\\boxed{x}', [{ kind: 'enclose', notation: ['top', 'bottom', 'left', 'right'], body: x }]],
        ['\\enclose{horizontalstrike,circle}{x}', [{ kind: 'enclose', notation: ['horizontalstrike'], body: x }]],
        ['x_\\text{max}', [{ kind: 'scripts', base: x, sub: [{ kind: 'text', text: 'max' }] }]],
        ['x_\\mathrm{max}', [{ kind: 'scripts', base: x, sub: [{ kind: 'identifier', text: 'max' }] }]],
        [
            'x^\\frac12',
            [{ kind: 'scripts', base: x, sup: [{ kind: 'fraction', numerator: one, denominator: two, line: 'bar' }] }],
        ],
        [
            'e^\\left(x\\right)',
            [
                {
                    kind: 'scripts',
                    base: letter('e'),
                    sup: [{ kind: 'fenced', open: '(', close: ')', separator: '', parts: [x] }],
                },
            ],
        ],
        [
            '\\sqrt\\frac12',
            [{ kind: 'radical', body: [{ kind: 'fraction', numerator: one, denominator: two, line: 'bar' }] }],
        ],
        // KaTeX and MathJax reject it; it has one sensible reading.
        [
            '\\frac\\sqrt{2}{3}',
            [
                {
                    kind: 'fraction',
                    numerator: [{ kind: 'radical', body: two }],
                    denominator: [{ kind: 'number', text: '3' }],
                    line: 'bar',
                },
            ],
        ],
        ['\\sin 3.5', [{ kind: 'function', name: letter('sin'), body: [{ kind: 'number', text: '3.5' }] }]],
        ['\\log 100 x', [{ kind: 'function', name: letter('log'), body: [{ kind: 'number', text: '100' }] }, ...x]],
        ['\\sum 10', [{ kind: 'nary', operator: '∑', limits: 'under', body: [{ kind: 'number', text: '10' }] }]],
        [
            '\\sin 2^x 3',
            [
                { kind: 'function', name: letter('sin'), body: [{ kind: 'scripts', base: two, sup: x }] },
                { kind: 'number', text: '3' },
            ],
        ],
        [
            '\\begin{cases} 1 & x \\\\ 2 & y \\\\ \\end{cases}',
            [
                {
                    kind: 'fenced',
                    open: '{',
                    close: '',
                    separator: '',
                    parts: [
                        [
                            {
                                kind: 'table',
                                layout: 'matrix',
                                rows: [
                                    [one, x],
                                    [two, letter('y')],
                                ],
                            },
                        ],
                    ],
                },
            ],
        ],
        [
            '\\begin{matrix} a \\\\[2pt] b \\end{matrix}',
            [{ kind: 'table', layout: 'matrix', rows: [[letter('a')], [letter('b')]] }],
        ],
        ['\\begin{matrix} a \\\\ {} \\end{matrix}', [{ kind: 'table', layout: 'matrix', rows: [[letter('a')], [[]]] }]],
        // A gap's [ follows \\ directly, as amsmath reads it; after a space it starts the next row.
        [
            '\\begin{matrix}a\\\\ [b]\\end{matrix}',
            [
                {
                    kind: 'table',
                    layout: 'matrix',
                    rows: [
                        [letter('a')],
                        [[{ kind: 'operator', text: '[' }, ...letter('b'), { kind: 'operator', text: ']' }]],
                    ],
                },
            ],
        ],
        [
            '\\begin{aligned}a\\\\*b\\\\*[1.5ex]c\\end{aligned}',
            [{ kind: 'table', layout: 'equations', rows: [[letter('a')], [letter('b')], [letter('c')]] }],
        ],
        [
            '\\big( x \\Bigr) \\bigl\\{ \\Biggm| \\bigg.',
            [
                { kind: 'operator', text: '(' },
                ...x,
                { kind: 'operator', text: ')' },
                { kind: 'operator', text: '{' },
                { kind: 'operator', text: '|' },
            ],
        ],
        ['x^\\big(', [{ kind: 'scripts', base: x, sup: [{ kind: 'operator', text: '(' }] }]],
        ['\\int\\!x', [{ kind: 'nary', operator: '∫', limits: 'side', body: x }]],
        [
            'a\\lt b\\gt c',
            [
                ...letter('a'),
                { kind: 'operator', text: '<' },
                ...letter('b'),
                { kind: 'operator', text: '>' },
                ...letter('c'),
            ],
        ],
        [
            '\\lim\\limits_{n} a',
            [
                {
                    kind: 'function',
                    name: [{ kind: 'limit', position: 'under', base: letter('lim'), limit: letter('n') }],
                    body: letter('a'),
                },
            ],
        ],
        [
            '\\lim\\nolimits_{n} a',
            [
                {
                    kind: 'function',
                    name: [{ kind: 'scripts', base: letter('lim'), sub: letter('n') }],
                    body: letter('a'),
                },
            ],
        ],
        [
            '\\left( a \\middle| b \\middle\\| c \\right)',
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '|',
                    parts: [letter('a'), [...letter('b'), { kind: 'operator', text: '‖' }, ...letter('c')]],
                },
            ],
        ],
        [
            '\\left( \\color{red} a \\middle| b \\right)',
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '|',
                    parts: [
                        [{ kind: 'identifier', text: 'a', color: '#FF0000' }],
                        [{ kind: 'identifier', text: 'b', color: '#FF0000' }],
                    ],
                },
            ],
        ],
        ['\\text{\\textasciitilde{}\\textasciicircum{}}', [{ kind: 'text', text: '~^' }]],
        // \not slashes the next symbol, composed where Unicode has the character.
        ['\\not=', [{ kind: 'operator', text: '≠' }]],
        ['a\\not\\in b', [...letter('a'), { kind: 'operator', text: '∉' }, ...letter('b')]],
        ['\\not\\equiv', [{ kind: 'operator', text: '≢' }]],
        ['\\not\\subset', [{ kind: 'operator', text: '⊄' }]],
        ['\\not\\preceq', [{ kind: 'operator', text: '⪯\u0338' }]],
        ['\\not a^2', [{ kind: 'scripts', base: [{ kind: 'identifier', text: 'a\u0338' }], sup: two }]],
        // A character's combining marks are part of it, so scripts take both.
        ['e\u0301^2', [{ kind: 'scripts', base: [{ kind: 'accent', accent: '\u0301', body: letter('e') }], sup: two }]],
    ])('%p', (latex, tree) => {
        const read = readLatex(latex);
        expect(read).toStrictEqual(tree);
        expect(canonicalIssue(read)).toBeUndefined();
    });

    test('an aligned table splits its cells at & as Word does', () => {
        expect(readLatex('\\begin{aligned} a &= b \\\\ &= c \\end{aligned}')).toStrictEqual([
            {
                kind: 'table',
                layout: 'equations',
                rows: [
                    [letter('a'), [{ kind: 'operator', text: '=' }, ...letter('b')]],
                    [[], [{ kind: 'operator', text: '=' }, ...letter('c')]],
                ],
            },
        ]);
    });

    test.each<[string, number]>([
        ['\\foo', 0],
        ['x}', 1],
        ['{x', 0],
        ['\\left( x', 0],
        ['x \\right)', 2],
        ['\\frac{a}', 8],
        ['x^1^2', 3],
        ['a & b', 2],
        ['a \\\\ b', 2],
        ['\\begin{foo} x \\end{foo}', 7],
        ['\\begin{matrix} x \\end{pmatrix}', 22],
        ['\\left x \\right)', 6],
        ['\\color{nope} x', 7],
        ['\\text{\\frac}', 6],
        ['x\u0001', 1],
        ['x\uD800', 1],
        ['\\', 0],
        ['x^\\frac1', 8],
        ['\\big x', 5],
        ['\\textasciitilde', 0],
        ['\\begin{matrix}a\\\\[b]\\end{matrix}', 17],
        ['\\not\\frac12', 4],
        ['\\not{=}', 4],
        ['x^\\not', 6],
        ['\\begin{matrix}a\\\\[{2pt}]b\\end{matrix}', 17],
    ])('%p is a MathError at offset %p', (latex, offset) => {
        expect(thrown(() => readLatex(latex))?.offset).toBe(offset);
    });
});

describe('writeLatex', () => {
    test.each<[MathRow, string]>([
        [[{ kind: 'operator', text: '∑' }, ...x], '{\\sum}x'],
        [[{ kind: 'scripts', base: [{ kind: 'operator', text: '∑' }], sub: x }], '{\\sum}_{x}'],
        [[{ kind: 'identifier', text: 'α' }, ...x], '\\alpha x'],
        [[{ kind: 'identifier', text: 'sin' }], '\\mathrm{sin}'],
        [[{ kind: 'identifier', text: 'x', color: '#FF0000', variant: 'bold' }], '\\textcolor{#FF0000}{\\mathbf{x}}'],
        [
            [{ kind: 'text', text: '50% of {a}_b & ~^\\  x y' }],
            '\\text{50\\% of \\{a\\}\\_b \\& \\textasciitilde{}\\textasciicircum{}\\textbackslash{}\\ \\ x~y}',
        ],
        [
            [
                { kind: 'operator', text: '&' },
                { kind: 'operator', text: '%' },
            ],
            '\\&\\%',
        ],
        [[{ kind: 'fraction', numerator: x, denominator: x, line: 'none' }], '\\genfrac{}{}{0pt}{}{x}{x}'],
        [[{ kind: 'function', name: [{ kind: 'identifier', text: 'sin' }], body: x }], '\\sin{x}'],
        [[{ kind: 'function', name: x, body: x }], '\\operatorname{\\mathit{x}}{x}'],
        [[{ kind: 'nary', operator: '∫', limits: 'under', sub: x, body: [] }], '\\int\\limits_{x}{}'],
        [[{ kind: 'radical', body: x, degree: [{ kind: 'operator', text: ']' }] }], '\\sqrt[{]}]{x}'],
        [[{ kind: 'radical', body: x, degree: [{ kind: 'scripts', base: [], sup: x }] }], '\\sqrt[{{}^{x}}]{x}'],
        [[{ kind: 'space', width: 'normal' }, ...x], '\\ x'],
        // TeX raises a ' as a superscript, so a superscript prime is \prime.
        [[{ kind: 'scripts', base: x, sup: [prime] }], 'x^{\\prime}'],
        [[{ kind: 'scripts', base: x, sub: one, sup: [prime, prime] }], 'x_{1}^{\\prime\\prime}'],
        [[{ kind: 'scripts', base: x, sup: [prime, ...x] }], "x^{'x}"],
        // A prime after a script would be TeX's double superscript.
        [[{ kind: 'scripts', base: x, sup: x }, prime], "x^{x}{}'"],
        [[{ kind: 'scripts', base: x, sub: x }, prime], "x_{x}{}'"],
        [
            [
                {
                    kind: 'limit',
                    position: 'over',
                    base: [{ kind: 'brace', char: '⏞', position: 'over', body: x }],
                    limit: x,
                },
                prime,
            ],
            "\\overbrace{x}^{x}{}'",
        ],
        [
            [
                { kind: 'identifier', text: 'α' },
                { kind: 'operator', text: '@' },
            ],
            '\\alpha @',
        ],
        [[{ kind: 'table', layout: 'matrix', rows: [[x], [[]]] }], '\\begin{matrix}x \\\\ {}\\end{matrix}'],
        [[{ kind: 'operator', text: '≠' }], '\\ne'],
        [[{ kind: 'operator', text: '∉' }], '\\notin'],
        [[{ kind: 'operator', text: '≢' }], '\\not\\equiv'],
        [[{ kind: 'operator', text: '≮' }], '\\not<'],
        [[{ kind: 'operator', text: '⪯\u0338' }], '\\not\\preceq'],
        [[{ kind: 'identifier', text: 'a\u0338' }], '\\not a'],
        [[{ kind: 'operator', text: '∑\u0338' }], '\\not\\sum'],
        [[{ kind: 'operator', text: '≠\u0338' }], '\\not\\ne'],
        [[{ kind: 'operator', text: '{\u0338' }], '\\not\\{'],
        [[{ kind: 'operator', text: '′\u0338' }], '\\not\\prime'],
        // U+2ADC has a slash in its decomposition, which NFC never composes back: \not would read as U+2ADD and U+0338.
        [[{ kind: 'operator', text: '\u2ADC' }], '\u2ADC'],
        // \not puts its slash last, after the symbol's marks; it slashes twice as \not\not.
        [[{ kind: 'identifier', text: 'x\u0338\u0338' }], '\\not\\not x'],
        [[{ kind: 'identifier', text: 'Γ\u0338\u0338' }], '\\not\\not\\Gamma'],
        [[{ kind: 'identifier', text: 'x\u20D2\u0338' }], '\\not x\u20D2'],
        [[{ kind: 'operator', text: '∑\u20D2\u0338' }], '\\not\\sum\u20D2'],
        [[{ kind: 'operator', text: '#\u0338' }], '\\not\\#'],
        // A slash before another mark stays where it is, as itself: \not would put it last.
        [[{ kind: 'identifier', text: 'x\u0338\u20D2' }], 'x\u0338\u20D2'],
        [[{ kind: 'identifier', text: 'x\u0338\u0335' }], 'x\u0338\u0335'],
        [[{ kind: 'operator', text: '≠\u20D2' }], '\\ne\u20D2'],
        // In \operatorname a - between letters is a hyphen, as amsmath draws it, so a minus there is written as itself.
        [[{ kind: 'identifier', text: 'arg-max' }], '{\\operatorname{arg-max}}'],
        [
            [{ kind: 'function', name: [{ kind: 'identifier', text: 'arg-max' }], body: x }],
            '\\operatorname{arg-max}{x}',
        ],
        [
            [
                {
                    kind: 'function',
                    name: [
                        { kind: 'identifier', text: 'arg' },
                        { kind: 'operator', text: '\u2212' },
                        { kind: 'identifier', text: 'max' },
                    ],
                    body: x,
                },
            ],
            '\\operatorname{arg\u2212max}{x}',
        ],
        [[{ kind: 'scripts', base: [{ kind: 'identifier', text: 'a-b' }], sup: x }], '{\\operatorname{a-b}}^{x}'],
        // A { before a matrix is cases; before equations it is a fenced aligned.
        [
            [
                {
                    kind: 'fenced',
                    open: '{',
                    close: '',
                    separator: '',
                    parts: [
                        [
                            {
                                kind: 'table',
                                layout: 'matrix',
                                rows: [
                                    [one, x],
                                    [two, letter('y')],
                                ],
                            },
                        ],
                    ],
                },
            ],
            '\\begin{cases}1 & x \\\\ 2 & y\\end{cases}',
        ],
        [
            [
                {
                    kind: 'fenced',
                    open: '{',
                    close: '',
                    separator: '',
                    parts: [[{ kind: 'table', layout: 'equations', rows: [[one, x]] }]],
                },
            ],
            '\\left\\{\\begin{aligned}1 & x\\end{aligned}\\right.',
        ],
        // An accent outside the accent table is \overset of its mark, which reads back as the accent.
        [[{ kind: 'accent', accent: '\u0311', body: x }], '\\overset{\u0311}{x}'],
        [
            [{ kind: 'table', layout: 'matrix', rows: [[x], [[{ kind: 'operator', text: '[' }, ...x]]] }],
            '\\begin{matrix}x \\\\ [x\\end{matrix}',
        ],
    ])('%j', (row, latex) => {
        expect(writeLatex(row)).toBe(latex);
        expect(readLatex(latex)).toStrictEqual(row);
    });

    // KaTeX and MathJax read each form; what it reads back as is a listed loss.
    test.each<[MathRow, string, MathRow]>([
        [
            [{ kind: 'accent', accent: '\u0304', body: x }],
            '\\overset{¯}{x}',
            [{ kind: 'limit', position: 'over', base: x, limit: [{ kind: 'operator', text: '¯' }] }],
        ],
        [
            [{ kind: 'fenced', open: '⟦', close: '⟧', separator: '', parts: [x] }],
            '⟦x⟧',
            [{ kind: 'operator', text: '⟦' }, ...x, { kind: 'operator', text: '⟧' }],
        ],
        [
            [
                {
                    kind: 'scripts',
                    base: [{ kind: 'fenced', open: '⟦', close: '⟧', separator: '', parts: [x] }],
                    sup: two,
                },
            ],
            '{⟦x⟧}^{2}',
            [
                {
                    kind: 'scripts',
                    base: [{ kind: 'operator', text: '⟦' }, ...x, { kind: 'operator', text: '⟧' }],
                    sup: two,
                },
            ],
        ],
        [[{ kind: 'operator', text: '~' }], '\\text{\\textasciitilde{}}', [{ kind: 'text', text: '~' }]],
        [[{ kind: 'operator', text: '^' }], '\\text{\\textasciicircum{}}', [{ kind: 'text', text: '^' }]],
        [[{ kind: 'operator', text: '^\u0338' }], '\\text{\\textasciicircum{}}', [{ kind: 'text', text: '^' }]],
        [[{ kind: 'operator', text: '~\u0338' }], '\\text{\\textasciitilde{}}', [{ kind: 'text', text: '~' }]],
        [[{ kind: 'operator', text: "'" }], "'", [{ kind: 'operator', text: '′' }]],
        [[{ kind: 'operator', text: "'\u0338" }], '\\not\\prime', [{ kind: 'operator', text: '′\u0338' }]],
        [
            [{ kind: 'fenced', open: '\u0302', close: ')', separator: '\u0302', parts: [x, x] }],
            '\\left.x\\middle.x\\right)',
            [{ kind: 'fenced', open: '', close: ')', separator: '', parts: [x, x] }],
        ],
        [
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '',
                    parts: [[{ kind: 'fenced', open: '\u0302', close: ')', separator: ',', parts: [x, x] }]],
                },
            ],
            '\\left(x,x)\\right)',
            [
                {
                    kind: 'fenced',
                    open: '(',
                    close: ')',
                    separator: '',
                    parts: [[...x, { kind: 'operator', text: ',' }, ...x, { kind: 'operator', text: ')' }]],
                },
            ],
        ],
        [
            [{ kind: 'accent', accent: '∘', body: x }],
            '\\overset{\\circ}{x}',
            [{ kind: 'limit', position: 'over', base: x, limit: [{ kind: 'operator', text: '∘' }] }],
        ],
    ])('%j is written %p', (row, latex, read) => {
        expect(writeLatex(row)).toBe(latex);
        expect(readLatex(latex)).toStrictEqual(read);
    });
});

describe('typed LaTeX rides along as the annotation', () => {
    test.each(['a<b', 'x \\& y', '\\text{]]>}', '\\text{non-BMP 😀} 𝟘', '\\mathbb{R}^n % "quoted"'])('%p', (latex) => {
        const row = readLatex(latex);
        const written = el(writeMathml(row, latex));
        expect(readMathml(written)).toStrictEqual(row);
        expect(readMathmlLatex(written)).toBe(latex);
    });

    test('the longest LaTeX with the largest tree fits the MathML cap', () => {
        const units = Math.floor((MATH_LIMITS.size - 1) / 2);
        const largest: MathRow = Array.from({ length: units }, () => ({
            kind: 'enclose',
            notation: [...MATH_ENCLOSURES],
            body: [],
        }));
        const latex = '"'.repeat(MATH_LIMITS.latexLength);
        expect(writeMathml(largest, latex).length).toBeLessThanOrEqual(MATH_LIMITS.mathmlLength);
    });
});

describe('readLatex ends in a tree or a MathError, in linear time', () => {
    // What MathML admits, LaTeX and OMML read back: no reader walks a level its own writer's output lacks.
    test('the depth bound counts the tree’s levels, as MathML does', () => {
        const leaf: MathRow = [{ kind: 'identifier', text: 'x', variant: 'bold', color: '#FF0000' }];
        const lim: MathRow = [{ kind: 'identifier', text: 'lim' }];
        const fenced = (row: MathRow): MathRow => [
            { kind: 'fenced', open: '(', close: ')', separator: '', parts: [row] },
        ];
        const chains: ((row: MathRow) => MathNode)[] = [
            (row) => ({ kind: 'radical', body: row }),
            (row) => ({ kind: 'scripts', base: fenced(row), sup: x }),
            (row) => ({
                kind: 'scripts',
                base: [{ kind: 'fraction', numerator: row, denominator: x, line: 'bar' }],
                sub: x,
            }),
            (row) => ({ kind: 'scripts', base: [...x, ...row], sup: x }),
            (row) => ({
                kind: 'function',
                name: [{ kind: 'limit', position: 'under', base: lim, limit: row }],
                body: x,
            }),
            (row) => ({ kind: 'function', name: row, body: x }),
            (row) => ({
                kind: 'limit',
                position: 'over',
                base: [{ kind: 'brace', char: '⏞', position: 'over', body: row }],
                limit: x,
            }),
            (row) => ({ kind: 'nary', operator: '∑', limits: 'under', sub: row, body: x }),
            (row) => ({ kind: 'table', layout: 'matrix', rows: [[row]] }),
            (row) => fenced([{ kind: 'table', layout: 'matrix', rows: [[row]] }])[0],
        ];
        for (const chain of chains) {
            const nested = (levels: number): MathRow => (levels === 0 ? leaf : [chain(nested(levels - 1))]);
            let levels = 0;
            while (thrown(() => viaMathml(nested(levels + 1))) === undefined) levels++;
            expect(viaLatex(nested(levels))).toStrictEqual(nested(levels));
            expect(viaOmml(nested(levels))).toStrictEqual(nested(levels));
            expect(thrown(() => viaLatex(nested(levels + 1)))).toBeInstanceOf(MathError);
        }
    });

    test('radical degrees and fences no command draws, nested to the bound, read back; one level more points at it', () => {
        const sum: MathRow = [{ kind: 'operator', text: '∑', variant: 'bold', color: '#FF0000' }];
        const bold: MathRow = [{ kind: 'identifier', text: 'x', variant: 'bold', color: '#FF0000' }];
        const degrees = (levels: number): MathRow =>
            levels === 0 ? sum : [{ kind: 'radical', body: x, degree: degrees(levels - 1) }];
        const fences = (levels: number): MathRow =>
            levels === 0
                ? bold
                : [{ kind: 'fenced', open: '⟦', close: '⟧', separator: '', parts: [fences(levels - 1)] }];
        const levels = MATH_LIMITS.depth - 1;
        for (const tree of [degrees(levels), fences(levels)]) {
            expect(viaMathml(tree)).toStrictEqual(tree);
        }
        expect(viaLatex(degrees(levels))).toStrictEqual(degrees(levels));
        expect(viaLatex(fences(levels))).toStrictEqual(expected(49, fences(levels)));
        expect(thrown(() => viaLatex(degrees(levels + 1)))?.offset).toBeGreaterThan(0);
        // An empty row is the first thing at the level past the bound.
        const empty = `${'\\sqrt{'.repeat(levels)}\\frac{}{}${'}'.repeat(levels)}`;
        expect(thrown(() => readLatex(empty))?.offset).toBeGreaterThan(0);
    });

    test('deep nesting of any kind ends in a MathError, not a stack overflow', () => {
        for (const latex of [
            `${'{'.repeat(5000)}x${'}'.repeat(5000)}`,
            `${'\\mathbf{'.repeat(4000)}x${'}'.repeat(4000)}`,
            `${'\\hat{'.repeat(5000)}x${'}'.repeat(5000)}`,
            `${'x^{'.repeat(5000)}x${'}'.repeat(5000)}`,
            `${'\\left('.repeat(3000)}${'\\right)'.repeat(3000)}`,
            `${'\\sin '.repeat(5000)}x`,
            `${'\\sum '.repeat(5000)}x`,
            `${'\\sqrt['.repeat(5000)}x${']{x}'.repeat(5000)}`,
            '\\sqrt[x'.repeat(MATH_LIMITS.latexLength / 8),
            `${'\\sqrt['.repeat(MATH_LIMITS.latexLength / 10 - 1)}x${']{x}'.repeat(MATH_LIMITS.latexLength / 10 - 1)}`,
            `${'\\sqrt'.repeat(MATH_LIMITS.latexLength / 5 - 1)}x`,
            `${'\\frac 1'.repeat(MATH_LIMITS.latexLength / 7 - 1)}1`,
        ]) {
            expect(thrown(() => readLatex(latex))).toBeInstanceOf(MathError);
        }
    });

    test('a bound error points into the LaTeX, whichever bound it meets', () => {
        for (const latex of [
            'x'.repeat(5000),
            '1'.repeat(5000),
            `\\text{${'a'.repeat(5000)}}`,
            'x+'.repeat(2100),
            '\\frac{}{}'.repeat(1400),
            `\\begin{matrix}${'x&'.repeat(3000)}x\\end{matrix}`,
            `{${'\\mathbf{'.repeat(40)}x${'}'.repeat(41)}`,
        ]) {
            const offset = thrown(() => readLatex(latex))?.offset;
            expect({ latex: latex.slice(0, 16), offset }).toEqual({
                latex: latex.slice(0, 16),
                offset: expect.any(Number),
            });
            expect(offset).toBeLessThanOrEqual(latex.length);
        }
    });

    // What LaTeX admits, MathML stores and reads back: neither counts a row or node the tree lacks.
    const plus: MathNode = { kind: 'operator', text: '+' };
    test.each<MathNode>([
        { kind: 'number', text: '42' },
        { kind: 'text', text: 'a b' },
        { kind: 'nary', operator: '∑', limits: 'under', sub: x, body: [] },
        { kind: 'scripts', base: [], sub: x },
        { kind: 'scripts', base: x, sub: x, pre: true },
        { kind: 'scripts', base: x, sup: x, pre: true },
        { kind: 'radical', body: x, degree: x },
        { kind: 'fenced', open: '(', close: ')', separator: '|', parts: [[], x] },
        { kind: 'function', name: [{ kind: 'identifier', text: 'lim' }], body: [] },
        { kind: 'table', layout: 'equations', rows: [[[], x], [[]]] },
        { kind: 'table', layout: 'equations', rows: [[x, x, x, x]] },
        { kind: 'fraction', numerator: [], denominator: x, line: 'none' },
        {
            kind: 'limit',
            position: 'over',
            base: [{ kind: 'brace', char: '⏞', position: 'over', body: [] }],
            limit: x,
        },
    ])('the size bound counts the tree, as MathML does: %j', (unit) => {
        const row = (count: number): MathRow => Array.from({ length: count }, () => [unit, plus]).flat();
        const admits = (count: number) => thrown(() => viaLatex(row(count))) === undefined;
        let low = 1;
        let high = MATH_LIMITS.size;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (admits(middle)) low = middle;
            else high = middle - 1;
        }
        expect(viaLatex(row(low))).toStrictEqual(row(low));
        expect(viaOmml(row(low))).toStrictEqual(row(low));
        expect(viaMathml(row(low))).toStrictEqual(row(low));
        expect(thrown(() => viaMathml(row(low + 1)))).toBeInstanceOf(MathError);
        expect(thrown(() => viaOmml(row(low + 1)))).toBeInstanceOf(MathError);
        expect(writeLatex(row(low + 1)).length).toBeLessThanOrEqual(MATH_LIMITS.latexLength);
    });

    // Typed forms the writer never emits: the largest tree LaTeX admits from them, MathML stores too.
    test.each(['\\sum_x+', '\\lim_x+', '{}^x+', '\\prescript{}{x}{y}+', '\\xrightarrow[x]{y}+', '\\pmod{x}'])(
        'the largest tree LaTeX admits from %p, MathML stores',
        (typed) => {
            let low = 1;
            let high = MATH_LIMITS.size;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (thrown(() => readLatex(typed.repeat(middle))) === undefined) low = middle;
                else high = middle - 1;
            }
            const tree = readLatex(typed.repeat(low));
            expect(viaMathml(tree)).toStrictEqual(tree);
        },
    );

    test('LaTeX past its cap is an error', () => {
        expect(readLatex(`${' '.repeat(MATH_LIMITS.latexLength - 1)}x`)).toStrictEqual(x);
        expect(() => readLatex(`${' '.repeat(MATH_LIMITS.latexLength)}x`)).toThrow(MathError);
    });

    test('long inputs read in linear time', () => {
        const length = MATH_LIMITS.latexLength;
        const inputs = [
            'x+'.repeat(length / 2),
            `${' '.repeat(length - 1)}x`,
            '\\,'.repeat(length / 2),
            `\\text{${'a'.repeat(length - 7)}}`,
            `%${'x'.repeat(length - 1)}`,
            `\\sqrt[${'x'.repeat(length - 10)}]{x}`,
            '{x}'.repeat(length / 3),
            `\\left(${'\\middle|'.repeat((length - 14) / 8)}\\right)`,
        ];
        for (const latex of inputs) {
            const start = performance.now();
            thrown(() => readLatex(latex));
            expect({ latex: latex.slice(0, 12), ms: performance.now() - start < 1000 }).toEqual({
                latex: latex.slice(0, 12),
                ms: true,
            });
        }
    });
});

describe('LATEX_COMMANDS', () => {
    test('reuses the notation tables: every accent, variant and space has its command', () => {
        for (const accent of ACCENT_COMMANDS) expect(ACCENTS.has(String(accent))).toBe(true);
        const fonts = new Set(commands('font').map((command) => command.kind === 'font' && command.variant));
        for (const variant of MATH_VARIANTS) expect(fonts).toContain(variant);
        const spaces = new Set(commands('space').map((command) => command.kind === 'space' && command.width));
        for (const width of MATH_SPACES) expect(spaces).toContain(width);
    });

    // `arguments` is what the reader takes, so a caller completing `\name` inserts the right number of braces.
    test('each command’s arguments are the number of arguments it reads', () => {
        const samples: Partial<Record<LatexCommand['kind'], string[]>> = {
            color: ['red', 'x'],
            colorSwitch: ['red'],
            genfrac: ['', '', '0pt', '', 'a', 'b'],
            notation: ['top', 'x'],
        };
        const structural = new Set(['left', 'middle', 'right', 'begin', 'end', 'limits', 'noop', 'big', 'not']);
        for (const [name, command] of LATEX_COMMANDS) {
            if (structural.has(command.kind)) continue;
            const count = command.arguments;
            const args = (samples[command.kind] ?? Array.from({ length: count }, () => 'x')).map((arg) => `{${arg}}`);
            expect({ name, count: args.length }).toEqual({ name, count });
            const complete = `\\${name}${args.join('')}`;
            expect({ name, error: thrown(() => readLatex(complete)) }).toEqual({ name, error: undefined });
            if (count > 0) {
                const missing = `\\${name}${args.slice(0, -1).join('')}`;
                expect({ name, missing: thrown(() => readLatex(missing))?.message }).toEqual({
                    name,
                    missing: 'An argument is missing',
                });
            }
        }
    });
});
