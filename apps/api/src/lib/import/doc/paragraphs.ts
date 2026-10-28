// The docx reader's block walk: it turns every paragraph into items in document order, so Word's counters run in
// order across tables, text boxes and notes, and buildBlocks turns the items into blocks. A paragraph keeps what it sets
// apart from the docx's Normal or its style.

import { isDeepStrictEqual } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { DOCUMENT_FONT, readFontSize } from '@workspace/lib/constants/fonts';
import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    flattenNestedStories,
    PROSE_TEXTBLOCKS,
    pagePx,
    pageTwips,
    ptToMm,
    readNormalStyle,
    readPageSetup,
    twipsToMm,
    twipsToPt,
} from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlElements, xmlText } from '../../core/xml';
import type { RunFace } from '../../document/looks';
import {
    CAPTION_LOOK,
    CODE_BLOCK_LOOK,
    familyLineScale,
    lineMultiple,
    nodeLook,
    ownTextLook,
    QUOTE_LOOK,
    TASK_DONE_LOOK,
} from '../../document/looks';
import type { Lost } from '../../document/transform/protocol';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { drawingTheme } from '../../ooxml/drawingml';
import { isAlternateContent, W_NS } from '../../ooxml/ooxml';
import type { Part } from '../../ooxml/opc';
import {
    CHECKBOX_GLYPHS,
    DEFAULT_RUN_SIZE,
    LIST_LEVELS,
    NOTE_SEPARATORS,
    SINGLE_LINE,
    STYLE_NAMES,
    TWIPS_PER_PX,
    textAlignOf,
} from '../../ooxml/wordml';
import type { MediaFiles } from '../image-types';
import { IMPORT_MESSAGES } from '../messages';
import type { Item, ParagraphItem } from './assemble';
import { buildBlocks, isFigureOnly, isWhitespace, placeAnchors } from './assemble';
import { isFill, isLightNeutral, markColor } from './colors';
import type { FontTable, Theme } from './docx-fonts';
import { byFace, fontMark, isMonospaceFont, readFontTable, readTheme } from './docx-fonts';
import type { DocxChart } from './drawings';
import type { Numbering } from './numbering';
import { readNumbering } from './numbering';
import type { DocxPackage } from './package';
import { descendants, twipsOf, w, wChild, wordAlternative } from './package';
import type { Field, Piece, RunContext } from './runs';
import { walkInline } from './runs';
import type { DocxRunProps, ParaProps, Role } from './styles';
import { mergePara, mergeRun, readParaProps, readRunProps, Styles } from './styles';
import { readTable } from './tables';

// The elements that only wrap content, such as a content control's or a tracked insertion's: their children are read
// in their place.
export const WRAPPERS = new Set(['customXml', 'ins', 'moveTo', 'smartTag']);

// y-tiptap spreads a paragraph's children into one call, which overflows near 500,000; the corpus's most is 274.
export const MAX_INLINE_NODES = 50_000;

export type Reader = {
    pkg: DocxPackage;
    theme: Theme;
    fontTable: FontTable;
    styles: Styles;
    numbering: Numbering;
    // Named per import, so a replace's pictures land beside the ones a restored version names.
    files: MediaFiles;
    // Each note by type and id, its part beside it, and each as read at its depth: a note is read once per depth
    // however often it is referenced. The notes being read, outermost first.
    noteElements: Map<string, { part: Part; note: XmlElement }>;
    notes: Map<string, { content: JSONContent[]; weight: number }>;
    openNotes: string[];
    fields: Field[];
    // The parts of a SmartArt's or a band's chart read: each is read once.
    graphicParts: Set<string>;
    // The theme's colours a chart's series take, and each chart part as read.
    colors: DrawingTheme;
    charts: Map<XmlElement, DocxChart>;
    // The body's size in half-points, its complex script's, and its color, which no run needs a mark for.
    bodySize: number;
    bodySizeCs: number;
    baseColor: string | undefined;
    // The docx's Normal as the doc stores it, which a run in its font and a paragraph in its format need no mark for.
    normal: NormalStyle;
    // The doc holds one page, the body's final section's; its text column places anchors and caps widths.
    page: PageSetup;
    columnTwips: number;
    columnPx: number;
    // What the doc can't hold, by kind: SmartArt, whose graphic the schema can't hold, a chart that came in as words, an
    // earlier section whose page differs from the doc's, a picture a band anchored, which it holds as a block figure,
    // and what a band drops (a picture behind the text or a VML one, a letterhead or a watermark, a note reference).
    lost: Lost;
    publicOrigin: string | undefined;
};

