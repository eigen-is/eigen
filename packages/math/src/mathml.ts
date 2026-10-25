// readMathml and writeMathml: MathML, the form an equation is stored and drawn in. The writer marks what its own reader
// needs to find the tree again, such as a large operator's body, and may carry the typed LaTeX as an annotation, which
// readMathmlLatex hands back. The reader reads that dialect first, then the MathML other tools paste, such as KaTeX's
// or MathJax's, as the picture it draws.

import { MathError } from './error';
import {
    ACCENTS,
    COLOR_NAMES,
    COMBINING_ACCENTS,
    FENCES,
    isNoLine,
    LARGE_OPERATORS,
    LINES,
    MINUS,
    naryLimits,
    SPACES,
    toAlphanumeric,
} from './notation';
import type { MathBudget, MathEnclosure, MathNode, MathRow, MathSpace, MathToken, MathVariant, RowSlot } from './tree';
import {
    bound,
    casesOf,
    defaultVariant,
    equationCells,
    hexColor,
    isCluster,
    MATH_ENCLOSURES,
    MATH_LIMITS,
    MATH_SPACES,
    MATH_VARIANTS,
    mark,
    optional,
    RowBuilder,
} from './tree';
import type { MathXmlElement } from './xml';
import { attribute, checkedXml, elementsOf, escapeXml, replaceEdges, textOf, trimXmlSpace } from './xml';

export const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const TEX = 'application/x-tex';
const FUNCTION_APPLICATION = '\u2061';

// Which children of a script element are the sub- and superscript.
const SCRIPT_SLOTS: ReadonlyMap<string, readonly ('sub' | 'sup')[]> = new Map([
    ['msub', ['sub']],
    ['munder', ['sub']],
    ['msup', ['sup']],
    ['mover', ['sup']],
    ['msubsup', ['sub', 'sup']],
    ['munderover', ['sub', 'sup']],
]);

const SPACE: ReadonlySet<string> = new Set(' ');

// The lines a line reads from: KaTeX writes \underline with U+203E, MathJax both with U+2015.
const LINE_CHARS = {
    over: new Set([LINES.over, '―']),
    under: new Set([LINES.under, LINES.over, '―']),
} as const;

// Braces MathML's operator dictionary stretches, so MathJax doesn't mark them.
const BRACES: ReadonlySet<string> = new Set('⏜⏝⏞⏟⎴⎵');

// MathML's other notations as the lines nearest them.
const BOX: readonly MathEnclosure[] = ['top', 'bottom', 'left', 'right'];
const NOTATIONS: ReadonlyMap<string, readonly MathEnclosure[]> = new Map([
    ['box', BOX],
    ['roundedbox', BOX],
    ['circle', BOX],
    ['actuarial', ['top', 'right']],
    ['madruwb', ['right', 'bottom']],
    ['longdiv', ['left', 'top']],
]);

// ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────────

// What an element hands the tokens in it: its own mathvariant and mathcolor, else its parent's, as mstyle does.
type Scope = { budget: MathBudget; variant?: MathVariant; color?: string };

// MathML has no n-ary or function: a scripted large operator, or a name before U+2061, waits for the next element. A
// chain waits as one, as \sum_i \sin x does: each link after the first is written `into` the body of the one before.
type Waiting = { kind: 'nary' | 'function'; element: MathXmlElement; scope: Scope; depth: number; into?: RowBuilder };

// An HTML DOM may put math in the XHTML namespace or none, with its prefix (mml:mi) in the local name.
function nameOf(element: MathXmlElement | undefined): string | undefined {
    if (!element) return undefined;
    if (element.ns === MATHML_NAMESPACE) return element.local;
    if (element.ns !== XHTML_NAMESPACE && element.ns !== '') return undefined;
    return element.local.slice(element.local.indexOf(':') + 1);
}

function is(element: MathXmlElement | undefined, local: string): element is MathXmlElement {
    return nameOf(element) === local;
}

const isFlagged = (element: MathXmlElement | undefined, flag: string) =>
    is(element, 'mo') && attribute(element, flag) === 'true';

// Temml writes unstretched parentheses as fences too: a fence stretches.
const isFence = (element: MathXmlElement | undefined) =>
    is(element, 'mo') && attribute(element, 'fence') === 'true' && attribute(element, 'stretchy') !== 'false';

