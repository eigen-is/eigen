import { COMBINING_ACCENTS, MINUS, naryLimits, SPACES } from './notation';
import type { MathBudget, MathEnclosure, MathNode, MathRow, MathVariant, RowSlot } from './tree';
import {
    bound,
    casesOf,
    defaultVariant,
    equationCells,
    hexColor,
    MATH_ENCLOSURES,
    mark,
    optional,
    RowBuilder,
    toColor,
} from './tree';
import type { MathXmlElement } from './xml';
import { attribute, checkedXml, elementsOf, escapeXml, textOf } from './xml';

export const OMML_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const WORDML_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const MARKUP_COMPATIBILITY_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

// Unicode's hyphen: Word draws it as one, where a hyphen-minus in a math run is the minus operator.
const HYPHEN = '\u2010';
// ECMA-376's defaults for an absent property.
const DEFAULT_ACCENT = '\u0302';
const DEFAULT_BRACE = '⏟';
const DEFAULT_NARY = '∫';

// How Word writes each variant; the reader also takes the combinations Word allows and MathML lacks.
const STYLES: Record<MathVariant, { scr?: string; sty: string }> = {
    normal: { sty: 'p' },
    italic: { sty: 'i' },
    bold: { sty: 'b' },
    'bold-italic': { sty: 'bi' },
    'double-struck': { scr: 'double-struck', sty: 'p' },
    monospace: { scr: 'monospace', sty: 'p' },
    script: { scr: 'script', sty: 'p' },
    'bold-script': { scr: 'script', sty: 'b' },
    fraktur: { scr: 'fraktur', sty: 'p' },
    'bold-fraktur': { scr: 'fraktur', sty: 'b' },
    'sans-serif': { scr: 'sans-serif', sty: 'p' },
    'bold-sans-serif': { scr: 'sans-serif', sty: 'b' },
    'sans-serif-italic': { scr: 'sans-serif', sty: 'i' },
    'sans-serif-bold-italic': { scr: 'sans-serif', sty: 'bi' },
};

// A border box draws a side unless it is hidden, and a strike only when it is on.
const BORDERS: Record<MathEnclosure, string> = {
    top: 'hideTop',
    bottom: 'hideBot',
    left: 'hideLeft',
    right: 'hideRight',
    horizontalstrike: 'strikeH',
    verticalstrike: 'strikeV',
    updiagonalstrike: 'strikeBLTR',
    downdiagonalstrike: 'strikeTLBR',
};

const isSide = (enclosure: MathEnclosure) => BORDERS[enclosure].startsWith('hide');

const AMPERSAND: MathNode = { kind: 'operator', text: '&' };

// Word's Symbol font, by code point less its private-use offset F000: its letters and the common math characters.
const SYMBOL_FONT: ReadonlyMap<number, string> = new Map([
    ...[...'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'].map((char, index): [number, string] => [0x41 + index, char]),
    ...[...'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'].map((char, index): [number, string] => [0x61 + index, char]),
    ...Object.entries({
        '22': '∀',
        '24': '∃',
        '27': '∋',
        '2D': '−',
        '40': '≅',
        '5C': '∴',
        '5E': '⊥',
        '7E': '∼',
        A2: '′',
        A3: '≤',
        A5: '∞',
        AB: '↔',
        AC: '←',
        AD: '↑',
        AE: '→',
        AF: '↓',
        B1: '±',
        B2: '″',
        B3: '≥',
        B4: '×',
        B5: '∝',
        B6: '∂',
        B7: '•',
        B8: '÷',
        B9: '≠',
        BA: '≡',
        BB: '≈',
        BC: '…',
        C0: 'ℵ',
        C4: '⊗',
        C5: '⊕',
        C6: '∅',
        C7: '∩',
        C8: '∪',
        C9: '⊃',
        CA: '⊇',
        CB: '⊄',
        CC: '⊂',
        CD: '⊆',
        CE: '∈',
        CF: '∉',
        D0: '∠',
        D1: '∇',
        D5: '∏',
        D6: '√',
        D7: '⋅',
        D8: '¬',
        D9: '∧',
        DA: '∨',
        DB: '⇔',
        DC: '⇐',
        DD: '⇑',
        DE: '⇒',
        DF: '⇓',
        E5: '∑',
        F2: '∫',
    }).map(([hex, char]): [number, string] => [Number.parseInt(hex, 16), char]),
]);

