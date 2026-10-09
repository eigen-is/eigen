// Audits a docx importer on a corpus: per file, what Word shows, counted from the OOXML with the style chain resolved,
// beside what reached the imported eigendoc JSON, and the raw OOXML elements the file holds (PROPOSAL_DOCX.md § The corpus).
//
// Usage:
//   bun apps/api/src/scripts/docx-audit.ts <corpus dir> --out <dir> [--importer <module>] [--name <label>] [--timeout <s>]
//   bun apps/api/src/scripts/docx-audit.ts compare <outA> <outB>
//
// The importer module exports `docxToPmJson` with from-docx.ts's signature. It runs in a Worker, and the source is read
// in another, so a hang is cut at the time cap and a crash is a result; every importer is measured by the same code.
// The per-file JSON samples the words that differ, so an out dir of a private corpus stays out of the repo.
import * as fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../lib/core/xml';
import { openZip } from '../lib/core/zip';
import { cssColorToHex } from '../lib/export/colors';
import type { docxToPmJson } from '../lib/import/doc/from-docx';
import { toTransitional } from '../lib/import/doc/package';

const FEATURES = [
    ['text', 'Visible text (words)'],
    ['paragraphs', 'Paragraphs'],
    ['heading1', 'Heading 1'],
    ['heading2', 'Heading 2'],
    ['heading3', 'Heading 3'],
    ['heading4', 'Heading 4'],
    ['heading5', 'Heading 5'],
    ['heading6', 'Heading 6'],
    ['heading7', 'Heading 7 to 9'],
    ['numberedHeadings', 'Numbered headings'],
    ['bold', 'Bold (words)'],
    ['italic', 'Italic (words)'],
    ['underline', 'Underline (words)'],
    ['strike', 'Strike (words)'],
    ['subscript', 'Subscript (words)'],
    ['superscript', 'Superscript (words)'],
    ['color', 'Text color (words)'],
    ['highlight', 'Highlight (words)'],
    ['font', 'Font family (words)'],
    ['small', 'Small text (words)'],
    ['code', 'Inline code (words)'],
    ['link', 'Links (words)'],
    ['listItems', 'List items'],
    ['bulletItems', 'Bullet items'],
    ['orderedItems', 'Ordered items'],
    ['nestedItems', 'Nested list items'],
    ['orderedLists', 'Ordered lists'],
    ['orderedStarts', 'Ordered lists not starting at 1'],
    ['itemNumbers', 'Ordered item numbers'],
    ['taskItems', 'Task items'],
    ['checkedTasks', 'Checked task items'],
    ['tables', 'Tables'],
    ['nestedTables', 'Nested tables'],
    ['cells', 'Table cells'],
    ['colspanCells', 'Cells spanning columns'],
    ['rowspanCells', 'Cells spanning rows'],
    ['headerRows', 'Header rows'],
    ['columnWidths', 'Tables with column widths'],
    ['images', 'Images'],
    ['imageWidths', 'Images with a width'],
    ['captions', 'Figure captions'],
    ['wrapped', 'Wrapped figures'],
    ['codeBlocks', 'Code blocks'],
    ['blockquotes', 'Blockquotes'],
    ['rules', 'Horizontal rules'],
    ['pageBreaks', 'Page breaks'],
    ['alignCenter', 'Centered paragraphs'],
    ['alignRight', 'Right-aligned paragraphs'],
    ['alignJustify', 'Justified paragraphs'],
    ['footnotes', 'Footnote and endnote references'],
] as const;

export type Feature = (typeof FEATURES)[number][0];

// Raw occurrences in the story parts; formatting a style carries counts in the features, not here.
const ELEMENTS = [
    'w:p',
    'w:r',
    'w:t',
    'w:tab',
    'w:br',
    'w:br type=page',
    'w:br type=column',
    'w:hyperlink',
    'w:tbl',
    'w:tbl (nested)',
    'w:gridCol',
    'w:gridSpan',
    'w:vMerge',
    'w:tblHeader',
    'w:numPr',
    'w:drawing',
    'wp:inline',
    'wp:anchor',
    'w:pict',
    'v:shape',
    'mc:AlternateContent',
    'w:txbxContent',
    'w:sdt',
    'w14:checkbox',
    'w:fldSimple',
    'w:instrText',
    'w:ins',
    'w:del',
    'w:moveFrom',
    'w:moveTo',
    'w:footnoteReference',
    'w:endnoteReference',
    'w:commentReference',
    'm:oMath',
    'w:sectPr',
    'w:headerReference',
    'w:footerReference',
    'w:hdr',
    'w:ftr',
    'w:pageBreakBefore',
    'w:bookmarkStart',
    'w:object',
    'c:chart',
    'w:bidi',
    'w:rtl',
    'w:smallCaps',
    'w:caps',
    'w:vanish',
    'w:b',
    'w:i',
    'w:u',
    'w:strike',
    'w:dstrike',
    'w:vertAlign',
    'w:color',
    'w:highlight',
    'w:shd',
    'w:rFonts',
    'w:sz',
    'w:jc',
    'w:spacing',
    'w:ind',
];

const ELEMENT_SET = new Set(ELEMENTS);

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const V = 'urn:schemas-microsoft-com:vml';
const O = 'urn:schemas-microsoft-com:office:office';
const W10 = 'urn:schemas-microsoft-com:office:word';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const PREFIXES = new Map([
    [W, 'w'],
    [W14, 'w14'],
    [WP, 'wp'],
    [MC, 'mc'],
    [V, 'v'],
    [M, 'm'],
    [C, 'c'],
]);

const HEADINGS: Feature[] = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7'];

const ALIGNMENTS = new Map<string, Feature>([
    ['center', 'alignCenter'],
    ['right', 'alignRight'],
    ['end', 'alignRight'],
    ['both', 'alignJustify'],
    ['distribute', 'alignJustify'],
    ['justify', 'alignJustify'],
]);

// Lowercased style names, as Word writes the built-in ones.
const QUOTE_STYLES = new Set(['quote', 'intense quote', 'block text']);
const CODE_BLOCK_STYLES = new Set(['code block', 'html preformatted', 'source code', 'macro text']);
const CODE_STYLES = new Set(['code', 'html code', 'html typewriter', 'html keyboard', 'html sample', 'verbatim char']);
const WRAPS = ['wrapSquare', 'wrapTight', 'wrapThrough'];
// Eigen's small text is 75% of the body (eigen-prose.css), the docx writer's 9 pt in 11; a body style a point
// smaller is still body text.
const SMALL = 0.85;
const SECTION_PAGE_BREAKS = new Set(['nextPage', 'oddPage', 'evenPage']);
const SKIPPED_NOTES = new Set(['separator', 'continuationSeparator', 'continuationNotice']);

// Counted per word they touch, and matched as words, so a mark on the wrong words keeps nothing.
const MARKS = new Set<Feature>([
    'bold',
    'italic',
    'underline',
    'strike',
    'subscript',
    'superscript',
    'color',
    'highlight',
    'font',
    'small',
    'code',
    'link',
]);

// A heading's line as shown: Word's number, when it numbers the heading, then its text.
type HeadingLine = { line: string; numbered: boolean };

export type Tally = {
    counts: Map<Feature, number>;
    words: string[];
    numbers: number[];
    marks: Map<Feature, string[]>;
    headings: HeadingLine[];
};

type Span = { text: string; marks: readonly Feature[] };

type FeatureResult = { source: number; imported: number; matched: number; invented: number; kept: number | null };

type FileResult = {
    file: string;
    bytes: number;
    import: 'ok' | 'crash' | 'timeout';
    error?: string;
    sourceError?: string;
    ms: { source: number; import: number };
    images?: number;
    text: { missing: number; extra: number; missingSample: string[]; extraSample: string[] };
    features: Record<string, FeatureResult>;
    elements: Record<string, number>;
};

type RunMeta = {
    name: string;
    importer: string;
    corpus: string;
    files: number;
    crashes: number;
    timeouts: number;
    sourceErrors: number;
    importMs: number;
    totalMs: number;
};

const newTally = (): Tally => ({ counts: new Map(), words: [], numbers: [], marks: new Map(), headings: [] });

function add(tally: Tally, feature: Feature, n = 1): void {
    tally.counts.set(feature, (tally.counts.get(feature) ?? 0) + n);
}

function child(element: XmlElement | undefined, local: string, ns = W): XmlElement | undefined {
    return element && xmlChild(element, ns, local);
}

function val(element: XmlElement | undefined): string | undefined {
    return element && xmlAttr(element, W, 'val');
}

// An on/off property present without w:val is on.
function on(element: XmlElement): boolean {
    return !['0', 'false', 'off'].includes(val(element) ?? 'true');
}