// MathJax marks \left … \right by TeX class, not as fences.
const isClassed = (element: MathXmlElement | undefined, texClass: string) =>
    is(element, 'mo') && attribute(element, 'data-mjx-texclass') === texClass;

const isApplication = (element: MathXmlElement | undefined) =>
    is(element, 'mo') && trimXmlSpace(textOf(element)) === FUNCTION_APPLICATION;

// A colour is #RRGGBB, #RGB or a CSS name; anything else is none, so a forged one reaches no writer.
function colorOf(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const hex = /^#[0-9A-Fa-f]{3}$/.test(value) ? value.replace(/[0-9A-Fa-f]/g, '$&$&') : value;
    return hexColor(hex) ?? COLOR_NAMES.get(value.toLowerCase());
}

function scopeOf(element: MathXmlElement, scope: Scope): Scope {
    const mathvariant = attribute(element, 'mathvariant');
    const variant = MATH_VARIANTS.find((candidate) => candidate === mathvariant) ?? scope.variant;
    const color = colorOf(attribute(element, 'mathcolor')) ?? scope.color;
    return variant === scope.variant && color === scope.color ? scope : { ...scope, variant, color };
}

// The space nearest a width: KaTeX writes a thin space 0.1667em, MathJax 0.167em.
function spaceOf(width = ''): MathSpace | undefined {
    const em = width.endsWith('em') ? Number(width.slice(0, -2)) : Number.NaN;
    return MATH_SPACES.find((space) => Math.abs(Number.parseFloat(SPACES[space].width) - em) < 0.01);
}

const baseOf = (element: MathXmlElement | undefined) =>
    element && SCRIPT_SLOTS.has(nameOf(element) ?? '') ? elementsOf(element)[0] : undefined;

// MathJax and Temml leave accent and stretchy to the operator dictionary; Eigen wraps a limit's lone operator.
function decorationOf(element: MathXmlElement | undefined): ((body: MathRow) => MathNode) | undefined {
    const position = is(element, 'mover') ? 'over' : is(element, 'munder') ? 'under' : undefined;
    const script = element && elementsOf(element)[1];
    if (!element || !position || !is(script, 'mo')) return undefined;
    const text = trimXmlSpace(textOf(script));
    const char = mark(text);
    if (!char) return undefined;
    const said = attribute(element, position === 'over' ? 'accent' : 'accentunder') ?? attribute(script, 'accent');
    const stretchy = attribute(script, 'stretchy');
    const dictionary = said === undefined && char === text;
    if (said === 'true' && LINE_CHARS[position].has(char)) return (body) => ({ kind: 'line', position, body });
    const accent =
        said === 'true' || (dictionary && stretchy !== 'true' && (COMBINING_ACCENTS.has(char) || ACCENTS.has(char)));
    if (accent && position === 'over')
        return (body) => ({ kind: 'accent', accent: COMBINING_ACCENTS.get(char) ?? char, body });
    if (stretchy === 'true' || (dictionary && stretchy === undefined && BRACES.has(char)))
        return (body) => ({ kind: 'brace', char, position, body });
    return undefined;
}

// A large operator: one character marked largeop, or one from the table under scripts that are no accent, line or
// brace. A mark after it makes a symbol of its own, such as ∑̸.
function isLargeOperator(element: MathXmlElement | undefined): boolean {
    const base = baseOf(element);
    const operator = base ?? element;
    if (!is(operator, 'mo')) return false;
    const text = trimXmlSpace(textOf(operator));
    const char = mark(text);
    return (
        char !== '' &&
        char === text &&
        (isFlagged(operator, 'largeop') || (base !== undefined && LARGE_OPERATORS.has(char) && !decorationOf(element)))
    );
}

// (a)+(b) with every parenthesis a fence is no fenced row: the fences between the first and the last balance.
function isBalanced(children: MathXmlElement[]): boolean {
    let open = 0;
    for (const child of children.slice(1, -1)) {
        if (!isFence(child)) continue;
        const char = mark(textOf(child));
        if (/\p{Ps}/u.test(char)) open++;
        if (/\p{Pe}/u.test(char)) open--;
        if (open < 0) return false;
    }
    return true;
}

