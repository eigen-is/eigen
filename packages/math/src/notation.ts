// The character tables every format shares, such as the accents with their spacing twins, the spaces and their
// widths, the large operators by name, the colour names and Unicode's mathematical alphanumerics. Readers and writers
// look a character up here, so each fact about one is written once.

import type { MathSpace, MathVariant } from './tree';

// Each accent as OMML and the tree hold it (combining) and as MathML draws it (spacing). U+203E stays the line's.
export const ACCENTS: ReadonlyMap<string, string> = new Map([
    ['\u0300', '`'],
    ['\u0301', '´'],
    ['\u0302', 'ˆ'],
    ['\u0303', '˜'],
    ['\u0304', '¯'],
    ['\u0305', 'ˉ'],
    ['\u0306', '˘'],
    ['\u0307', '˙'],
    ['\u0308', '¨'],
    ['\u030A', '˚'],
    ['\u030B', '˝'],
    ['\u030C', 'ˇ'],
    ['\u20D0', '↼'],
    ['\u20D1', '⇀'],
    ['\u20D6', '←'],
    ['\u20D7', '→'],
    ['\u20E1', '↔'],
]);

// What an accent's spacing character folds to on read. Word also writes the overline accent as U+203E, MathJax as
// U+2015; KaTeX and MathJax write the hat and tilde as ASCII, the acute and grave as modifier letters.
export const COMBINING_ACCENTS: ReadonlyMap<string, string> = new Map([
    ...Array.from(ACCENTS, ([combining, spacing]): [string, string] => [spacing, combining]),
    ['‾', '\u0305'],
    ['\u2015', '\u0305'],
    ['^', '\u0302'],
    ['~', '\u0303'],
    ['\u02CA', '\u0301'],
    ['\u02CB', '\u0300'],
]);

export const LINES = { over: '‾', under: '_' } as const;

export const SPACES: Readonly<Record<MathSpace, { text: string; width: string }>> = {
    normal: { text: ' ', width: '0.3333em' },
    thin: { text: '\u2009', width: '0.1667em' },
    medium: { text: '\u205F', width: '0.2222em' },
    thick: { text: '\u2004', width: '0.2778em' },
    quad: { text: '\u2003', width: '1em' },
    qquad: { text: '\u2003\u2003', width: '2em' },
};

// Characters MathML stretches as fences, so a bare one is written unstretched. Word's angle brackets are escaped:
// Unicode normalisation turns them into the CJK U+3008 and U+3009.
export const FENCES: ReadonlySet<string> = new Set(['\u2329', '\u232A', ...'()[]{}|‖⌈⌉⌊⌋⟨⟩⟦⟧⟮⟯⦃⦄']);

export const PRIME = '′';

// CSS's basic colour names and the rest LaTeX's xcolor shares with CSS, as browsers draw them: KaTeX and MathJax hand
// a name to CSS, and MathML takes CSS's.
export const COLOR_NAMES: ReadonlyMap<string, string> = new Map([
    ['aqua', '#00FFFF'],
    ['black', '#000000'],
    ['blue', '#0000FF'],
    ['brown', '#A52A2A'],
    ['cyan', '#00FFFF'],
    ['fuchsia', '#FF00FF'],
    ['gray', '#808080'],
    ['green', '#008000'],
    ['lime', '#00FF00'],
    ['magenta', '#FF00FF'],
    ['maroon', '#800000'],
    ['navy', '#000080'],
    ['olive', '#808000'],
    ['orange', '#FFA500'],
    ['pink', '#FFC0CB'],
    ['purple', '#800080'],
    ['red', '#FF0000'],
    ['silver', '#C0C0C0'],
    ['teal', '#008080'],
    ['violet', '#EE82EE'],
    ['white', '#FFFFFF'],
    ['yellow', '#FFFF00'],
]);

// The minus operator: Chrome draws an ASCII hyphen-minus in an mo as a hyphen, so every reader folds one to U+2212.
export const MINUS = '\u2212';

// Unicode's superscript and subscript digits and signs: each reads as a script holding its NFKC character.
export const SCRIPT_CHARS: ReadonlyMap<string, readonly ['sub' | 'sup', string]> = new Map(
    (['sup', 'sub'] as const).flatMap((slot) =>
        [...(slot === 'sup' ? '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾' : '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎')].map(
            (char) => [char, [slot, char.normalize('NFKC')]] as const,
        ),
    ),
);

// The large operators by their unicode-math names, which LaTeX writes. The integrals stand apart, since Word puts
// their limits beside them.
const INTEGRAL_NAMES: Readonly<Record<string, string>> = {
    int: '∫',
    iint: '∬',
    iiint: '∭',
    oint: '∮',
    oiint: '∯',
    oiiint: '∰',
    intclockwise: '∱',
    varointclockwise: '∲',
    ointctrclockwise: '∳',
    sumint: '⨋',
    iiiint: '⨌',
    intbar: '⨍',
    intBar: '⨎',
    fint: '⨏',
    cirfnint: '⨐',
    awint: '⨑',
    rppolint: '⨒',
    scpolint: '⨓',
    npolint: '⨔',
    pointint: '⨕',
    sqint: '⨖',
    intlarhk: '⨗',
    intx: '⨘',
    intcap: '⨙',
    intcup: '⨚',
    upint: '⨛',
    lowint: '⨜',
};