// Not into a match, nor into a text box: its content is walked by its own drawing, once.
function find(root: XmlElement, ns: string, local: string): XmlElement[] {
    const found: XmlElement[] = [];
    const stack = xmlElements(root).reverse();
    for (let element = stack.pop(); element; element = stack.pop()) {
        if (element.ns === ns && element.local === local) found.push(element);
        else if (!(element.ns === W && element.local === 'txbxContent')) stack.push(...xmlElements(element).reverse());
    }
    return found;
}

// Word renders the first choice it understands; every choice in this corpus's era is one Word 2010 reads.
function alternative(element: XmlElement): XmlElement | undefined {
    return child(element, 'Choice', MC) ?? child(element, 'Fallback', MC);
}

// Soft hyphens show only at a line end; the importer spells a non-breaking hyphen U+2011. A word carries every mark any of
// its characters does.
function wordsOf(spans: Span[]): { word: string; marks: Set<Feature> }[] {
    const words: { word: string; marks: Set<Feature> }[] = [];
    let word = '';
    let marks = new Set<Feature>();
    const flush = () => {
        if (word) words.push({ word, marks });
        word = '';
        marks = new Set();
    };
    for (const span of spans) {
        for (const char of span.text.replace(/\u00AD/g, '').replace(/[\u2010\u2011]/g, '-')) {
            if (/[\s\u200B]/u.test(char)) flush();
            else {
                word += char;
                for (const mark of span.marks) marks.add(mark);
            }
        }
    }
    flush();
    return words;
}

function record(tally: Tally, spans: Span[]): string[] {
    const words = wordsOf(spans);
    for (const { word, marks } of words) {
        tally.words.push(word);
        for (const mark of marks) {
            const marked = tally.marks.get(mark) ?? [];
            tally.marks.set(mark, marked);
            marked.push(word);
            add(tally, mark);
        }
    }
    return words.map(({ word }) => word);
}

function nonSpace(text: string): number {
    return text.replace(/[\s\u00AD\u200B]/gu, '').length;
}

const textOf = (spans: Span[]) => spans.map((span) => span.text).join('');

function multisetDiff<T>(source: T[], imported: T[]): { missing: T[]; extra: T[] } {
    const left = new Map<T, number>();
    for (const item of imported) left.set(item, (left.get(item) ?? 0) + 1);
    const missing = source.filter((item) => {
        const n = left.get(item) ?? 0;
        if (n > 0) left.set(item, n - 1);
        return n === 0;
    });
    const extra = imported.filter((item) => {
        const n = left.get(item) ?? 0;
        if (n > 0) left.set(item, n - 1);
        return n > 0;
    });
    return { missing, extra };
}

// ── Source: what Word shows ─────────────────────────────────────────────────────────────────────────────────────

type Styles = {
    chain: (id: string | undefined) => XmlElement[];
    paragraph?: string;
    character?: string;
    rPr?: XmlElement;
    pPr?: XmlElement;
    theme: { major?: string; minor?: string };
};

type ParagraphLook = {
    heading?: number;
    quote: boolean;
    code: boolean;
    caption: boolean;
    jc?: string;
    pageBreakBefore: boolean;
    sectionBreak: boolean;
    rule: boolean;
    // The sides drawn and how: paragraphs in a row sharing them stand in one box.
    borders: string;
    indent: number;
    deletedMark: boolean;
    numId?: string;
    ilvl: number;
    // The paragraph style's run formatting, nearest first, then docDefaults.
    runs: XmlElement[];
};

type Paragraph = { spans: Span[]; image: boolean; breaks: number; quote: boolean; code: boolean; borders: string };

type OpenList = { level: number; ordered: boolean; number: number };

// rule: the borders of an empty paragraph that is a rule unless the next one shares them.
type Chain = { last?: Paragraph; lists: OpenList[]; carry: Span[]; rule?: string };

type Field = { result: boolean; instr: string; link: boolean };

type Scope = { chain: Chain; float: boolean; cell: boolean; note: boolean; fields: Field[] };

type Inline = { scope: Scope; paragraph: Paragraph; runs: XmlElement[]; marks: boolean; link: boolean };

type RunLook = { hidden: boolean; code: boolean; marks: Feature[] };

const newChain = (): Chain => ({ lists: [], carry: [] });

function readStyles(root: XmlElement | undefined, theme: XmlElement | undefined): Styles {
    const byId = new Map<string, XmlElement>();
    let paragraph: string | undefined;
    let character: string | undefined;
    for (const style of root ? xmlChildren(root, W, 'style') : []) {
        const id = xmlAttr(style, W, 'styleId');
        if (!id) continue;
        byId.set(id, style);
        if (!['1', 'true', 'on'].includes(xmlAttr(style, W, 'default') ?? '')) continue;
        const type = xmlAttr(style, W, 'type');
        if (type === 'paragraph') paragraph = id;
        if (type === 'character') character = id;
    }
    const chains = new Map<string, XmlElement[]>();
    const defaults = child(root, 'docDefaults');
    const scheme = child(child(theme, 'themeElements', A), 'fontScheme', A);
    const typeface = (font: string) => {
        const latin = child(child(scheme, font, A), 'latin', A);
        return latin && xmlAttr(latin, '', 'typeface');
    };
    return {
        chain: (id) => {
            if (!id) return [];
            const cached = chains.get(id);
            if (cached) return cached;
            const chain: XmlElement[] = [];
            for (let style = byId.get(id); style && !chain.includes(style); ) {
                chain.push(style);
                const basedOn = val(child(style, 'basedOn'));
                style = basedOn === undefined ? undefined : byId.get(basedOn);
            }
            chains.set(id, chain);
            return chain;
        },
        paragraph,
        character,
        rPr: child(child(defaults, 'rPrDefault'), 'rPr'),
        pPr: child(child(defaults, 'pPrDefault'), 'pPr'),
        theme: { major: typeface('majorFont'), minor: typeface('minorFont') },
    };
}

function styleName(style: XmlElement): string {
    return (val(child(style, 'name')) ?? xmlAttr(style, W, 'styleId') ?? '').toLowerCase();
}

function first(sources: XmlElement[], local: string): XmlElement | undefined {
    for (const source of sources) {
        const found = child(source, local);
        if (found) return found;
    }
    return undefined;
}

// Counters per abstract definition, as Word keeps them: lists sharing one continue, a start override restarts once.
function readNumbering(root: XmlElement | undefined) {
    const abstracts = new Map<string, XmlElement>();
    const linked = new Map<string, string>();
    for (const abstract of root ? xmlChildren(root, W, 'abstractNum') : []) {
        const id = xmlAttr(abstract, W, 'abstractNumId');
        if (id === undefined) continue;
        abstracts.set(id, abstract);
        const link = val(child(abstract, 'styleLink'));
        if (link) linked.set(link, id);
    }
    const nums = new Map<string, XmlElement>();
    for (const num of root ? xmlChildren(root, W, 'num') : []) {
        const id = xmlAttr(num, W, 'numId');
        if (id !== undefined) nums.set(id, num);
    }
    const counters = new Map<string, number[]>();
    const restarted = new Set<string>();
    return (numId: string, ilvl: number): { ordered: boolean; number: number; label: string } | undefined => {
        const num = nums.get(numId);
        let abstractId = val(child(num, 'abstractNumId'));
        const styleLink = val(child(abstractId === undefined ? undefined : abstracts.get(abstractId), 'numStyleLink'));
        if (styleLink) abstractId = linked.get(styleLink) ?? abstractId;
        const abstract = abstractId === undefined ? undefined : abstracts.get(abstractId);
        if (!num || !abstract || abstractId === undefined) return undefined;
        const levelAt = (at: number) => {
            const override = xmlChildren(num, W, 'lvlOverride').find((o) => xmlAttr(o, W, 'ilvl') === String(at));
            const level = (element: XmlElement | undefined) =>
                element && xmlChildren(element, W, 'lvl').find((lvl) => xmlAttr(lvl, W, 'ilvl') === String(at));
            return { override, lvl: level(override) ?? level(abstract) };
        };
        const { override, lvl } = levelAt(ilvl);
        if (!lvl) return undefined;
        const overrideStart = val(child(override, 'startOverride'));
        // ECMA-376 17.9.25: an omitted start is 0.
        const startOf = (level: XmlElement | undefined) => Number(val(child(level, 'start')) ?? 0);
        const counter = counters.get(abstractId) ?? [];
        counters.set(abstractId, counter);
        const restart = `${numId}:${ilvl}`;
        let number = counter[ilvl] === undefined ? startOf(lvl) : counter[ilvl] + 1;
        if (overrideStart !== undefined && !restarted.has(restart)) {
            restarted.add(restart);
            number = Number(overrideStart);
        }
        counter[ilvl] = number;
        counter.length = ilvl + 1;
        const format = val(child(lvl, 'numFmt')) ?? 'decimal';
        if (format === 'none') return undefined;
        const legal = !!child(lvl, 'isLgl');
        const text = (val(child(lvl, 'lvlText')) ?? '').replace(/%([1-9])/g, (_, at: string) => {
            const level = levelAt(Number(at) - 1).lvl;
            const value = counter[Number(at) - 1] ?? startOf(level);
            return spell(value, legal ? 'decimal' : (val(child(level, 'numFmt')) ?? 'decimal'));
        });
        const suffix = val(child(lvl, 'suff')) ?? 'tab';
        return { ordered: format !== 'bullet', number, label: suffix === 'nothing' ? text : `${text} ` };
    };
}

