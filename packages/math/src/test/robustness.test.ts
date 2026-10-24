import { describe, expect, test } from 'bun:test';
import { MathError } from '../error';
import { readLatex, writeLatex } from '../latex';
import { MATHML_NAMESPACE, readMathml, writeMathml } from '../mathml';
import { SPACES } from '../notation';
import { OMML_NAMESPACE, readOmml, WORDML_NAMESPACE, writeOmml } from '../omml';
import { writeText } from '../text';
import type { MathNode, MathRow } from '../tree';
import { MATH_ENCLOSURES, MATH_LIMITS, MATH_VARIANTS } from '../tree';
import type { MathXmlElement } from '../xml';
import { elementsOf } from '../xml';
import { canonicalIssue } from './canonical';
import type { Random } from './generate';
import { generateTree, pick, seeded } from './generate';
import { el, parseWritten, viaLatex, viaMathml, viaOmml } from './parse';

// Over the whole package: every reader on seeded random input, the largest admitted trees through every writer, and
// what each writer may put in its output.

const x: MathRow = [{ kind: 'identifier', text: 'x' }];

// What a reader promises for any input: a canonical tree that every writer writes and every reader reads back (LaTeX
// but for its listed losses), or a MathError. The tree, or undefined for the error.
function settled(input: string, read: () => MathRow): MathRow | undefined {
    let tree: MathRow;
    try {
        tree = read();
    } catch (error) {
        expect({ input, error: error instanceof MathError ? 'MathError' : String(error) }).toEqual({
            input,
            error: 'MathError',
        });
        return undefined;
    }
    expect({ input, issue: canonicalIssue(tree) }).toEqual({ input, issue: undefined });
    expect({ input, tree: viaMathml(tree) }).toStrictEqual({ input, tree });
    expect({ input, tree: viaOmml(tree) }).toStrictEqual({ input, tree });
    expect({ input, issue: canonicalIssue(viaLatex(tree)) }).toEqual({ input, issue: undefined });
    writeText(tree);
    return tree;
}

// ── Seeded element trees ───────────────────────────────────────────────────────────────────────────────────────

// A format's elements: what each holds, which hold text, and the attributes one may carry. Mostly what the format
// nests, sometimes anything, so a reader meets both its own shapes and forged ones.
type Grammar = {
    namespace: string;
    root: string;
    row: readonly string[];
    parts: Readonly<Record<string, readonly string[]>>;
    textual: ReadonlySet<string>;
    attributes: (name: string, random: Random) => Record<string, string>;
    // The writer's output for a tree, parsed: the shapes a reader looks for, to damage.
    written: (row: MathRow) => MathXmlElement;
};

const PREFIXES: Record<string, string> = {
    m: OMML_NAMESPACE,
    w: WORDML_NAMESPACE,
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    x: 'urn:x',
};

const TEXTS = [
    'x',
    'xy',
    'sin',
    '12',
    '3.14',
    '1.2.3',
    ' ',
    '\u00A0',
    '\t\n',
    '\u2003',
    '\u2003\u2003',
    '\u200B',
    '\u2061',
    '&',
    '<',
    '"',
    ']]>',
    'javascript:alert(1)',
    'α',
    '𝐯',
    'ℝ',
    '😀',
    '\u0302',
    '\u0338',
    '²',
    '₋',
    '¯',
    'a b ',
    '∑',
    '∫',
    '(',
    ')',
    '|',
    '⏞',
    '‾',
    '',
    '\u0000',
    '\uD800',
    '\uFFFE',
];

const VALUES = [
    ...['1', '0', 'on', 'off', 'true', 'false', '', ' ', 'p', 'b', 'i', 'bi', 'roman', 'double-struck', 'script'],
    ...['fraktur', 'sans-serif', 'monospace', 'lin', 'noBar', 'skw', 'top', 'bot', 'undOvr', 'subSup', '∑', '∫'],
    ...['(', '⟨', '|', '\u0302', '˙', 'FF0000', 'ff00aa', 'auto', '#FF0000', 'javascript:alert(1)', '"<&', ' ( '],
    ...['😀', '\u0000', '\uD800'],
];

function qualified(grammar: Grammar, name: string): { ns: string; local: string } {
    const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
    return { ns: prefix ? PREFIXES[prefix] : grammar.namespace, local };
}