// Tracked changes: what an insertion or a move's destination holds shows, a deletion or a move's source doesn't.
const INSERTED = new Set(['ins', 'moveTo']);
const DELETED = new Set(['del', 'moveFrom']);

// ── Reader ─────────────────────────────────────────────────────────────────────────────────────────────────────

const is = (element: MathXmlElement, ns: string, local: string) => element.ns === ns && element.local === local;

function childOf(element: MathXmlElement | undefined, ns: string, local: string): MathXmlElement | undefined {
    return element && elementsOf(element).find((child) => is(child, ns, local));
}

const valOf = (element: MathXmlElement | undefined) => element && attribute(element, 'val');

// ST_OnOff: an element without a value is on.
function isOn(element: MathXmlElement | undefined): boolean {
    return element !== undefined && !['0', 'off', 'false'].includes(valOf(element)?.trim() ?? '');
}

function variantOf(sty: string, scr: string | undefined): MathVariant {
    const bold = sty === 'b' || sty === 'bi';
    const italic = sty === 'i' || sty === 'bi';
    switch (scr) {
        case 'double-struck':
        case 'monospace':
            return scr;
        case 'script':
            return bold ? 'bold-script' : 'script';
        case 'fraktur':
            return bold ? 'bold-fraktur' : 'fraktur';
        case 'sans-serif':
            if (bold) return italic ? 'sans-serif-bold-italic' : 'bold-sans-serif';
            return italic ? 'sans-serif-italic' : 'sans-serif';
        default:
            if (bold) return italic ? 'bold-italic' : 'bold';
            return italic ? 'italic' : 'normal';
    }
}

// A run's own parts, tracked insertions opened and deletions dropped.
function runParts(elements: MathXmlElement[], budget: MathBudget, depth: number): MathXmlElement[] {
    bound(budget, depth, 0);
    return elements.flatMap((part) => {
        if (part.ns !== WORDML_NAMESPACE) return [part];
        if (INSERTED.has(part.local)) return runParts(elementsOf(part), budget, depth + 1);
        return DELETED.has(part.local) ? [] : [part];
    });
}

// A w:sym's character, where it is one of the Symbol font's math characters; '' for anything else.
function symbolOf(sym: MathXmlElement): string {
    const code = Number.parseInt(attribute(sym, 'char') ?? '', 16);
    const position = code >= 0xf000 ? code - 0xf000 : code;
    return attribute(sym, 'font') === 'Symbol' ? (SYMBOL_FONT.get(position) ?? '') : '';
}

// In a run of an equation's own, Word's # starts the equation's number: whether it did.
function readRun(row: RowBuilder, run: MathXmlElement, depth: number, numbered = false): boolean {
    const parts = runParts(elementsOf(run), row.budget, depth);
    const math = parts.find((part) => is(part, OMML_NAMESPACE, 'rPr'));
    const word = parts.find((part) => is(part, WORDML_NAMESPACE, 'rPr'));
    const text = parts
        .map((part) =>
            is(part, OMML_NAMESPACE, 't') ? textOf(part) : is(part, WORDML_NAMESPACE, 'sym') ? symbolOf(part) : '',
        )
        .join('');
    const color = toColor(valOf(childOf(word, WORDML_NAMESPACE, 'color')));
    if (isOn(childOf(math, OMML_NAMESPACE, 'nor'))) {
        row.text(text, color);
        return false;
    }
    const sty = valOf(childOf(math, OMML_NAMESPACE, 'sty'));
    const scr = valOf(childOf(math, OMML_NAMESPACE, 'scr'));
    const number = numbered ? text.indexOf('#') : -1;
    const shown = number < 0 ? text : text.slice(0, number);
    // Word draws a hyphen-minus in a math run as the minus operator, in an upright run too; its U+2010 is a hyphen.
    const chars = shown.replaceAll('-', MINUS).replaceAll(HYPHEN, '-');
    // Without a style Word draws letters italic and the rest upright.
    row.chars(chars, variantOf(sty ?? 'i', scr), variantOf(sty ?? 'p', scr), color);
    return number >= 0;
}

function readRow(elements: MathXmlElement[], budget: MathBudget, depth: number, slot?: RowSlot): MathRow {
    const row = new RowBuilder(budget, depth, slot);
    for (const element of elements) readInto(row, element, depth);
    return row.done();
}