// Per part: its relationships, the story it tells (only the body's breaks page, and only the body's pictures float), the
// tables around it, the table style, the cell's width in px, whether the text sits on a fill the schema drops, and the
// cell fill drawn behind it.
export type Scope = {
    part: Part;
    story: 'body' | 'note' | 'band';
    tables: number;
    tableRun?: DocxRunProps;
    room?: number;
    onFill?: boolean;
    fill?: string;
    // Inside a text box, whose paragraphs own no spacing and whose pictures draw in line.
    box?: boolean;
};

export function createReader(
    pkg: DocxPackage,
    files: MediaFiles,
    lost: Lost,
    publicOrigin: string | undefined,
): Reader {
    const defaults = wChild(wChild(wChild(pkg.styles, 'docDefaults'), 'rPrDefault'), 'rPr');
    const lang = wChild(defaults, 'lang');
    const theme = readTheme(pkg.theme, { bidi: w(lang, 'bidi'), eastAsia: w(lang, 'eastAsia') });
    const styles = new Styles(pkg.styles, theme);
    const body = mergeRun(styles.docRun, styles.run(styles.defaultParagraph));
    const fontTable = readFontTable(pkg.fontTable);
    const sectPr = wChild(wChild(pkg.document.root, 'body'), 'sectPr');
    const size = sectionPage(sectPr);
    const page = { ...size, differentFirstPage: pkg.titlePg, pageless: pkg.webView };
    const px = pagePx(page);
    const twips = pageTwips(page);
    // A size past the range lands in it, as a run's does.
    const bodySize = 2 * (readFontSize((body.size ?? DEFAULT_RUN_SIZE) / 2) ?? DEFAULT_RUN_SIZE / 2);
    const font = fontMark(byFace(' ', body.fonts, body, false)[0]?.font, fontTable) ?? DOCUMENT_FONT;
    const para = mergePara(styles.docPara, styles.para(styles.defaultParagraph));
    // Single where no auto line is set, as Google Docs reads an at-least one; in the font's own line, as a paragraph's.
    const line = (para.lineRule ?? 'auto') === 'auto' ? (para.line ?? SINGLE_LINE) : SINGLE_LINE;
    for (const section of descendants(pkg.document.root, W_NS, 'sectPr'))
        if (section !== sectPr && !isDeepStrictEqual(sectionPage(section), size)) lost('section-pages-dropped');
    return {
        pkg,
        theme,
        fontTable,
        styles,
        numbering: readNumbering(pkg.numbering, styles),
        files,
        noteElements: noteElements(pkg),
        notes: new Map(),
        openNotes: [],
        fields: [],
        graphicParts: new Set(),
        colors: drawingTheme(pkg.theme),
        charts: new Map(),
        bodySize,
        bodySizeCs: 2 * (readFontSize((body.sizeCs ?? body.size ?? DEFAULT_RUN_SIZE) / 2) ?? DEFAULT_RUN_SIZE / 2),
        baseColor: body.color?.hex,
        normal: readNormalStyle({
            font,
            size: bodySize / 2,
            lineSpacing: lineMultiple(line, font),
            spaceBefore: twipsToPt(para.before ?? 0),
            spaceAfter: twipsToPt(para.after ?? 0),
            color: body.color?.hex && markColor(body.color.hex),
        }),
        page,
        columnTwips: twips.width - twips.margin.left - twips.margin.right,
        columnPx: Math.floor(px.width - px.margin.left - px.margin.right),
        lost,
        publicOrigin,
    };
}

// Word draws a margin a section leaves out at 1 in; a size it leaves out is the default A4.
const WORD_MARGIN_MM = ptToMm(72);

// Through the one reader of a stored page, so a file's page is clamped as a peer's is, a band's distance from the edge
// within its margin too. w:orient is not read: Word draws the page w by h whatever it says.
function sectionPage(sectPr: XmlElement | undefined): PageSetup {
    const size = wChild(sectPr, 'pgSz');
    const margin = wChild(sectPr, 'pgMar');
    const mm = (element: XmlElement | undefined, local: string) => {
        const twips = twipsOf(w(element, local));
        return twips === undefined ? undefined : twipsToMm(twips);
    };
    return readPageSetup({
        width: mm(size, 'w'),
        height: mm(size, 'h'),
        marginTop: mm(margin, 'top') ?? WORD_MARGIN_MM,
        marginRight: mm(margin, 'right') ?? WORD_MARGIN_MM,
        marginBottom: mm(margin, 'bottom') ?? WORD_MARGIN_MM,
        marginLeft: mm(margin, 'left') ?? WORD_MARGIN_MM,
        headerDistance: mm(margin, 'header'),
        footerDistance: mm(margin, 'footer'),
    });
}