const ROMAN: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
];

// The number formats Word spells most; any other reads as decimal.
function spell(value: number, format: string): string {
    if (format === 'decimalZero' && value < 10) return `0${value}`;
    if ((format === 'lowerLetter' || format === 'upperLetter') && value > 0) {
        // Word's 27th is aa, its 28th bb.
        const letter = String.fromCharCode(97 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1);
        return format === 'upperLetter' ? letter.toUpperCase() : letter;
    }
    if ((format === 'lowerRoman' || format === 'upperRoman') && value > 0) {
        let roman = '';
        let rest = value;
        for (const [n, digits] of ROMAN) {
            for (; rest >= n; rest -= n) roman += digits;
        }
        return format === 'lowerRoman' ? roman.toLowerCase() : roman;
    }
    return String(value);
}

function countElements(root: XmlElement, into: Map<string, number>): void {
    const bump = (label: string) => into.set(label, (into.get(label) ?? 0) + 1);
    const stack: [XmlElement, number][] = [[root, 0]];
    for (let next = stack.pop(); next; next = stack.pop()) {
        const [element, tables] = next;
        const prefix = PREFIXES.get(element.ns);
        let label = prefix && `${prefix}:${element.local}`;
        if (label === 'w:br') {
            const type = xmlAttr(element, W, 'type');
            if (type === 'page' || type === 'column') label = `w:br type=${type}`;
        }
        if (label && ELEMENT_SET.has(label)) bump(label);
        if (label === 'w:tbl' && tables > 0) bump('w:tbl (nested)');
        for (const inner of xmlElements(element)) stack.push([inner, tables + (label === 'w:tbl' ? 1 : 0)]);
    }
}