// Content that reads as if it stood in the row itself: a level deeper, so deep wrappers meet the bound.
function readThrough(row: RowBuilder, elements: MathXmlElement[], depth: number): void {
    bound(row.budget, depth, 0);
    for (const element of elements) readInto(row, element, depth);
}

// What a wrapper reads as: an alternative its fallback, a tracked deletion nothing, anything else outside OMML its
// content. An OMML element is no wrapper.
function unwrapped(element: MathXmlElement): MathXmlElement[] | undefined {
    if (is(element, MARKUP_COMPATIBILITY_NAMESPACE, 'AlternateContent')) {
        const fallback = childOf(element, MARKUP_COMPATIBILITY_NAMESPACE, 'Fallback');
        return fallback ? elementsOf(fallback) : [];
    }
    if (element.ns === OMML_NAMESPACE) return undefined;
    return element.ns === WORDML_NAMESPACE && DELETED.has(element.local) ? [] : elementsOf(element);
}

// ECMA-376 §22.1.2.23: a tracked deletion of an object's control character deletes the object.
function isDeleted(object: MathXmlElement): boolean {
    const control = childOf(childOf(object, OMML_NAMESPACE, `${object.local}Pr`), OMML_NAMESPACE, 'ctrlPr');
    return !!control && elementsOf(control).some((part) => part.ns === WORDML_NAMESPACE && DELETED.has(part.local));
}

// An equation's parts with their depths, its wrappers opened as readInto reads them: Word shows a run in a tracked
// insertion as part of the equation, so its # starts the number there too.
function* equationParts(
    elements: MathXmlElement[],
    budget: MathBudget,
    depth: number,
): Generator<[MathXmlElement, number]> {
    for (const element of elements) {
        const inner = unwrapped(element);
        if (!inner) {
            yield [element, depth];
            continue;
        }
        bound(budget, depth + 1, 0);
        yield* equationParts(inner, budget, depth + 1);
    }
}