function element(grammar: Grammar, name: string, random: Random, depth: number): MathXmlElement {
    const { ns, local } = qualified(grammar, name);
    const parts = grammar.parts[name];
    const children: (string | object)[] = [];
    const count = parts || grammar.textual.has(name) ? Math.floor(random() * 4) : 0;
    for (let index = 0; index < count; index++) {
        const roll = random();
        if (grammar.textual.has(name) || roll < 0.08) children.push(pick(random, TEXTS));
        // Bun's tree holds comments and processing instructions as objects without a local name.
        else if (roll < 0.12) children.push({ comment: 'x' });
        else if (depth < 7 && parts)
            children.push(element(grammar, pick(random, roll < 0.85 ? parts : grammar.row), random, depth + 1));
    }
    return { ns, local, attributes: grammar.attributes(local, random), children };
}

const isElement = (child: string | object): child is MathXmlElement => typeof child === 'object' && 'local' in child;

// A writer's output with seeded damage: an element may lose, repeat or swap a child, gain a random one, change its name
// or its attributes, and a text may change, so a reader meets its own patterns broken in every way.
function damaged(grammar: Grammar, original: MathXmlElement, random: Random): MathXmlElement {
    const children = original.children.map((child) => {
        if (typeof child === 'string') return random() < 0.1 ? pick(random, TEXTS) : child;
        return isElement(child) ? damaged(grammar, child, random) : child;
    });
    const at = Math.floor(random() * children.length);
    const roll = random();
    if (roll < 0.05) children.splice(at, 1);
    else if (roll < 0.1 && children.length > 0) children.splice(at, 0, children[at]);
    else if (roll < 0.15 && children.length > 1) [children[0], children[at]] = [children[at], children[0]];
    else if (roll < 0.2) children.splice(at, 0, element(grammar, pick(random, grammar.row), random, 5));
    const renamed = random() < 0.05 ? qualified(grammar, pick(random, grammar.row)) : original;
    const attributes = random() < 0.1 ? grammar.attributes(renamed.local, random) : original.attributes;
    return { ns: renamed.ns, local: renamed.local, attributes, children };
}

const OMML_OBJECTS = ['f', 'sSub', 'sSup', 'sSubSup', 'sPre', 'rad', 'nary', 'd', 'func', 'acc', 'bar', 'groupChr'];
const OMML_ROW = [
    ...OMML_OBJECTS,
    ...['limLow', 'limUpp', 'borderBox', 'm', 'eqArr', 'box', 'phant', 'r', 'r', 'r', 'r', 'r', 'oMath'],
    ...['w:ins', 'w:del', 'w:moveTo', 'w:moveFrom', 'mc:AlternateContent', 'x:unknown', 'w:r'],
];
const BORDERS = ['hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH', 'strikeV', 'strikeBLTR', 'strikeTLBR'];
const OMML_PROPERTIES = new Set([
    ...['sty', 'scr', 'nor', 'lit', 'type', 'degHide', 'chr', 'limLoc', 'subHide', 'supHide', 'begChr', 'sepChr'],
    ...['endChr', 'pos', 'color', 'b', ...BORDERS],
]);
const ARGUMENTS = ['e', 'num', 'den', 'sub', 'sup', 'deg', 'fName', 'lim', 'w:ins', 'w:moveTo', 'w:del', 'x:unknown'];