export function readDocument(reader: Reader): JSONContent[] {
    const body = wChild(reader.pkg.document.root, 'body');
    if (!body) return [];
    const scope: Scope = { part: reader.pkg.document, story: 'body', tables: 0 };
    return placeAnchors(buildBlocks(readBlocks(reader, xmlElements(body), scope)), reader.normal);
}

// A header or footer part's blocks, read as the body's are, through the part's own relationships, its lists counting
// on their own as a band's do in Eigen. A band's last block draws no space after (PAGE_BAND_CLASS), so one the docx sets
// there isn't kept.
export function readBand(reader: Reader, part: Part): JSONContent[] {
    reader.fields.length = 0;
    const { numbering } = reader;
    reader.numbering = numbering.restarted();
    const blocks = buildBlocks(readBlocks(reader, xmlElements(part.root), { part, story: 'band', tables: 0 }));
    reader.numbering = numbering;
    const last = blocks.at(-1);
    if (last?.attrs?.['spaceAfter'] == null) return blocks;
    return [...blocks.slice(0, -1), { ...last, attrs: { ...last.attrs, spaceAfter: null } }];
}

// Endnotes are footnotes: Google Docs has none, and Word draws both from one kind of part. The separators and the
// notice no reference names are no notes.
function noteElements(pkg: DocxPackage): Map<string, { part: Part; note: XmlElement }> {
    const notes = new Map<string, { part: Part; note: XmlElement }>();
    for (const [type, part] of [
        ['footnote', pkg.footnotes],
        ['endnote', pkg.endnotes],
    ] as const) {
        if (!part) continue;
        for (const note of xmlElements(part.root)) {
            const id = w(note, 'id');
            const separator = NOTE_SEPARATORS.some((kind) => kind === w(note, 'type'));
            const key = `${type}-${id}`;
            if (note.local === type && id !== undefined && !separator && !notes.has(key))
                notes.set(key, { part, note });
        }
    }
    return notes;
}

// A note's paragraphs, read through its part's own relationships, once per depth however often it is referenced: each
// copy past the first is charged as the pieces no tag counts are. A note referenced in a note is its text there; one
// referenced deeper, or from inside itself, is dropped, so the walk nests at most twice and a note's text is the same
// whichever reference reads it first. Its lists count on their own, as a note's do in Eigen. Undefined for a note the
// file lacks.
export function readNote(reader: Reader, type: 'footnote' | 'endnote', id: string): JSONContent[] | undefined {
    const note = `${type}-${id}`;
    const key = `${note}@${reader.openNotes.length}`;
    const read = reader.notes.get(key);
    if (read) {
        reader.pkg.pieces.charge(read.weight);
        return read.content;
    }
    const found = reader.noteElements.get(note);
    if (!found || reader.openNotes.length > 1 || reader.openNotes.includes(note)) return undefined;
    // A field open in the body around the reference stays open there, and so do the body's list counters.
    const { fields, numbering } = reader;
    reader.fields = [];
    reader.numbering = numbering.restarted();
    reader.openNotes.push(note);
    const blocks = buildBlocks(
        readBlocks(reader, xmlElements(found.note), { part: found.part, story: 'note', tables: 0 }),
    );
    reader.openNotes.pop();
    reader.fields = fields;
    reader.numbering = numbering;
    const paragraphs = blocks.flatMap(storyParagraphs);
    trimStart(paragraphs[0]?.content ?? []);
    const content =
        flattenNestedStories({
            type: 'footnote',
            content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
        }).content ?? [];
    reader.notes.set(key, { content, weight: weightOf(content) });
    return content;
}

// A note or a text box holds paragraphs: a heading's or a code block's text is one, and a list's, a quote's or a table's
// paragraphs are its own. A rule or a break holds none.
export function storyParagraphs(block: JSONContent): JSONContent[] {
    if (block.type === 'paragraph') return [block];
    if (PROSE_TEXTBLOCKS.includes(block.type ?? '') || block.type === 'codeBlock')
        return [{ type: 'paragraph', ...(block.content && { content: block.content }) }];
    return (block.content ?? []).flatMap(storyParagraphs);
}

