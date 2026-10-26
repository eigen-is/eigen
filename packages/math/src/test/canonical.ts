import { ACCENTS, COMBINING_ACCENTS, fromAlphanumeric, naryLimits, SCRIPT_CHARS, SPACES } from '../notation';
import type { MathNode, MathRow, MathToken } from '../tree';
import { MATH_ENCLOSURES, MATH_LIMITS } from '../tree';

// The canonical tree as a check: the first rule a row breaks, or undefined. Every reader's output and every generated
// tree must pass it. It restates the readers' character classes rather than importing them, so a wrong class in a
// reader can't pass its own yardstick.

const COLOR = /^#[0-9A-F]{6}$/;
const SPACE_TEXTS = new Set([...Object.values(SPACES).map((space) => space.text), '\u00A0', '\t', '\n', '\r']);
const INVISIBLE = /[\u200B\u2061-\u2064]|\uFE0E|\uFE0F/u;
const NOT_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

const isLetter = (char: string) => /^\p{L}$/u.test(char);
const startsWithLetter = (cluster: string | undefined) => cluster !== undefined && isLetter([...cluster][0]);
// Each character with the combining marks it keeps.
const clustersOf = (text: string) => text.match(/\P{M}\p{M}*/gu) ?? [];
const isMarked = (text: string) => /\p{M}/u.test(text);
// A capital Greek letter stands upright by default, as TeX and Word draw it.
const UPRIGHT_LETTER = /^[\u0391-\u03A9\u03F4]\p{M}*$/u;
const uprightByDefault = (text: string) => clustersOf(text).length > 1 || UPRIGHT_LETTER.test(text);
function isUpright(node: MathNode): node is MathToken {
    return node.kind === 'identifier' && (node.variant === 'normal' || (!node.variant && uprightByDefault(node.text)));
}

// One character a fence, accent, brace or large operator may hold.
function isMark(char: string): boolean {
    return [...char].length === 1 && !/[ \t\n\r]/.test(char) && !INVISIBLE.test(char) && !NOT_XML.test(char);
}

function sameStyle(a: MathToken, b: MathToken): boolean {
    return a.variant === b.variant && a.color === b.color;
}

function tokenIssue(node: MathToken): string | undefined {
    const clusters = clustersOf(node.text);
    const [first] = node.text;
    if (node.color !== undefined && !COLOR.test(node.color)) return `colour ${node.color}`;
    if ([...node.text].some((char) => fromAlphanumeric(char))) return `alphanumeric in ${node.text}`;
    if (clusters.join('') !== node.text || INVISIBLE.test(node.text)) return `a mark on nothing in ${node.text}`;
    // A mark from the accent table makes an accent; any other stays, composed where Unicode composes it.
    for (const cluster of clusters.filter(isMarked)) {
        if ([...cluster].some((char) => ACCENTS.has(char))) return `an accent mark in ${node.text}`;
        if (cluster.normalize('NFC') !== cluster) return `uncomposed ${node.text}`;
        if ([...cluster].length > MATH_LIMITS.marks + 1) return `more than ${MATH_LIMITS.marks} marks in ${node.text}`;
    }
    switch (node.kind) {
        case 'identifier':
            // A word's hyphen stands between two letters, as \operatorname draws one.
            if (
                clusters.length === 0 ||
                !clusters.every(
                    (cluster, index) =>
                        startsWithLetter(cluster) ||
                        (cluster === '-' &&
                            startsWithLetter(clusters[index - 1]) &&
                            startsWithLetter(clusters[index + 1])),
                )
            )
                return `identifier ${node.text}`;
            if (clusters.length > 1 && (node.variant || isMarked(node.text)))
                return `styled or marked word ${node.text}`;
            return node.variant === (UPRIGHT_LETTER.test(node.text) ? 'normal' : 'italic')
                ? `default variant on ${node.text}`
                : undefined;
        case 'number':
            if (!/^[0-9]+(\.[0-9]+)?$/.test(node.text)) return `number ${node.text}`;
            return node.variant === 'normal' ? `default variant on ${node.text}` : undefined;
        case 'operator':
            if (
                clusters.length !== 1 ||
                !isMark(first) ||
                isLetter(first) ||
                SPACE_TEXTS.has(first) ||
                SCRIPT_CHARS.has(node.text) ||
                // The minus sign is U+2212.
                first === '-' ||
                (/[0-9]/.test(first) && !isMarked(node.text))
            )
                return `operator ${JSON.stringify(node.text)}`;
            return node.variant === 'normal' ? `default variant on ${node.text}` : undefined;
    }
}

