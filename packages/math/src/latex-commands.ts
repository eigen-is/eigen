// LATEX_COMMANDS is the one table of LaTeX commands. Each name maps to what it means, such as a symbol, a function, a
// large operator, a font or a fraction, with how many braced arguments it takes. The LaTeX reader parses through it,
// the writer reads it backwards, and a caller may list it, for example to complete a command as the user types.

import { LARGE_OPERATOR_NAMES, PRIME } from './notation';
import type { MathEnclosure, MathSpace, MathVariant } from './tree';
import { CASES } from './tree';

const SYMBOL_CLASSES = ['letter', 'operator', 'relation', 'arrow', 'delimiter', 'misc'] as const;

type LatexRow =
    | { kind: 'symbol'; char: string; class: (typeof SYMBOL_CLASSES)[number] }
    | { kind: 'function'; limits: boolean }
    | { kind: 'operatorname' }
    | { kind: 'largeOperator'; operator: string }
    | { kind: 'limits'; limits: 'under' | 'side' }
    | { kind: 'accent'; accent: string }
    | { kind: 'line'; position: 'over' | 'under' }
    | { kind: 'brace'; char: string; position: 'over' | 'under' }
    | { kind: 'limit'; position: 'over' | 'under' }
    | { kind: 'arrow'; char: string }
    | { kind: 'font'; variant: MathVariant }
    | { kind: 'fraction'; open: string; close: string; line: 'bar' | 'none' }
    | { kind: 'genfrac' }
    | { kind: 'radical' }
    | { kind: 'prescript' }
    | { kind: 'space'; width: MathSpace }
    | { kind: 'text' }
    | { kind: 'color' }
    | { kind: 'colorSwitch' }
    | { kind: 'enclose'; notation: readonly MathEnclosure[] }
    | { kind: 'notation' }
    | { kind: 'pmod' }
    // The braket package's commands, such as \ket and \braket: a fenced row around the argument. With `split`, each |
    // in the argument is a separator.
    | { kind: 'braket'; open: string; close: string; split: boolean; stars: number }
    // The physics package's \expval, \mel and \ketbra. Their stars only size the fences, which the tree doesn't keep.
    | { kind: 'expectation'; stars: number }
    | { kind: 'matrixElement'; stars: number }
    | { kind: 'outerProduct'; stars: number }
    | { kind: 'left' }
    | { kind: 'middle' }
    | { kind: 'right' }
    | { kind: 'big' }
    | { kind: 'not' }
    | { kind: 'begin' }
    | { kind: 'end' }
    | { kind: 'noop' };

// `arguments` counts braced arguments; an optional [argument] or group, a star or a `\left` delimiter comes on top.
export type LatexCommand = Readonly<LatexRow & { arguments: number }>;

const ARGUMENTS: Readonly<Record<LatexRow['kind'], number>> = {
    symbol: 0,
    function: 0,
    operatorname: 1,
    largeOperator: 0,
    limits: 0,
    accent: 1,
    line: 1,
    brace: 1,
    limit: 2,
    arrow: 1,
    font: 1,
    fraction: 2,
    genfrac: 6,
    radical: 1,
    prescript: 3,
    space: 0,
    text: 1,
    color: 2,
    colorSwitch: 1,
    enclose: 1,
    notation: 2,
    pmod: 1,
    braket: 1,
    expectation: 1,
    matrixElement: 3,
    outerProduct: 1,
    left: 0,
    middle: 0,
    right: 0,
    big: 0,
    not: 0,
    begin: 1,
    end: 1,
    noop: 0,
};

