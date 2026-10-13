import { MathError } from './error';
import {
    ACCENTS,
    COMBINING_ACCENTS,
    FENCES,
    LARGE_OPERATORS,
    LINES,
    naryLimits,
    SPACES,
    toAlphanumeric,
} from './notation';
import {
    bound,
    equationCells,
    MATH_ENCLOSURES,
    MATH_LIMITS,
    MATH_SPACES,
    MATH_VARIANTS,
    type MathBudget,
    type MathNode,
    type MathRow,
    type MathToken,
    mark,
    optional,
    RowBuilder,
    toColor,
} from './tree';
import {
    attribute,
    checkedXml,
    elementsOf,
    escapeXml,
    type MathXmlElement,
    replaceEdges,
    textOf,
    trimXmlSpace,
} from './xml';

export const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const TEX = 'application/x-tex';
const FUNCTION_APPLICATION = '\u2061';

// Which children of a script element are the sub- and superscript.
const SCRIPT_SLOTS = new Map<string, ('sub' | 'sup')[]>([
    ['msub', ['sub']],
    ['munder', ['sub']],
    ['msup', ['sup']],
    ['mover', ['sup']],
    ['msubsup', ['sub', 'sup']],
    ['munderover', ['sub', 'sup']],
]);

const SPACE_OF_WIDTH = new Map(MATH_SPACES.map((space) => [SPACES[space].width, space]));
const SPACE: ReadonlySet<string> = new Set(' ');

// ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────────

function is(element: MathXmlElement | undefined, local: string): element is MathXmlElement {
    return element?.ns === MATHML_NAMESPACE && element.local === local;
}

const isFlagged = (element: MathXmlElement | undefined, flag: string) =>
    is(element, 'mo') && attribute(element, flag) === 'true';

const colorOf = (element: MathXmlElement) => {
    const color = attribute(element, 'mathcolor');
    return color?.startsWith('#') ? toColor(color.slice(1)) : undefined;
};

// The three mrows that mean more than their children: an n-ary (a large operator from the table with scripts, or
// one marked largeop, then its body), a fenced row (both ends marked fence) and a function application (name,
// U+2061, body).
function patternOf(mrow: MathXmlElement): 'nary' | 'fenced' | 'function' | undefined {
    const children = elementsOf(mrow);
    const [first] = children;
    const scripted = first?.ns === MATHML_NAMESPACE && SCRIPT_SLOTS.has(first.local);
    const operator = scripted ? elementsOf(first)[0] : first;
    if (is(operator, 'mo')) {
        const char = mark(textOf(operator));
        if (char && (isFlagged(operator, 'largeop') || (scripted && LARGE_OPERATORS.has(char)))) return 'nary';
    }
    if (children.length >= 2 && isFlagged(first, 'fence') && isFlagged(children.at(-1), 'fence')) return 'fenced';
    if (children.length === 3 && is(children[1], 'mo') && trimXmlSpace(textOf(children[1])) === FUNCTION_APPLICATION)
        return 'function';
    return undefined;
}

function readRow(elements: MathXmlElement[], budget: MathBudget, depth: number): MathRow {
    const row = new RowBuilder(budget, depth);
    for (const element of elements) readInto(row, element, depth);
    return row.done();
}

// An argument is one element; a plain mrow there is the row itself, not a level of its own. So is math, an mrow too.
function readArgument(element: MathXmlElement | undefined, budget: MathBudget, depth: number): MathRow {
    if (element && (is(element, 'mrow') || is(element, 'math')) && !patternOf(element))
        return readRow(elementsOf(element), budget, depth);
    return readRow(element ? [element] : [], budget, depth);
}

// Content that reads as if it stood in the row itself: a level deeper, so deep wrappers meet the bound.
function readThrough(row: RowBuilder, elements: MathXmlElement[], depth: number): void {
    bound(row.budget, depth, 0);
    for (const element of elements) readInto(row, element, depth);
}

function readScripts(
    children: MathXmlElement[],
    slots: readonly ('sub' | 'sup')[],
    budget: MathBudget,
    depth: number,
): { sub?: MathRow; sup?: MathRow } {
    const scripts: { sub?: MathRow; sup?: MathRow } = {};
    for (const [index, slot] of slots.entries()) {
        const script = optional(readArgument(children[index], budget, depth));
        if (script) scripts[slot] = script;
    }
    return scripts;
}

