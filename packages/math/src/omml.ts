import { COMBINING_ACCENTS, naryLimits, SPACES } from './notation';
import {
    bound,
    equationCells,
    hexColor,
    MATH_ENCLOSURES,
    type MathBudget,
    type MathEnclosure,
    type MathNode,
    type MathRow,
    type MathVariant,
    mark,
    optional,
    RowBuilder,
    type RowSlot,
    toColor,
} from './tree';
import { attribute, checkedXml, elementsOf, escapeXml, type MathXmlElement, textOf } from './xml';

export const OMML_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const WORDML_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MARKUP_COMPATIBILITY_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

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

function readRun(row: RowBuilder, run: MathXmlElement, depth: number): void {
    const parts = runParts(elementsOf(run), row.budget, depth);
    const math = parts.find((part) => is(part, OMML_NAMESPACE, 'rPr'));
    const word = parts.find((part) => is(part, WORDML_NAMESPACE, 'rPr'));
    const text = parts
        .filter((part) => is(part, OMML_NAMESPACE, 't'))
        .map(textOf)
        .join('');
    const color = toColor(valOf(childOf(word, WORDML_NAMESPACE, 'color')));
    if (isOn(childOf(math, OMML_NAMESPACE, 'nor'))) {
        row.text(text, color);
        return;
    }
    const sty = valOf(childOf(math, OMML_NAMESPACE, 'sty'));
    const scr = valOf(childOf(math, OMML_NAMESPACE, 'scr'));
    // Without a style Word draws letters italic and the rest upright.
    row.chars(text, variantOf(sty ?? 'i', scr), variantOf(sty ?? 'p', scr), color);
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

function readInto(row: RowBuilder, element: MathXmlElement, depth: number): void {
    if (is(element, MARKUP_COMPATIBILITY_NAMESPACE, 'AlternateContent')) {
        const fallback = childOf(element, MARKUP_COMPATIBILITY_NAMESPACE, 'Fallback');
        readThrough(row, fallback ? elementsOf(fallback) : [], depth + 1);
        return;
    }
    if (element.ns !== OMML_NAMESPACE) {
        if (element.ns !== WORDML_NAMESPACE || !DELETED.has(element.local))
            readThrough(row, elementsOf(element), depth + 1);
        return;
    }
    const { budget } = row;
    const own = childOf(element, OMML_NAMESPACE, `${element.local}Pr`);
    const property = (local: string) => childOf(own, OMML_NAMESPACE, local);
    // ECMA-376 §22.1.2.23: a tracked deletion of its control character deletes the object.
    const control = property('ctrlPr');
    if (control && elementsOf(control).some((part) => part.ns === WORDML_NAMESPACE && DELETED.has(part.local))) return;
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
                    return equationCells(readRow(equation, budget, depth + 1, 'equation'));
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

// ── Writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Run = { properties: string; text: string };

const val = (name: string, value: string) => `<m:${name} m:val="${escapeXml(value)}"/>`;

function properties(object: string, values: [string, string | undefined][]): string {
    const set = values.flatMap(([name, value]) => (value === undefined ? [] : [val(name, value)]));
    return set.length > 0 ? `<m:${object}Pr>${set.join('')}</m:${object}Pr>` : '';
}

const colored = (color: string | undefined) => {
    const hex = hexColor(color);
    return hex ? `<w:rPr><w:color w:val="${hex.slice(1)}"/></w:rPr>` : '';
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
            // A word is upright, which Word only draws when told.
            const upright = node.kind === 'identifier' && [...node.text].length > 1;
            return {
                properties: style(node.variant ?? (upright ? 'normal' : undefined)) + colored(node.color),
                text: node.text,
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
            const pr = properties('d', [
                ['begChr', node.open === '(' ? undefined : node.open],
                ['sepChr', node.parts.length < 2 || node.separator === '|' ? undefined : node.separator],
                ['endChr', node.close === ')' ? undefined : node.close],
            ]);
            return `<m:d>${pr}${node.parts.map((part) => argument('e', part)).join('')}</m:d>`;
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
        case 'table':
            if (node.layout === 'equations') {
                const equations = node.rows.map((cells) =>
                    argument(
                        'e',
                        cells.flatMap((cell, index) => (index > 0 ? [AMPERSAND, ...cell] : cell)),
                    ),
                );
                return `<m:eqArr>${equations.join('')}</m:eqArr>`;
            }
            return `<m:m>${node.rows.map((cells) => `<m:mr>${cells.map((cell) => argument('e', cell)).join('')}</m:mr>`).join('')}</m:m>`;
    }
}

const writeRun = ({ properties, text }: Run) =>
    `<m:r>${properties}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;

function writeRow(row: MathRow): string {
    let xml = '';
    let pending: Run | undefined;
    for (const node of row) {
        const next = piece(node);
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

// The caller binds m: and w:, as the docx writer declares them once on its root.
export function writeOmml(row: MathRow): string {
    return checkedXml(`<m:oMath>${writeRow(row)}</m:oMath>`);
}