// Word's view: deleted and moved-away text, field instructions and hidden runs are no text, and a field's result is.
// Formatting a structure draws (a heading's, a quote's, a note's, a task's paragraph style) is the structure's, not a
// mark; a link's color and underline count only when set on the run itself. Table styles are not resolved.
export function auditSource(bytes: ArrayBuffer | Uint8Array): Tally & { elements: Map<string, number> } {
    const zip = openZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const read = (part: string | undefined) => {
        const xml = part === undefined ? undefined : zip.read(part);
        const root = xml && parseXml(xml);
        if (root) toTransitional(root);
        return root ?? undefined;
    };
    const relationships = (part: string) => {
        const directory = path.posix.dirname(part);
        const rels = read(path.posix.join(directory, '_rels', `${path.posix.basename(part)}.rels`));
        return (rels ? xmlChildren(rels, REL, 'Relationship') : [])
            .filter((rel) => xmlAttr(rel, '', 'TargetMode') !== 'External')
            .map((rel) => {
                const target = xmlAttr(rel, '', 'Target') ?? '';
                return {
                    type: (xmlAttr(rel, '', 'Type') ?? '').split('/').at(-1),
                    part: target.startsWith('/') ? target.slice(1) : path.posix.join(directory, target),
                };
            });
    };
    const main = relationships('').find((rel) => rel.type === 'officeDocument')?.part ?? 'word/document.xml';
    const related = relationships(main);
    const partOf = (type: string) => related.find((rel) => rel.type === type)?.part;
    const document = read(main);
    if (!document) throw new Error(`${main} missing`);
    const footnotes = read(partOf('footnotes'));
    const endnotes = read(partOf('endnotes'));
    const styles = readStyles(read(partOf('styles')), read(partOf('theme')));
    const numberItem = readNumbering(read(partOf('numbering')));

    const elements = new Map<string, number>();
    const stories = [document, footnotes, endnotes, read(partOf('comments'))];
    for (const rel of related) if (rel.type === 'header' || rel.type === 'footer') stories.push(read(rel.part));
    for (const story of stories) if (story) countElements(story, elements);

    const tally = newTally();
    const paragraphLook = (pPr: XmlElement | undefined): ParagraphLook => {
        const chain = styles.chain(val(child(pPr, 'pStyle')) ?? styles.paragraph);
        const names = chain.map(styleName);
        const pPrs = [pPr, ...chain.map((style) => child(style, 'pPr')), styles.pPr].flatMap((p) => p ?? []);
        // Word's Title is H1 in Eigen (PROPOSAL_DOCX.md, Decision 8). The nearest style that names a level decides,
        // and outline level 9 is body text, as a TOC Heading based on Heading 1 sets it.
        let heading: number | undefined;
        for (const [index, style] of chain.entries()) {
            const named = Number(names[index].match(/^heading ([1-9])$/)?.[1] ?? (names[index] === 'title' ? 1 : 0));
            const outline = val(child(child(style, 'pPr'), 'outlineLvl'));
            if (!named && outline === undefined) continue;
            heading = named || (Number(outline) < 9 ? Number(outline) + 1 : undefined);
            break;
        }
        // numId and ilvl resolve apart: a paragraph may set its level on a style's list.
        const numPr = (local: string) => val(pPrs.map((p) => child(child(p, 'numPr'), local)).find(Boolean));
        const pageBreakBefore = first(pPrs, 'pageBreakBefore');
        const pBdr = first(pPrs, 'pBdr');
        const drawn = ['top', 'left', 'bottom', 'right', 'between'].flatMap((side) => {
            const border = child(pBdr, side);
            const style = val(border);
            return border && style && !['none', 'nil'].includes(style) ? [{ side, border, style }] : [];
        });
        const only = (side: string) => drawn.length === 1 && drawn[0].side === side;
        const code = names.some((name) => CODE_BLOCK_STYLES.has(name));
        const section = child(pPr, 'sectPr');
        const left = pPrs
            .map((p) => child(p, 'ind'))
            .map((ind) => ind && (xmlAttr(ind, W, 'left') ?? xmlAttr(ind, W, 'start')))
            .find((value) => value !== undefined);
        return {
            heading,
            code,
            quote: !code && (names.some((name) => QUOTE_STYLES.has(name)) || (heading === undefined && only('left'))),
            caption: names.includes('caption'),
            jc: val(first(pPrs, 'jc')),
            pageBreakBefore: !!pageBreakBefore && on(pageBreakBefore),
            sectionBreak: !!section && SECTION_PAGE_BREAKS.has(val(child(section, 'type')) ?? 'nextPage'),
            rule: only('bottom'),
            borders: drawn
                .map(({ side, border, style }) =>
                    [side, style, xmlAttr(border, W, 'sz'), xmlAttr(border, W, 'color')].join(':'),
                )
                .join(' '),
            indent: Number(left ?? 0),
            deletedMark: !!child(child(pPr, 'rPr'), 'del'),
            numId: numPr('numId'),
            ilvl: Number(numPr('ilvl') ?? 0),
            runs: [...chain.flatMap((style) => child(style, 'rPr') ?? []), ...(styles.rPr ? [styles.rPr] : [])],
        };
    };

    const fontOf = (sources: XmlElement[]) => {
        for (const source of sources) {
            const fonts = child(source, 'rFonts');
            if (!fonts) continue;
            const theme = xmlAttr(fonts, W, 'asciiTheme') ?? xmlAttr(fonts, W, 'hAnsiTheme');
            if (theme)
                return ((theme.startsWith('major') ? styles.theme.major : styles.theme.minor) ?? theme).toLowerCase();
            const name = xmlAttr(fonts, W, 'ascii') ?? xmlAttr(fonts, W, 'hAnsi');
            if (name) return name.toLowerCase();
        }
        return undefined;
    };
    const colorOf = (sources: XmlElement[]) => {
        const color = val(first(sources, 'color'))?.toUpperCase();
        return !color || color === 'AUTO' ? '000000' : color;
    };
    const sizeOf = (sources: XmlElement[]) => Number(val(first(sources, 'sz')) ?? 20);
    // What a run in a plain paragraph looks like: the text a mark stands out from.
    const { runs: plain, indent } = paragraphLook(undefined);
    const base = { font: fontOf(plain), color: colorOf(plain), size: sizeOf(plain), indent };

    const runLook = (rPr: XmlElement | undefined, context: Inline): RunLook => {
        const chain = styles.chain(val(child(rPr, 'rStyle')) ?? styles.character);
        const characterRuns = chain.flatMap((style) => child(style, 'rPr') ?? []);
        const direct = rPr ? [rPr] : [];
        const sources = [...direct, ...characterRuns, ...context.runs];
        // Toggles (ECMA-376 17.7.3): direct formatting sets the value; the character and paragraph styles each toggle it.
        const toggle = (local: string) => {
            const set = child(rPr, local);
            if (set) return on(set);
            const byCharacter = first(characterRuns, local);
            const byParagraph = first(context.runs, local);
            return (!!byCharacter && on(byCharacter)) !== (!!byParagraph && on(byParagraph));
        };
        const linked = context.link || context.scope.fields.some((field) => field.link);
        const own = linked ? direct : sources;
        // MS-OI29500 2.1.100: a w:u without w:val takes the style hierarchy's, and none at its end.
        const underline = own.map((source) => val(child(source, 'u'))).find((value) => value !== undefined);
        const vertAlign = val(first(sources, 'vertAlign'));
        const highlight = val(first(sources, 'highlight'));
        const shading = first(sources, 'shd');
        const fill = shading && xmlAttr(shading, W, 'fill')?.toUpperCase();
        const marks: [Feature, boolean][] = [
            ['bold', toggle('b')],
            ['italic', toggle('i')],
            ['underline', underline !== undefined && underline !== 'none'],
            ['strike', toggle('strike') || toggle('dstrike')],
            ['subscript', vertAlign === 'subscript'],
            ['superscript', vertAlign === 'superscript'],
            ['color', own.some((source) => child(source, 'color')) && colorOf(own) !== base.color],
            ['highlight', (!!highlight && highlight !== 'none') || (!!fill && fill !== 'AUTO' && fill !== 'FFFFFF')],
            ['font', (fontOf(sources) ?? base.font) !== base.font],
            ['small', sizeOf(sources) <= base.size * SMALL],
            ['link', linked],
        ];
        return {
            hidden: toggle('vanish'),
            code: chain.some((style) => CODE_STYLES.has(styleName(style))),
            marks: marks.filter(([, set]) => set).map(([feature]) => feature),
        };
    };

    const visible = (scope: Scope) => scope.fields.every((field) => field.result);

    const text = (value: string, context: Inline, look: RunLook | undefined) => {
        const marks: readonly Feature[] = !context.marks || !look ? [] : look.code ? ['code'] : look.marks;
        context.paragraph.spans.push({ text: value, marks });
    };
    const space = (context: Inline) => context.paragraph.spans.push({ text: ' ', marks: [] });

    const drawing = (element: XmlElement, context: Inline) => {
        for (const holder of xmlElements(element)) {
            if (holder.ns !== WP) continue;
            const blips = find(holder, A, 'blip').filter(
                (blip) => xmlAttr(blip, R, 'embed') || xmlAttr(blip, R, 'link'),
            );
            const extent = child(holder, 'extent', WP);
            if (blips.length > 0) {
                add(tally, 'images', blips.length);
                if (Number(extent && xmlAttr(extent, '', 'cx')) > 0) add(tally, 'imageWidths', blips.length);
                if (holder.local === 'anchor' && WRAPS.some((wrap) => child(holder, wrap, WP))) {
                    add(tally, 'wrapped', blips.length);
                } else context.paragraph.image = true;
            }
            for (const box of find(holder, W, 'txbxContent'))
                blocks(box, { ...context.scope, chain: newChain(), fields: [] });
        }
    };

    const vml = (element: XmlElement, context: Inline) => {
        const shapes = [...find(element, V, 'shape'), ...find(element, V, 'rect')];
        if (shapes.some((shape) => ['t', 'true'].includes(xmlAttr(shape, O, 'hr') ?? ''))) add(tally, 'rules');
        for (const shape of shapes) {
            const image = child(shape, 'imagedata', V);
            if (!image || !xmlAttr(image, R, 'id')) continue;
            add(tally, 'images');
            if (/(^|;)\s*width\s*:/.test(xmlAttr(shape, '', 'style') ?? '')) add(tally, 'imageWidths');
            const wrap = child(shape, 'wrap', W10);
            if (wrap && ['square', 'tight', 'through'].includes(xmlAttr(wrap, '', 'type') ?? '')) add(tally, 'wrapped');
            else context.paragraph.image = true;
        }
        for (const box of find(element, W, 'txbxContent'))
            blocks(box, { ...context.scope, chain: newChain(), fields: [] });
    };

    const runContent = (container: XmlElement, look: RunLook, context: Inline) => {
        const { fields } = context.scope;
        for (const node of xmlElements(container)) {
            if (node.ns === MC && node.local === 'AlternateContent') {
                const choice = alternative(node);
                if (choice) runContent(choice, look, context);
                continue;
            }
            if (node.ns !== W) continue;
            const shown = visible(context.scope) && !look.hidden;
            switch (node.local) {
                case 't':
                    if (shown) text(xmlText(node), context, look);
                    break;
                case 'noBreakHyphen':
                    if (shown) text('-', context, look);
                    break;
                case 'tab':
                case 'ptab':
                case 'cr':
                    if (shown) space(context);
                    break;
                case 'br':
                    if (!shown) break;
                    space(context);
                    if (xmlAttr(node, W, 'type') !== 'page') break;
                    add(tally, 'pageBreaks');
                    context.paragraph.breaks++;
                    break;
                case 'fldChar': {
                    const type = xmlAttr(node, W, 'fldCharType');
                    if (type === 'begin') {
                        fields.push({ result: false, instr: '', link: false });
                        const box = child(child(node, 'ffData'), 'checkBox');
                        if (box && shown) {
                            add(tally, 'taskItems');
                            const state = child(box, 'checked') ?? child(box, 'default');
                            if (state && on(state)) add(tally, 'checkedTasks');
                        }
                    }
                    const field = fields.at(-1);
                    if (type === 'separate' && field) {
                        field.result = true;
                        field.link = /^\s*HYPERLINK\b/i.test(field.instr);
                    }
                    if (type === 'end') fields.pop();
                    break;
                }
                case 'instrText': {
                    const field = fields.at(-1);
                    if (field) field.instr += xmlText(node);
                    break;
                }
                case 'drawing':
                    if (shown) drawing(node, context);
                    break;
                case 'pict':
                    if (shown) vml(node, context);
                    break;
                case 'footnoteReference':
                case 'endnoteReference':
                    if (!shown) break;
                    // Its number is the note's, not text: a word boundary, as on the imported side.
                    space(context);
                    add(tally, 'footnotes');
                    break;
            }
        }
    };

    const inline = (container: XmlElement, context: Inline) => {
        for (const node of xmlElements(container)) {
            if (node.ns === MC && node.local === 'AlternateContent') {
                const choice = alternative(node);
                if (choice) inline(choice, context);
                continue;
            }
            if (node.ns === M && node.local === 't') {
                if (visible(context.scope)) text(xmlText(node), context, undefined);
                continue;
            }
            if (node.ns !== W) {
                inline(node, context);
                continue;
            }
            switch (node.local) {
                case 'r':
                    runContent(node, runLook(child(node, 'rPr'), context), context);
                    break;
                case 'hyperlink':
                    inline(node, { ...context, link: true });
                    break;
                case 'fldSimple':
                    inline(node, {
                        ...context,
                        link: context.link || /^\s*HYPERLINK\b/i.test(xmlAttr(node, W, 'instr') ?? ''),
                    });
                    break;
                case 'sdt': {
                    const box = child(child(node, 'sdtPr'), 'checkbox', W14);
                    if (!box) {
                        const content = child(node, 'sdtContent');
                        if (content) inline(content, context);
                    } else if (visible(context.scope)) {
                        add(tally, 'taskItems');
                        const checked = child(box, 'checked', W14);
                        if (checked && ['1', 'true'].includes(xmlAttr(checked, W14, 'val') ?? ''))
                            add(tally, 'checkedTasks');
                    }
                    break;
                }
                case 'del':
                case 'moveFrom':
                case 'pPr':
                case 'rPr':
                case 'sdtPr':
                    break;
                default:
                    inline(node, context);
            }
        }
    };

    const paragraph = (element: XmlElement, scope: Scope) => {
        const look = paragraphLook(child(element, 'pPr'));
        const { chain } = scope;
        if (chain.rule !== undefined && chain.rule !== look.borders) add(tally, 'rules');
        chain.rule = undefined;
        const previous = chain.last;
        const caption = look.caption && !!previous?.image;
        const structural =
            look.heading !== undefined ||
            look.quote ||
            look.code ||
            caption ||
            scope.note ||
            find(element, W14, 'checkbox').length > 0;
        const numbered = look.numId && look.numId !== '0' ? numberItem(look.numId, look.ilvl) : undefined;
        // A heading can't stand in an Eigen list: Word shows its number as text, which survives as text or not at all.
        const label = look.heading !== undefined && numbered?.ordered ? numbered.label : undefined;
        const current: Paragraph = {
            spans: [...(label ? [{ text: label, marks: [] }] : []), ...chain.carry],
            image: false,
            breaks: 0,
            quote: look.quote,
            code: look.code,
            borders: look.borders,
        };
        chain.carry = [];
        const item = look.heading === undefined ? numbered : undefined;
        if (item) {
            add(tally, 'listItems');
            add(tally, item.ordered ? 'orderedItems' : 'bulletItems');
            if (look.ilvl > 0) add(tally, 'nestedItems');
            if (item.ordered) tally.numbers.push(item.number);
            const open = chain.lists;
            while ((open.at(-1)?.level ?? -1) > look.ilvl) open.pop();
            const top = open.at(-1);
            if (
                top?.level === look.ilvl &&
                top.ordered === item.ordered &&
                (!item.ordered || item.number === top.number + 1)
            ) {
                top.number = item.number;
            } else {
                if (top?.level === look.ilvl) open.pop();
                open.push({ level: look.ilvl, ordered: item.ordered, number: item.number });
                if (item.ordered) {
                    add(tally, 'orderedLists');
                    if (item.number !== 1) add(tally, 'orderedStarts');
                }
            }
        }
        inline(element, {
            scope,
            paragraph: current,
            runs: structural ? (styles.rPr ? [styles.rPr] : []) : look.runs,
            marks: !look.code && !caption,
            link: false,
        });
        // A deleted paragraph mark joins the paragraph to the next.
        if (look.deletedMark) {
            chain.carry = current.spans;
            return;
        }
        const words = record(tally, current.spans);
        const hasText = nonSpace(textOf(current.spans)) > 0;
        if (look.pageBreakBefore) add(tally, 'pageBreaks');
        if (look.sectionBreak) add(tally, 'pageBreaks');
        // A paragraph holding only a page break is the break, a block in Eigen: the quote, code or list around it goes on.
        if (!hasText && !current.image && current.breaks > 0) return;
        // Word numbers on across an item's empty paragraphs and those indented past the body; a body paragraph or heading
        // ends the list.
        if (!item && hasText && (look.indent <= base.indent || look.heading !== undefined)) chain.lists = [];
        chain.last = current;
        if (!scope.float && !caption && (hasText || current.image)) {
            add(tally, 'paragraphs');
            if (look.heading && hasText) {
                add(tally, HEADINGS[Math.min(look.heading, 7) - 1]);
                if (label) add(tally, 'numberedHeadings');
                tally.headings.push({ line: words.join(' '), numbered: !!label });
            }
            const alignment = look.jc && ALIGNMENTS.get(look.jc);
            if (alignment && hasText && !look.code) add(tally, alignment);
        }
        if (caption && hasText) add(tally, 'captions');
        if (look.code && !previous?.code) add(tally, 'codeBlocks');
        if (look.quote && !previous?.quote) add(tally, 'blockquotes');
        if (look.rule && !hasText && !current.image && previous?.borders !== look.borders) chain.rule = look.borders;
    };

    const settle = (chain: Chain) => {
        if (chain.rule !== undefined) add(tally, 'rules');
        chain.rule = undefined;
    };

    // Rows and cells may sit in content controls or custom XML.
    const within = (element: XmlElement, local: string): XmlElement[] =>
        xmlElements(element).flatMap((node) => {
            if (node.ns !== W) return [];
            if (node.local === local) return [node];
            if (node.local === 'sdt') {
                const content = child(node, 'sdtContent');
                return content ? within(content, local) : [];
            }
            return node.local === 'customXml' ? within(node, local) : [];
        });

    // False for a floating figure, which stands outside the flow around it.
    const table = (element: XmlElement, scope: Scope): boolean => {
        const rows = within(element, 'tr').filter((row) => !child(child(row, 'trPr'), 'del'));
        const cells = rows.map((row) => within(row, 'tc'));
        const only = cells.length === 1 && cells[0].length === 1 ? cells[0][0] : undefined;
        // The writer's wrapped figure, and Word's floating picture-in-a-table: a figure, not a table.
        if (
            only &&
            child(child(element, 'tblPr'), 'tblpPr') &&
            (find(only, A, 'blip').length > 0 || find(only, V, 'imagedata').length > 0)
        ) {
            add(tally, 'wrapped');
            blocks(only, { ...scope, chain: newChain(), float: true });
            return false;
        }
        add(tally, 'tables');
        if (scope.cell) add(tally, 'nestedTables');
        const grid = xmlChildren(child(element, 'tblGrid') ?? element, W, 'gridCol');
        if (grid.some((column) => Number(xmlAttr(column, W, 'w')) > 0)) add(tally, 'columnWidths');
        const placed = rows.map((row, index) => {
            const trPr = child(row, 'trPr');
            const header = child(trPr, 'tblHeader');
            if (header && on(header)) add(tally, 'headerRows');
            let column = Number(val(child(trPr, 'gridBefore')) ?? 0);
            return cells[index].map((cell) => {
                const tcPr = child(cell, 'tcPr');
                const span = Number(val(child(tcPr, 'gridSpan')) ?? 1) || 1;
                const merge = child(tcPr, 'vMerge');
                const at = { cell, column, span, merge: merge && (val(merge) === 'restart' ? 'restart' : 'continue') };
                column += span;
                return at;
            });
        });
        for (const [index, row] of placed.entries()) {
            for (const { cell, column, span, merge } of row) {
                if (merge === 'continue') continue;
                add(tally, 'cells');
                if (span > 1) add(tally, 'colspanCells');
                const below = placed[index + 1]?.find((next) => next.column === column);
                if (merge === 'restart' && below?.merge === 'continue') add(tally, 'rowspanCells');
                blocks(cell, { ...scope, chain: newChain(), cell: true });
            }
        }
        return true;
    };

    const blocks = (container: XmlElement, scope: Scope) => {
        for (const node of xmlElements(container)) {
            if (node.ns === MC && node.local === 'AlternateContent') {
                const choice = alternative(node);
                if (choice) blocks(choice, scope);
                continue;
            }
            if (node.ns === W && node.local === 'p') paragraph(node, scope);
            else if (node.ns === W && node.local === 'tbl') {
                settle(scope.chain);
                if (table(node, scope)) {
                    scope.chain.last = undefined;
                    scope.chain.lists = [];
                }
            } else if (
                !(
                    node.ns === W &&
                    ['del', 'moveFrom', 'sdtPr', 'sdtEndPr', 'sectPr', 'tblPr', 'pPr'].includes(node.local)
                )
            ) {
                blocks(node, scope);
            }
        }
        record(tally, scope.chain.carry);
        scope.chain.carry = [];
        settle(scope.chain);
    };

    const body = child(document, 'body');
    if (body) blocks(body, { chain: newChain(), float: false, cell: false, note: false, fields: [] });
    for (const notes of [footnotes, endnotes]) {
        for (const note of notes ? xmlElements(notes) : []) {
            if (SKIPPED_NOTES.has(xmlAttr(note, W, 'type') ?? '')) continue;
            blocks(note, { chain: newChain(), float: false, cell: false, note: true, fields: [] });
        }
    }
    tally.counts.set('text', tally.words.length);
    tally.counts.set('itemNumbers', tally.numbers.length);
    return { ...tally, elements };
}

