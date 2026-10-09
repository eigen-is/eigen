// Audits a docx importer on a corpus: per file, what Word shows, counted from the OOXML with the style chain resolved,
// beside what reached the imported eigendoc JSON, and the raw OOXML elements the file holds (PROPOSAL_DOCX.md § The corpus).
//
// Usage:
//   bun apps/api/src/scripts/docx-audit.ts <corpus dir> --out <dir> [--importer <module>] [--name <label>] [--timeout <s>]
//   bun apps/api/src/scripts/docx-audit.ts compare <outA> <outB>
//
// The importer module exports `docxToPmJson` with from-docx.ts's signature. It runs in a Worker, so a hang is cut at
// the time cap and a crash is a result; every importer is measured by the same code. The per-file JSON samples the
// words that differ, so an out dir of a private corpus stays out of the repo.
import * as fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import JSZip from 'jszip';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../lib/core/xml';
import { cssColorToHex } from '../lib/export/colors';
import { assertDecompressedSizeWithinBounds } from '../lib/import/zip-size-guard';

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
    ['bold', 'Bold (characters)'],
    ['italic', 'Italic (characters)'],
    ['underline', 'Underline (characters)'],
    ['strike', 'Strike (characters)'],
    ['subscript', 'Subscript (characters)'],
    ['superscript', 'Superscript (characters)'],
    ['color', 'Text color (characters)'],
    ['highlight', 'Highlight (characters)'],
    ['font', 'Font family (characters)'],
    ['small', 'Small text (characters)'],
    ['code', 'Inline code (characters)'],
    ['link', 'Links (characters)'],
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

export type Tally = { counts: Map<Feature, number>; words: string[]; numbers: number[] };

type FeatureResult = { source: number; imported: number; matched: number; kept: number | null };

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

// Soft hyphens show only at a line end; mammoth spells a non-breaking hyphen U+2011.
function wordsOf(text: string): string[] {
    return text
        .replace(/\u00AD/g, '')
        .replace(/[\u2010\u2011]/g, '-')
        .split(/[\s\u200B]+/u)
        .filter(Boolean);
}

function nonSpace(text: string): number {
    return text.replace(/[\s\u00AD\u200B]/gu, '').length;
}

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
    indented: boolean;
    deletedMark: boolean;
    numId?: string;
    ilvl: number;
    // The paragraph style's run formatting, nearest first, then docDefaults.
    runs: XmlElement[];
};

type Paragraph = { text: string; image: boolean; breaks: number; quote: boolean; code: boolean };

type OpenList = { level: number; ordered: boolean; number: number };

type Chain = { last?: Paragraph; lists: OpenList[]; carry: string };

type Field = { result: boolean; instr: string; link: boolean };

type Scope = { chain: Chain; float: boolean; cell: boolean; note: boolean; fields: Field[] };

type Inline = { scope: Scope; paragraph: Paragraph; runs: XmlElement[]; marks: boolean; link: boolean };

type RunLook = { hidden: boolean; code: boolean; marks: Feature[] };