function readInto(row: RowBuilder, element: MathXmlElement, depth: number): void {
    const inner = unwrapped(element);
    if (inner) {
        readThrough(row, inner, depth + 1);
        return;
    }
    if (isDeleted(element)) return;
    const { budget } = row;
    const own = childOf(element, OMML_NAMESPACE, `${element.local}Pr`);
    const property = (local: string) => childOf(own, OMML_NAMESPACE, local);
    const content = (local: string) => {
        const slot = childOf(element, OMML_NAMESPACE, local);
        return slot ? elementsOf(slot) : [];
    };
    const slot = (local: string) => readRow(content(local), budget, depth + 1);
    const optionalSlot = (local: string) => optional(readRow(content(local), budget, depth + 1, 'optional'));
    switch (element.local) {
        case 'r':
            readRun(row, element, depth);
            return;
        case 'f': {
            const type = valOf(property('type'));
            if (type === 'lin') {
                readThrough(row, content('num'), depth + 1);
                row.chars('/', 'normal', 'normal', undefined);
                readThrough(row, content('den'), depth + 1);
                return;
            }
            const line = type === 'noBar' ? 'none' : type === 'skw' ? 'skewed' : 'bar';
            row.node({ kind: 'fraction', numerator: slot('num'), denominator: slot('den'), line });
            return;
        }
        case 'sSub':
        case 'sSup':
        case 'sSubSup':
        case 'sPre': {
            const sub = optionalSlot('sub');
            const sup = optionalSlot('sup');
            if (!sub && !sup) {
                readThrough(row, content('e'), depth + 1);
                return;
            }
            const scripts: MathNode = { kind: 'scripts', base: slot('e'), ...(sub && { sub }), ...(sup && { sup }) };
            if (element.local === 'sPre') scripts.pre = true;
            row.node(scripts);
            return;
        }
        case 'rad': {
            const degree = isOn(property('degHide')) ? undefined : optionalSlot('deg');
            row.node({ kind: 'radical', body: slot('e'), ...(degree && { degree }) });
            return;
        }
        case 'nary': {
            const operator = mark(valOf(property('chr')) ?? '') || DEFAULT_NARY;
            const sub = isOn(property('subHide')) ? undefined : optionalSlot('sub');
            const sup = isOn(property('supHide')) ? undefined : optionalSlot('sup');
            // Without scripts the location shows nothing, so the operator's default stands.
            const location = sub || sup ? valOf(property('limLoc')) : undefined;
            const limits = location === 'undOvr' ? 'under' : location === 'subSup' ? 'side' : naryLimits(operator);
            row.node({ kind: 'nary', operator, limits, ...(sub && { sub }), ...(sup && { sup }), body: slot('e') });
            return;
        }
        case 'd': {
            const parts = elementsOf(element)
                .filter((part) => is(part, OMML_NAMESPACE, 'e'))
                .map((part) => readRow(elementsOf(part), budget, depth + 1));
            const fence = (local: string, absent: string) => {
                const value = valOf(property(local));
                return value === undefined ? absent : mark(value);
            };
            row.node({
                kind: 'fenced',
                open: fence('begChr', '('),
                close: fence('endChr', ')'),
                separator: parts.length > 1 ? fence('sepChr', '|') : '',
                parts: parts.length > 0 ? parts : [readRow([], budget, depth + 1)],
            });
            return;
        }
        case 'func':
            row.node({ kind: 'function', name: slot('fName'), body: slot('e') });
            return;
        case 'acc': {
            const char = mark(valOf(property('chr')) ?? '') || DEFAULT_ACCENT;
            row.node({ kind: 'accent', accent: COMBINING_ACCENTS.get(char) ?? char, body: slot('e') });
            return;
        }
        case 'bar':
            row.node({
                kind: 'line',
                position: valOf(property('pos')) === 'top' ? 'over' : 'under',
                body: slot('e'),
            });
            return;
        case 'groupChr':
            row.node({
                kind: 'brace',
                char: mark(valOf(property('chr')) ?? '') || DEFAULT_BRACE,
                position: valOf(property('pos')) === 'top' ? 'over' : 'under',
                body: slot('e'),
            });
            return;
        case 'limLow':
        case 'limUpp':
            row.node({
                kind: 'limit',
                position: element.local === 'limUpp' ? 'over' : 'under',
                base: slot('e'),
                limit: slot('lim'),
            });
            return;
        case 'borderBox':
            row.node({
                kind: 'enclose',
                notation: MATH_ENCLOSURES.filter(
                    (enclosure) => isSide(enclosure) !== isOn(property(BORDERS[enclosure])),
                ),
                body: slot('e'),
            });
            return;
        // ECMA-376 needs a row in m:m, a cell in m:mr and an equation in m:eqArr: an empty one reads as one empty cell.
        case 'm': {
            const rows = elementsOf(element)
                .filter((matrixRow) => is(matrixRow, OMML_NAMESPACE, 'mr'))
                .map((matrixRow) => elementsOf(matrixRow).filter((cell) => is(cell, OMML_NAMESPACE, 'e')));
            row.node({
                kind: 'table',
                layout: 'matrix',
                rows: (rows.length > 0 ? rows : [[]]).map((cells) => {
                    bound(budget, depth + 1, 1);
                    return (cells.length > 0 ? cells.map(elementsOf) : [[]]).map((cell) =>
                        readRow(cell, budget, depth + 1),
                    );
                }),
            });
            return;
        }
        case 'eqArr': {
            const equations = elementsOf(element).filter((equation) => is(equation, OMML_NAMESPACE, 'e'));
            row.node({
                kind: 'table',
                layout: 'equations',
                rows: (equations.length > 0 ? equations.map(elementsOf) : [[]]).map((equation) => {
                    bound(budget, depth + 1, 1);
                    const row = new RowBuilder(budget, depth + 1, 'equation');
                    // Word numbers an equation with # and the number after it, which belongs to the document. A # in a
                    // box is the character.
                    for (const [part, partDepth] of equationParts(equation, budget, depth + 1)) {
                        if (!is(part, OMML_NAMESPACE, 'r')) readInto(row, part, partDepth);
                        else if (readRun(row, part, partDepth, true)) break;
                    }
                    return equationCells(row.done());
                }),
            });
            return;
        }
        default:
            // Properties are their object's; a box, a phantom and what this reader doesn't know read as their content.
            if (!element.local.endsWith('Pr')) readThrough(row, elementsOf(element), depth + 1);
    }
}

export function readOmml(oMath: MathXmlElement): MathRow {
    return readRow(elementsOf(oMath), { size: 0 }, 1);
}