// Where two names give one character, the writer uses the first.
const SYMBOL_COMMANDS: Record<(typeof SYMBOL_CLASSES)[number], Record<string, string>> = {
    letter: {
        alpha: 'α',
        beta: 'β',
        gamma: 'γ',
        delta: 'δ',
        epsilon: 'ϵ',
        varepsilon: 'ε',
        zeta: 'ζ',
        eta: 'η',
        theta: 'θ',
        vartheta: 'ϑ',
        iota: 'ι',
        kappa: 'κ',
        varkappa: 'ϰ',
        lambda: 'λ',
        mu: 'μ',
        nu: 'ν',
        xi: 'ξ',
        omicron: 'ο',
        pi: 'π',
        varpi: 'ϖ',
        rho: 'ρ',
        varrho: 'ϱ',
        sigma: 'σ',
        varsigma: 'ς',
        tau: 'τ',
        upsilon: 'υ',
        phi: 'ϕ',
        varphi: 'φ',
        chi: 'χ',
        psi: 'ψ',
        omega: 'ω',
        Gamma: 'Γ',
        Delta: 'Δ',
        Theta: 'Θ',
        Lambda: 'Λ',
        Xi: 'Ξ',
        Pi: 'Π',
        Sigma: 'Σ',
        Upsilon: 'Υ',
        Phi: 'Φ',
        Psi: 'Ψ',
        Omega: 'Ω',
        aleph: 'ℵ',
        beth: 'ℶ',
        gimel: 'ℷ',
        ell: 'ℓ',
        hbar: 'ℏ',
        imath: 'ı',
        jmath: 'ȷ',
        Re: 'ℜ',
        Im: 'ℑ',
    },
    operator: {
        pm: '±',
        mp: '∓',
        times: '×',
        div: '÷',
        cdot: '⋅',
        ast: '∗',
        star: '⋆',
        circ: '∘',
        bullet: '∙',
        cap: '∩',
        cup: '∪',
        uplus: '⊎',
        sqcap: '⊓',
        sqcup: '⊔',
        vee: '∨',
        lor: '∨',
        wedge: '∧',
        land: '∧',
        setminus: '∖',
        oplus: '⊕',
        ominus: '⊖',
        otimes: '⊗',
        oslash: '⊘',
        odot: '⊙',
        dagger: '†',
        ddagger: '‡',
        amalg: '⨿',
        wr: '≀',
        diamond: '⋄',
        bigcirc: '◯',
        triangleleft: '◁',
        triangleright: '▷',
    },
    relation: {
        le: '≤',
        leq: '≤',
        ge: '≥',
        geq: '≥',
        ne: '≠',
        neq: '≠',
        equiv: '≡',
        approx: '≈',
        sim: '∼',
        simeq: '≃',
        cong: '≅',
        propto: '∝',
        ll: '≪',
        gg: '≫',
        prec: '≺',
        succ: '≻',
        preceq: '⪯',
        succeq: '⪰',
        subset: '⊂',
        supset: '⊃',
        subseteq: '⊆',
        supseteq: '⊇',
        sqsubseteq: '⊑',
        sqsupseteq: '⊒',
        in: '∈',
        ni: '∋',
        notin: '∉',
        perp: '⊥',
        parallel: '∥',
        mid: '∣',
        models: '⊨',
        vdash: '⊢',
        dashv: '⊣',
        doteq: '≐',
        asymp: '≍',
        bowtie: '⋈',
        coloneqq: '≔',
        lt: '<',
        gt: '>',
    },
    arrow: {
        to: '→',
        rightarrow: '→',
        leftarrow: '←',
        gets: '←',
        leftrightarrow: '↔',
        Rightarrow: '⇒',
        Leftarrow: '⇐',
        Leftrightarrow: '⇔',
        longrightarrow: '⟶',
        longleftarrow: '⟵',
        longleftrightarrow: '⟷',
        Longrightarrow: '⟹',
        implies: '⟹',
        Longleftarrow: '⟸',
        impliedby: '⟸',
        Longleftrightarrow: '⟺',
        iff: '⟺',
        mapsto: '↦',
        longmapsto: '⟼',
        hookrightarrow: '↪',
        hookleftarrow: '↩',
        uparrow: '↑',
        downarrow: '↓',
        updownarrow: '↕',
        Uparrow: '⇑',
        Downarrow: '⇓',
        Updownarrow: '⇕',
        nearrow: '↗',
        searrow: '↘',
        swarrow: '↙',
        nwarrow: '↖',
        rightleftharpoons: '⇌',
        leftharpoonup: '↼',
        rightharpoonup: '⇀',
        leftharpoondown: '↽',
        rightharpoondown: '⇁',
    },
    delimiter: {
        '{': '{',
        '}': '}',
        lbrace: '{',
        rbrace: '}',
        langle: '⟨',
        rangle: '⟩',
        lceil: '⌈',
        rceil: '⌉',
        lfloor: '⌊',
        rfloor: '⌋',
        '|': '‖',
        Vert: '‖',
        lVert: '‖',
        rVert: '‖',
        vert: '|',
        lvert: '|',
        rvert: '|',
        lgroup: '⟮',
        rgroup: '⟯',
        lbrack: '[',
        rbrack: ']',
        backslash: '\\',
    },
    misc: {
        '%': '%',
        '&': '&',
        '#': '#',
        $: '$',
        _: '_',
        infty: '∞',
        partial: '∂',
        nabla: '∇',
        forall: '∀',
        exists: '∃',
        nexists: '∄',
        neg: '¬',
        lnot: '¬',
        emptyset: '∅',
        varnothing: '∅',
        prime: PRIME,
        angle: '∠',
        triangle: '△',
        top: '⊤',
        bot: '⊥',
        ldots: '…',
        dots: '…',
        cdots: '⋯',
        vdots: '⋮',
        ddots: '⋱',
        therefore: '∴',
        because: '∵',
        surd: '√',
        wp: '℘',
        checkmark: '✓',
        clubsuit: '♣',
        diamondsuit: '♢',
        heartsuit: '♡',
        spadesuit: '♠',
        flat: '♭',
        natural: '♮',
        sharp: '♯',
        Box: '□',
    },
};

