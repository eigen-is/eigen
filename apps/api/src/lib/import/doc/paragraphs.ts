import { isDeepStrictEqual } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { DOCUMENT_FONT, EIGEN_FONT_NAMES } from '@workspace/lib/constants/fonts';
import {
    flattenNestedFootnotes,
    type NormalStyle,
    type PageSetup,
    PROSE_TEXTBLOCKS,
    pagePx,
    pageTwips,
    readNormalStyle,
    readPageSetup,
} from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../core/errors';
import { isAlternateContent, W_NS } from '../../core/ooxml';
import { hasXmlName, type XmlElement, xmlElements, xmlText } from '../../core/xml';
import { CAPTION_LOOK, CODE_BLOCK_LOOK, nodeLook, QUOTE_LOOK, TASK_DONE_LOOK } from '../../document/looks';
import { CHECKBOX_GLYPHS, LIST_LEVELS, NOTE_SEPARATORS, STYLE_NAMES } from '../../document/wordml';
import { fontLineHeight } from '../../export/fonts';
import { DOCUMENT_TOO_LARGE } from '../messages';
import { build, type Item, isFigureOnly, isWhitespace, type Para } from './assemble';
import { byFace, type FontTable, fontMark, isMonospaceFont, readFontTable, readTheme, type Theme } from './docx-fonts';
import type { MediaPart } from './drawings';
import { Numbering } from './numbering';
import { alternative, type DocxPackage, descendants, type Part, twipsOf, w, wChild } from './package';
import { type Field, type Piece, type RunContext, walkInline } from './runs';
import {
    type DocxRunProps,
    isFill,
    isLightNeutral,
    markColor,
    mergePara,
    mergeRun,
    type ParaProps,
    type Role,
    readParaProps,
    readRunProps,
    Styles,
} from './styles';
import { readTable } from './tables';

// The block walk turns every paragraph into items in document order, so Word's counters run in order across tables,
// text boxes and notes; assemble.ts turns the items into blocks.

export type Reader = {
    pkg: DocxPackage;
    theme: Theme;
    fontTable: FontTable;
    styles: Styles;
    numbering: Numbering;
    images: MediaPart[];
    imageNames: Map<string, string>;
    // Each note by type and id, its part beside it, and each as read: a note is read once however often it is
    // referenced. The notes being read, outermost first.
    noteElements: Map<string, { part: Part; note: XmlElement }>;
    notes: Map<string, { content: JSONContent[]; weight: number }>;
    openNotes: string[];
    fields: Field[];
    // Charts and SmartArt, whose graphic the schema can't hold, and the parts of theirs read: each is read once.
    graphicsDropped: number;
    graphicParts: Set<string>;
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
    // Earlier sections whose page differs from it.
    pagesDropped: number;
    // Pictures a band anchored, which it holds as block figures.
    bandAnchors: number;
    // What a band drops: a picture behind the text or a VML one, a letterhead or a watermark, and a note reference.
    bandDropped: number;
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
};