// Neighbours a reader would have read as one node.
function mergeIssue(row: MathRow, index: number): string | undefined {
    const [before, previous, node] = [row[index - 2], row[index - 1], row[index]];
    if (!previous) return undefined;
    if (node.kind === 'text' && previous.kind === 'text' && node.color === previous.color) return 'adjacent text';
    // Em spaces pair up from the left: a quad before another quad or a qquad reads as a qquad first.
    if (node.kind === 'space' && previous.kind === 'space' && previous.width === 'quad' && node.width.endsWith('quad'))
        return 'a quad before a quad';
    if (node.kind === 'number' && previous.kind === 'number' && sameStyle(node, previous)) return 'adjacent numbers';
    if (
        isUpright(node) &&
        isUpright(previous) &&
        node.color === previous.color &&
        !isMarked(node.text) &&
        !isMarked(previous.text)
    )
        return 'adjacent upright letters';
    if (
        before?.kind === 'number' &&
        !before.text.includes('.') &&
        previous.kind === 'operator' &&
        previous.text === '.' &&
        node.kind === 'number' &&
        sameStyle(before, previous) &&
        sameStyle(previous, node)
    )
        return 'a decimal point between numbers';
    return undefined;
}

function optionalIssue(row: MathRow | undefined): string | undefined {
    if (row === undefined) return undefined;
    return row.length === 0 ? 'an empty optional slot' : canonicalIssue(row);
}

function nodeIssue(node: MathNode): string | undefined {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator':
            return tokenIssue(node);
        case 'text':
            if (node.color !== undefined && !COLOR.test(node.color)) return `colour ${node.color}`;
            if (node.text === '' || NOT_XML.test(node.text) || /[\t\n\r]/.test(node.text))
                return `text ${JSON.stringify(node.text)}`;
            return /^[ \u00A0]*\u00A0|\u00A0[ \u00A0]*$/.test(node.text)
                ? 'a no-break space at the edge of text'
                : undefined;
        case 'space':
            return node.width in SPACES ? undefined : `space ${node.width}`;
        case 'fraction':
            return canonicalIssue(node.numerator) ?? canonicalIssue(node.denominator);
        case 'scripts':
            if (!node.sub && !node.sup) return 'scripts without a script';
            return canonicalIssue(node.base) ?? optionalIssue(node.sub) ?? optionalIssue(node.sup);
        case 'radical':
            return canonicalIssue(node.body) ?? optionalIssue(node.degree);
        case 'nary':
            if (!isMark(node.operator)) return `nary ${node.operator}`;
            if (!node.sub && !node.sup && node.limits !== naryLimits(node.operator)) return 'limits without scripts';
            return optionalIssue(node.sub) ?? optionalIssue(node.sup) ?? canonicalIssue(node.body);
        case 'fenced':
            if ([node.open, node.close].some((char) => char !== '' && !isMark(char))) return 'fence';
            if (node.parts.length === 0) return 'fenced without parts';
            if (node.parts.length === 1 ? node.separator !== '' : node.separator !== '' && !isMark(node.separator))
                return `separator ${node.separator}`;
            return node.parts.map((part) => canonicalIssue(part)).find(Boolean);
        case 'function':
            return canonicalIssue(node.name) ?? canonicalIssue(node.body);
        case 'accent':
            if (!isMark(node.accent) || COMBINING_ACCENTS.has(node.accent)) return `accent ${node.accent}`;
            return canonicalIssue(node.body);
        case 'line':
            return canonicalIssue(node.body);
        case 'brace':
            return isMark(node.char) ? canonicalIssue(node.body) : `brace ${node.char}`;
        case 'limit':
            return canonicalIssue(node.base) ?? canonicalIssue(node.limit);
        case 'enclose':
            if (MATH_ENCLOSURES.filter((side) => node.notation.includes(side)).join() !== node.notation.join())
                return `notation ${node.notation}`;
            return canonicalIssue(node.body);
        case 'table':
            if (node.rows.length === 0) return 'a table without rows';
            for (const cells of node.rows) {
                if (cells.length === 0) return 'a row without cells';
                const issue = cells.map((cell) => canonicalIssue(cell, node.layout === 'equations')).find(Boolean);
                if (issue) return issue;
            }
            return undefined;
    }
}

export function canonicalIssue(row: MathRow, equationCell = false): string | undefined {
    for (const [index, node] of row.entries()) {
        if (equationCell && node.kind === 'operator' && node.text === '&') return '& in an equation cell';
        const issue = nodeIssue(node) ?? mergeIssue(row, index);
        if (issue) return issue;
    }
    return undefined;
}