// The text of an equation readOmml refuses, as it shows. Word cuts runs by style, not by word, so runs side by side
// are one word and each object is a word of its own: x²+1 reads "x2 +1". A loop, not recursion, since such an
// equation may nest as deep as its XML.
export function readOmmlText(oMath: MathXmlElement): string {
    const words = [''];
    // null marks where an object of the row ends.
    const stack: (MathXmlElement | null)[] = [];
    const walk = (elements: MathXmlElement[]) => {
        for (let index = elements.length - 1; index >= 0; index--) stack.push(elements[index]);
    };
    walk(elementsOf(oMath));
    let inObject = false;
    for (let element = stack.pop(); element !== undefined; element = stack.pop()) {
        const inner = element && unwrapped(element);
        if (element === null) {
            inObject = false;
            words.push('');
        } else if (is(element, WORDML_NAMESPACE, 'sym')) words[words.length - 1] += symbolOf(element);
        else if (inner) walk(inner);
        else if (element.local === 't') words[words.length - 1] += textOf(element);
        // Properties hold no text and start no word.
        else if (!element.local.endsWith('Pr') && !isDeleted(element)) {
            if (!inObject && element.local !== 'r') {
                inObject = true;
                words.push('');
                stack.push(null);
            }
            walk(elementsOf(element));
        }
    }
    return words
        .map((word) => word.trim())
        .filter(Boolean)
        .join(' ');
}

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Run = { properties: string; text: string };

const val = (name: string, value: string) => `<m:${name} m:val="${escapeXml(value)}"/>`;

function properties(object: string, values: [string, string | undefined][]): string {
    const set = values.flatMap(([name, value]) => (value === undefined ? [] : [val(name, value)]));
    return set.length > 0 ? `<m:${object}Pr>${set.join('')}</m:${object}Pr>` : '';
}

const colored = (color: string | undefined) => {
    const hex = hexColor(color);
    return hex ? `<w:rPr><w:color w:val="${escapeXml(hex.slice(1))}"/></w:rPr>` : '';
};

function style(variant: MathVariant | undefined): string {
    if (!variant) return '';
    const { scr, sty } = STYLES[variant];
    return `<m:rPr>${scr ? val('scr', scr) : ''}${val('sty', sty)}</m:rPr>`;
}

const argument = (local: string, row: MathRow) => `<m:${local}>${writeRow(row)}</m:${local}>`;