// Eigen's n-ary (its operator marked largeop, then its body), a fenced row or a function (name, U+2061, body).
function patternOf(mrow: MathXmlElement): 'nary' | 'fenced' | 'function' | undefined {
    const children = elementsOf(mrow);
    const [first] = children;
    const last = children.at(-1);
    if (isLargeOperator(first) && isFlagged(baseOf(first) ?? first, 'largeop')) return 'nary';
    const mathjax =
        attribute(mrow, 'data-mjx-texclass') === 'INNER' && isClassed(first, 'OPEN') && isClassed(last, 'CLOSE');
    if (children.length >= 2 && ((isFence(first) && isFence(last) && isBalanced(children)) || mathjax)) return 'fenced';
    // Temml spaces a name from its body inside the name's mrow: that space is no body.
    if (children.length === 3 && isApplication(children[1]) && !is(children[2], 'mspace')) return 'function';
    return undefined;
}

// An operator or a space after a function name or n-ary is no body; Temml wraps unstretched parentheses in an mrow.
function leadsWithOperator(element: MathXmlElement): boolean {
    let first: MathXmlElement | undefined = element;
    for (let level = 0; level < MATH_LIMITS.depth && is(first, 'mrow') && !patternOf(first); level++)
        first = elementsOf(first)[0];
    return is(first, 'mo') || is(first, 'mspace');
}

// KaTeX puts the U+2061 after \lim inside the base of its limit.
function isFunctionName(element: MathXmlElement, next: MathXmlElement | undefined): boolean {
    if (isApplication(next)) return true;
    const base = baseOf(element);
    return is(base, 'mrow') && isApplication(elementsOf(base).at(-1));
}

function readRow(elements: MathXmlElement[], scope: Scope, depth: number, slot?: RowSlot): MathRow {
    const row = new RowBuilder(scope.budget, depth, slot);
    settle(row, readElements(row, elements, depth, scope));
    return row.done();
}

// An argument is one element; a plain mrow there is the row itself, not a level of its own. So is math, an mrow too.
function argumentOf(element: MathXmlElement | undefined, scope: Scope): [MathXmlElement[], Scope] {
    if (element && (is(element, 'mrow') || is(element, 'math')) && !patternOf(element))
        return [elementsOf(element), scopeOf(element, scope)];
    return [element ? [element] : [], scope];
}

function readArgument(element: MathXmlElement | undefined, scope: Scope, depth: number, slot?: RowSlot): MathRow {
    const [elements, inner] = argumentOf(element, scope);
    return readRow(elements, inner, depth, slot);
}

// Content that reads as if it stood in the row itself: a level deeper and a part, so deep or many wrappers meet the
// bounds.
function readThrough(row: RowBuilder, elements: MathXmlElement[], depth: number, scope: Scope): Waiting[] {
    bound(scope.budget, depth, 1);
    return readElements(row, elements, depth, scope);
}

// What waits at the end waits for the element after the wrapper only when it is all the wrapper holds, as Temml wraps
// \sum_i and \sin: a TeX group, {a+\sum_i}, ends the n-ary in it.
function readElements(row: RowBuilder, elements: MathXmlElement[], depth: number, scope: Scope): Waiting[] {
    let waiting: Waiting[] = [];
    let start = 0;
    for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        if (waiting.length > 0 && leadsWithOperator(element)) {
            settle(row, waiting);
            waiting = [];
        }
        if (waiting.length === 0) start = index;
        // A link of a chain sits in the body of the one before it, a level deeper.
        const last = waiting.at(-1);
        const level = last ? last.depth + 1 : depth;
        if (isFunctionName(element, elements[index + 1])) {
            const into = last && new RowBuilder(scope.budget, level);
            waiting.push({ kind: 'function', element, scope, depth: level, into });
            if (!isApplication(elements[index + 1])) continue;
            index++;
            // Temml spaces the name from its body with a thin space of its own width; a space typed there stays.
            const space = elements[index + 1];
            if (is(space, 'mspace') && attribute(space, 'width') === '0.1667em') index++;
            continue;
        }
        if (!last) {
            waiting = readInto(row, element, depth, scope) ?? [];
            continue;
        }
        // The body, or the first link of a chain that waits in it.
        const [body, inner] = argumentOf(element, scope);
        const into = new RowBuilder(scope.budget, level);
        const [first, ...rest] = readElements(into, body, level, inner);
        if (first) {
            waiting.push({ ...first, into }, ...rest);
            continue;
        }
        settle(row, waiting, into.done());
        waiting = [];
    }
    if (start === 0) return waiting;
    settle(row, waiting);
    return [];
}