function weightOf(nodes: JSONContent[]): number {
    return nodes.reduce((sum, node) => sum + 1 + (node.marks?.length ?? 0) + weightOf(node.content ?? []), 0);
}

// flatMap, not a spread push: a body inside one content control can hold more items than a call takes arguments.
export function readBlocks(reader: Reader, elements: XmlElement[], scope: Scope): Item[] {
    return elements.flatMap((element): Item[] => {
        if (isAlternateContent(element)) return readBlocks(reader, wordAlternative(element), scope);
        if (element.ns !== W_NS) return [];
        if (element.local === 'p') return readParagraph(reader, element, scope);
        if (element.local === 'tbl') return readTable(reader, element, scope);
        if (element.local === 'sdt')
            return readBlocks(reader, xmlElements(wChild(element, 'sdtContent') ?? element), scope);
        return WRAPPERS.has(element.local) ? readBlocks(reader, xmlElements(element), scope) : [];
    });
}

// The roles whose node draws its own size: set at the body's, it reads as body text, and no list holds it.
const SIZED = new Set<Role['kind']>(['heading', 'title', 'subtitle']);

const CHECKBOXES = new Map([
    [CHECKBOX_GLYPHS.unchecked, false],
    ['☑', true],
    [CHECKBOX_GLYPHS.checked, true],
]);