const OMML: Grammar = {
    namespace: OMML_NAMESPACE,
    root: 'oMath',
    row: OMML_ROW,
    parts: {
        ...Object.fromEntries(
            [...ARGUMENTS, 'oMath', 'mc:Choice', 'mc:Fallback', 'box', 'phant'].map((n) => [n, OMML_ROW]),
        ),
        r: ['rPr', 't', 't', 'w:rPr', 'w:ins', 'w:del', 'w:moveFrom'],
        'w:ins': [...OMML_ROW, 't'],
        rPr: ['sty', 'scr', 'nor', 'lit'],
        'w:rPr': ['w:color', 'w:b'],
        'mc:AlternateContent': ['mc:Choice', 'mc:Fallback'],
        f: ['fPr', 'num', 'den'],
        fPr: ['type', 'ctrlPr'],
        sSub: ['e', 'sub'],
        sSup: ['e', 'sup'],
        sSubSup: ['e', 'sub', 'sup'],
        sPre: ['sub', 'sup', 'e'],
        rad: ['radPr', 'deg', 'e'],
        radPr: ['degHide'],
        nary: ['naryPr', 'sub', 'sup', 'e'],
        naryPr: ['chr', 'limLoc', 'subHide', 'supHide'],
        d: ['dPr', 'e', 'e'],
        dPr: ['begChr', 'sepChr', 'endChr'],
        func: ['fName', 'e'],
        acc: ['accPr', 'e'],
        accPr: ['chr', 'ctrlPr'],
        ctrlPr: ['w:del', 'w:ins', 'w:rPr'],
        bar: ['barPr', 'e'],
        barPr: ['pos'],
        groupChr: ['groupChrPr', 'e'],
        groupChrPr: ['chr', 'pos'],
        limLow: ['e', 'lim'],
        limUpp: ['e', 'lim'],
        borderBox: ['borderBoxPr', 'e'],
        borderBoxPr: BORDERS,
        m: ['mr', 'mr', 'mPr'],
        mr: ['e', 'e'],
        eqArr: ['e', 'e'],
    },
    textual: new Set(['t']),
    attributes: (local, random) => {
        if (OMML_PROPERTIES.has(local) && random() < 0.8)
            return { [pick(random, ['m:val', 'w:val', 'val'])]: pick(random, VALUES) };
        return local === 't' && random() < 0.3 ? { 'xml:space': 'preserve' } : {};
    },
    written: (row) => parseWritten(writeOmml(row)),
};

const MATHML_ROW = [
    ...['mi', 'mi', 'mn', 'mo', 'mo', 'mo', 'mtext', 'mspace', 'mrow', 'mrow', 'mfrac', 'msqrt', 'mroot', 'msub'],
    ...['msup', 'msubsup', 'mmultiscripts', 'mprescripts', 'none', 'munder', 'mover', 'munderover', 'menclose'],
    ...['mtable', 'semantics', 'mstyle', 'mfenced', 'mphantom', 'math', 'maction', 'mpadded', 'ms', 'x:unknown'],
];
const FLAG = ['true', 'false', ''];
const MATHML_ATTRIBUTES: [string, readonly string[]][] = [
    ['mathvariant', [...MATH_VARIANTS, 'bogus']],
    [
        'mathcolor',
        ['#FF0000', '#ff00aa', 'red', 'RED', '#F00', '#f0a', 'constructor', 'javascript:alert(1)', '#\u0000'],
    ],
    ['width', [...Object.values(SPACES).map((space) => space.width), '0.167em', '0.1667em', '-1em', 'em', '1e999em']],
    ['linethickness', ['0', '0px', '0em', '0pt', '1']],
    ['selection', ['1', '2', '0', '-1', '1e309', 'NaN']],
    ...['open', 'close', 'separators'].map((name): [string, readonly string[]] => [
        name,
        ['(', ']', ',;', '', ' ', '\u0302', '\u2061', '<&'],
    ]),
    ['data-mjx-texclass', ['OPEN', 'CLOSE', 'INNER', 'ORD']],
    ['notation', [...MATH_ENCLOSURES, 'box', 'top  left', 'bogus']],
    ['encoding', ['application/x-tex', 'text/plain']],
    ...['stretchy', 'fence', 'separator', 'largeop', 'accent', 'accentunder', 'bevelled', 'displaystyle'].map(
        (name): [string, readonly string[]] => [name, FLAG],
    ),
];

const MATHML: Grammar = {
    namespace: MATHML_NAMESPACE,
    root: 'math',
    row: MATHML_ROW,
    parts: {
        ...Object.fromEntries(
            [
                ...['math', 'mrow', 'mstyle', 'mfenced', 'mphantom', 'msqrt', 'menclose', 'mtd', 'mfrac', 'mroot'],
                ...['msub', 'msup', 'msubsup', 'mmultiscripts', 'munder', 'mover', 'munderover', 'maction', 'mpadded'],
                ...['x:unknown', 'annotation-xml'],
            ].map((name) => [name, MATHML_ROW]),
        ),
        mtable: ['mtr', 'mtr', 'x:unknown'],
        mtr: ['mtd', 'mtd'],
        semantics: [...MATHML_ROW, 'annotation', 'annotation', 'annotation-xml'],
    },
    textual: new Set(['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation']),
    attributes: (local, random) => {
        const attributes: Record<string, string> = {};
        for (let count = Math.floor(random() * 3); count > 0; count--) {
            const [name, values] = pick(random, MATHML_ATTRIBUTES);
            attributes[name] = pick(random, values);
        }
        // A fenced row or an n-ary needs its marks on an mo.
        if (local === 'mo' && random() < 0.5) attributes[pick(random, ['fence', 'largeop', 'separator'])] = 'true';
        return attributes;
    },
    written: (row) => el(writeMathml(row)),
};