function readPattern(mrow: MathXmlElement, budget: MathBudget, depth: number): MathNode | undefined {
    const children = elementsOf(mrow);
    switch (patternOf(mrow)) {
        case 'nary': {
            const [scripted, ...body] = children;
            const slots = SCRIPT_SLOTS.get(scripted.local) ?? [];
            const [operatorElement, ...scripts] = slots.length > 0 ? elementsOf(scripted) : [scripted];
            const operator = mark(textOf(operatorElement));
            const { sub, sup } = readScripts(scripts, slots, budget, depth + 1);
            const under = ['munder', 'mover', 'munderover'].includes(scripted.local);
            const limits = sub || sup ? (under ? 'under' : 'side') : naryLimits(operator);
            return {
                kind: 'nary',
                operator,
                limits,
                ...(sub && { sub }),
                ...(sup && { sup }),
                body: readRow(body, budget, depth + 1),
            };
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
                parts: parts.map((part) => readRow(part, budget, depth + 1)),
            };
        }
        case 'function':
            return {
                kind: 'function',
                name: readArgument(children[0], budget, depth + 1),
                body: readArgument(children[2], budget, depth + 1),
            };
        case undefined:
            return undefined;
    }
}

function readToken(row: RowBuilder, element: MathXmlElement): void {
    const text = trimXmlSpace(textOf(element));
    const mathvariant = attribute(element, 'mathvariant');
    const variant = MATH_VARIANTS.find((candidate) => candidate === mathvariant);
    // MathML draws a lone letter in an mi italic and anything else upright.
    const lone = element.local === 'mi' && [...text].length === 1;
    row.chars(text, variant ?? (lone ? 'italic' : 'normal'), variant ?? 'normal', colorOf(element));
}

function readInto(row: RowBuilder, element: MathXmlElement, depth: number): void {
    const { budget } = row;
    const children = elementsOf(element);
    const argument = (index: number) => readArgument(children[index], budget, depth + 1);
    if (element.ns !== MATHML_NAMESPACE) {
        readThrough(row, children, depth + 1);
        return;
    }
    switch (element.local) {
        case 'mi':
        case 'mn':
        case 'mo':
            readToken(row, element);
            return;
        case 'mtext':
            row.text(trimXmlSpace(textOf(element)), colorOf(element));
            return;
        case 'mspace': {
            const width = SPACE_OF_WIDTH.get(attribute(element, 'width') ?? '');
            // As characters, so two quads pair as they do in text.
            if (width) row.chars(SPACES[width].text, 'normal', 'normal', undefined);
            return;
        }
        case 'math':
        case 'mrow': {
            const node = readPattern(element, budget, depth);
            if (node) row.node(node);
            else readThrough(row, children, depth + 1);
            return;
        }
        case 'mfrac': {
            const line =
                attribute(element, 'bevelled') === 'true'
                    ? 'skewed'
                    : attribute(element, 'linethickness') === '0'
                      ? 'none'
                      : 'bar';
            row.node({ kind: 'fraction', numerator: argument(0), denominator: argument(1), line });
            return;
        }
        case 'msqrt':
            row.node({ kind: 'radical', body: readRow(children, budget, depth + 1) });
            return;
        case 'mroot': {
            const degree = optional(argument(1));
            row.node({ kind: 'radical', body: argument(0), ...(degree && { degree }) });
            return;
        }
        case 'msub':
        case 'msup':
        case 'msubsup':
        case 'mmultiscripts': {
            const prescripts = children.findIndex((child) => is(child, 'mprescripts'));
            const first = prescripts < 0 ? 1 : prescripts + 1;
            const slots = SCRIPT_SLOTS.get(element.local) ?? ['sub', 'sup'];
            const { sub, sup } = readScripts(children.slice(first), slots, budget, depth + 1);
            if (!sub && !sup) {
                readThrough(row, children.slice(0, 1), depth + 1);
                return;
            }
            const scripts: MathNode = { kind: 'scripts', base: argument(0), ...(sub && { sub }), ...(sup && { sup }) };
            if (prescripts >= 0) scripts.pre = true;
            row.node(scripts);
            return;
        }
        case 'mover':
        case 'munder': {
            const over = element.local === 'mover';
            const script = children[1];
            const char = is(script, 'mo') ? mark(textOf(script)) : '';
            if (char && attribute(element, over ? 'accent' : 'accentunder') === 'true') {
                if (char === LINES[over ? 'over' : 'under']) {
                    row.node({ kind: 'line', position: over ? 'over' : 'under', body: argument(0) });
                    return;
                }
                if (over) {
                    row.node({ kind: 'accent', accent: COMBINING_ACCENTS.get(char) ?? char, body: argument(0) });
                    return;
                }
            }
            const position = over ? 'over' : 'under';
            if (char && isFlagged(script, 'stretchy')) row.node({ kind: 'brace', char, position, body: argument(0) });
            else row.node({ kind: 'limit', position, base: argument(0), limit: argument(1) });
            return;
        }
        // Outside an n-ary: a limit under inside a limit over.
        case 'munderover': {
            bound(budget, depth + 1, 2);
            const under: MathNode = {
                kind: 'limit',
                position: 'under',
                base: readArgument(children[0], budget, depth + 2),
                limit: readArgument(children[1], budget, depth + 2),
            };
            row.node({ kind: 'limit', position: 'over', base: [under], limit: argument(2) });
            return;
        }
        case 'menclose': {
            const notation = (attribute(element, 'notation') ?? '').split(/\s+/);
            row.node({
                kind: 'enclose',
                notation: MATH_ENCLOSURES.filter((enclosure) => notation.includes(enclosure)),
                body: readRow(children, budget, depth + 1),
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
                    readRow(cell, budget, depth + 1),
                );
                return layout === 'equations' ? read.flatMap(equationCells) : read;
            });
            row.node({ kind: 'table', layout, rows: tableRows });
            return;
        }
        case 'semantics':
            readThrough(row, children.slice(0, 1), depth + 1);
            return;
        case 'annotation':
        case 'annotation-xml':
        case 'none':
        case 'mprescripts':
            return;
        default:
            readThrough(row, children, depth + 1);
    }
}