function readParagraph(reader: Reader, p: XmlElement, scope: Scope): Item[] {
    const { styles } = reader;
    const direct = readParaProps(wChild(p, 'pPr'));
    const styleId = direct.style && styles.get(direct.style) ? direct.style : styles.defaultParagraph;
    const style = styles.get(styleId);
    const styled = mergePara(styles.docPara, styles.para(styleId));
    let role: Role = styles.role(styleId) ?? { kind: 'paragraph' };
    // A custom heading style gives its outline level; one set on a paragraph directly, or a TOC entry's, draws as body text.
    const outline = styles.para(styleId).outlineLvl;
    if (role.kind === 'paragraph' && outline !== undefined && outline < 6 && !style?.name.startsWith('toc'))
        role = { kind: 'heading', level: outline + 1 };
    const paraRun = mergeRun(styles.docRun, scope.tableRun ?? {}, styles.run(styleId));
    const numId = direct.numId ?? styled.numId;
    const listed = numId !== undefined && numId !== '0';
    // A numbered heading is outline structure, and demoted its number would read as a list.
    if (SIZED.has(role.kind) && !listed && isBodySized(reader, p, paraRun)) role = { kind: 'paragraph' };
    if (role.kind === 'code' && !isMonospace(reader, p, paraRun)) role = { kind: 'paragraph' };

    // No fill of its own is transparent: a cell's shows through.
    const runScope = isFill(direct.shading ?? styled.shading) ? { ...scope, onFill: true } : scope;
    const context: RunContext = {
        scope: runScope,
        paraStyle: styleId,
        role,
        spaceBefore: (mergePara(styled, direct).before ?? 0) / TWIPS_PER_PX,
        pieces: [],
        pending: [],
        leftOut: [],
    };
    walkInline(
        reader,
        xmlElements(p).filter((child) => child.ns !== W_NS || child.local !== 'pPr'),
        context,
    );
    const { pieces } = context;
    const task = taskOf(pieces);
    if (task?.checked && role.kind === 'paragraph') role = { kind: 'taskDone' };
    for (const [index, piece] of pieces.entries())
        if (piece.kind === 'checkbox')
            pieces[index] = {
                kind: 'node',
                node: { type: 'text', text: piece.checked ? CHECKBOX_GLYPHS.checked : CHECKBOX_GLYPHS.unchecked },
            };
    const halves = splitAtBreaks(pieces);

    // A paragraph holding nothing but a page break gives no item: the break joins the open one, and the number stays free.
    const styleLevel = listed && direct.numId === undefined ? reader.numbering.styleLevel(numId, styleId) : undefined;
    const ilvl = Math.min(LIST_LEVELS - 1, Math.max(0, direct.ilvl ?? styled.ilvl ?? styleLevel ?? 0));
    const breakOnly = halves.length > 1 && !halves.some(isShown);
    const list = listed && !breakOnly && !direct.markDeleted ? reader.numbering.next(numId, ilvl) : undefined;
    const props = mergePara(styled, list?.pPr ?? {}, direct);
    const textAlign = textAlignOf(props.jc, props.bidi);

    // Google Docs flattens the Code Block style: every run holding text monospace on the writer's fill, or on a light
    // grey of any shade, as other editors shade code.
    const texts = pieces.filter((piece) => piece.kind === 'node' && piece.node.type === 'text');
    const mono = (piece: Piece) => piece.kind === 'node' && isMonospaceFont(piece.font, reader.fontTable);
    const allMono =
        texts.some(mono) && texts.every((piece) => mono(piece) || (piece.kind === 'node' && isWhitespace(piece.node)));
    if (
        role.kind === 'paragraph' &&
        !list &&
        !task &&
        ((allMono && (props.shading === CODE_BLOCK_LOOK.fill || isLightNeutral(props.shading))) ||
            (texts.length === 0 && props.shading === CODE_BLOCK_LOOK.fill))
    )
        role = { kind: 'code', language: null };

    const borders = props.borders ?? {};
    // A bar alone is a quote only at the writer's width, which a heading in a quote carries too, in any color; the
    // Quote style always is, and its bar counts its depth.
    const writersBar = borders.bar === QUOTE_LOOK.border.sz;
    const leftBar =
        !!borders.left &&
        !borders.top &&
        !borders.bottom &&
        !borders.right &&
        role.kind !== 'code' &&
        (role.kind === 'quote' || writersBar);
    // The writer's code box: its style, or the fill and four borders a Google Docs re-save keeps of it.
    const boxed =
        role.kind === 'code' &&
        (style?.name === STYLE_NAMES.CodeBlock.toLowerCase() ||
            style?.language !== undefined ||
            (props.shading === CODE_BLOCK_LOOK.fill &&
                !!borders.top &&
                !!borders.left &&
                !!borders.bottom &&
                !!borders.right));
    // A hanging first line starts left of the text, where Word draws a bar and an indent nests; an item's holds its
    // number or checkbox, so an item is at its text.
    const indLeft = (props.indLeft ?? 0) + (list || task ? 0 : Math.min(0, props.indFirst ?? 0));
    // Code nests by its indent alone, which assemble.ts reads against the list item around it.
    const quote = leftBar ? Math.max(1, Math.round(indLeft / QUOTE_LOOK.indent)) : role.kind === 'quote' ? 1 : 0;
    const roleLook = nodeLook(role.kind, role.kind === 'heading' ? role.level : undefined);
    // Under a done task the editor strikes nested open ones too, so their look is the done one's.
    const done = markColor(TASK_DONE_LOOK.color);
    const shown = texts.flatMap((piece) =>
        piece.kind === 'node' && piece.node.text?.trim() ? [piece.node.marks ?? []] : [],
    );
    const looksDone =
        shown.length > 0 &&
        shown.every(
            (marks) =>
                marks.some((mark) => mark.type === 'strike') &&
                marks.some((mark) => mark.type === 'textStyle' && mark.attrs?.['color'] === done),
        );
    if (task?.checked || (task && looksDone)) stripLook(pieces, 'strike', TASK_DONE_LOOK.color);

    // A numbered heading or title keeps its number as text: the schema holds no numbered heading.
    const label = list && SIZED.has(role.kind) ? list.label() : '';
    if (label)
        halves[0]?.unshift({
            kind: 'node',
            node: { type: 'text', text: list?.suffix === 'nothing' ? label : `${label} ` },
        });

    // What the paragraph sets apart from the docx's Normal, or a heading, a title, a quote or a note from its style,
    // whose look is the node's. The writer rescales the line of a paragraph all in one family (familyLineScale), which
    // this undoes over the same faces, so a line Word draws as the Normal's reads as none.
    const { normal } = reader;
    const normalBase = role.kind === 'paragraph' && scope.story !== 'note';
    const base = normalBase ? mergePara(styles.docPara, styles.para(styles.defaultParagraph)) : styled;
    const autoLine = (para: ParaProps) =>
        (para.lineRule ?? 'auto') === 'auto' ? (para.line ?? SINGLE_LINE) : undefined;
    const line = autoLine(props);
    const baseLine = autoLine(base);
    const mark: RunFace = {
        family:
            fontMark(byFace(' ', paraRun.fonts, paraRun, false)[0]?.font, reader.fontTable, normal.font) ?? normal.font,
        size: paraRun.size ?? DEFAULT_RUN_SIZE,
    };
    // Every run the writer counts: each run of text, whitespace too, and a field or a note reference in the style's run;
    // not the space a task's or a note's text starts with, which goes, as the writer writes the checkbox or the note's
    // number and the space after it apart.
    const noteNumbered =
        scope.story === 'note' &&
        descendants(p, W_NS, 'footnoteRef').length + descendants(p, W_NS, 'endnoteRef').length > 0;
    const start =
        task || noteNumbered ? pieces.findIndex((piece) => !(piece.kind === 'node' && isWhitespace(piece.node))) : 0;
    const faces = pieces.slice(Math.max(0, start)).flatMap((piece) => {
        if (piece.kind !== 'node') return [];
        if (piece.node.type === 'pageNumber' || piece.node.type === 'footnote') return [mark];
        if (piece.node.type !== 'text' || !piece.node.text || piece.size === undefined) return [];
        return [{ family: fontMark(piece.font, reader.fontTable, normal.font) ?? normal.font, size: piece.size }];
    });
    // An at-least Normal reads as single, so the Normal's own line is the one to compare with. A style draws its line in
    // its own font, the style's run's. The writer writes a rescaled line on the paragraph itself, so a node read against
    // its style that takes its line from the style reads as none, whatever family its runs are in.
    const baseSpacing = normalBase
        ? normal.lineSpacing
        : baseLine === undefined
          ? undefined
          : lineMultiple(baseLine, mark.family);
    const multiple = line === undefined ? undefined : lineMultiple(line / familyLineScale(mark, faces), mark.family);
    const lineSpacing =
        multiple !== undefined &&
        (normalBase || direct.line !== undefined || list?.pPr.line !== undefined) &&
        (baseSpacing === undefined || Math.round(multiple * 100) !== Math.round(baseSpacing * 100))
            ? multiple
            : undefined;
    const before = props.before ?? 0;
    const after = props.after ?? 0;
    // A cell's paragraphs take their spacing from the cell.
    const format = {
        lineSpacing,
        spaceBefore: scope.tables > 0 || scope.box || before === (base.before ?? 0) ? undefined : twipsToPt(before),
        spaceAfter: scope.tables > 0 || scope.box || after === (base.after ?? 0) ? undefined : twipsToPt(after),
    };
    // An item's indent holds its number or checkbox.
    const indent =
        list || task
            ? undefined
            : { left: props.indLeft ?? 0, right: props.indRight ?? 0, firstLine: props.indFirst ?? 0 };

    const captionColor = markColor(CAPTION_LOOK.color);
    const markSize = direct.markSize ?? styles.run(styleId).size ?? DEFAULT_RUN_SIZE;
    // A paragraph whose mark and text are hidden is not there at all.
    const markHidden = direct.markHidden ?? styles.run(styleId).vanish ?? false;
    const items: Item[] = [];
    if (props.pageBreakBefore && scope.story === 'body') items.push({ kind: 'break' });
    const split = halves.length > 1;
    let numbered = false;
    for (const [index, half] of halves.entries()) {
        if (index > 0) items.push({ kind: 'break' });
        // A task's heading is a paragraph (assemble.ts), and only the half that takes the task is one. In an italic
        // node an italic mark is a run Word draws upright, and Google Docs writes the node's own look as direct
        // formatting.
        const look = !numbered && task ? {} : roleLook;
        for (const piece of half)
            if (piece.kind === 'node' && piece.italic !== undefined && piece.italic !== !!look.italic)
                piece.node.marks = [...(piece.node.marks ?? []), { type: 'italic' }];
        if (quote > 0) stripLook(half, QUOTE_LOOK.italic && !look.italic ? 'italic' : undefined, QUOTE_LOOK.color);
        if (look.color) stripLook(half, undefined, look.color);
        const content = half.flatMap((piece) => (piece.kind === 'node' ? [piece.node] : []));
        if (!numbered && task) trimStart(content);
        if (content.length > MAX_INLINE_NODES) throw new ApiError(413, IMPORT_MESSAGES.docx.tooLarge);
        const visible = isShown(half);
        const isRule = half.some((piece) => piece.kind === 'hr');
        if ((split || markHidden || direct.markDeleted) && !visible && !isRule) continue;
        const halfTexts = half.filter(
            (piece) => piece.kind === 'node' && piece.node.type === 'text' && piece.node.text?.trim(),
        );
        // An empty heading is the blank line Word shows, not a heading's height; an empty title stays one, as Word
        // draws it at the title's height.
        const kind: Role = visible
            ? role
            : isRule
              ? { kind: 'hr' }
              : role.kind === 'heading'
                ? { kind: 'paragraph' }
                : role;
        // A size or a space the node draws in Eigen is none: the writer's style holds it, so it would come back as none.
        const own = ownTextLook(kind.kind, kind.kind === 'heading' ? kind.level : 1, normal, scope.story === 'note');
        if (own) for (const node of content) dropOwn(node, 'fontSize', own.sizePt);
        const unlessOwn = (pt: number | undefined, ownTwips: number | undefined) =>
            pt !== undefined && ownTwips !== undefined && pt === twipsToPt(ownTwips) ? undefined : pt;
        // The writer's styles write a node's own line in the Normal's font.
        const ownLine = own && Math.round(lineMultiple(own.line, normal.font) * 100);
        const keptLineSpacing =
            format.lineSpacing !== undefined && Math.round(format.lineSpacing * 100) === ownLine
                ? undefined
                : format.lineSpacing;
        const para: ParagraphItem = {
            kind: 'para',
            role: kind,
            inlines: content,
            textAlign,
            continued: numbered,
            indLeft,
            quote,
            empty: !visible && !content.some((node) => node.type === 'text' && node.text),
            small: halfTexts.length > 0 && halfTexts.every((piece) => piece.kind === 'node' && piece.small),
            captionLook:
                halfTexts.length > 0 &&
                halfTexts.every(
                    (piece) =>
                        piece.kind === 'node' &&
                        piece.small &&
                        piece.node.marks?.some(
                            (mark) => mark.type === 'textStyle' && mark.attrs?.['color'] === captionColor,
                        ),
                ),
            hairline: (props.exactLine !== undefined && props.exactLine <= 40) || markSize <= 4,
            // Word spaces a split paragraph above its first line and below its last.
            format: {
                lineSpacing: keptLineSpacing,
                spaceBefore: index === 0 ? unlessOwn(format.spaceBefore, own?.before) : undefined,
                baseBefore: twipsToPt(base.before ?? 0),
                baseAfter: twipsToPt(base.after ?? 0),
                spaceAfter: index === halves.length - 1 ? unlessOwn(format.spaceAfter, own?.after) : undefined,
            },
            indent,
        };
        if (!numbered && list && !SIZED.has(role.kind)) para.list = { ...list, ilvl };
        if (!numbered && task) para.task = task;
        if (para.list || para.task) para.numberAt = indLeft + Math.min(0, props.indFirst ?? 0);
        if (boxed) para.boxed = true;
        if (direct.markDeleted && index === halves.length - 1) para.joinsNext = true;
        if (label && index === 0) para.labelled = true;
        // A framed paragraph holding only an image or a chart is a wrapped figure.
        if (props.frame) para.frame = props.frame;
        if (props.frame && isFigureOnly(para)) {
            for (const node of content)
                if (node.attrs && !node.attrs['layout']) node.attrs['layout'] = `wrap-${props.frame}`;
        }
        if (para.empty && borders.bottom && !borders.left && role.kind !== 'code') para.role = { kind: 'hr' };
        numbered = true;
        items.push(para);
    }
    // A text box's blocks follow the paragraph that anchors it, at its text and in its quotes, so they stay in its item.
    for (const item of context.pending) {
        if (item.kind === 'para') {
            item.indLeft += indLeft;
            if (item.numberAt !== undefined) item.numberAt += indLeft;
            item.quote ||= quote;
        } else if (item.kind === 'table') item.indent += indLeft;
        items.push(item);
    }
    for (const leftOut of context.leftOut) leftOut.textAlign = textAlign;
    if (props.sectionBreak && scope.story === 'body') items.push({ kind: 'break' });
    return items;
}