// The last link takes the body, or none, and is the body of the link before it. An n-ary without a body takes an empty
// one; a function name without one reads as it is.
function settle(row: RowBuilder, chain: Waiting[] = [], body?: MathRow): void {
    let next = body;
    for (const link of chain.toReversed()) {
        const { element, scope, depth, into = row } = link;
        if (link.kind === 'nary') {
            into.node(readNary(element, scope, depth, next ?? readRow([], scope, depth + 1)));
        } else if (next) {
            into.node({ kind: 'function', name: readArgument(element, scope, depth + 1), body: next });
        } else {
            settle(into, readInto(into, element, depth, scope));
        }
        next = link.into?.done();
    }
}

function readScripts(
    children: MathXmlElement[],
    slots: readonly ('sub' | 'sup')[],
    scope: Scope,
    depth: number,
): { sub?: MathRow; sup?: MathRow } {
    const scripts: { sub?: MathRow; sup?: MathRow } = {};
    for (const [index, slot] of slots.entries()) {
        if (is(children[index], 'none')) continue;
        const script = optional(readArgument(children[index], scope, depth, 'optional'));
        if (script) scripts[slot] = script;
    }
    return scripts;
}

const PAIR: readonly ('sub' | 'sup')[] = ['sub', 'sup'];

// A script element's base and its scripts, then each further pair of mmultiscripts' on an empty base. Without scripts
// the element reads as its base.
function readPostscripts(
    row: RowBuilder,
    children: MathXmlElement[],
    slots: readonly ('sub' | 'sup')[],
    scope: Scope,
    depth: number,
): Waiting[] | undefined {
    const [base, ...scripts] = children;
    let waiting: Waiting[] | undefined;
    let index = 0;
    do {
        const { sub, sup } = readScripts(scripts.slice(index, index + slots.length), slots, scope, depth + 1);
        if (sub || sup) {
            settle(row, waiting);
            waiting = undefined;
            const on = index === 0 ? readArgument(base, scope, depth + 1) : readRow([], scope, depth + 1);
            row.node({ kind: 'scripts', base: on, ...(sub && { sub }), ...(sup && { sup }) });
        } else if (index === 0) waiting = readThrough(row, base ? [base] : [], depth + 1, scope);
        // An empty pair after the first makes nothing, and counts as a part all the same.
        else bound(scope.budget, depth, 1);
        index += slots.length;
    } while (slots.length > 0 && index < scripts.length);
    return waiting;
}

function readNary(scripted: MathXmlElement, outer: Scope, depth: number, body: MathRow): MathNode {
    const scope = scopeOf(scripted, outer);
    const name = nameOf(scripted) ?? '';
    const slots = SCRIPT_SLOTS.get(name) ?? [];
    const [operatorElement, ...scripts] = slots.length > 0 ? elementsOf(scripted) : [scripted];
    const operator = mark(textOf(operatorElement));
    const { sub, sup } = readScripts(scripts, slots, scope, depth + 1);
    const under = ['munder', 'mover', 'munderover'].includes(name);
    const limits = sub || sup ? (under ? 'under' : 'side') : naryLimits(operator);
    return { kind: 'nary', operator, limits, ...(sub && { sub }), ...(sup && { sup }), body };
}

