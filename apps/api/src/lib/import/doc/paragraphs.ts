import type { JSONContent } from '@tiptap/core';
import { type XmlElement, xmlElements } from '../../core/xml';
import { CODE_BLOCK_LOOK, QUOTE_LOOK, STYLE_NAMES, TASK_DONE_LOOK, W_NS } from '../../export/doc/ooxml';
import { build, type Item, isFigureOnly, isWhitespace, type Para } from './assemble';
import { isMonospace, readTheme, type Theme } from './docx-fonts';
import type { MediaPart } from './drawings';
import { MAX_LEVEL, Numbering } from './numbering';
import { alternative, int, isAlternateContent, type Package, type Part, w, wChild } from './package';
import { type Field, type Piece, type RunContext, walkInline } from './runs';
import { mergePara, mergeRun, type Role, type RunProps, readParaProps, Styles } from './styles';
import { isFill, readTable } from './tables';

// The block walk turns every paragraph into items in document order, so Word's counters run in order across tables,
// text boxes and notes; assemble.ts turns the items into blocks.

type NoteRef = { type: 'footnote' | 'endnote'; id: string; number: number };

export type Reader = {
    pkg: Package;
    theme: Theme;
    styles: Styles;
    numbering: Numbering;
    images: MediaPart[];
    imageNames: Map<string, string>;
    // By type and id, in the order first referenced: a note is read once however often it is referenced.
    notes: Map<string, NoteRef>;
    fields: Field[];
    // The body's size in half-points and its color, which no run needs a mark for.
    bodySize: number;
    baseColor: string | undefined;
    columnTwips: number;
    publicOrigin: string | undefined;
};

// Per part: its relationships, whether its breaks page, the tables around it, the table style, the cell's width in px
// and whether the text sits on a fill the schema drops.
export type Scope = {
    part: Part;
    inNote: boolean;
    tables: number;
    tableRun?: RunProps;
    room?: number;
    onFill?: boolean;
};

export function createReader(pkg: Package, publicOrigin: string | undefined): Reader {
    const theme = readTheme(pkg.theme);
    const styles = new Styles(pkg.styles, theme);
    const body = mergeRun(styles.docRun, styles.run(styles.defaultParagraph));
    const sectPr = wChild(wChild(pkg.document.root, 'body'), 'sectPr');
    const margin = wChild(sectPr, 'pgMar');
    return {
        pkg,
        theme,
        styles,
        numbering: new Numbering(pkg.numbering, styles),
        images: [],
        imageNames: new Map(),
        notes: new Map(),
        fields: [],
        // Word's default is 10 pt.
        bodySize: body.size ?? 20,
        baseColor: body.color,
        columnTwips:
            (int(w(wChild(sectPr, 'pgSz'), 'w')) ?? 11906) -
            (int(w(margin, 'left')) ?? 1440) -
            (int(w(margin, 'right')) ?? 1440),
        publicOrigin,
    };
}

export function readDocument(reader: Reader): JSONContent[] {
    const body = wChild(reader.pkg.document.root, 'body');
    if (!body) return [];
    const blocks = build(
        readBlocks(reader, xmlElements(body), { part: reader.pkg.document, inNote: false, tables: 0 }),
    );
    const notes = readNotes(reader);
    if (notes.length > 0) blocks.push({ type: 'orderedList', attrs: { start: 1, type: null }, content: notes });
    return blocks;
}