// Each run's text in the faces Word draws it in, beside the run's own properties. A run's text box is not searched.
function textFaces(reader: Reader, p: XmlElement, paraRun: DocxRunProps) {
    return descendants(p, W_NS, 'r').flatMap((run) => {
        const direct = readRunProps(wChild(run, 'rPr'), reader.theme);
        const props = mergeRun(paraRun, reader.styles.run(direct.style), direct);
        return xmlElements(run)
            .filter((child) => hasXmlName(child, W_NS, 't'))
            .flatMap((t) => byFace(xmlText(t), props.fonts, props, true, () => reader.pkg.pieces.charge(1)))
            .filter((face) => face.text.trim())
            .map((face) => ({ ...face, direct }));
    });
}

// A run holding text set by hand below its heading's size and at most the body's, in half points. The audit reads it
// as the reader does.
export function isBodySizedRun(size: number | undefined, heading: number, body: number): boolean {
    return size !== undefined && size < heading && size <= body;
}

// Every run holding text body sized, which Word draws as body text, complex script at its szCs; the style's bold and
// italic then stay as marks.
function isBodySized(reader: Reader, p: XmlElement, heading: DocxRunProps): boolean {
    const headingSize = heading.size ?? DEFAULT_RUN_SIZE;
    const headingSizeCs = heading.sizeCs ?? headingSize;
    const faces = textFaces(reader, p, heading).map(({ complex, direct }) =>
        complex
            ? { size: direct.sizeCs, heading: headingSizeCs, body: reader.bodySizeCs }
            : { size: direct.size, heading: headingSize, body: reader.bodySize },
    );
    return faces.length > 0 && faces.every(({ size, heading, body }) => isBodySizedRun(size, heading, body));
}