// ── Imported: what the eigendoc JSON holds ──────────────────────────────────────────────────────────────────────

const MARK_FEATURES = new Map<string | undefined, Feature>([
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['underline', 'underline'],
    ['strike', 'strike'],
    ['subscript', 'subscript'],
    ['superscript', 'superscript'],
    ['highlight', 'highlight'],
    ['small', 'small'],
    ['code', 'code'],
    ['link', 'link'],
]);

// 1, 1.2, 1.2.3., 4), a., (b), iv., B): an imported heading that starts with one looks numbered.
const NUMBER_LABEL = /^\s*(?:\d+(?:\.\d+)*[.)]?|\(?(?:[a-z]+|[A-Z]+)[.)])\s/;

type Place = { depth: number; table: boolean; quote: boolean; align?: unknown };

export function auditImported(json: JSONContent): Tally {
    const tally = newTally();
    const textblock = (node: JSONContent, align: unknown) => {
        const spans: Span[] = [];
        const space = () => spans.push({ text: ' ', marks: [] });
        let figure = false;
        let footnoteHref: unknown;
        for (const inline of node.content ?? []) {
            if (inline.type === 'figure') {
                const attrs = inline.attrs ?? {};
                space();
                if (!attrs['mediaName'] && !attrs['src']) continue;
                add(tally, 'images');
                if (typeof attrs['width'] === 'number' && attrs['width'] > 0) add(tally, 'imageWidths');
                const caption = attrs['caption'];
                if (typeof caption === 'string' && nonSpace(caption) > 0) {
                    add(tally, 'captions');
                    record(tally, [{ text: caption, marks: [] }]);
                }
                if (attrs['layout'] === 'wrap-left' || attrs['layout'] === 'wrap-right') add(tally, 'wrapped');
                else figure = true;
                continue;
            }
            if (inline.type !== 'text') {
                space();
                continue;
            }
            const value = inline.text ?? '';
            const marks = inline.marks ?? [];
            const href = marks.find((mark) => mark.type === 'link')?.attrs?.['href'];
            // A footnote reference with no node of its own: a superscript link into the document. Its marker is no text.
            const reference =
                typeof href === 'string' && href.startsWith('#') && marks.some((mark) => mark.type === 'superscript');
            if (reference && href !== footnoteHref) add(tally, 'footnotes');
            footnoteHref = reference ? href : undefined;
            if (reference) {
                space();
                continue;
            }
            const features: Feature[] = [];
            for (const mark of marks) {
                const attrs = mark.attrs ?? {};
                const feature = MARK_FEATURES.get(mark.type);
                if (feature) features.push(feature);
                if (mark.type !== 'textStyle') continue;
                const color = attrs['color'];
                if (typeof color === 'string' && color && cssColorToHex(color) !== '000000') features.push('color');
                if (typeof attrs['fontFamily'] === 'string' && attrs['fontFamily']) features.push('font');
            }
            spans.push({ text: value, marks: features });
        }
        const words = record(tally, spans);
        const text = textOf(spans);
        const hasText = nonSpace(text) > 0;
        if (!hasText && !figure) return;
        add(tally, 'paragraphs');
        if (!hasText) return;
        const level = node.attrs?.['level'];
        if (node.type === 'heading' && typeof level === 'number') {
            add(tally, HEADINGS[Math.min(Math.max(level, 1), 7) - 1]);
            const numbered = NUMBER_LABEL.test(text);
            if (numbered) add(tally, 'numberedHeadings');
            tally.headings.push({ line: words.join(' '), numbered });
        }
        // A cell's alignment aligns its paragraphs.
        const alignment = ALIGNMENTS.get(String(node.attrs?.['textAlign'] ?? align));
        if (alignment) add(tally, alignment);
    };
    const visit = (node: JSONContent, place: Place) => {
        const children = node.content ?? [];
        switch (node.type) {
            case 'paragraph':
            case 'heading':
                textblock(node, place.align);
                return;
            case 'codeBlock': {
                add(tally, 'codeBlocks');
                const text = children.map((inline) => inline.text ?? '').join('');
                record(tally, [{ text, marks: [] }]);
                add(tally, 'paragraphs', text.split('\n').filter((line) => nonSpace(line) > 0).length);
                return;
            }
            case 'blockquote':
                if (!place.quote) add(tally, 'blockquotes');
                for (const inner of children) visit(inner, { ...place, quote: true });
                return;
            case 'horizontalRule':
                add(tally, 'rules');
                return;
            case 'pageBreak':
                add(tally, 'pageBreaks');
                return;
            case 'bulletList':
            case 'orderedList':
            case 'taskList': {
                const ordered = node.type === 'orderedList';
                const start = node.attrs?.['start'];
                const from = typeof start === 'number' ? start : 1;
                if (ordered) {
                    add(tally, 'orderedLists');
                    if (from !== 1) add(tally, 'orderedStarts');
                }
                for (const [index, item] of children.entries()) {
                    if (item.type === 'taskItem') {
                        add(tally, 'taskItems');
                        if (item.attrs?.['checked'] === true) add(tally, 'checkedTasks');
                    } else {
                        add(tally, 'listItems');
                        add(tally, ordered ? 'orderedItems' : 'bulletItems');
                        if (place.depth > 0) add(tally, 'nestedItems');
                        if (ordered) tally.numbers.push(from + index);
                    }
                    for (const inner of item.content ?? []) visit(inner, { ...place, depth: place.depth + 1 });
                }
                return;
            }
            case 'table': {
                add(tally, 'tables');
                if (place.table) add(tally, 'nestedTables');
                let widths = false;
                for (const row of children) {
                    const cells = row.content ?? [];
                    if (cells.length > 0 && cells.every((cell) => cell.type === 'tableHeader'))
                        add(tally, 'headerRows');
                    for (const cell of cells) {
                        add(tally, 'cells');
                        const { colspan, rowspan, colwidth } = cell.attrs ?? {};
                        if (typeof colspan === 'number' && colspan > 1) add(tally, 'colspanCells');
                        if (typeof rowspan === 'number' && rowspan > 1) add(tally, 'rowspanCells');
                        if (Array.isArray(colwidth) && colwidth.some((width) => typeof width === 'number' && width > 0))
                            widths = true;
                        for (const inner of cell.content ?? []) {
                            visit(inner, { ...place, table: true, align: cell.attrs?.['align'] });
                        }
                    }
                }
                if (widths) add(tally, 'columnWidths');
                return;
            }
            default:
                for (const inner of children) visit(inner, place);
        }
    };
    visit(json, { depth: 0, table: false, quote: false });
    tally.counts.set('text', tally.words.length);
    tally.counts.set('itemNumbers', tally.numbers.length);
    return tally;
}