// The paste route: an HTML DOM puts math in the XHTML namespace or in none, and may keep a prefix in the local name.
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const HTML_NAMES = [
    (local: string) => ({ ns: XHTML_NAMESPACE, local }),
    (local: string) => ({ ns: '', local }),
    (local: string) => ({ ns: XHTML_NAMESPACE, local: `mml:${local}` }),
];

function pasted(element: MathXmlElement, index = 0): MathXmlElement {
    const children = element.children.map((child, at) => (isElement(child) ? pasted(child, index + at) : child));
    const name = element.ns === MATHML_NAMESPACE ? HTML_NAMES[index % HTML_NAMES.length](element.local) : element;
    return { ...element, ...name, children };
}

describe('every reader ends in a tree or a MathError, within its time budget', () => {
    test.each<[string, Grammar, (root: MathXmlElement) => MathRow]>([
        ['readOmml', OMML, readOmml],
        ['readMathml', MATHML, readMathml],
        ['readMathml through an HTML DOM', MATHML, (root) => readMathml(pasted(root))],
    ])('%s on 1,500 seeded element trees, one in five a damaged writer output', (name, grammar, read) => {
        const start = performance.now();
        let trees = 0;
        for (let seed = 1; seed <= 1500; seed++) {
            const random = seeded(seed);
            const root =
                seed % 5 === 0
                    ? damaged(grammar, grammar.written(generateTree(seed)), random)
                    : element(grammar, grammar.root, random, 1);
            if (settled(`${name} seed ${seed}`, () => read(root))) trees++;
        }
        expect(trees).toBeGreaterThan(1000);
        expect(performance.now() - start).toBeLessThan(4000);
    });

    test('readLatex on 10,000 seeded token strings', () => {
        const TOKENS = [
            ..."xy1.2+-=(){}^_&'~%#$[]|",
            ...[' ', '\n', '\u00A0', '😀', '\u0000', '\uD800', '{x}', '{}', '\\\\', '\\ ', '\\,', '\\quad', '\\frac'],
            ...['\\binom', '\\genfrac{}{}{0pt}{}', '\\sqrt', '\\sqrt[3]', '\\left(', '\\left.', '\\middle|'],
            ...['\\right)', '\\right\\}', '\\left( x \\middle| y \\right]', '\\begin{pmatrix}', '\\end{pmatrix}'],
            ...['\\begin{cases} 1 & x \\\\ 2 \\end{cases}', '\\begin{aligned} a &= b \\end{aligned}', '\\sum', '\\int'],
            ...['\\limits', '\\sin', '\\lim', '\\operatorname', '\\operatorname*{arg}', '\\text{', '\\text{a  b}'],
            ...['\\color{red}', '\\textcolor{blue}', '\\mathbf', '\\mathrm', '\\hat', '\\overline', '\\overbrace'],
            ...['\\overset', '\\xrightarrow', '\\xrightarrow[a]', '\\prescript', '\\boxed', '\\enclose{top}', '\\pmod'],
            ...['\\alpha', '\\displaystyle', '\\unknown', '\\href{javascript:alert(1)}{x}', '\\not', '\\Gamma'],
            ...['\u0301', '\u0338', '\u0311', '²', '⁻', '₂'],
        ];
        const random = seeded(7);
        const start = performance.now();
        let trees = 0;
        for (let run = 0; run < 10_000; run++) {
            const latex = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pick(random, TOKENS)).join('');
            const tree = settled(latex, () => readLatex(latex));
            if (!tree) continue;
            trees++;
            // Typed LaTeX holds no picture LaTeX lacks, so its tree's LaTeX reads back whole.
            expect({ latex, tree: viaLatex(tree) }).toStrictEqual({ latex, tree });
        }
        expect(trees).toBeGreaterThan(1000);
        expect(performance.now() - start).toBeLessThan(5000);
    });

    // Each writer's costliest unit, as many as the size bound admits: an enclose drawing every line around an empty row
    // (MathML's and LaTeX's), a coloured operator in the longest font command with the longest symbol command, and
    // coloured text of backslashes.
    test('the largest admitted trees go through every writer and back; one unit more is an error', () => {
        const units = Math.floor((MATH_LIMITS.size - 1) / 2);
        const enclosures = (count: number) =>
            Array.from(
                { length: count },
                (): MathNode => ({ kind: 'enclose', notation: [...MATH_ENCLOSURES], body: [] }),
            );
        const trees: MathRow[] = [
            enclosures(units),
            Array.from(
                { length: units },
                (): MathNode => ({ kind: 'operator', text: '⟺', variant: 'sans-serif-bold-italic', color: '#FF0000' }),
            ),
            [{ kind: 'text', text: '\\'.repeat(MATH_LIMITS.size - 2), color: '#FF0000' }],
        ];
        for (const tree of trees) {
            expect(viaMathml(tree)).toStrictEqual(tree);
            expect(viaOmml(tree)).toStrictEqual(tree);
            const latex = writeLatex(tree);
            expect(latex.length).toBeLessThanOrEqual(MATH_LIMITS.latexLength);
            expect(readLatex(latex)).toStrictEqual(tree);
            expect(writeText(tree).length).toBeGreaterThan(0);
        }
        expect(() => viaMathml(enclosures(units + 1))).toThrow(MathError);
        expect(() => viaOmml(enclosures(units + 1))).toThrow(MathError);
        expect(() => viaLatex(enclosures(units + 1))).toThrow(MathError);
    });

    // The writer escapes every other <, so each opens or closes a tag. Its densest units, an accent, line or brace over
    // an empty row and a fence pair around one, write three tags each.
    test('the densest MathML at the size bound fits the tag cap; one unit more is an error', () => {
        const units = Math.floor((MATH_LIMITS.size - 1) / 2);
        const tagsOf = (mathml: string) => mathml.split('<').length - 1;
        const dense: MathNode[] = [
            { kind: 'accent', accent: '\u0302', body: [] },
            { kind: 'line', position: 'over', body: [] },
            { kind: 'brace', char: '⏞', position: 'over', body: [] },
            { kind: 'fenced', open: '(', close: ')', separator: '', parts: [[]] },
        ];
        for (const node of dense) {
            const tree = Array.from({ length: units }, () => node);
            const mathml = writeMathml(tree, writeLatex(tree));
            expect(tagsOf(mathml)).toBeLessThanOrEqual(MATH_LIMITS.mathmlTags);
            expect(readMathml(el(mathml))).toStrictEqual(tree);
            expect(() => writeMathml([...tree, node], writeLatex(tree))).toThrow(MathError);
        }
    });
});