// A code style draws code only where every run holding text is monospace, an empty line where its mark is;
// HTML Preformatted in Times is prose.
function isMonospace(reader: Reader, p: XmlElement, paraRun: DocxRunProps): boolean {
    const faces = textFaces(reader, p, paraRun);
    if (faces.length > 0) return faces.every((face) => isMonospaceFont(face.font, reader.fontTable));
    const mark = mergeRun(paraRun, readRunProps(wChild(wChild(p, 'pPr'), 'rPr'), reader.theme));
    return isMonospaceFont(byFace(' ', mark.fonts, mark, false)[0]?.font, reader.fontTable);
}

function splitAtBreaks(pieces: Piece[]): Piece[][] {
    const halves: Piece[][] = [[]];
    for (const piece of pieces) {
        if (piece.kind === 'break') halves.push([]);
        else halves.at(-1)?.push(piece);
    }
    return halves;
}

function isShown(half: Piece[]): boolean {
    return half.some((piece) => piece.kind === 'node' && !isWhitespace(piece.node));
}

// A checkbox, a content control's or Google Docs' glyph, opens a task item.
function taskOf(pieces: Piece[]): { checked: boolean } | undefined {
    const first = pieces.findIndex((piece) => !(piece.kind === 'node' && isWhitespace(piece.node)));
    const opener = pieces[first];
    if (opener?.kind === 'checkbox') {
        pieces.splice(first, 1);
        return { checked: opener.checked };
    }
    if (opener?.kind !== 'node' || opener.node.type !== 'text') return undefined;
    const text = opener.node.text ?? '';
    const checked = CHECKBOXES.get(text.charAt(0));
    if (checked === undefined || (text.length > 1 && !/^[\t ]/.test(text.slice(1)))) return undefined;
    opener.node.text = text.slice(1);
    return { checked };
}