// Word's own accent for \bar is the combining overline; the macron and the double acute have no command.
const ACCENT_COMMANDS: Record<string, string> = {
    grave: '\u0300',
    acute: '\u0301',
    hat: '\u0302',
    widehat: '\u0302',
    tilde: '\u0303',
    widetilde: '\u0303',
    bar: '\u0305',
    breve: '\u0306',
    dot: '\u0307',
    ddot: '\u0308',
    mathring: '\u030A',
    check: '\u030C',
    overleftharpoon: '\u20D0',
    overrightharpoon: '\u20D1',
    overleftarrow: '\u20D6',
    vec: '\u20D7',
    overrightarrow: '\u20D7',
    overleftrightarrow: '\u20E1',
};

// The five variants LaTeX's own fonts lack take their unicode-math names.
const FONT_COMMANDS: Record<string, MathVariant> = {
    mathrm: 'normal',
    mathit: 'italic',
    mathbf: 'bold',
    boldsymbol: 'bold-italic',
    mathbb: 'double-struck',
    mathcal: 'script',
    mathscr: 'script',
    mathfrak: 'fraktur',
    mathsf: 'sans-serif',
    mathtt: 'monospace',
    mathbffrak: 'bold-fraktur',
    mathbfscr: 'bold-script',
    mathbfsf: 'bold-sans-serif',
    mathsfit: 'sans-serif-italic',
    mathbfsfit: 'sans-serif-bold-italic',
};

const SPACE_COMMANDS: Record<string, MathSpace> = {
    ' ': 'normal',
    ',': 'thin',
    ':': 'medium',
    '>': 'medium',
    ';': 'thick',
    quad: 'quad',
    qquad: 'qquad',
};

const FUNCTIONS = 'arccos arcsin arctan arg cos cosh cot coth csc deg dim exp hom ker lg ln log sec sin sinh tan tanh';
// Functions whose scripts go under and over, as limits.
const LIMIT_FUNCTIONS = 'det gcd inf lim max min Pr sup';

const FRACTION: LatexRow = { kind: 'fraction', open: '', close: '', line: 'bar' };
const BINOM: LatexRow = { kind: 'fraction', open: '(', close: ')', line: 'none' };