// Notes as the import has always shown them: a [n] reference, and at the end one numbered list with a back link per note.
// A note referenced inside a note joins the end of the map, which this loop still reaches.
function readNotes(reader: Reader): JSONContent[] {
    const items: JSONContent[] = [];
    const index = (part: Part | undefined, type: NoteRef['type']) => {
        const byId = new Map<string, XmlElement>();
        for (const note of part ? xmlElements(part.root) : []) {
            const id = w(note, 'id');
            if (note.local === type && id !== undefined && !byId.has(id)) byId.set(id, note);
        }
        return byId;
    };
    const byType = {
        footnote: index(reader.pkg.footnotes, 'footnote'),
        endnote: index(reader.pkg.endnotes, 'endnote'),
    };
    for (const ref of reader.notes.values()) {
        const part = ref.type === 'footnote' ? reader.pkg.footnotes : reader.pkg.endnotes;
        const note = byType[ref.type].get(ref.id);
        if (!part || !note) continue;
        reader.fields.length = 0;
        const blocks = build(readBlocks(reader, xmlElements(note), { part, inNote: true, tables: 0 }));
        const back: JSONContent[] = [
            { type: 'text', text: ' ' },
            { type: 'text', text: '↑', marks: [{ type: 'link', attrs: { href: `#${ref.type}-ref-${ref.id}` } }] },
        ];
        const last = blocks.at(-1);
        if (last?.type === 'paragraph') last.content = [...(last.content ?? []), ...back];
        else blocks.push({ type: 'paragraph', content: back });
        if (blocks[0]?.type !== 'paragraph') blocks.unshift({ type: 'paragraph' });
        items.push({ type: 'listItem', content: blocks });
    }
    return items;
}

export const WRAPPERS = new Set(['customXml', 'ins', 'moveTo', 'smartTag']);

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