function readPattern(mrow: MathXmlElement, scope: Scope, depth: number): MathNode | undefined {
    const children = elementsOf(mrow);
    switch (patternOf(mrow)) {
        case 'nary': {
            const [scripted, ...body] = children;
            return readNary(scripted, scope, depth, readRow(body, scope, depth + 1));
        }
        case 'fenced': {
            const parts: MathXmlElement[][] = [[]];
            let separator = '';
            for (const child of children.slice(1, -1)) {
                if (!isFlagged(child, 'separator')) {
                    parts[parts.length - 1].push(child);
                    continue;
                }
                if (parts.length === 1) separator = mark(textOf(child));
                parts.push([]);
            }
            return {
                kind: 'fenced',
                open: mark(textOf(children[0])),
                close: mark(textOf(children[children.length - 1])),
                separator: parts.length > 1 ? separator : '',
                parts: parts.map((part) => readRow(part, scope, depth + 1)),
            };
        }
        case 'function':
            return {
                kind: 'function',
                name: readArgument(children[0], scope, depth + 1),
                body: readArgument(children[2], scope, depth + 1),
            };
        case undefined:
            return;
    }
}

function readToken(row: RowBuilder, text: string, name: string, scope: Scope): void {
    const { variant, color } = scope;
    // MathML draws a lone letter in an mi italic and anything else upright.
    const lone = name === 'mi' && isCluster(text);
    // A hyphen-minus in an mo is the minus sign; in an mi it may join a word, as in arg-max.
    const chars = name === 'mo' ? text.replaceAll('-', MINUS) : text;
    row.chars(chars, variant ?? (lone ? 'italic' : 'normal'), variant ?? 'normal', color);
}