// ── Comparing the two sides ─────────────────────────────────────────────────────────────────────────────────────

const SAMPLE = 20;

// Text, marks and item numbers match as multisets of words and numbers, so a word moved, a mark on another word or
// a list renumbered is a loss, and what has no match on the source side is invented. A numbered heading matches the
// whole line Word shows. Every other feature keeps at most what the source holds, so an importer can't make up in one
// feature what it loses in another, and invents what it holds beyond it.
export function compareTallies(source: Tally, imported: Tally): Pick<FileResult, 'text' | 'features'> {
    const words = multisetDiff(source.words, imported.words);
    const numbers = multisetDiff(source.numbers, imported.numbers);
    const lines = (tally: Tally, numbered?: boolean) =>
        tally.headings.filter((heading) => numbered === undefined || heading.numbered).map(({ line }) => line);
    const diffs = new Map<Feature, { missing: unknown[]; extra: unknown[] }>([
        ['text', words],
        ['itemNumbers', numbers],
        [
            'numberedHeadings',
            {
                missing: multisetDiff(lines(source, true), lines(imported)).missing,
                extra: multisetDiff(lines(source), lines(imported, true)).extra,
            },
        ],
        ...[...MARKS].map((mark): [Feature, { missing: unknown[]; extra: unknown[] }] => [
            mark,
            multisetDiff(source.marks.get(mark) ?? [], imported.marks.get(mark) ?? []),
        ]),
    ]);
    const features: Record<string, FeatureResult> = {};
    for (const [feature] of FEATURES) {
        const from = source.counts.get(feature) ?? 0;
        const to = imported.counts.get(feature) ?? 0;
        const diff = diffs.get(feature);
        const matched = diff ? from - diff.missing.length : Math.min(from, to);
        const invented = diff ? diff.extra.length : Math.max(0, to - from);
        features[feature] = { source: from, imported: to, matched, invented, kept: from > 0 ? matched / from : null };
    }
    return {
        text: {
            missing: words.missing.length,
            extra: words.extra.length,
            missingSample: words.missing.slice(0, SAMPLE),
            extraSample: words.extra.slice(0, SAMPLE),
        },
        features,
    };
}

type Row = { files: number; source: number; imported: number; matched: number; invented: number };

const emptyRow = (): Row => ({ files: 0, source: 0, imported: 0, matched: 0, invented: 0 });

function aggregate(results: FileResult[]): Map<string, Row> {
    const rows = new Map<string, Row>(FEATURES.map(([feature]) => [feature, emptyRow()]));
    for (const result of results) {
        for (const [feature, row] of rows) {
            const counts = result.features[feature];
            if (!counts) continue;
            if (counts.source > 0) row.files++;
            row.source += counts.source;
            row.imported += counts.imported;
            row.matched += counts.matched;
            row.invented += counts.invented;
        }
    }
    return rows;
}