const newChain = (): Chain => ({ lists: [], carry: '' });

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
    return (numId: string, ilvl: number): { ordered: boolean; number: number } | undefined => {
        const num = nums.get(numId);
        let abstractId = val(child(num, 'abstractNumId'));
        const styleLink = val(child(abstractId === undefined ? undefined : abstracts.get(abstractId), 'numStyleLink'));
        if (styleLink) abstractId = linked.get(styleLink) ?? abstractId;
        const abstract = abstractId === undefined ? undefined : abstracts.get(abstractId);
        if (!num || !abstract || abstractId === undefined) return undefined;
        const override = xmlChildren(num, W, 'lvlOverride').find((o) => xmlAttr(o, W, 'ilvl') === String(ilvl));
        const level = (element: XmlElement | undefined) =>
            element && xmlChildren(element, W, 'lvl').find((lvl) => xmlAttr(lvl, W, 'ilvl') === String(ilvl));
        const lvl = level(override) ?? level(abstract);
        if (!lvl) return undefined;
        const overrideStart = val(child(override, 'startOverride'));
        // ECMA-376 17.9.25: an omitted start is 0.
        const start = Number(val(child(lvl, 'start')) ?? 0);
        const counter = counters.get(abstractId) ?? [];
        counters.set(abstractId, counter);
        const restart = `${numId}:${ilvl}`;
        let number = counter[ilvl] === undefined ? start : counter[ilvl] + 1;
        if (overrideStart !== undefined && !restarted.has(restart)) {
            restarted.add(restart);
            number = Number(overrideStart);
        }
        counter[ilvl] = number;
        counter.length = ilvl + 1;
        const format = val(child(lvl, 'numFmt')) ?? 'decimal';
        if (format === 'none') return undefined;
        return { ordered: format !== 'bullet', number };
    };
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
export async function auditSource(bytes: ArrayBuffer | Uint8Array): Promise<Tally & { elements: Map<string, number> }> {
    const zip = await JSZip.loadAsync(bytes);
    await assertDecompressedSizeWithinBounds(zip, 'Document too large');
    const read = async (part: string | undefined) => {
        const text = part === undefined ? undefined : await zip.file(part)?.async('string');
        return text === undefined ? undefined : (parseXml(text) ?? undefined);
    };
    const relationships = async (part: string) => {
        const directory = path.posix.dirname(part);
        const rels = await read(path.posix.join(directory, '_rels', `${path.posix.basename(part)}.rels`));
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
    const main = (await relationships('')).find((rel) => rel.type === 'officeDocument')?.part ?? 'word/document.xml';
    const related = await relationships(main);
    const partOf = (type: string) => related.find((rel) => rel.type === type)?.part;
    const document = await read(main);
    if (!document) throw new Error(`${main} missing`);
    const footnotes = await read(partOf('footnotes'));
    const endnotes = await read(partOf('endnotes'));
    const styles = readStyles(await read(partOf('styles')), await read(partOf('theme')));
    const numberItem = readNumbering(await read(partOf('numbering')));

    const elements = new Map<string, number>();
    const stories = [document, footnotes, endnotes, await read(partOf('comments'))];
    for (const rel of related) if (rel.type === 'header' || rel.type === 'footer') stories.push(await read(rel.part));
    for (const story of stories) if (story) countElements(story, elements);

    const tally: Tally = { counts: new Map(), words: [], numbers: [] };
    const paragraphLook = (pPr: XmlElement | undefined): ParagraphLook => {
        const chain = styles.chain(val(child(pPr, 'pStyle')) ?? styles.paragraph);
        const names = chain.map(styleName);
        const pPrs = [pPr, ...chain.map((style) => child(style, 'pPr')), styles.pPr].flatMap((p) => p ?? []);
        // Word's Title is H1 in Eigen (PROPOSAL_DOCX.md, Decision 8); 9 is body text.
        const heading = chain
            .map((style, index) => {
                const named = Number(
                    names[index].match(/^heading ([1-9])$/)?.[1] ?? (names[index] === 'title' ? 1 : 0),
                );
                const outline = Number(val(child(child(style, 'pPr'), 'outlineLvl')) ?? 9);
                return named || (outline < 9 ? outline + 1 : 0);
            })
            .find((level) => level > 0);
        // numId and ilvl resolve apart: a paragraph may set its level on a style's list.
        const numPr = (local: string) => val(pPrs.map((p) => child(child(p, 'numPr'), local)).find(Boolean));
        const pageBreakBefore = first(pPrs, 'pageBreakBefore');
        const bottom = child(first(pPrs, 'pBdr'), 'bottom');
        const left = child(first(pPrs, 'pBdr'), 'left');
        const bordered = (border: XmlElement | undefined) =>
            !!border && !['none', 'nil'].includes(val(border) ?? 'none');
        const code = names.some((name) => CODE_BLOCK_STYLES.has(name));
        const section = child(pPr, 'sectPr');
        const indent = first(pPrs, 'ind');
        return {
            heading,
            code,
            quote: !code && (names.some((name) => QUOTE_STYLES.has(name)) || bordered(left)),
            caption: names.includes('caption'),
            jc: val(first(pPrs, 'jc')),
            pageBreakBefore: !!pageBreakBefore && on(pageBreakBefore),
            sectionBreak: !!section && SECTION_PAGE_BREAKS.has(val(child(section, 'type')) ?? 'nextPage'),
            rule: bordered(bottom),
            indented: !!indent && Number(xmlAttr(indent, W, 'left') ?? xmlAttr(indent, W, 'start') ?? 0) > 0,
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
    const { runs: plain } = paragraphLook(undefined);
    const base = { font: fontOf(plain), color: colorOf(plain), size: sizeOf(plain) };

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
        const underline = val(first(own, 'u'));
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
        context.paragraph.text += value;
        const n = nonSpace(value);
        if (!n || !context.marks || !look) return;
        if (look.code) add(tally, 'code', n);
        else for (const mark of look.marks) add(tally, mark, n);
    };

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
                    if (shown) context.paragraph.text += ' ';
                    break;
                case 'br':
                    if (!shown) break;
                    context.paragraph.text += ' ';
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
                    context.paragraph.text += ' ';
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
        const previous = chain.last;
        const caption = look.caption && !!previous?.image;
        const structural =
            look.heading !== undefined ||
            look.quote ||
            look.code ||
            caption ||
            scope.note ||
            find(element, W14, 'checkbox').length > 0;
        const current: Paragraph = {
            text: chain.carry,
            image: false,
            breaks: 0,
            quote: look.quote,
            code: look.code,
        };
        chain.carry = '';
        const item = look.numId && look.numId !== '0' ? numberItem(look.numId, look.ilvl) : undefined;
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
            chain.carry = current.text;
            return;
        }
        tally.words.push(...wordsOf(current.text));
        const hasText = nonSpace(current.text) > 0;
        if (look.pageBreakBefore) add(tally, 'pageBreaks');
        if (look.sectionBreak) add(tally, 'pageBreaks');
        // A paragraph holding only a page break is the break, a block in Eigen: the quote, code or list around it goes on.
        if (!hasText && !current.image && current.breaks > 0) return;
        // Word numbers on across an item's indented or empty paragraphs; a body paragraph or heading ends the list.
        if (!item && hasText && (!look.indented || look.heading !== undefined)) chain.lists = [];
        chain.last = current;
        if (!scope.float && !caption && (hasText || current.image)) {
            add(tally, 'paragraphs');
            if (look.heading && hasText) add(tally, HEADINGS[Math.min(look.heading, 7) - 1]);
            const alignment = look.jc && ALIGNMENTS.get(look.jc);
            if (alignment && hasText && !look.code) add(tally, alignment);
        }
        if (caption && hasText) add(tally, 'captions');
        if (look.code && !previous?.code) add(tally, 'codeBlocks');
        if (look.quote && !previous?.quote) add(tally, 'blockquotes');
        if (look.rule && !hasText && !current.image) add(tally, 'rules');
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
        tally.words.push(...wordsOf(scope.chain.carry));
        scope.chain.carry = '';
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

type Place = { depth: number; table: boolean; quote: boolean; align?: unknown };

export function auditImported(json: JSONContent): Tally {
    const tally: Tally = { counts: new Map(), words: [], numbers: [] };
    const textblock = (node: JSONContent, align: unknown) => {
        let text = '';
        let figure = false;
        let footnoteHref: unknown;
        for (const inline of node.content ?? []) {
            if (inline.type === 'figure') {
                const attrs = inline.attrs ?? {};
                text += ' ';
                if (!attrs['mediaName'] && !attrs['src']) continue;
                add(tally, 'images');
                if (typeof attrs['width'] === 'number' && attrs['width'] > 0) add(tally, 'imageWidths');
                const caption = attrs['caption'];
                if (typeof caption === 'string' && nonSpace(caption) > 0) {
                    add(tally, 'captions');
                    tally.words.push(...wordsOf(caption));
                }
                if (attrs['layout'] === 'wrap-left' || attrs['layout'] === 'wrap-right') add(tally, 'wrapped');
                else figure = true;
                continue;
            }
            if (inline.type !== 'text') {
                text += ' ';
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
                text += ' ';
                continue;
            }
            text += value;
            const n = nonSpace(value);
            if (!n) continue;
            for (const mark of marks) {
                const attrs = mark.attrs ?? {};
                if (mark.type === 'textStyle') {
                    const color = attrs['color'];
                    if (typeof color === 'string' && color && cssColorToHex(color) !== '000000') add(tally, 'color', n);
                    if (typeof attrs['fontFamily'] === 'string' && attrs['fontFamily']) add(tally, 'font', n);
                    continue;
                }
                const feature = MARK_FEATURES.get(mark.type);
                if (feature) add(tally, feature, n);
            }
        }
        tally.words.push(...wordsOf(text));
        const hasText = nonSpace(text) > 0;
        if (!hasText && !figure) return;
        add(tally, 'paragraphs');
        if (!hasText) return;
        const level = node.attrs?.['level'];
        if (node.type === 'heading' && typeof level === 'number')
            add(tally, HEADINGS[Math.min(Math.max(level, 1), 7) - 1]);
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
                tally.words.push(...wordsOf(text));
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

// Text and item numbers match as multisets, so a word moved or a list renumbered is a loss; every other feature keeps
// at most what the source holds, so an importer can't make up in one feature what it loses in another.
function compareTallies(source: Tally, imported: Tally): Pick<FileResult, 'text' | 'features'> {
    const words = multisetDiff(source.words, imported.words);
    const numbers = multisetDiff(source.numbers, imported.numbers);
    const features: Record<string, FeatureResult> = {};
    for (const [feature] of FEATURES) {
        const from = source.counts.get(feature) ?? 0;
        const to = imported.counts.get(feature) ?? 0;
        const missing =
            feature === 'text' ? words.missing.length : feature === 'itemNumbers' ? numbers.missing.length : 0;
        const matched = feature === 'text' || feature === 'itemNumbers' ? from - missing : Math.min(from, to);
        features[feature] = { source: from, imported: to, matched, kept: from > 0 ? matched / from : null };
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

type Row = { files: number; source: number; imported: number; matched: number };

function aggregate(results: FileResult[]): Map<string, Row> {
    const rows = new Map<string, Row>(
        FEATURES.map(([feature]) => [feature, { files: 0, source: 0, imported: 0, matched: 0 }]),
    );
    for (const result of results) {
        for (const [feature, row] of rows) {
            const counts = result.features[feature];
            if (!counts) continue;
            if (counts.source > 0) row.files++;
            row.source += counts.source;
            row.imported += counts.imported;
            row.matched += counts.matched;
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
        `| Import time | ${seconds(meta.importMs)} |`,
        `| Total time | ${seconds(meta.totalMs)} |`,
        '',
        '## Features',
        '',
        "Source is what Word shows: the body, footnotes, endnotes and text boxes, with paragraph and character styles resolved through basedOn and docDefaults, deleted text, field instructions and hidden text left out. Marks count non-space characters, so run splitting can't skew them. Formatting a structure draws (a heading's, a quote's, a note's or a task's paragraph style, a link's character style) belongs to the structure, not to a mark. Font family counts characters in another font than the body text's, small text characters at most 85% of its size, text color characters in another color. Ordered lists split where Word's numbers don't follow on, and a list's items carry the numbers Word shows. Kept sums each file's min(imported, source) over the source; text and ordered item numbers match as multisets. A crash or timeout keeps nothing.",
        '',
        'Not resolved: table styles (a header row a table style makes bold), the mc:Fallback of a choice Word reads, `w:sym` symbols, the preview picture of an embedded object (`w:object`), headers, footers and comments.',
        '',
        '| Feature | Files | Source | Imported | Kept |',
        '|---|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const row = rows.get(feature) ?? { files: 0, source: 0, imported: 0, matched: 0 };
            return `| ${label} | ${row.files} | ${row.source} | ${row.imported} | ${percent(row.matched, row.source)} |`;
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
        `| Import time ${totals((meta) => seconds(meta.importMs))}`,
        '',
        '## Features',
        '',
        `| Feature | Files | Source | ${nameA} | ${nameB} | Δ points |`,
        '|---|---:|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const ra = rowsA.get(feature);
            const rb = rowsB.get(feature);
            // Rounded first, so a difference below the shown precision reads 0.0, not -0.0.
            const points =
                ra && rb && ra.source > 0 && rb.source > 0
                    ? Math.round((rb.matched / rb.source - ra.matched / ra.source) * 1000) / 10
                    : undefined;
            const delta = points === undefined ? '–' : `${points > 0 ? '+' : ''}${(points || 0).toFixed(1)}`;
            return `| ${label} | ${ra?.files ?? 0} | ${ra?.source ?? 0} | ${kept(ra)} | ${kept(rb)} | ${delta} |`;
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

type WorkerRequest = { kind: 'load'; importer: string } | { kind: 'import'; bytes: ArrayBuffer };

type WorkerReply =
    | { kind: 'loaded' }
    | { kind: 'imported'; json: JSONContent; images: number; ms: number }
    | { kind: 'failed'; error: string; ms: number }
    | { kind: 'timeout' }
    | { kind: 'died'; error: string };

function reply(worker: Worker, timeoutMs: number): Promise<WorkerReply> {
    return new Promise((resolve) => {
        const finish = (result: WorkerReply) => {
            clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('close', onClose);
            resolve(result);
        };
        const onMessage = (event: MessageEvent<WorkerReply>) => finish(event.data);
        const onError = (event: ErrorEvent) => finish({ kind: 'died', error: event.message });
        const onClose = () => finish({ kind: 'died', error: 'worker exited' });
        const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('close', onClose);
    });
}

async function loadImporter(importer: string): Promise<Worker> {
    const worker = new Worker(import.meta.path);
    const loaded = reply(worker, LOAD_TIMEOUT_MS);
    worker.postMessage({ kind: 'load', importer } satisfies WorkerRequest);
    const result = await loaded;
    if (result.kind === 'loaded') return worker;
    worker.terminate();
    throw new Error(`Cannot load ${importer}: ${'error' in result ? result.error : result.kind}`);
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
    const files = [...new Bun.Glob('**/*.docx').scanSync(options.corpus)]
        .filter((file) => !path.basename(file).startsWith('~$'))
        .sort();
    fs.rmSync(path.join(options.out, 'files'), { recursive: true, force: true });
    let worker = await loadImporter(importer);
    const results: FileResult[] = [];
    try {
        for (const [index, file] of files.entries()) {
            const bytes = await Bun.file(path.join(options.corpus, file)).arrayBuffer();
            const sourceStarted = performance.now();
            let source: Awaited<ReturnType<typeof auditSource>> | undefined;
            let sourceError: string | undefined;
            try {
                source = await auditSource(bytes);
            } catch (error) {
                sourceError = error instanceof Error ? error.message : String(error);
            }
            const sourceMs = performance.now() - sourceStarted;
            const size = bytes.byteLength;
            const pending = reply(worker, timeoutMs);
            worker.postMessage({ kind: 'import', bytes } satisfies WorkerRequest, [bytes]);
            const outcome = await pending;
            if (outcome.kind === 'timeout' || outcome.kind === 'died') {
                worker.terminate();
                worker = await loadImporter(importer);
            }
            const empty: Tally = { counts: new Map(), words: [], numbers: [] };
            const imported = outcome.kind === 'imported' ? auditImported(outcome.json) : empty;
            const result: FileResult = {
                file,
                bytes: size,
                import: outcome.kind === 'imported' ? 'ok' : outcome.kind === 'timeout' ? 'timeout' : 'crash',
                ...(outcome.kind === 'failed' || outcome.kind === 'died' ? { error: outcome.error } : {}),
                ...(sourceError ? { sourceError } : {}),
                ms: {
                    source: Math.round(sourceMs),
                    import:
                        outcome.kind === 'imported' || outcome.kind === 'failed'
                            ? Math.round(outcome.ms)
                            : outcome.kind === 'timeout'
                              ? timeoutMs
                              : 0,
                },
                ...(outcome.kind === 'imported' ? { images: outcome.images } : {}),
                ...compareTallies(source ?? empty, imported),
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
        worker.terminate();
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

// The worker side: loads the importer once, then imports one file per message.
if (!Bun.isMainThread) {
    let importer: unknown;
    self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
        const request = event.data;
        const started = performance.now();
        try {
            if (request.kind === 'load') {
                const module: unknown = await import(request.importer);
                importer =
                    typeof module === 'object' && module !== null && 'docxToPmJson' in module
                        ? module.docxToPmJson
                        : undefined;
                if (typeof importer !== 'function') throw new Error('no docxToPmJson export');
                postMessage({ kind: 'loaded' } satisfies WorkerReply);
                return;
            }
            if (typeof importer !== 'function') throw new Error('no importer loaded');
            const { json, images } = await importer(Buffer.from(request.bytes));
            if (typeof json !== 'object' || json === null) throw new Error('the importer returned no JSON');
            postMessage({
                kind: 'imported',
                json,
                images: Array.isArray(images) ? images.length : 0,
                ms: performance.now() - started,
            } satisfies WorkerReply);
        } catch (error) {
            postMessage({
                kind: 'failed',
                error: error instanceof Error ? error.message : String(error),
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