export function createReader(pkg: DocxPackage, publicOrigin: string | undefined): Reader {
    const defaults = wChild(wChild(wChild(pkg.styles, 'docDefaults'), 'rPrDefault'), 'rPr');
    const lang = wChild(defaults, 'lang');
    const theme = readTheme(pkg.theme, { bidi: w(lang, 'bidi'), eastAsia: w(lang, 'eastAsia') });
    const styles = new Styles(pkg.styles, theme);
    const body = mergeRun(styles.docRun, styles.run(styles.defaultParagraph));
    const fontTable = readFontTable(pkg.fontTable);
    const sectPr = wChild(wChild(pkg.document.root, 'body'), 'sectPr');
    const size = sectionPage(sectPr);
    const page = { ...size, differentFirstPage: pkg.titlePg };
    const px = pagePx(page);
    const twips = pageTwips(page);
    // Word's default is 10 pt.
    const bodySize = body.size ?? 20;
    const font = fontMark(byFace(' ', body.fonts, body, false)[0]?.font, fontTable) ?? DOCUMENT_FONT;
    const para = mergePara(styles.docPara, styles.para(styles.defaultParagraph));
    // Single where no auto line is set, as Google Docs reads an at-least one; in the font's own line, as a paragraph's.
    const line = (para.lineRule ?? 'auto') === 'auto' ? (para.line ?? 240) / 240 : 1;
    return {
        pkg,
        theme,
        fontTable,
        styles,
        numbering: new Numbering(pkg.numbering, styles),
        images: [],
        imageNames: new Map(),
        noteElements: noteElements(pkg),
        notes: new Map(),
        openNotes: [],
        fields: [],
        graphicsDropped: 0,
        graphicParts: new Set(),
        bodySize,
        bodySizeCs: body.sizeCs ?? body.size ?? 20,
        baseColor: body.color?.hex,
        normal: readNormalStyle({
            font,
            size: bodySize / 2,
            lineSpacing: (line * fontLineHeight(font)) / fontLineHeight(DOCUMENT_FONT),
            spaceBefore: (para.before ?? 0) / 20,
            spaceAfter: (para.after ?? 0) / 20,
            color: body.color?.hex && markColor(body.color.hex),
        }),
        page,
        columnTwips: twips.width - twips.margin.left - twips.margin.right,
        columnPx: Math.floor(px.width - px.margin.left - px.margin.right),
        pagesDropped: descendants(pkg.document.root, W_NS, 'sectPr').filter(
            (section) => section !== sectPr && !isDeepStrictEqual(sectionPage(section), size),
        ).length,
        bandAnchors: 0,
        bandDropped: 0,
        publicOrigin,
    };
}

// Word draws a margin a section leaves out at 1 in; a size it leaves out is the default A4.
const WORD_MARGIN_MM = 25.4;

// Through the one reader of a stored page, so a file's page is clamped as a peer's is. w:orient is not read: Word draws
// the page w by h whatever it says.
function sectionPage(sectPr: XmlElement | undefined): PageSetup {
    const size = wChild(sectPr, 'pgSz');
    const margin = wChild(sectPr, 'pgMar');
    const mm = (element: XmlElement | undefined, local: string) => {
        const twips = twipsOf(w(element, local));
        return twips === undefined ? undefined : (twips * 25.4) / 1440;
    };
    return readPageSetup({
        width: mm(size, 'w'),
        height: mm(size, 'h'),
        marginTop: mm(margin, 'top') ?? WORD_MARGIN_MM,
        marginRight: mm(margin, 'right') ?? WORD_MARGIN_MM,
        marginBottom: mm(margin, 'bottom') ?? WORD_MARGIN_MM,
        marginLeft: mm(margin, 'left') ?? WORD_MARGIN_MM,
    });
}

export function readDocument(reader: Reader): JSONContent[] {
    const body = wChild(reader.pkg.document.root, 'body');
    if (!body) return [];
    return build(readBlocks(reader, xmlElements(body), { part: reader.pkg.document, story: 'body', tables: 0 }));
}

// A header or footer part's blocks, read as the body's are, through the part's own relationships.
// A band's last block draws no space after (PAGE_BAND_CLASS), so one the docx sets there isn't kept.
export function readBand(reader: Reader, part: Part): JSONContent[] {
    reader.fields.length = 0;
    const blocks = build(readBlocks(reader, xmlElements(part.root), { part, story: 'band', tables: 0 }));
    const last = blocks.at(-1);
    if (last?.attrs?.['spaceAfter'] == null) return blocks;
    return [...blocks.slice(0, -1), { ...last, attrs: { ...last.attrs, spaceAfter: null } }];
}

// Endnotes are footnotes (S9): Google Docs has none, and Word draws both from one kind of part. The separators and the
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