function percent(matched: number, source: number): string {
    return source > 0 ? `${((matched / source) * 100).toFixed(1)}%` : '–';
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

function summaryMarkdown(meta: RunMeta, results: FileResult[]): string {
    const rows = aggregate(results);
    const text = rows.get('text');
    const elements = ELEMENTS.map((label) => {
        const holding = results.filter((result) => (result.elements[label] ?? 0) > 0);
        const occurrences = holding.reduce((sum, result) => sum + (result.elements[label] ?? 0), 0);
        return `| \`${label}\` | ${holding.length} | ${occurrences} |`;
    });
    return [
        `# docx audit: ${meta.name}`,
        '',
        `Importer \`${meta.importer}\` on \`${meta.corpus}\`.`,
        '',
        '| Total | |',
        '|---|---|',
        `| Files | ${meta.files} |`,
        `| Crashes | ${meta.crashes} |`,
        `| Timeouts | ${meta.timeouts} |`,
        `| Unreadable sources | ${meta.sourceErrors} |`,
        `| Text kept | ${text ? percent(text.matched, text.source) : '–'} |`,
        `| Text invented (words) | ${text?.invented ?? 0} |`,
        `| Import time | ${seconds(meta.importMs)} |`,
        `| Total time | ${seconds(meta.totalMs)} |`,
        '',
        '## Features',
        '',
        "Source is what Word shows: the body, footnotes, endnotes and text boxes, with paragraph and character styles resolved through basedOn and docDefaults, deleted text, field instructions and hidden text left out. Marks count the words they touch, a word carrying every mark any of its characters does, so run splitting can't skew them. Formatting a structure draws (a heading's, a quote's, a note's or a task's paragraph style, a link's character style) belongs to the structure, not to a mark. Font family counts words in another font than the body text's, small text words at most 85% of its size, text color words in another color. A quote is a paragraph with a left border alone or a quote style; a rule an empty paragraph with a bottom border alone, outside a run of paragraphs sharing its borders, which Word draws as one box. Ordered lists split where Word's numbers don't follow on, and a list's items carry the numbers Word shows. A heading Word numbers is no list item: it is a numbered heading whose number Word shows as text, kept when an imported heading reads the same line, number first. Text, marks, item numbers and numbered headings match as multisets of words, numbers and lines: kept is what matches over the source, invented what the import holds with no match in the source. Every other feature keeps each file's min(imported, source) and invents its max(0, imported − source). A crash or timeout keeps and invents nothing.",
        '',
        'Not resolved: table styles (a header row a table style makes bold), the mc:Fallback of a choice Word reads, `w:sym` symbols, the preview picture of an embedded object (`w:object`), headers, footers and comments.',
        '',
        '| Feature | Files | Source | Imported | Kept | Invented |',
        '|---|---:|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const row = rows.get(feature) ?? emptyRow();
            return `| ${label} | ${row.files} | ${row.source} | ${row.imported} | ${percent(row.matched, row.source)} | ${row.invented} |`;
        }),
        '',
        '## Elements',
        '',
        'Occurrences as written in the story parts (document, footnotes, endnotes, comments, headers, footers), both branches of `mc:AlternateContent` included.',
        '',
        '| Element | Files | Occurrences |',
        '|---|---:|---:|',
        ...elements,
        '',
    ].join('\n');
}

function readRun(out: string): { meta: RunMeta; results: Map<string, FileResult> } {
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
    const results = new Map<string, FileResult>();
    for (const file of [...new Bun.Glob('**/*.json').scanSync(path.join(out, 'files'))].sort()) {
        const result: FileResult = JSON.parse(fs.readFileSync(path.join(out, 'files', file), 'utf8'));
        results.set(result.file, result);
    }
    return { meta, results };
}

const TOP_FILES = 15;

export function compareRuns(outA: string, outB: string): string {
    const a = readRun(outA);
    const b = readRun(outB);
    const rowsA = aggregate([...a.results.values()]);
    const rowsB = aggregate([...b.results.values()]);
    const [nameA, nameB] = [a.meta.name, b.meta.name];
    const totals = (pick: (meta: RunMeta) => number | string) => `| ${pick(a.meta)} | ${pick(b.meta)} |`;
    const kept = (row: Row | undefined) => (row ? percent(row.matched, row.source) : '–');
    const diffs = [...a.results.keys()]
        .filter((file) => b.results.has(file))
        .map((file) => {
            const fa = a.results.get(file);
            const fb = b.results.get(file);
            const changes = FEATURES.flatMap(([feature, label]) => {
                const ka = fa?.features[feature]?.kept;
                const kb = fb?.features[feature]?.kept;
                return typeof ka === 'number' && typeof kb === 'number' && ka !== kb
                    ? [
                          {
                              label,
                              delta: kb - ka,
                              text: `${label} ${(ka * 100).toFixed(1)}% → ${(kb * 100).toFixed(1)}%`,
                          },
                      ]
                    : [];
            }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
            const score = changes.reduce((sum, change) => sum + Math.abs(change.delta), 0);
            const status = fa?.import === fb?.import ? '' : ` (${fa?.import} → ${fb?.import})`;
            const text = (result: FileResult | undefined) =>
                result ? percent(result.features['text']?.matched ?? 0, result.features['text']?.source ?? 0) : '–';
            return {
                file,
                score,
                line: `| ${file}${status} | ${text(fa)} | ${text(fb)} | ${changes
                    .slice(0, 3)
                    .map((change) => change.text)
                    .join('; ')} |`,
            };
        })
        .filter((diff) => diff.score > 0)
        .sort((x, y) => y.score - x.score || x.file.localeCompare(y.file));
    const only = (from: typeof a, other: typeof b) =>
        [...from.results.keys()].filter((file) => !other.results.has(file));
    return [
        `# docx audit: ${nameA} vs ${nameB}`,
        '',
        `| | ${nameA} | ${nameB} |`,
        '|---|---|---|',
        `| Files ${totals((meta) => meta.files)}`,
        `| Crashes ${totals((meta) => meta.crashes)}`,
        `| Timeouts ${totals((meta) => meta.timeouts)}`,
        `| Text kept | ${kept(rowsA.get('text'))} | ${kept(rowsB.get('text'))} |`,
        `| Text invented (words) | ${rowsA.get('text')?.invented ?? 0} | ${rowsB.get('text')?.invented ?? 0} |`,
        `| Import time ${totals((meta) => seconds(meta.importMs))}`,
        '',
        '## Features',
        '',
        `| Feature | Files | Source | ${nameA} kept | ${nameB} kept | Δ points | ${nameA} invented | ${nameB} invented |`,
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const ra = rowsA.get(feature);
            const rb = rowsB.get(feature);
            // Rounded first, so a difference below the shown precision reads 0.0, not -0.0.
            const points =
                ra && rb && ra.source > 0 && rb.source > 0
                    ? Math.round((rb.matched / rb.source - ra.matched / ra.source) * 1000) / 10
                    : undefined;
            const delta = points === undefined ? '–' : `${points > 0 ? '+' : ''}${(points || 0).toFixed(1)}`;
            return `| ${label} | ${ra?.files ?? 0} | ${ra?.source ?? 0} | ${kept(ra)} | ${kept(rb)} | ${delta} | ${ra?.invented ?? 0} | ${rb?.invented ?? 0} |`;
        }),
        '',
        '## Files that differ most',
        '',
        `| File | ${nameA} text | ${nameB} text | Largest differences |`,
        '|---|---:|---:|---|',
        ...diffs.slice(0, TOP_FILES).map((diff) => diff.line),
        '',
        ...only(a, b).map((file) => `Only in ${nameA}: ${file}`),
        ...only(b, a).map((file) => `Only in ${nameB}: ${file}`),
        '',
    ].join('\n');
}

// ── Running an importer ─────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_IMPORTER = path.join(import.meta.dir, '../lib/import/doc/from-docx.ts');
const DEFAULT_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 60_000;

type SourceTally = ReturnType<typeof auditSource>;

type WorkerRequest =
    | { kind: 'load'; importer: string }
    | { kind: 'audit'; bytes: ArrayBuffer }
    | { kind: 'import'; bytes: ArrayBuffer };

type WorkerReply =
    | { kind: 'loaded' }
    | { kind: 'audited'; source: SourceTally; ms: number }
    | { kind: 'imported'; json: JSONContent; images: number; ms: number }
    | { kind: 'failed'; error: string; ms: number };

