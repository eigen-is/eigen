import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex, writeLatex } from '../latex';
import { LATEX_ARGUMENTS, LATEX_COMMANDS, type LatexCommand } from '../latex-commands';
import { readMathml, writeMathml } from '../mathml';
import { ACCENTS, LARGE_OPERATORS, naryLimits } from '../notation';
import { readOmml } from '../omml';
import { MATH_ENCLOSURES, MATH_LIMITS, MATH_SPACES, MATH_VARIANTS, type MathNode, type MathRow } from '../tree';
import { canonicalIssue } from './canonical';
import { CORPUS } from './corpus';
import { LATEX_FORMULAS } from './fixtures/latex-formulas';
import { generateTree } from './generate';
import { el, viaOmml } from './parse';

const letter = (text: string): MathRow => [{ kind: 'identifier', text }];
const x = letter('x');
const viaLatex = (row: MathRow) => readLatex(writeLatex(row));

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
const OPERATOR_COMMANDS = new Set(
    commands('largeOperator').map((command) => command.kind === 'largeOperator' && command.operator),
);

// C3's losses: a picture LaTeX has no command for is swapped for one it has, so the seeded trees stay comparable.
const withoutLosses = (row: MathRow): MathRow =>
    JSON.parse(JSON.stringify(row), (_, node) => {
        switch (node?.kind) {
            case 'fraction':
                return node.line === 'skewed' ? { ...node, line: 'bar' } : node;
            case 'brace':
                return BRACE_COMMANDS.has(node.char + node.position)
                    ? node
                    : { ...node, char: node.position === 'over' ? '⏞' : '⏟' };
            case 'accent':
                return ACCENT_COMMANDS.has(node.accent) ? node : { ...node, accent: '\u0302' };
            case 'nary':
                if (OPERATOR_COMMANDS.has(node.operator)) return node;
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

// Word's own fence characters that LaTeX draws with its own commands.
const FENCE_TWINS: Record<string, string> = { '\u2329': '⟨', '\u232A': '⟩', '∥': '‖' };

// C3's losses in the fixture, each with the equations it changes (checked below, so the list stays exact).
const LOSSES: { reason: string; indices: number[]; apply: (row: MathRow) => MathRow }[] = [
    {
        reason: 'Word’s \u2329 \u232A and ∥ fences are written \\langle, \\rangle and \\|, and read back as ⟨ ⟩ and ‖',
        indices: [51, 52, 53],
        apply: (row) =>
            JSON.parse(JSON.stringify(row), (_, node) =>
                node?.kind === 'fenced'
                    ? {
                          ...node,
                          open: FENCE_TWINS[node.open] ?? node.open,
                          close: FENCE_TWINS[node.close] ?? node.close,
                          separator: FENCE_TWINS[node.separator] ?? node.separator,
                      }
                    : node,
            ),
    },
];

function expected(index: number, tree: MathRow): MathRow {
    return LOSSES.reduce((row, loss) => (loss.indices.includes(index) ? loss.apply(row) : row), tree);
}

describe('C3: tree → LaTeX → tree is the identity, but for the listed losses', () => {
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

    test('1,000 seeded canonical trees, with the pictures LaTeX lacks swapped out', () => {
        for (let seed = 1; seed <= 1000; seed++) {
            const tree = withoutLosses(generateTree(seed));
            expect({ seed, issue: canonicalIssue(tree) }).toEqual({ seed, issue: undefined });
            expect({ seed, tree: viaLatex(tree) }).toStrictEqual({ seed, tree });
        }
    });

    test('each loss keeps the picture: a lossy tree still reads, canonical, and its LaTeX is stable', () => {
        const lossy: MathRow = [
            { kind: 'fraction', numerator: x, denominator: letter('y'), line: 'skewed' },
            { kind: 'brace', char: '→', position: 'over', body: x },
            { kind: 'accent', accent: '\u0311', body: x },
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
});

describe('the 45 formulas of the storage study', () => {
    for (const [index, latex] of LATEX_FORMULAS.entries()) {
        test(`#${index + 1} ${latex}`, () => {
            const tree = readLatex(latex);
            expect(canonicalIssue(tree)).toBeUndefined();
            expect(viaLatex(tree)).toStrictEqual(tree);
            expect(readMathml(el(writeMathml(tree, latex)))).toStrictEqual({ row: tree, latex });
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
        ['\\frac\\sqrt{2}{3}', 10],
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
        [[{ kind: 'space', width: 'normal' }, ...x], '\\ x'],
    ])('%j', (row, latex) => {
        expect(writeLatex(row)).toBe(latex);
        expect(readLatex(latex)).toStrictEqual(row);
    });
});

describe('C4: typed LaTeX rides along as the annotation', () => {
    test.each(['a<b', 'x \\& y', '\\text{]]>}', '\\text{non-BMP 😀} 𝟘', '\\mathbb{R}^n % "quoted"'])('%p', (latex) => {
        const row = readLatex(latex);
        expect(readMathml(el(writeMathml(row, latex)))).toStrictEqual({ row, latex });
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

describe('C6: readLatex ends in a tree or a MathError, in linear time', () => {
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
            while (thrown(() => readMathml(el(writeMathml(nested(levels + 1))))) === undefined) levels++;
            expect(viaLatex(nested(levels))).toStrictEqual(nested(levels));
            expect(viaOmml(nested(levels))).toStrictEqual(nested(levels));
            expect(thrown(() => viaLatex(nested(levels + 1)))).toBeInstanceOf(MathError);
        }
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
        ]) {
            expect(thrown(() => readLatex(latex))).toBeInstanceOf(MathError);
        }
    });

    // What LaTeX admits, MathML stores and reads back: neither counts a row or node the tree lacks.
    test('the size bound counts the tree, as MathML does', () => {
        const plus: MathNode = { kind: 'operator', text: '+' };
        const units: MathNode[] = [
            { kind: 'number', text: '42' },
            { kind: 'text', text: 'a b' },
            { kind: 'nary', operator: '∑', limits: 'under', sub: x, body: [] },
            { kind: 'scripts', base: [], sub: x },
            { kind: 'scripts', base: x, sub: x, pre: true },
            { kind: 'fenced', open: '(', close: ')', separator: '|', parts: [[], x] },
            { kind: 'function', name: [{ kind: 'identifier', text: 'lim' }], body: [] },
            { kind: 'table', layout: 'equations', rows: [[[], x], [[]]] },
            { kind: 'fraction', numerator: [], denominator: x, line: 'none' },
            {
                kind: 'limit',
                position: 'over',
                base: [{ kind: 'brace', char: '⏞', position: 'over', body: [] }],
                limit: x,
            },
        ];
        for (const unit of units) {
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
            expect(readMathml(el(writeMathml(row(low)))).row).toStrictEqual(row(low));
            expect(thrown(() => readMathml(el(writeMathml(row(low + 1)))))).toBeInstanceOf(MathError);
            expect(writeLatex(row(low + 1)).length).toBeLessThanOrEqual(MATH_LIMITS.latexLength);
        }
        // Typed forms the writer never emits: the largest tree LaTeX admits from them, MathML stores too.
        for (const typed of [
            '\\sum_x+',
            '\\lim_x+',
            '{}^x+',
            '\\prescript{}{x}{y}+',
            '\\xrightarrow[x]{y}+',
            '\\pmod{x}',
        ]) {
            let low = 1;
            let high = MATH_LIMITS.latexLength / typed.length;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (thrown(() => readLatex(typed.repeat(middle))) === undefined) low = middle;
                else high = middle - 1;
            }
            const tree = readLatex(typed.repeat(low));
            expect({ typed, tree: readMathml(el(writeMathml(tree))).row }).toStrictEqual({ typed, tree });
        }
    });

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
            expect({ latex: latex.slice(0, 12), ms: performance.now() - start < 250 }).toEqual({
                latex: latex.slice(0, 12),
                ms: true,
            });
        }
    });

    test('seeded random token strings end in a canonical tree that writes back, or a MathError', () => {
        const TOKENS = [
            ..."xy1.2+-=(){}^_&'~%#$[]|",
            ' ',
            '\n',
            '\u00A0',
            '😀',
            '{x}',
            '{}',
            '\\\\',
            '\\ ',
            '\\,',
            '\\quad',
            '\\frac',
            '\\binom',
            '\\genfrac{}{}{0pt}{}',
            '\\sqrt',
            '\\sqrt[3]',
            '\\left(',
            '\\left.',
            '\\middle|',
            '\\right)',
            '\\right\\}',
            '\\left( x \\middle| y \\right]',
            '\\begin{pmatrix}',
            '\\end{pmatrix}',
            '\\begin{cases} 1 & x \\\\ 2 \\end{cases}',
            '\\begin{aligned} a &= b \\end{aligned}',
            '\\sum',
            '\\int',
            '\\limits',
            '\\sin',
            '\\lim',
            '\\operatorname',
            '\\operatorname*{arg}',
            '\\text{',
            '\\text{a  b}',
            '\\color{red}',
            '\\textcolor{blue}',
            '\\mathbf',
            '\\mathrm',
            '\\hat',
            '\\overline',
            '\\overbrace',
            '\\overset',
            '\\xrightarrow',
            '\\xrightarrow[a]',
            '\\prescript',
            '\\boxed',
            '\\enclose{top}',
            '\\pmod',
            '\\alpha',
            '\\displaystyle',
            '\\unknown',
        ];
        let state = 7;
        const random = () => {
            state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
            return state / 4_294_967_296;
        };
        const start = performance.now();
        let trees = 0;
        for (let run = 0; run < 10_000; run++) {
            const latex = Array.from(
                { length: 1 + Math.floor(random() * 12) },
                () => TOKENS[Math.floor(random() * TOKENS.length)],
            ).join('');
            let tree: MathRow;
            try {
                tree = readLatex(latex);
            } catch (error) {
                expect({ latex, error: error instanceof MathError }).toEqual({ latex, error: true });
                continue;
            }
            trees++;
            expect({ latex, issue: canonicalIssue(tree) }).toEqual({ latex, issue: undefined });
            expect({ latex, tree: viaLatex(tree) }).toStrictEqual({ latex, tree });
        }
        expect(trees).toBeGreaterThan(1000);
        expect(performance.now() - start).toBeLessThan(5000);
    });
});

describe('LATEX_COMMANDS', () => {
    test('reuses the notation tables: every accent, large operator, variant and space has its command', () => {
        for (const accent of ACCENT_COMMANDS) expect(ACCENTS.has(String(accent))).toBe(true);
        expect([...OPERATOR_COMMANDS].sort()).toEqual([...LARGE_OPERATORS].sort());
        const fonts = new Set(commands('font').map((command) => command.kind === 'font' && command.variant));
        for (const variant of MATH_VARIANTS) expect(fonts).toContain(variant);
        const spaces = new Set(commands('space').map((command) => command.kind === 'space' && command.width));
        for (const width of MATH_SPACES) expect(spaces).toContain(width);
    });

    // The editor turns `\name` + space into `\name{}…`: the count it inserts must be what the reader takes.
    test('LATEX_ARGUMENTS is the number of arguments each command reads', () => {
        const samples: Partial<Record<LatexCommand['kind'], string[]>> = {
            color: ['red', 'x'],
            colorSwitch: ['red'],
            genfrac: ['', '', '0pt', '', 'a', 'b'],
            notation: ['top', 'x'],
        };
        const structural = new Set(['left', 'middle', 'right', 'begin', 'end', 'limits', 'noop']);
        for (const [name, command] of LATEX_COMMANDS) {
            if (structural.has(command.kind)) continue;
            const count = LATEX_ARGUMENTS[command.kind];
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