// A note's paragraphs, read through its part's own relationships, once however often it is referenced from the body:
// each copy past the first is charged as the pieces no tag counts are. A note referenced in a note is its text there;
// one referenced deeper, or from inside itself, is dropped, so the walk nests at most twice. Undefined for a note the
// file lacks.
export function readNote(reader: Reader, type: 'footnote' | 'endnote', id: string): JSONContent[] | undefined {
    const key = `${type}-${id}`;
    const read = reader.notes.get(key);
    if (read) {
        reader.pkg.chargePiece(read.weight);
        return read.content;
    }
    const found = reader.noteElements.get(key);
    if (!found || reader.openNotes.length > 1 || reader.openNotes.includes(key)) return undefined;
    // Read inside another note, its own notes nest too deep and drop, so only a read at the body's depth is kept.
    const whole = reader.openNotes.length === 0;
    // A field open in the body around the reference stays open there.
    const fields = reader.fields;
    reader.fields = [];
    reader.openNotes.push(key);
    const blocks = build(readBlocks(reader, xmlElements(found.note), { part: found.part, story: 'note', tables: 0 }));
    reader.openNotes.pop();
    reader.fields = fields;
    const paragraphs = blocks.flatMap(noteParagraphs);
    trimStart(paragraphs[0]?.content ?? []);
    const note = flattenNestedFootnotes({
        type: 'footnote',
        content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
    });
    const content = note.content ?? [];
    if (whole) reader.notes.set(key, { content, weight: weightOf(content) });
    return content;
}

// A note holds paragraphs: a heading's or a code block's text is one, and a list's, a quote's or a table's paragraphs
// are its own. A rule or a break holds none.
function noteParagraphs(block: JSONContent): JSONContent[] {
    if (block.type === 'paragraph') return [block];
    if (PROSE_TEXTBLOCKS.includes(block.type ?? '') || block.type === 'codeBlock')
        return [{ type: 'paragraph', ...(block.content && { content: block.content }) }];
    return (block.content ?? []).flatMap(noteParagraphs);
}

function weightOf(nodes: JSONContent[]): number {
    return nodes.reduce((sum, node) => sum + 1 + (node.marks?.length ?? 0) + weightOf(node.content ?? []), 0);
}

export const WRAPPERS = new Set(['customXml', 'ins', 'moveTo', 'smartTag']);

// y-tiptap spreads a paragraph's children into one call, which overflows near 500,000; the corpus's most is 274.
export const MAX_INLINE_NODES = 50_000;