// ── Output safety ──────────────────────────────────────────────────────────────────────────────────────────────

// Every string a tree holds, as one character or as text, holding what XML, LaTeX or a URL would act on.
const HOSTILE_CHARS = ['<', '>', '"', '&', '\\', '%', '#', '}'];
const HOSTILE_TEXTS = ['</mtext><script>alert(1)</script>', '</m:t><w:del>"&]]>', 'javascript:alert(1)', '\\end{x}}%'];
const marks = (char: string): MathRow => [
    { kind: 'operator', text: char },
    { kind: 'fenced', open: char, close: char, separator: char, parts: [x, x] },
    { kind: 'accent', accent: char, body: x },
    { kind: 'brace', char, position: 'over', body: x },
    { kind: 'nary', operator: char, limits: 'under', sub: x, body: x },
];
const HOSTILE: MathRow[] = [
    ...HOSTILE_CHARS.map(marks),
    HOSTILE_TEXTS.map((text): MathNode => ({ kind: 'text', text })),
];
// A colour a tree was handed that is no #RRGGBB.
const FORGED_COLORS = ['red', '#F00', '#GG0000', '#FF00001', ' #FF0000', 'javascript:alert(1)', '" onclick="alert(1)'];
const FORGED: MathRow[] = FORGED_COLORS.map((color) => [
    { kind: 'identifier', text: 'x', color },
    { kind: 'text', text: 'if', color },
]);