function readInto(row: RowBuilder, element: MathXmlElement, depth: number, outer: Scope): Waiting[] | undefined {
    const scope = scopeOf(element, outer);
    const { budget } = scope;
    const children = elementsOf(element);
    const argument = (index: number) => readArgument(children[index], scope, depth + 1);
    const name = nameOf(element);
    // An element that makes nothing counts as a part, so no number of them goes unbounded.
    const empty = () => bound(budget, depth, 1);
    if (baseOf(element) && isLargeOperator(element)) return [{ kind: 'nary', element, scope: outer, depth }];
    switch (name) {
        case 'mi':
        case 'mn':
        case 'mo': {
            const text = trimXmlSpace(textOf(element));
            if (text === '') empty();
            else readToken(row, text, name, scope);
            return;
        }
        // MathML Core draws a string literal without the quotes MathML 3 put around it.
        case 'ms':
        case 'mtext': {
            const text = trimXmlSpace(textOf(element));
            if (text === '') empty();
            else row.text(text, scope.color);
            return;
        }
        case 'mspace': {
            const space = spaceOf(attribute(element, 'width'));
            // As characters, so two quads pair as they do in text.
            if (space) row.chars(SPACES[space].text, 'normal', 'normal', undefined);
            else empty();
            return;
        }
        case 'math':
        case 'mrow': {
            const node = readPattern(element, scope, depth);
            if (!node) return readThrough(row, children, depth + 1, scope);
            row.node(node);
            return;
        }
        // Deprecated, but Word for the web and OMML2MML write it. The tree holds one separator: the first stands for
        // all.
        case 'mfenced': {
            const separator = mark(attribute(element, 'separators') ?? ',');
            const parts =
                separator && children.length > 1
                    ? children.map((child) => readArgument(child, scope, depth + 1))
                    : [readRow(children, scope, depth + 1)];
            row.node({
                kind: 'fenced',
                open: mark(attribute(element, 'open') ?? '('),
                close: mark(attribute(element, 'close') ?? ')'),
                separator: parts.length > 1 ? separator : '',
                parts,
            });
            return;
        }
        case 'mfrac': {
            const line =
                attribute(element, 'bevelled') === 'true'
                    ? 'skewed'
                    : isNoLine(attribute(element, 'linethickness') ?? '')
                      ? 'none'
                      : 'bar';
            row.node({ kind: 'fraction', numerator: argument(0), denominator: argument(1), line });
            return;
        }
        case 'msqrt':
            row.node({ kind: 'radical', body: readRow(children, scope, depth + 1) });
            return;
        case 'mroot': {
            const degree = optional(readArgument(children[1], scope, depth + 1, 'optional'));
            row.node({ kind: 'radical', body: argument(0), ...(degree && { degree }) });
            return;
        }
        case 'msub':
        case 'msup':
        case 'msubsup': {
            const slots = SCRIPT_SLOTS.get(name) ?? [];
            return readPostscripts(row, children.slice(0, 1 + slots.length), slots, scope, depth);
        }
        // The prescripts' base is the base with its postscripts.
        case 'mmultiscripts': {
            const at = children.findIndex((child) => is(child, 'mprescripts'));
            if (at < 0) return readPostscripts(row, children, PAIR, scope, depth);
            const postscripts = children.slice(0, at);
            const { sub, sup } = readScripts(children.slice(at + 1), PAIR, scope, depth + 1);
            if (!sub && !sup) return readPostscripts(row, postscripts, PAIR, scope, depth);
            let base: MathRow;
            if (postscripts.length > 1) {
                const builder = new RowBuilder(budget, depth + 1);
                settle(builder, readPostscripts(builder, postscripts, PAIR, scope, depth + 1));
                base = builder.done();
            } else base = readArgument(postscripts[0], scope, depth + 1);
            row.node({ kind: 'scripts', base, ...(sub && { sub }), ...(sup && { sup }), pre: true });
            return;
        }
        case 'mover':
        case 'munder': {
            const decorate = decorationOf(element);
            const position = name === 'mover' ? 'over' : 'under';
            row.node(
                decorate ? decorate(argument(0)) : { kind: 'limit', position, base: argument(0), limit: argument(1) },
            );
            return;
        }
        // Outside an n-ary: a limit under inside a limit over.
        case 'munderover': {
            const base = new RowBuilder(budget, depth + 1);
            base.node({
                kind: 'limit',
                position: 'under',
                base: readArgument(children[0], scope, depth + 2),
                limit: readArgument(children[1], scope, depth + 2),
            });
            row.node({ kind: 'limit', position: 'over', base: base.done(), limit: argument(2) });
            return;
        }
        case 'menclose': {
            const notation = (attribute(element, 'notation') ?? '')
                .split(/\s+/)
                .flatMap((value): readonly string[] => NOTATIONS.get(value) ?? [value]);
            row.node({
                kind: 'enclose',
                notation: MATH_ENCLOSURES.filter((enclosure) => notation.includes(enclosure)),
                body: readRow(children, scope, depth + 1),
            });
            return;
        }
        case 'mtable': {
            const layout = attribute(element, 'displaystyle') === 'true' ? 'equations' : 'matrix';
            const rows = children
                .filter((tableRow) => is(tableRow, 'mtr'))
                .map((tableRow) => elementsOf(tableRow).filter((cell) => is(cell, 'mtd')));
            // OMML has no empty table or row: each reads as one empty cell.
            const tableRows = (rows.length > 0 ? rows : [[]]).map((cells) => {
                bound(budget, depth + 1, 1);
                const read = (cells.length > 0 ? cells.map(elementsOf) : [[]]).map((cell) =>
                    readRow(cell, scope, depth + 1, layout === 'equations' ? 'equation' : 'required'),
                );
                return layout === 'equations' ? read.flatMap(equationCells) : read;
            });
            row.node({ kind: 'table', layout, rows: tableRows });
            return;
        }
        // The child shown, counted from 1.
        case 'maction': {
            const shown = children[Number(attribute(element, 'selection') ?? 1) - 1] ?? children[0];
            return readThrough(row, shown ? [shown] : [], depth + 1, scope);
        }
        case 'semantics':
            return readThrough(row, children.slice(0, 1), depth + 1, scope);
        case 'annotation':
        case 'annotation-xml':
        case 'none':
        case 'mprescripts':
            empty();
            return;
        // mstyle, mpadded, mphantom (the tree has no phantom: it shows) and anything unknown.
        default:
            return readThrough(row, children, depth + 1, scope);
    }
}

// A semantics carries the equation's LaTeX only when it is the whole equation.
function semanticsOf(math: MathXmlElement): MathXmlElement | undefined {
    const elements = elementsOf(math);
    return elements.length === 1 && is(elements[0], 'semantics') ? elements[0] : undefined;
}

// Apart from the tree, so an equation whose tree is past a bound can still show its LaTeX.
export function readMathmlLatex(math: MathXmlElement): string | undefined {
    const semantics = semanticsOf(math);
    const tex =
        semantics &&
        elementsOf(semantics)
            .slice(1)
            .find((annotation) => is(annotation, 'annotation') && attribute(annotation, 'encoding') === TEX);
    return tex && checkedXml(textOf(tex));
}