// Word sets a task's text off its checkbox, and a note's off its number, with spaces or a tab; Eigen draws its own.
function trimStart(inlines: JSONContent[]): void {
    for (let first = inlines[0]; first?.type === 'text'; first = inlines[0]) {
        const rest = (first.text ?? '').replace(/^[\t ]+/, '');
        if (rest) {
            first.text = rest;
            return;
        }
        inlines.shift();
    }
}

function stripLook(pieces: Piece[], toggle: string | undefined, color: string): void {
    for (const piece of pieces) {
        if (piece.kind !== 'node') continue;
        if (piece.node.marks && toggle) piece.node.marks = piece.node.marks.filter((mark) => mark.type !== toggle);
        dropOwn(piece.node, 'color', markColor(color));
    }
}

// A font mark's value the node draws itself goes, and the mark with it when nothing else is left.
function dropOwn(node: JSONContent, key: 'color' | 'fontSize', value: string | number): void {
    if (!node.marks) return;
    node.marks = node.marks.flatMap((mark) => {
        if (mark.type !== 'textStyle' || mark.attrs?.[key] !== value) return [mark];
        const attrs = { ...mark.attrs, [key]: null };
        return Object.values(attrs).some((held) => held !== null) ? [{ ...mark, attrs }] : [];
    });
    if (node.marks.length === 0) delete node.marks;
}