// What a request comes to: the worker's reply, or the worker cut at the cap or gone.
type Outcome = WorkerReply | { kind: 'timeout' } | { kind: 'died'; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isSourceTally(value: unknown): value is SourceTally {
    return (
        typeof value === 'object' &&
        value !== null &&
        'counts' in value &&
        value.counts instanceof Map &&
        'marks' in value &&
        value.marks instanceof Map &&
        'elements' in value &&
        value.elements instanceof Map &&
        'words' in value &&
        Array.isArray(value.words) &&
        'numbers' in value &&
        Array.isArray(value.numbers) &&
        'headings' in value &&
        Array.isArray(value.headings)
    );
}

function isReply(data: unknown): data is WorkerReply {
    if (typeof data !== 'object' || data === null || !('kind' in data)) return false;
    const timed = 'ms' in data && typeof data.ms === 'number';
    switch (data.kind) {
        case 'loaded':
            return true;
        case 'audited':
            return timed && 'source' in data && isSourceTally(data.source);
        case 'imported':
            return (
                timed &&
                'json' in data &&
                typeof data.json === 'object' &&
                data.json !== null &&
                'images' in data &&
                typeof data.images === 'number'
            );
        case 'failed':
            return timed && 'error' in data && typeof data.error === 'string';
        default:
            return false;
    }
}

function isImporter(value: unknown): value is typeof docxToPmJson {
    return typeof value === 'function';
}

function reply(worker: Worker, timeoutMs: number): Promise<Outcome> {
    return new Promise((resolve) => {
        const finish = (result: Outcome) => {
            clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('close', onClose);
            resolve(result);
        };
        const onMessage = (event: MessageEvent<unknown>) =>
            finish(isReply(event.data) ? event.data : { kind: 'died', error: 'malformed reply' });
        const onError = (event: ErrorEvent) => finish({ kind: 'died', error: event.message });
        const onClose = () => finish({ kind: 'died', error: 'worker exited' });
        const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('close', onClose);
    });
}

async function spawn(importer: string | undefined): Promise<Worker> {
    const worker = new Worker(import.meta.path);
    if (importer === undefined) return worker;
    const loaded = reply(worker, LOAD_TIMEOUT_MS);
    worker.postMessage({ kind: 'load', importer } satisfies WorkerRequest);
    const result = await loaded;
    if (result.kind === 'loaded') return worker;
    worker.terminate();
    throw new Error(`Cannot load ${importer}: ${'error' in result ? result.error : result.kind}`);
}

// One worker under the time cap; one cut, dead or out of memory is replaced on the next request, and a replacement
// that fails to load is that request's crash.
function lane(timeoutMs: number, importer?: string) {
    let worker: Worker | undefined;
    return {
        start: async () => {
            worker ??= await spawn(importer);
        },
        ask: async (request: WorkerRequest, transfer: Transferable[]): Promise<Outcome> => {
            let current: Worker;
            try {
                current = worker ?? (await spawn(importer));
            } catch (error) {
                return { kind: 'died', error: message(error) };
            }
            worker = current;
            const pending = reply(current, timeoutMs);
            current.postMessage(request, transfer);
            const outcome = await pending;
            if (outcome.kind === 'timeout' || outcome.kind === 'died') {
                current.terminate();
                worker = undefined;
            }
            return outcome;
        },
        close: () => worker?.terminate(),
    };
}

export async function runAudit(options: {
    corpus: string;
    out: string;
    importer?: string;
    name: string;
    timeoutMs?: number;
}): Promise<RunMeta> {
    const started = performance.now();
    const importer = path.resolve(options.importer ?? DEFAULT_IMPORTER);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Word's lock files (~$name.docx) are no packages.
    const files = [...new Bun.Glob('**/*.docx').scanSync({ cwd: options.corpus, followSymlinks: true })]
        .filter((file) => !path.basename(file).startsWith('~$'))
        .sort();
    if (files.length === 0) throw new Error(`No .docx files under ${options.corpus}`);
    fs.mkdirSync(options.out, { recursive: true });
    fs.rmSync(path.join(options.out, 'files'), { recursive: true, force: true });
    // The source is read off the main thread too, under the same cap.
    const sources = lane(timeoutMs);
    const imports = lane(timeoutMs, importer);
    await imports.start();
    const took = (outcome: Outcome) =>
        'ms' in outcome ? Math.round(outcome.ms) : outcome.kind === 'timeout' ? timeoutMs : 0;
    const results: FileResult[] = [];
    try {
        for (const [index, file] of files.entries()) {
            const bytes = await Bun.file(path.join(options.corpus, file)).arrayBuffer();
            const copy = bytes.slice(0);
            const size = bytes.byteLength;
            const [audited, outcome] = await Promise.all([
                sources.ask({ kind: 'audit', bytes: copy }, [copy]),
                imports.ask({ kind: 'import', bytes }, [bytes]),
            ]);
            const source = audited.kind === 'audited' ? audited.source : undefined;
            const sourceError = source ? undefined : 'error' in audited ? audited.error : audited.kind;
            const imported = outcome.kind === 'imported' ? auditImported(outcome.json) : newTally();
            const result: FileResult = {
                file,
                bytes: size,
                import: outcome.kind === 'imported' ? 'ok' : outcome.kind === 'timeout' ? 'timeout' : 'crash',
                ...('error' in outcome ? { error: outcome.error } : {}),
                ...(sourceError ? { sourceError } : {}),
                ms: { source: took(audited), import: took(outcome) },
                ...(outcome.kind === 'imported' ? { images: outcome.images } : {}),
                ...compareTallies(source ?? newTally(), imported),
                elements: Object.fromEntries(
                    ELEMENTS.flatMap((label) => {
                        const n = source?.elements.get(label) ?? 0;
                        return n > 0 ? [[label, n]] : [];
                    }),
                ),
            };
            results.push(result);
            const target = path.join(options.out, 'files', `${file}.json`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
            console.log(
                `[${index + 1}/${files.length}] ${file}: ${result.import}${sourceError ? ', source unreadable' : ''}, ${result.ms.import} ms`,
            );
        }
    } finally {
        sources.close();
        imports.close();
    }
    const meta: RunMeta = {
        name: options.name,
        importer: path.relative(process.cwd(), importer),
        corpus: path.relative(process.cwd(), path.resolve(options.corpus)),
        files: results.length,
        crashes: results.filter((result) => result.import === 'crash').length,
        timeouts: results.filter((result) => result.import === 'timeout').length,
        sourceErrors: results.filter((result) => result.sourceError).length,
        importMs: Math.round(results.reduce((sum, result) => sum + result.ms.import, 0)),
        totalMs: Math.round(performance.now() - started),
    };
    fs.writeFileSync(path.join(options.out, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(path.join(options.out, 'summary.md'), summaryMarkdown(meta, results));
    return meta;
}

declare var self: Worker;

// The worker side: reads a source, or loads the importer once and then imports one file per message.
if (!Bun.isMainThread) {
    let importer: typeof docxToPmJson | undefined;
    self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
        const request = event.data;
        const started = performance.now();
        try {
            if (request.kind === 'load') {
                const module: unknown = await import(request.importer);
                const exported =
                    typeof module === 'object' && module !== null && 'docxToPmJson' in module
                        ? module.docxToPmJson
                        : undefined;
                if (!isImporter(exported)) throw new Error('no docxToPmJson export');
                importer = exported;
                postMessage({ kind: 'loaded' } satisfies WorkerReply);
                return;
            }
            if (request.kind === 'audit') {
                const source = auditSource(request.bytes);
                postMessage({ kind: 'audited', source, ms: performance.now() - started } satisfies WorkerReply);
                return;
            }
            if (!importer) throw new Error('no importer loaded');
            const { json, images } = await importer(Buffer.from(request.bytes));
            postMessage({
                kind: 'imported',
                json,
                images: images.length,
                ms: performance.now() - started,
            } satisfies WorkerReply);
        } catch (error) {
            postMessage({
                kind: 'failed',
                error: message(error),
                ms: performance.now() - started,
            } satisfies WorkerReply);
        }
    };
}

if (import.meta.main && Bun.isMainThread) {
    const { values, positionals } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            importer: { type: 'string' },
            name: { type: 'string' },
            timeout: { type: 'string' },
        },
    });
    if (positionals[0] === 'compare' && positionals.length === 3) {
        console.log(compareRuns(positionals[1], positionals[2]));
    } else if (positionals.length === 1 && values.out) {
        const meta = await runAudit({
            corpus: positionals[0],
            out: values.out,
            importer: values.importer,
            name: values.name ?? path.basename(values.importer ?? 'mammoth', '.ts'),
            timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
        });
        console.log(
            `${meta.files} files, ${meta.crashes} crashes, ${meta.timeouts} timeouts: ${path.join(values.out, 'summary.md')}`,
        );
    } else {
        console.error(
            'Usage: bun apps/api/src/scripts/docx-audit.ts <corpus dir> --out <dir> [--importer <module>] [--name <label>] [--timeout <s>]\n       bun apps/api/src/scripts/docx-audit.ts compare <outA> <outB>',
        );
        process.exit(1);
    }
}