const ROWS: [string, LatexRow][] = [
    ...SYMBOL_CLASSES.flatMap((group) =>
        Object.entries(SYMBOL_COMMANDS[group]).map(([name, char]): [string, LatexRow] => [
            name,
            { kind: 'symbol', char, class: group },
        ]),
    ),
    ...FUNCTIONS.split(' ').map((name): [string, LatexRow] => [name, { kind: 'function', limits: false }]),
    ...LIMIT_FUNCTIONS.split(' ').map((name): [string, LatexRow] => [name, { kind: 'function', limits: true }]),
    ...Array.from(LARGE_OPERATOR_NAMES, ([name, operator]): [string, LatexRow] => [
        name,
        { kind: 'largeOperator', operator },
    ]),
    ...Object.entries(ACCENT_COMMANDS).map(([name, accent]): [string, LatexRow] => [name, { kind: 'accent', accent }]),
    ...Object.entries(FONT_COMMANDS).map(([name, variant]): [string, LatexRow] => [name, { kind: 'font', variant }]),
    ...Object.entries(SPACE_COMMANDS).map(([name, width]): [string, LatexRow] => [name, { kind: 'space', width }]),
    ...['big', 'Big', 'bigg', 'Bigg'].flatMap((size) =>
        ['', 'l', 'm', 'r'].map((side): [string, LatexRow] => [size + side, { kind: 'big' }]),
    ),
    ['not', { kind: 'not' }],
    ['operatorname', { kind: 'operatorname' }],
    ['limits', { kind: 'limits', limits: 'under' }],
    ['nolimits', { kind: 'limits', limits: 'side' }],
    ['overline', { kind: 'line', position: 'over' }],
    ['underline', { kind: 'line', position: 'under' }],
    ['overbrace', { kind: 'brace', char: '⏞', position: 'over' }],
    ['underbrace', { kind: 'brace', char: '⏟', position: 'under' }],
    ['overparen', { kind: 'brace', char: '⏜', position: 'over' }],
    ['underparen', { kind: 'brace', char: '⏝', position: 'under' }],
    ['overset', { kind: 'limit', position: 'over' }],
    ['underset', { kind: 'limit', position: 'under' }],
    ['stackrel', { kind: 'limit', position: 'over' }],
    ['xrightarrow', { kind: 'arrow', char: '→' }],
    ['xleftarrow', { kind: 'arrow', char: '←' }],
    ['frac', FRACTION],
    ['dfrac', FRACTION],
    ['tfrac', FRACTION],
    ['cfrac', FRACTION],
    ['binom', BINOM],
    ['dbinom', BINOM],
    ['tbinom', BINOM],
    ['genfrac', { kind: 'genfrac' }],
    ['sqrt', { kind: 'radical' }],
    ['prescript', { kind: 'prescript' }],
    ['text', { kind: 'text' }],
    ['textcolor', { kind: 'color' }],
    ['color', { kind: 'colorSwitch' }],
    ['boxed', { kind: 'enclose', notation: ['top', 'bottom', 'left', 'right'] }],
    ['cancel', { kind: 'enclose', notation: ['updiagonalstrike'] }],
    ['bcancel', { kind: 'enclose', notation: ['downdiagonalstrike'] }],
    ['xcancel', { kind: 'enclose', notation: ['updiagonalstrike', 'downdiagonalstrike'] }],
    ['enclose', { kind: 'notation' }],
    ['pmod', { kind: 'pmod' }],
    // physics takes a star on \bra and \ket. The braket package's capitals grow, as every fence in the tree does.
    ['bra', { kind: 'braket', open: '⟨', close: '|', split: false, stars: 1 }],
    ['Bra', { kind: 'braket', open: '⟨', close: '|', split: false, stars: 0 }],
    ['ket', { kind: 'braket', open: '|', close: '⟩', split: false, stars: 1 }],
    ['Ket', { kind: 'braket', open: '|', close: '⟩', split: false, stars: 0 }],
    ['braket', { kind: 'braket', open: '⟨', close: '⟩', split: true, stars: 0 }],
    ['Braket', { kind: 'braket', open: '⟨', close: '⟩', split: true, stars: 0 }],
    ['set', { kind: 'braket', open: '{', close: '}', split: true, stars: 0 }],
    ['Set', { kind: 'braket', open: '{', close: '}', split: true, stars: 0 }],
    ['expval', { kind: 'expectation', stars: 2 }],
    ['mel', { kind: 'matrixElement', stars: 2 }],
    ['ketbra', { kind: 'outerProduct', stars: 1 }],
    ['left', { kind: 'left' }],
    ['middle', { kind: 'middle' }],
    ['right', { kind: 'right' }],
    ['begin', { kind: 'begin' }],
    ['end', { kind: 'end' }],
    // Wikipedia's annotations start with {\displaystyle; whether it is displayed belongs to the document.
    ['displaystyle', { kind: 'noop' }],
    ['textstyle', { kind: 'noop' }],
    // A negative thin space: the tree has no negative width.
    ['!', { kind: 'noop' }],
];

export const LATEX_COMMANDS: ReadonlyMap<string, LatexCommand> = new Map(
    ROWS.map(([name, row]): [string, LatexCommand] => [name, { ...row, arguments: ARGUMENTS[row.kind] }]),
);

type LatexEnvironment = { layout: 'matrix' | 'equations'; open: string; close: string };

// The environment of each layout without fences.
export const BARE_ENVIRONMENTS: Readonly<Record<LatexEnvironment['layout'], string>> = {
    matrix: 'matrix',
    equations: 'aligned',
};

export const LATEX_ENVIRONMENTS: ReadonlyMap<string, LatexEnvironment> = new Map<string, LatexEnvironment>([
    [BARE_ENVIRONMENTS.matrix, { layout: 'matrix', open: '', close: '' }],
    ['pmatrix', { layout: 'matrix', open: '(', close: ')' }],
    ['bmatrix', { layout: 'matrix', open: '[', close: ']' }],
    ['Bmatrix', { layout: 'matrix', open: '{', close: '}' }],
    ['vmatrix', { layout: 'matrix', open: '|', close: '|' }],
    ['Vmatrix', { layout: 'matrix', open: '‖', close: '‖' }],
    ['cases', { layout: 'matrix', ...CASES }],
    [BARE_ENVIRONMENTS.equations, { layout: 'equations', open: '', close: '' }],
]);