const CHECKBOX_GLYPHS = new Map([
    ['☐', false],
    ['☑', true],
    ['☒', true],
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
            pieces[index] = { kind: 'node', node: { type: 'text', text: piece.checked ? '☒' : '☐' } };
    const halves = splitAtBreaks(pieces);

    // A paragraph holding nothing but a page break gives no item: the break joins the open one, and the number stays free.
    const numId = direct.numId ?? styled.numId;
    const ilvl = Math.min(MAX_LEVEL, Math.max(0, direct.ilvl ?? styled.ilvl ?? 0));
    const breakOnly = halves.length > 1 && !halves.some(isShown);
    const list =
        numId && numId !== '0' && !breakOnly && !direct.markDeleted ? reader.numbering.next(numId, ilvl) : undefined;
    const props = mergePara(styled, { indLeft: list?.indLeft }, direct);

    // Google Docs flattens the Code Block style: a shaded paragraph all in a monospace font.
    const texts = pieces.filter((piece) => piece.kind === 'node' && piece.node.type === 'text');
    const allMono = texts.length > 0 && texts.every((piece) => piece.kind === 'node' && isMonospace(piece.font));
    const shaded = !!props.shading && props.shading !== 'FFFFFF';
    if (
        role.kind === 'paragraph' &&
        !list &&
        !task &&
        ((allMono && shaded) || (texts.length === 0 && props.shading === CODE_BLOCK_LOOK.fill))
    )
        role = { kind: 'code', language: null };

    const borders = props.borders ?? {};
    const leftBar = !!borders.left && !borders.top && !borders.bottom && !borders.right && role.kind !== 'code';
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
    const indLeft = props.indLeft ?? 0;
    // Code nests by its indent alone, which assemble.ts reads against the list item around it.
    const quote = leftBar ? Math.max(1, Math.round(indLeft / QUOTE_LOOK.indent)) : role.kind === 'quote' ? 1 : 0;
    // The quote's and the done task's look, which Google Docs writes as direct formatting, is the node's.
    if (quote > 0) stripLook(pieces, QUOTE_LOOK.italic ? 'italic' : undefined, QUOTE_LOOK.color);
    // Under a done task the editor strikes nested open ones too, so their look is the done one's.
    const done = `#${TASK_DONE_LOOK.color.toLowerCase()}`;
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

    // A numbered heading keeps its number as text: the schema holds no numbered heading.
    const label = list && role.kind === 'heading' ? list.label() : '';
    if (label)
        halves[0]?.unshift({
            kind: 'node',
            node: { type: 'text', text: list?.suffix === 'nothing' ? label : `${label} ` },
        });

    const markSize = direct.markSize ?? styles.run(styleId).size ?? 24;
    // A paragraph whose mark and text are hidden is not there at all.
    const markHidden = direct.markHidden ?? styles.run(styleId).vanish ?? false;
    const items: Item[] = [];
    if (props.pageBreakBefore && !scope.inNote) items.push({ kind: 'break' });
    const split = halves.length > 1;
    let numbered = false;
    for (const [index, half] of halves.entries()) {
        if (index > 0) items.push({ kind: 'break' });
        const content = half.flatMap((piece) => (piece.kind === 'node' ? [piece.node] : []));
        const visible = isShown(half);
        const isRule = half.some((piece) => piece.kind === 'hr');
        if ((split || markHidden || direct.markDeleted) && !visible && !isRule) continue;
        const halfTexts = half.filter(
            (piece) => piece.kind === 'node' && piece.node.type === 'text' && piece.node.text?.trim(),
        );
        const para: Para = {
            kind: 'para',
            role: isRule && !visible ? { kind: 'hr' } : role,
            inlines: content,
            textAlign: alignmentOf(props.jc, props.bidi),
            continued: numbered,
            indLeft,
            quote,
            empty: !visible && !content.some((node) => node.type === 'text' && node.text),
            small: halfTexts.length > 0 && halfTexts.every((piece) => piece.kind === 'node' && piece.small),
            hairline: (props.exactLine !== undefined && props.exactLine <= 40) || markSize <= 4,
        };
        if (!numbered && list && role.kind !== 'heading') para.list = { ...list, ilvl };
        if (!numbered && task) para.task = task;
        if (boxed) para.boxed = true;
        if (direct.markDeleted && index === halves.length - 1) para.joinsNext = true;
        if (label && index === 0) para.labelled = true;
        // A framed paragraph holding only an image is a wrapped figure.
        if (props.frame && isFigureOnly(para)) {
            for (const node of content)
                if (node.attrs && !node.attrs['layout']) node.attrs['layout'] = `wrap-${props.frame}`;
        }
        if (para.empty && borders.bottom && !borders.left && role.kind !== 'code') para.role = { kind: 'hr' };
        numbered = true;
        items.push(para);
    }
    for (const item of context.pending) items.push(item);
    if (props.sectionBreak && !scope.inNote) items.push({ kind: 'break' });
    return items;
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
        dropLeadingTab(pieces, first);
        return { checked: opener.checked };
    }
    if (opener?.kind !== 'node' || opener.node.type !== 'text') return undefined;
    const text = opener.node.text ?? '';
    const checked = CHECKBOX_GLYPHS.get(text.charAt(0));
    if (checked === undefined || (text.length > 1 && !/^[\t {2}]/.test(text.slice(1)))) return undefined;
    const rest = text.slice(1).replace(/^[\t {2}]/, '');
    if (rest) opener.node.text = rest;
    else {
        pieces.splice(first, 1);
        dropLeadingTab(pieces, first);
    }
    return { checked };
}

function dropLeadingTab(pieces: Piece[], from: number): void {
    const next = pieces[from];
    if (next?.kind === 'node' && next.node.type === 'text' && next.node.text?.startsWith('\t')) {
        const rest = next.node.text.slice(1);
        if (rest) next.node.text = rest;
        else pieces.splice(from, 1);
    }
}

function stripLook(pieces: Piece[], toggle: string | undefined, color: string): void {
    const hex = `#${color.toLowerCase()}`;
    for (const piece of pieces) {
        if (piece.kind !== 'node' || !piece.node.marks) continue;
        piece.node.marks = piece.node.marks.flatMap((mark) => {
            if (mark.type === toggle) return [];
            if (mark.type !== 'textStyle' || mark.attrs?.['color'] !== hex) return [mark];
            return mark.attrs?.['fontFamily'] ? [{ ...mark, attrs: { ...mark.attrs, color: null } }] : [];
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