export const LARGE_OPERATOR_NAMES: ReadonlyMap<string, string> = new Map(
    Object.entries({
        ...INTEGRAL_NAMES,
        sum: '∑',
        prod: '∏',
        coprod: '∐',
        bigwedge: '⋀',
        bigvee: '⋁',
        bigcap: '⋂',
        bigcup: '⋃',
        bigodot: '⨀',
        bigoplus: '⨁',
        bigotimes: '⨂',
        bigcupdot: '⨃',
        biguplus: '⨄',
        bigsqcap: '⨅',
        bigsqcup: '⨆',
        bigtimes: '⨉',
    }),
);

const INTEGRALS: ReadonlySet<string> = new Set(Object.values(INTEGRAL_NAMES));

export const LARGE_OPERATORS: ReadonlySet<string> = new Set(LARGE_OPERATOR_NAMES.values());

// Word's defaults: integrals carry their limits beside, every other large operator under and over.
export function naryLimits(operator: string): 'under' | 'side' {
    return INTEGRALS.has(operator) ? 'side' : 'under';
}

// Unicode's Mathematical Alphanumeric Symbols, block by block, with the letters it left in Letterlike Symbols.
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const GREEK_CAPITALS = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ';
const GREEK = `${GREEK_CAPITALS}∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ`;
const DIGITS = '0123456789';

const BLOCKS: readonly [MathVariant, string, number][] = [
    ['bold', LATIN, 0x1d400],
    ['italic', LATIN, 0x1d434],
    ['bold-italic', LATIN, 0x1d468],
    ['script', LATIN, 0x1d49c],
    ['bold-script', LATIN, 0x1d4d0],
    ['fraktur', LATIN, 0x1d504],
    ['double-struck', LATIN, 0x1d538],
    ['bold-fraktur', LATIN, 0x1d56c],
    ['sans-serif', LATIN, 0x1d5a0],
    ['bold-sans-serif', LATIN, 0x1d5d4],
    ['sans-serif-italic', LATIN, 0x1d608],
    ['sans-serif-bold-italic', LATIN, 0x1d63c],
    ['monospace', LATIN, 0x1d670],
    ['italic', 'ıȷ', 0x1d6a4],
    ['bold', GREEK, 0x1d6a8],
    ['italic', GREEK, 0x1d6e2],
    ['bold-italic', GREEK, 0x1d71c],
    ['bold-sans-serif', GREEK, 0x1d756],
    ['sans-serif-bold-italic', GREEK, 0x1d790],
    ['bold', 'Ϝϝ', 0x1d7ca],
    ['bold', DIGITS, 0x1d7ce],
    ['double-struck', DIGITS, 0x1d7d8],
    ['sans-serif', DIGITS, 0x1d7e2],
    ['bold-sans-serif', DIGITS, 0x1d7ec],
    ['monospace', DIGITS, 0x1d7f6],
];

// TeX and Word draw a capital Greek letter upright.
export const UPRIGHT_LETTERS: ReadonlySet<string> = new Set(GREEK_CAPITALS);

const LETTERLIKE: Readonly<Record<string, string>> = {
    'italic h': 'ℎ',
    'script B': 'ℬ',
    'script E': 'ℰ',
    'script F': 'ℱ',
    'script H': 'ℋ',
    'script I': 'ℐ',
    'script L': 'ℒ',
    'script M': 'ℳ',
    'script R': 'ℛ',
    'script e': 'ℯ',
    'script g': 'ℊ',
    'script o': 'ℴ',
    'fraktur C': 'ℭ',
    'fraktur H': 'ℌ',
    'fraktur I': 'ℑ',
    'fraktur R': 'ℜ',
    'fraktur Z': 'ℨ',
    'double-struck C': 'ℂ',
    'double-struck H': 'ℍ',
    'double-struck N': 'ℕ',
    'double-struck P': 'ℙ',
    'double-struck Q': 'ℚ',
    'double-struck R': 'ℝ',
    'double-struck Z': 'ℤ',
};

const STYLED = new Map<string, string>();
const PLAIN = new Map<string, readonly [string, MathVariant]>();
for (const [variant, alphabet, start] of BLOCKS) {
    for (const [index, char] of [...alphabet].entries()) {
        const key = `${variant} ${char}`;
        const styled = LETTERLIKE[key] ?? String.fromCodePoint(start + index);
        STYLED.set(key, styled);
        PLAIN.set(styled, [char, variant]);
    }
}

export function toAlphanumeric(char: string, variant: MathVariant): string | undefined {
    return STYLED.get(`${variant} ${char}`);
}

export function fromAlphanumeric(char: string): readonly [string, MathVariant] | undefined {
    return PLAIN.get(char);
}