// A token, text or space is a run that its neighbours of the same style join; any other node is its object.
function piece(node: MathNode): Run | string {
    switch (node.kind) {
        case 'identifier':
        case 'number':
        case 'operator': {
            // A word or a capital Greek letter is upright, which Word only draws when told.
            const upright = node.kind === 'identifier' && defaultVariant(node.kind, node.text) === 'normal';
            return {
                properties: style(node.variant ?? (upright ? 'normal' : undefined)) + colored(node.color),
                // A hyphen in a word is U+2010, which Word draws as a hyphen where its '-' is a minus.
                text: node.kind === 'identifier' ? node.text.replaceAll('-', HYPHEN) : node.text,
            };
        }
        case 'text':
            return { properties: `<m:rPr><m:nor/></m:rPr>${colored(node.color)}`, text: node.text };
        case 'space':
            return { properties: '', text: SPACES[node.width].text };
        case 'fraction': {
            const type = node.line === 'none' ? 'noBar' : node.line === 'skewed' ? 'skw' : undefined;
            return `<m:f>${properties('f', [['type', type]])}${argument('num', node.numerator)}${argument('den', node.denominator)}</m:f>`;
        }
        case 'scripts': {
            if (node.pre) {
                return `<m:sPre>${argument('sub', node.sub ?? [])}${argument('sup', node.sup ?? [])}${argument('e', node.base)}</m:sPre>`;
            }
            const name = node.sub && node.sup ? 'sSubSup' : node.sub ? 'sSub' : 'sSup';
            const sub = node.sub ? argument('sub', node.sub) : '';
            const sup = node.sup ? argument('sup', node.sup) : '';
            return `<m:${name}>${argument('e', node.base)}${sub}${sup}</m:${name}>`;
        }
        case 'radical': {
            const hidden = properties('rad', [['degHide', node.degree ? undefined : '1']]);
            return `<m:rad>${hidden}${argument('deg', node.degree ?? [])}${argument('e', node.body)}</m:rad>`;
        }
        case 'nary': {
            const location =
                node.limits === naryLimits(node.operator) ? undefined : node.limits === 'under' ? 'undOvr' : 'subSup';
            const pr = properties('nary', [
                ['chr', node.operator === DEFAULT_NARY ? undefined : node.operator],
                ['limLoc', location],
                ['subHide', node.sub ? undefined : '1'],
                ['supHide', node.sup ? undefined : '1'],
            ]);
            return `<m:nary>${pr}${argument('sub', node.sub ?? [])}${argument('sup', node.sup ?? [])}${argument('e', node.body)}</m:nary>`;
        }
        case 'fenced': {
            // Written even where they are the defaults, since Google Docs drops the fences an m:d leaves out.
            const pr = properties('d', [
                ['begChr', node.open],
                ['sepChr', node.parts.length < 2 ? undefined : node.separator],
                ['endChr', node.close],
            ]);
            const cases = casesOf(node);
            const parts = cases
                ? `<m:e>${writeMatrix(cases, 'left')}</m:e>`
                : node.parts.map((part) => argument('e', part)).join('');
            return `<m:d>${pr}${parts}</m:d>`;
        }
        case 'function':
            return `<m:func>${argument('fName', node.name)}${argument('e', node.body)}</m:func>`;
        case 'accent': {
            const pr = properties('acc', [['chr', node.accent === DEFAULT_ACCENT ? undefined : node.accent]]);
            return `<m:acc>${pr}${argument('e', node.body)}</m:acc>`;
        }
        case 'line':
            return `<m:bar>${properties('bar', [['pos', node.position === 'over' ? 'top' : undefined]])}${argument('e', node.body)}</m:bar>`;
        case 'brace': {
            const over = node.position === 'over';
            // Word sets an under-brace's vertical justification to top.
            const pr = properties('groupChr', [
                ['chr', node.char === DEFAULT_BRACE ? undefined : node.char],
                ['pos', over ? 'top' : undefined],
                ['vertJc', over ? undefined : 'top'],
            ]);
            return `<m:groupChr>${pr}${argument('e', node.body)}</m:groupChr>`;
        }
        case 'limit': {
            const name = node.position === 'over' ? 'limUpp' : 'limLow';
            return `<m:${name}>${argument('e', node.base)}${argument('lim', node.limit)}</m:${name}>`;
        }
        case 'enclose': {
            const pr = properties(
                'borderBox',
                MATH_ENCLOSURES.map((enclosure) => [
                    BORDERS[enclosure],
                    isSide(enclosure) !== node.notation.includes(enclosure) ? '1' : undefined,
                ]),
            );
            return `<m:borderBox>${pr}${argument('e', node.body)}</m:borderBox>`;
        }
        case 'table': {
            if (node.layout === 'equations') {
                const equations = node.rows.map(
                    (cells) =>
                        `<m:e>${writeRow(
                            cells.flatMap((cell, index) => (index > 0 ? [AMPERSAND, ...cell] : cell)),
                            true,
                        )}</m:e>`,
                );
                return `<m:eqArr>${equations.join('')}</m:eqArr>`;
            }
            return writeMatrix(node, 'center');
        }
    }
}

// Google Docs draws an m:m without its column count flat. ST_Integer255 caps the count; columns past it keep the
// default, centred.
function writeMatrix(node: Extract<MathNode, { kind: 'table' }>, justification: 'center' | 'left'): string {
    const columns = Math.min(Math.max(...node.rows.map((cells) => cells.length)), 255);
    const pr = `<m:mPr><m:mcs><m:mc><m:mcPr>${val('count', String(columns))}${val('mcJc', justification)}</m:mcPr></m:mc></m:mcs></m:mPr>`;
    return `<m:m>${pr}${node.rows.map((cells) => `<m:mr>${cells.map((cell) => argument('e', cell)).join('')}</m:mr>`).join('')}</m:m>`;
}

const writeRun = ({ properties, text }: Run) =>
    `<m:r>${properties}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;

// In an equation a #, marked or not, would start Word's equation number: it goes in a box.
function writeRow(row: MathRow, equation = false): string {
    let xml = '';
    let pending: Run | undefined;
    for (const node of row) {
        const numberSign = equation && node.kind === 'operator' && node.text.startsWith('#');
        const next = numberSign ? `<m:box>${argument('e', [node])}</m:box>` : piece(node);
        if (typeof next !== 'string' && pending?.properties === next.properties) {
            pending.text += next.text;
            continue;
        }
        if (pending) xml += writeRun(pending);
        pending = typeof next === 'string' ? undefined : next;
        if (typeof next === 'string') xml += next;
    }
    return pending ? xml + writeRun(pending) : xml;
}

// The caller binds m: and w:, once on its root.
export function writeOmml(row: MathRow): string {
    return checkedXml(`<m:oMath>${writeRow(row)}</m:oMath>`);
}