// flatMap, not a spread push: a body inside one content control can hold more items than a call takes arguments.
export function readBlocks(reader: Reader, elements: XmlElement[], scope: Scope): Item[] {
    return elements.flatMap((element): Item[] => {
        if (isAlternateContent(element)) return readBlocks(reader, alternative(element), scope);
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
    const context: RunContext = { scope: runScope, paraStyle: styleId, role, pieces: [], pending: [] };
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
    // whose look is the node's. A line is drawn in its family's own line, so it is stored as a multiple of Inter's; the
    // writer scales the line of a paragraph all in one family other than the Normal's by that family's line, which this
    // undoes, so a line Word draws as Normal's reads as none.
    const base =
        role.kind === 'paragraph' && scope.story !== 'note'
            ? mergePara(styles.docPara, styles.para(styles.defaultParagraph))
            : styled;
    const autoLine = (para: ParaProps) => ((para.lineRule ?? 'auto') === 'auto' ? (para.line ?? 240) : undefined);
    const line = autoLine(props);
    const baseLine = autoLine(base);
    const { normal } = reader;
    const families = new Set(
        texts.flatMap((piece) =>
            piece.kind === 'node' && piece.node.text?.trim()
                ? [piece.node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['fontFamily'] ?? normal.font]
                : [],
        ),
    );
    const [family] = families;
    const scaleOf = (font: string) => fontLineHeight(font) / fontLineHeight(DOCUMENT_FONT);
    const scale = families.size === 1 && EIGEN_FONT_NAMES.includes(family) ? scaleOf(family) : 1;
    const lineSpacing =
        line !== undefined &&
        line !== baseLine &&
        (baseLine === undefined ||
            Math.round((line * scale) / 2.4) !== Math.round((baseLine * scaleOf(normal.font)) / 2.4))
            ? (line * scale) / 240
            : undefined;
    const before = props.before ?? 0;
    const after = props.after ?? 0;
    // A cell's paragraphs take their spacing from the cell.
    const format = {
        lineSpacing,
        spaceBefore: scope.tables > 0 || before === (base.before ?? 0) ? undefined : before / 20,
        spaceAfter: scope.tables > 0 || after === (base.after ?? 0) ? undefined : after / 20,
    };
    // An item's indent holds its number or checkbox.
    const indent =
        list || task
            ? undefined
            : { left: props.indLeft ?? 0, right: props.indRight ?? 0, firstLine: props.indFirst ?? 0 };

    const captionColor = markColor(CAPTION_LOOK.color);
    const markSize = direct.markSize ?? styles.run(styleId).size ?? 24;
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
        if (content.length > MAX_INLINE_NODES) throw new ApiError(413, DOCUMENT_TOO_LARGE);
        const visible = isShown(half);
        const isRule = half.some((piece) => piece.kind === 'hr');
        if ((split || markHidden || direct.markDeleted) && !visible && !isRule) continue;
        const halfTexts = half.filter(
            (piece) => piece.kind === 'node' && piece.node.type === 'text' && piece.node.text?.trim(),
        );
        const para: Para = {
            kind: 'para',
            // An empty heading is the blank line Word shows, not a heading's height; an empty title stays one, as Word
            // draws it at the title's height.
            role: visible ? role : isRule ? { kind: 'hr' } : role.kind === 'heading' ? { kind: 'paragraph' } : role,
            inlines: content,
            textAlign: alignmentOf(props.jc, props.bidi),
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
                lineSpacing: format.lineSpacing,
                spaceBefore: index === 0 ? format.spaceBefore : undefined,
                spaceAfter: index === halves.length - 1 ? format.spaceAfter : undefined,
            },
            indent,
        };
        if (!numbered && list && !SIZED.has(role.kind)) para.list = { ...list, ilvl };
        if (!numbered && task) para.task = task;
        if (para.list || para.task) para.numberAt = indLeft + Math.min(0, props.indFirst ?? 0);
        if (boxed) para.boxed = true;
        if (direct.markDeleted && index === halves.length - 1) para.joinsNext = true;
        if (label && index === 0) para.labelled = true;
        // A framed paragraph holding only an image is a wrapped figure.
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
            .flatMap((t) => byFace(xmlText(t), props.fonts, props, true, reader.pkg.chargePiece))
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
    const headingSize = heading.size ?? 20;
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
    const hex = markColor(color);
    for (const piece of pieces) {
        if (piece.kind !== 'node' || !piece.node.marks) continue;
        piece.node.marks = piece.node.marks.flatMap((mark) => {
            if (mark.type === toggle) return [];
            if (mark.type !== 'textStyle' || mark.attrs?.['color'] !== hex) return [mark];
            const attrs = { ...mark.attrs, color: null };
            return Object.values(attrs).some((value) => value !== null) ? [{ ...mark, attrs }] : [];
        });
        if (piece.node.marks.length === 0) delete piece.node.marks;
    }
}

// Left is the default, so no attribute (Google Docs writes it on every paragraph); start and end follow the direction.
function alignmentOf(jc: string | undefined, bidi: boolean | undefined): string | null {
    switch (jc) {
        case 'center':
            return 'center';
        case 'right':
            return 'right';
        case 'start':
            return bidi ? 'right' : null;
        case 'end':
            return bidi ? null : 'right';
        case 'both':
        case 'distribute':
            return 'justify';
        default:
            return null;
    }
}