export function readMathml(math: MathXmlElement): { row: MathRow; latex: string | undefined } {
    const budget = { size: 0 };
    const elements = elementsOf(math);
    const [semantics] = elements;
    if (elements.length !== 1 || !is(semantics, 'semantics'))
        return { row: readArgument(math, budget, 1), latex: undefined };
    const [presentation, ...annotations] = elementsOf(semantics);
    const tex = annotations.find(
        (annotation) => is(annotation, 'annotation') && attribute(annotation, 'encoding') === TEX,
    );
    return { row: readArgument(presentation, budget, 1), latex: tex && checkedXml(textOf(tex)) };
}

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

const colorAttribute = (color: string | undefined) => (color ? ` mathcolor="${escapeXml(color)}"` : '');

function writeToken(node: MathToken): string {
    const tag = node.kind === 'identifier' ? 'mi' : node.kind === 'number' ? 'mn' : 'mo';
    const { variant } = node;
    // Chrome draws Unicode's alphanumerics but honours only mathvariant="normal": a variant is a character where
    // Unicode has one.
    const styled = variant && [...node.text].map((char) => toAlphanumeric(char, variant));
    const alphanumeric = styled && !styled.includes(undefined) ? styled.join('') : undefined;
    const mathvariant = variant && !alphanumeric ? ` mathvariant="${variant}"` : '';
    // A bare fence would stretch around a tall neighbour, as only a fenced row should.
    const stretchy = node.kind === 'operator' && FENCES.has(node.text) ? ' stretchy="false"' : '';
    return `<${tag}${mathvariant}${colorAttribute(node.color)}${stretchy}>${escapeXml(alphanumeric ?? node.text)}</${tag}>`;
}

const writeRow = (row: MathRow) => row.map(writeNode).join('');

const writeArgument = (row: MathRow) => (row.length === 1 ? writeNode(row[0]) : `<mrow>${writeRow(row)}</mrow>`);

// A large operator alone in a base is wrapped, so a reader never takes its scripts, limit, accent, line or brace for
// an n-ary.
function writeBase(row: MathRow): string {
    const [single] = row;
    const bare = row.length === 1 && single.kind === 'operator' && LARGE_OPERATORS.has(single.text);
    return bare ? `<mrow>${writeRow(row)}</mrow>` : writeArgument(row);
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
            return `<mspace width="${SPACES[node.width].width}"/>`;
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
            const parts = node.parts.map(writeRow).join(separator);
            return `<mrow><mo fence="true">${escapeXml(node.open)}</mo>${parts}<mo fence="true">${escapeXml(node.close)}</mo></mrow>`;
        }
        case 'function':
            return `<mrow>${writeArgument(node.name)}<mo>${FUNCTION_APPLICATION}</mo>${writeArgument(node.body)}</mrow>`;
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
            return `<${tag}>${writeBase(node.base)}${writeArgument(node.limit)}</${tag}>`;
        }
        case 'enclose':
            return `<menclose notation="${node.notation.join(' ')}">${writeRow(node.body)}</menclose>`;
        case 'table': {
            const columns = Math.max(0, ...node.rows.map((cells) => cells.length));
            // Equations align as Word's & marks do: right of the first mark, left of the next, by turns.
            const align = Array.from({ length: columns }, (_, index) => (index % 2 === 0 ? 'right' : 'left')).join(' ');
            const layout = node.layout === 'equations' ? ` displaystyle="true" columnalign="${align}"` : '';
            const rows = node.rows.map(
                (cells) => `<mtr>${cells.map((cell) => `<mtd>${writeRow(cell)}</mtd>`).join('')}</mtr>`,
            );
            return `<mtable${layout}>${rows.join('')}</mtable>`;
        }
    }
}

export function writeMathml(row: MathRow, latex?: string): string {
    const content =
        latex === undefined
            ? writeRow(row)
            : `<semantics>${writeArgument(row)}<annotation encoding="${TEX}">${escapeXml(checkedXml(latex))}</annotation></semantics>`;
    const mathml = `<math xmlns="${MATHML_NAMESPACE}">${content}</math>`;
    if (mathml.length > MATH_LIMITS.mathmlLength) {
        throw new MathError(`An equation's MathML is at most ${MATH_LIMITS.mathmlLength} characters`);
    }
    return mathml;
}
