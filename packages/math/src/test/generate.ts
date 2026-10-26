import { ACCENTS, LARGE_OPERATORS, naryLimits } from '../notation';
import type { MathNode, MathRow } from '../tree';
import { defaultVariant, MATH_ENCLOSURES, MATH_SPACES, MATH_VARIANTS } from '../tree';
import { canonicalIssue } from './canonical';

// Seeded canonical trees for the round-trip contracts: every node kind and field, text that needs escaping, characters
// beyond the BMP. Skewed fractions, every brace character and every fence stay in: only LaTeX loses them.

export type Random = () => number;

// mulberry32: small, seedable, good enough to spread choices.
export function seeded(seed: number): Random {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Seeds 1 to `seeds` in chunks of 1,000, a test each, so no test nears bun's 5 s timeout under a full check's load.
export const seedChunks = (seeds: number): [number, number][] =>
    Array.from({ length: Math.ceil(seeds / 1000) }, (_, index) => [
        index * 1000 + 1,
        Math.min((index + 1) * 1000, seeds),
    ]);

export const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];

// Marked tokens and slashed relations too, as readers compose them: x\u0338 stays, = and U+0338 compose to ≠.
const LETTERS = ['x', 'y', 'Z', 'α', 'Ω', 'Γ', 'ж', 'ℏ', 'h', 'R', 'x\u0338', 'Γ\u0338'];
// A hyphen between the letters of an upright word is a hyphen, as \operatorname draws it.
const WORDS = ['sin', 'dx', 'lim', 'если', 'arg-max'];
const NUMBERS = ['0', '42', '3.14'];
// `&` stays out of an equations cell, where it is the cell break.
const OPERATORS = [
    '&',
    '#',
    '#\u0338',
    '+',
    '−',
    '=',
    '<',
    '>',
    '"',
    '(',
    ')',
    '[',
    '|',
    '{',
    '′',
    '∑',
    '∫',
    '‾',
    '_',
    '˙',
    '→',
    '/',
    '.',
    '∂',
    '∇',
    '≠',
    '≢',
    '⪯\u0338',
    '∑\u0338',
    '2\u0338',
    '′\u0338',
];
const TEXTS = ['if', 'a < b & c', ' edge ', 'x\u00A0y', ']]>', 'non-BMP 😀', 'javascript:alert(1)', '"quoted"'];
const COLORS = [undefined, undefined, undefined, '#FF0000', '#000000', '#0A0B0C'];
const FENCE_CHARS = ['(', ')', '[', ']', '{', '}', '|', '‖', '⟨', '⟩', '⌈', ''];
const BRACE_CHARS = ['⏞', '⏟', '⏜', '⏝', '→', '‾', '{'];
// U+0311 is no table accent: it is written as it is.
const ACCENT_CHARS = [...ACCENTS.keys(), '\u0311'];
const NARY_OPERATORS = [...LARGE_OPERATORS].filter((_, index) => index % 4 === 0).concat('⋆');

function token(random: Random): MathNode {
    const color = pick(random, COLORS);
    const variant = random() < 0.3 ? pick(random, MATH_VARIANTS) : undefined;
    switch (pick(random, ['letter', 'word', 'number', 'operator'] as const)) {
        case 'letter': {
            const text = pick(random, LETTERS);
            return {
                kind: 'identifier',
                text,
                variant: variant === defaultVariant('identifier', text) ? undefined : variant,
                color,
            };
        }
        case 'word':
            return { kind: 'identifier', text: pick(random, WORDS), color };
        case 'number':
            return {
                kind: 'number',
                text: pick(random, NUMBERS),
                variant: variant === 'normal' ? undefined : variant,
                color,
            };
        case 'operator':
            return {
                kind: 'operator',
                text: pick(random, OPERATORS),
                variant: variant === 'normal' ? undefined : variant,
                color,
            };
    }
}