const MATHML_ELEMENTS = new Set([
    ...['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'mfrac', 'msqrt', 'mroot'],
    ...['msub', 'msup', 'msubsup', 'mmultiscripts', 'mprescripts', 'none', 'munder', 'mover', 'munderover'],
    ...['menclose', 'mtable', 'mtr', 'mtd'],
]);
const MATHML_ATTRIBUTE_NAMES = new Set([
    ...['xmlns', 'encoding', 'mathvariant', 'mathcolor', 'stretchy', 'fence', 'separator', 'largeop', 'accent'],
    ...['accentunder', 'width', 'linethickness', 'bevelled', 'notation', 'displaystyle', 'columnalign'],
]);

function mathmlVocabulary(element: MathXmlElement): string[] {
    const own = element.ns === MATHML_NAMESPACE && MATHML_ELEMENTS.has(element.local) ? [] : [element.local];
    const attributes = Object.keys(element.attributes).filter((name) => !MATHML_ATTRIBUTE_NAMES.has(name));
    return [...own, ...attributes, ...elementsOf(element).flatMap(mathmlVocabulary)];
}

function ommlVocabulary(element: MathXmlElement): string[] {
    const allowed =
        element.ns === OMML_NAMESPACE || (element.ns === WORDML_NAMESPACE && ['rPr', 'color'].includes(element.local));
    const own = allowed ? [] : [`${element.ns} ${element.local}`];
    const attributes = Object.keys(element.attributes).filter(
        (name) => !['m:val', 'w:val', 'xml:space'].includes(name),
    );
    return [...own, ...attributes, ...elementsOf(element).flatMap(ommlVocabulary)];
}

describe('a writer’s output holds only its own vocabulary', () => {
    // LaTeX's vocabulary is the command table: the reader knows nothing else, so output that reads back holds nothing
    // else. The text form is one line.
    test('hostile, forged and 200 seeded trees through every writer', () => {
        const seededTrees = Array.from({ length: 200 }, (_, seed) => generateTree(seed + 1));
        for (const tree of [...HOSTILE, ...FORGED, ...seededTrees]) {
            const input = JSON.stringify(tree).slice(0, 200);
            expect({
                input,
                mathml: mathmlVocabulary(el(writeMathml(tree, '</annotation><script>x</script>'))),
            }).toEqual({ input, mathml: [] });
            expect({ input, omml: ommlVocabulary(parseWritten(writeOmml(tree))) }).toEqual({ input, omml: [] });
            expect({ input, issue: canonicalIssue(viaLatex(tree)) }).toEqual({ input, issue: undefined });
            expect({ input, lines: writeText(tree).split(/[\n\r]/).length }).toEqual({ input, lines: 1 });
        }
    });

    test('a colour that is no #RRGGBB reaches no output', () => {
        for (const tree of FORGED) {
            expect(writeMathml(tree)).not.toContain('mathcolor');
            expect(writeOmml(tree)).not.toContain('w:color');
            expect(writeLatex(tree)).not.toContain('color');
        }
        const lower: MathRow = [{ kind: 'identifier', text: 'x', color: '#ff00aa' }];
        expect(writeMathml(lower)).toContain('mathcolor="#FF00AA"');
        expect(writeOmml(lower)).toContain('w:val="FF00AA"');
        expect(writeLatex(lower)).toBe('\\textcolor{#FF00AA}{x}');
    });

    test('a forged variant or notation stays inside its MathML attribute', () => {
        const forged = '" onmouseover="alert(1)';
        const tree: MathRow = JSON.parse(
            JSON.stringify([
                { kind: 'identifier', text: 'ж', variant: forged },
                { kind: 'enclose', notation: [forged], body: x },
            ]),
        );
        expect(mathmlVocabulary(el(writeMathml(tree)))).toEqual([]);
    });

    test('a character XML can’t hold is a MathError in every writer', () => {
        for (const char of ['\u0000', '\u0001', '\uD800', '\uDC00', '\uFFFE']) {
            const text: MathNode = { kind: 'text', text: `a${char}b` };
            for (const node of [...marks(char), text]) {
                for (const write of [writeMathml, writeOmml, writeLatex, writeText]) {
                    expect(() => write([node])).toThrow(MathError);
                }
            }
        }
    });
});