// The tree alone: readMathmlLatex reads the annotation, so one it refuses never costs the tree.
export function readMathml(math: MathXmlElement): MathRow {
    const semantics = semanticsOf(math);
    const scope = scopeOf(math, { budget: { size: 0 } });
    return readArgument(semantics ? elementsOf(semantics)[0] : math, scope, 1);
}

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

const colorAttribute = (color: string | undefined) => {
    const hex = hexColor(color);
    return hex ? ` mathcolor="${escapeXml(hex)}"` : '';
};

function writeToken(node: MathToken): string {
    const tag = node.kind === 'identifier' ? 'mi' : node.kind === 'number' ? 'mn' : 'mo';
    // MathML draws a lone letter italic, so an upright one says so.
    const upright =
        node.kind === 'identifier' && isCluster(node.text) && defaultVariant(node.kind, node.text) === 'normal';
    const variant = node.variant ?? (upright ? 'normal' : undefined);
    // Chrome draws Unicode's alphanumerics but honours only mathvariant="normal": a variant is a character where
    // Unicode has one.
    const styled = variant && [...node.text].map((char) => toAlphanumeric(char, variant));
    const alphanumeric = styled && !styled.includes(undefined) ? styled.join('') : undefined;
    const mathvariant = variant && !alphanumeric ? ` mathvariant="${escapeXml(variant)}"` : '';
    // A bare fence would stretch around a tall neighbour, as only a fenced row should.
    const stretchy = node.kind === 'operator' && FENCES.has(node.text) ? ' stretchy="false"' : '';
    return `<${tag}${mathvariant}${colorAttribute(node.color)}${stretchy}>${escapeXml(alphanumeric ?? node.text)}</${tag}>`;
}

const writeRow = (row: MathRow) => row.map(writeNode).join('');

const wrap = (row: MathRow) => `<mrow>${writeRow(row)}</mrow>`;

const writeArgument = (row: MathRow) => (row.length === 1 ? writeNode(row[0]) : wrap(row));

// A large operator alone in a base is wrapped, so a reader never takes its scripts, limit, accent, line or brace for an
// n-ary.
function writeBase(row: MathRow): string {
    const [single] = row;
    const bare = row.length === 1 && single.kind === 'operator' && LARGE_OPERATORS.has(single.text);
    return bare ? wrap(row) : writeArgument(row);
}

function writeScripts(tag: string, base: string, node: { sub?: MathRow; sup?: MathRow }): string {
    const sub = node.sub ? writeArgument(node.sub) : '';
    const sup = node.sup ? writeArgument(node.sup) : '';
    return `<${tag}>${base}${sub}${sup}</${tag}>`;
}

function scriptTag(node: { sub?: MathRow; sup?: MathRow }, under: boolean): string {
    if (node.sub && node.sup) return under ? 'munderover' : 'msubsup';
    if (node.sub) return under ? 'munder' : 'msub';
    return under ? 'mover' : 'msup';
}