function row(random: Random, depth: number, nonEmpty = false, equationCell = false): MathRow {
    const nodes: MathRow = [];
    const length = Math.floor(random() * 4) + (nonEmpty ? 1 : 0);
    while (nodes.length < length) {
        const next = node(random, depth);
        if (canonicalIssue([...nodes.slice(-2), next], equationCell) === undefined) nodes.push(next);
    }
    return nodes;
}

// Often one token: a base is where MathML's reader looks for a large operator.
function base(random: Random, depth: number): MathRow {
    return random() < 0.5 ? [token(random)] : row(random, depth);
}

function optional(random: Random, depth: number): MathRow | undefined {
    return random() < 0.5 ? row(random, depth, true) : undefined;
}

function node(random: Random, depth: number): MathNode {
    const leaf = depth >= 4 || random() < 0.5;
    const kind = leaf
        ? pick(random, ['token', 'token', 'token', 'text', 'space'] as const)
        : pick(random, [
              'fraction',
              'scripts',
              'radical',
              'nary',
              'fenced',
              'function',
              'accent',
              'line',
              'brace',
              'limit',
              'enclose',
              'table',
          ] as const);
    const inner = depth + 1;
    switch (kind) {
        case 'token':
            return token(random);
        case 'text':
            return { kind: 'text', text: pick(random, TEXTS), color: pick(random, COLORS) };
        case 'space':
            return { kind: 'space', width: pick(random, MATH_SPACES) };
        case 'fraction':
            return {
                kind: 'fraction',
                numerator: row(random, inner),
                denominator: row(random, inner),
                line: pick(random, ['bar', 'none', 'skewed'] as const),
            };
        case 'scripts': {
            const sub = optional(random, inner);
            const sup = sub ? optional(random, inner) : row(random, inner, true);
            return { kind: 'scripts', base: base(random, inner), sub, sup, pre: random() < 0.3 ? true : undefined };
        }
        case 'radical':
            return { kind: 'radical', body: row(random, inner), degree: optional(random, inner) };
        case 'nary': {
            const operator = pick(random, NARY_OPERATORS);
            const sub = optional(random, inner);
            const sup = optional(random, inner);
            const limits = sub || sup ? pick(random, ['under', 'side'] as const) : naryLimits(operator);
            return { kind: 'nary', operator, limits, sub, sup, body: row(random, inner) };
        }
        case 'fenced': {
            const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => row(random, inner));
            const separator = parts.length > 1 ? pick(random, ['|', ',', '', '│']) : '';
            return {
                kind: 'fenced',
                open: pick(random, FENCE_CHARS),
                close: pick(random, FENCE_CHARS),
                separator,
                parts,
            };
        }
        case 'function':
            return { kind: 'function', name: row(random, inner), body: row(random, inner) };
        case 'accent':
            return { kind: 'accent', accent: pick(random, ACCENT_CHARS), body: base(random, inner) };
        case 'line':
            return { kind: 'line', position: pick(random, ['over', 'under'] as const), body: base(random, inner) };
        case 'brace':
            return {
                kind: 'brace',
                char: pick(random, BRACE_CHARS),
                position: pick(random, ['over', 'under'] as const),
                body: base(random, inner),
            };
        case 'limit':
            return {
                kind: 'limit',
                position: pick(random, ['over', 'under'] as const),
                base: base(random, inner),
                limit: row(random, inner),
            };
        case 'enclose':
            return {
                kind: 'enclose',
                notation: MATH_ENCLOSURES.filter(() => random() < 0.5),
                body: row(random, inner),
            };
        case 'table': {
            const layout = pick(random, ['matrix', 'equations'] as const);
            const columns = 1 + Math.floor(random() * 3);
            const rows = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
                Array.from({ length: columns }, () => row(random, inner, false, layout === 'equations')),
            );
            return { kind: 'table', layout, rows };
        }
    }
}

export function generateTree(seed: number): MathRow {
    // Through JSON, so absent fields are absent rather than undefined, as a reader leaves them.
    return JSON.parse(JSON.stringify(row(seeded(seed), 1)));
}