function writeNode(node: MathNode): string {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator':
            return writeToken(node);
        case 'text': {
            // MathML trims a token's edge spaces; no-break spaces stay.
            const text = replaceEdges(node.text, SPACE, '\u00A0');
            return `<mtext${colorAttribute(node.color)}>${escapeXml(text)}</mtext>`;
        }
        case 'space':
            return `<mspace width="${escapeXml(SPACES[node.width].width)}"/>`;
        case 'fraction': {
            const line = node.line === 'none' ? ' linethickness="0"' : node.line === 'skewed' ? ' bevelled="true"' : '';
            return `<mfrac${line}>${writeArgument(node.numerator)}${writeArgument(node.denominator)}</mfrac>`;
        }
        case 'scripts': {
            const base = writeBase(node.base);
            if (node.pre) {
                const sub = node.sub ? writeArgument(node.sub) : '<none/>';
                const sup = node.sup ? writeArgument(node.sup) : '<none/>';
                return `<mmultiscripts>${base}<mprescripts/>${sub}${sup}</mmultiscripts>`;
            }
            return writeScripts(scriptTag(node, false), base, node);
        }
        case 'radical':
            return node.degree
                ? `<mroot>${writeArgument(node.body)}${writeArgument(node.degree)}</mroot>`
                : `<msqrt>${writeRow(node.body)}</msqrt>`;
        case 'nary': {
            const operator = `<mo largeop="true">${escapeXml(node.operator)}</mo>`;
            const scripted =
                node.sub || node.sup
                    ? writeScripts(scriptTag(node, node.limits === 'under'), operator, node)
                    : operator;
            return `<mrow>${scripted}${writeRow(node.body)}</mrow>`;
        }
        case 'fenced': {
            const separator = `<mo separator="true">${escapeXml(node.separator)}</mo>`;
            const cases = casesOf(node);
            const parts = cases ? writeTable(cases, ' columnalign="left"') : node.parts.map(writeRow).join(separator);
            return `<mrow><mo fence="true">${escapeXml(node.open)}</mo>${parts}<mo fence="true">${escapeXml(node.close)}</mo></mrow>`;
        }
        case 'function': {
            // A lone space is wrapped, so the reader never takes it for the space Temml puts after a name.
            const body =
                node.body.length === 1 && node.body[0].kind === 'space' ? wrap(node.body) : writeArgument(node.body);
            return `<mrow>${writeArgument(node.name)}<mo>${FUNCTION_APPLICATION}</mo>${body}</mrow>`;
        }
        case 'accent': {
            const char = ACCENTS.get(node.accent) ?? node.accent;
            return `<mover accent="true">${writeBase(node.body)}<mo>${escapeXml(char)}</mo></mover>`;
        }
        case 'line':
            return node.position === 'over'
                ? `<mover accent="true">${writeBase(node.body)}<mo>${LINES.over}</mo></mover>`
                : `<munder accentunder="true">${writeBase(node.body)}<mo>${LINES.under}</mo></munder>`;
        case 'brace': {
            const tag = node.position === 'over' ? 'mover' : 'munder';
            return `<${tag}>${writeBase(node.body)}<mo stretchy="true">${escapeXml(node.char)}</mo></${tag}>`;
        }
        case 'limit': {
            const tag = node.position === 'over' ? 'mover' : 'munder';
            // A lone operator is wrapped, so the reader never takes it for an accent or a brace.
            const limit =
                node.limit.length === 1 && node.limit[0].kind === 'operator'
                    ? wrap(node.limit)
                    : writeArgument(node.limit);
            return `<${tag}>${writeBase(node.base)}${limit}</${tag}>`;
        }
        case 'enclose':
            return `<menclose notation="${escapeXml(node.notation.join(' '))}">${writeRow(node.body)}</menclose>`;
        case 'table': {
            const columns = Math.max(0, ...node.rows.map((cells) => cells.length));
            // Equations align as Word's & marks do: right of the first mark, left of the next, by turns.
            const align = Array.from({ length: columns }, (_, index) => (index % 2 === 0 ? 'right' : 'left')).join(' ');
            return writeTable(node, node.layout === 'equations' ? ` displaystyle="true" columnalign="${align}"` : '');
        }
    }
}

function writeTable(node: Extract<MathNode, { kind: 'table' }>, layout: string): string {
    const rows = node.rows.map((cells) => `<mtr>${cells.map((cell) => `<mtd>${writeRow(cell)}</mtd>`).join('')}</mtr>`);
    return `<mtable${layout}>${rows.join('')}</mtable>`;
}

export function writeMathml(row: MathRow, latex?: string): string {
    const content =
        latex === undefined
            ? writeRow(row)
            : `<semantics>${writeArgument(row)}<annotation encoding="${TEX}">${escapeXml(latex)}</annotation></semantics>`;
    const mathml = checkedXml(`<math xmlns="${MATHML_NAMESPACE}">${content}</math>`);
    if (mathml.length > MATH_LIMITS.mathmlLength) {
        throw new MathError(`An equation's MathML is at most ${MATH_LIMITS.mathmlLength} characters`);
    }
    if (mathml.split('<').length - 1 > MATH_LIMITS.mathmlTags) {
        throw new MathError(`An equation's MathML holds at most ${MATH_LIMITS.mathmlTags} tags`);
    }
    return mathml;
}
