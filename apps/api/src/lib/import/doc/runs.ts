import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { readFontSize } from '@workspace/lib/constants/fonts';
import { type Caps, PAGE_NUMBER_KINDS, type PageNumberKind } from '@workspace/lib/docs/eigendoc';
import { MathError, readOmml, readOmmlText, writeMathml } from '@workspace/math';
import { isAlternateContent, isOn, M_NS, R_NS, W_NS, W14_NS } from '../../core/ooxml';
import {
    trimXmlSpace,
    XML_NAMESPACE,
    type XmlElement,
    xmlAttr,
    xmlChild,
    xmlChildren,
    xmlElements,
    xmlText,
} from '../../core/xml';
import { LINK_LOOK } from '../../document/looks';
import { DEFAULT_HIGHLIGHT, PAGE_NUMBER_FIELDS } from '../../document/wordml';
import type { Item } from './assemble';
import { byFace, fontMark, isMonospaceFont, symbolOf } from './docx-fonts';
import { readDrawing, readVml } from './drawings';
import { alternative, onOff, w, wChild } from './package';
import type { Reader, Scope } from './paragraphs';
import {
    ABSORBED,
    type DocxRunProps,
    isDark,
    isFill,
    isLight,
    isLightNeutral,
    markColor,
    mergeRun,
    type Role,
    readRunProps,
    TOGGLES,
} from './styles';

// A paragraph's content, run by run: text with its marks, breaks, checkboxes and rules, which the paragraph sorts out.
// italic is whether Word draws a run italic: whether that is the mark waits for the paragraph's node.
// equation is the text of an equation past a bound, which the text beside it is set off from.
export type Piece =
    | { kind: 'node'; node: JSONContent; small?: boolean; font?: string; italic?: boolean; equation?: true }
    | { kind: 'break' }
    | { kind: 'clear' }
    | { kind: 'checkbox'; checked: boolean }
    | { kind: 'hr' };

// A link to a bookmark has no href, as Eigen holds no bookmarks.
type Link = { href?: string; title: string | null };

// Each open field carries what the fields around it say too, so the innermost answers alone: whether any is still in
// its code, the link its result shows, and whether it is a table of contents.
export type Field = { inCode: boolean; code: string; link?: Link; checkbox?: boolean; toc?: boolean };

export type RunContext = {
    scope: Scope;
    paraStyle: string | undefined;
    role: Role;
    link?: Link;
    pieces: Piece[];
    // What a text box anchored here holds, which follows the paragraph.
    pending: Item[];
};

// Content that doesn't show: a tracked deletion, and properties. Markers such as bookmarks and comment ranges hold
// nothing, so they walk to nothing; a comment's text lives in comments.xml, which is never read.
const SKIPPED_INLINE = new Set(['del', 'moveFrom', 'pPr', 'rPr', 'sdtPr', 'sdtEndPr']);

export function walkInline(reader: Reader, elements: XmlElement[], context: RunContext): void {
    for (const element of elements) {
        if (isAlternateContent(element)) {
            walkInline(reader, alternative(element), context);
            continue;
        }
        if (element.ns === M_NS && (element.local === 'oMath' || element.local === 'oMathPara')) {
            // Word shows no field's code.
            if (reader.fields.at(-1)?.inCode) continue;
            // CT_OMathPara holds its equations directly: none in a tracked deletion or an alternative.
            const display = element.local === 'oMathPara';
            for (const oMath of display ? xmlChildren(element, M_NS, 'oMath') : [element])
                pushEquation(reader, oMath, display, context);
            continue;
        }
        if (element.ns !== W_NS) {
            walkInline(reader, xmlElements(element), context);
            continue;
        }
        if (SKIPPED_INLINE.has(element.local)) continue;
        switch (element.local) {
            case 'r':
                readRunContent(
                    reader,
                    xmlElements(element),
                    readRunProps(wChild(element, 'rPr'), reader.theme),
                    context,
                );
                break;
            case 'hyperlink': {
                const link = linkOf(reader, element, context.scope);
                walkInline(reader, xmlElements(element), link ? { ...context, link } : context);
                break;
            }
            case 'fldSimple': {
                const instr = w(element, 'instr') ?? '';
                const kind = pageNumberKind(instr);
                if (kind) {
                    if (!reader.fields.at(-1)?.inCode)
                        context.pieces.push({ kind: 'node', node: { type: 'pageNumber', attrs: { kind } } });
                    break;
                }
                const link = hyperlinkField(reader, instr);
                walkInline(reader, xmlElements(element), link ? { ...context, link } : context);
                break;
            }
            case 'sdt': {
                const checkbox = xmlChild(wChild(element, 'sdtPr') ?? element, W14_NS, 'checkbox');
                if (checkbox) {
                    const checked = xmlChild(checkbox, W14_NS, 'checked');
                    const value = checked && xmlAttr(checked, W14_NS, 'val');
                    context.pieces.push({ kind: 'checkbox', checked: isOn(value) === true });
                    break;
                }
                walkInline(reader, xmlElements(wChild(element, 'sdtContent') ?? element), context);
                break;
            }
            default:
                // ins, moveTo, smartTag, customXml, dir, bdo, sdtContent and the unknown: their content counts.
                walkInline(reader, xmlElements(element), context);
        }
    }
}

// An equation past a bound of the package is its text.
function pushEquation(reader: Reader, oMath: XmlElement, display: boolean, context: RunContext): void {
    try {
        const mathml = writeMathml(readOmml(oMath));
        reader.pkg.chargeMathml(mathml.length);
        context.pieces.push({ kind: 'node', node: { type: 'equation', attrs: { mathml, display } } });
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        pushText(reader, readOmmlText(oMath), {}, context, true);
    }
}

function readRunContent(reader: Reader, children: XmlElement[], direct: DocxRunProps, context: RunContext): void {
    for (const child of children) {
        if (isAlternateContent(child)) {
            readRunContent(reader, alternative(child), direct, context);
            continue;
        }
        if (child.ns === W_NS && child.local === 'fldChar') {
            fieldChar(reader, child, context);
            continue;
        }
        const field = reader.fields.at(-1);
        if (field?.inCode) {
            if (child.ns === W_NS && child.local === 'instrText') field.code += xmlText(child);
            continue;
        }
        const link = field?.link ?? context.link;
        const linked = link ? { ...context, link } : context;
        if (child.ns !== W_NS) {
            if (child.ns === M_NS) walkInline(reader, [child], linked);
            continue;
        }
        switch (child.local) {
            case 't':
                pushText(reader, runText(child), direct, linked);
                break;
            case 'tab':
            case 'ptab':
                pushText(reader, '\t', direct, linked);
                break;
            case 'noBreakHyphen':
                pushText(reader, '‑', direct, linked);
                break;
            case 'softHyphen':
                pushText(reader, '­', direct, linked);
                break;
            case 'sym': {
                const unicode = symbolOf(w(child, 'font') ?? '', Number.parseInt(w(child, 'char') ?? '', 16));
                if (unicode) pushText(reader, unicode, direct, linked);
                break;
            }
            case 'br':
            case 'cr': {
                const type = w(child, 'type');
                if (type === 'page') {
                    // Only the body is paged.
                    if (context.scope.story === 'body') context.pieces.push({ kind: 'break' });
                } else if (type !== 'column') {
                    const clear = w(child, 'clear');
                    context.pieces.push(
                        clear && clear !== 'none' ? { kind: 'clear' } : { kind: 'node', node: { type: 'hardBreak' } },
                    );
                }
                break;
            }
            case 'drawing':
                readDrawing(reader, child, linked);
                break;
            case 'pict':
            case 'object':
                readVml(reader, child, linked);
                break;
            case 'footnoteReference':
            case 'endnoteReference': {
                // The notes list is the body's, so a band's [n] would link nowhere.
                if (context.scope.story === 'band') {
                    reader.bandDropped++;
                    break;
                }
                const type = child.local === 'footnoteReference' ? 'footnote' : 'endnote';
                const id = w(child, 'id') ?? '';
                const key = `${type}-${id}`;
                const note = reader.notes.get(key) ?? { type, id, number: reader.notes.size + 1 };
                reader.notes.set(key, note);
                context.pieces.push({
                    kind: 'node',
                    node: {
                        type: 'text',
                        text: `[${note.number}]`,
                        marks: [{ type: 'link', attrs: { href: `#${type}-${id}` } }, { type: 'superscript' }],
                    },
                });
                break;
            }
            case 'ruby':
                walkInline(reader, xmlElements(wChild(child, 'rubyBase') ?? child), linked);
                break;
        }
    }
}

// Word drops a w:t's leading and trailing whitespace unless xml:space preserves it, and draws a line feed as a space.
function runText(t: XmlElement): string {
    const text = xmlText(t);
    const kept = xmlAttr(t, XML_NAMESPACE, 'space') === 'preserve' ? text : trimXmlSpace(text);
    return kept.replace(/[\r\n]/g, ' ');
}

// A complex field keeps its result and drops its code; a HYPERLINK field links its result, a form checkbox is a checkbox,
// and a PAGE or NUMPAGES field is the page number node, its result skipped as a code is: the digits a page last had.
function fieldChar(reader: Reader, element: XmlElement, context: RunContext): void {
    const type = w(element, 'fldCharType');
    if (type === 'begin') {
        const checkBox = wChild(wChild(element, 'ffData'), 'checkBox');
        const checked = checkBox && (onOff(wChild(checkBox, 'checked')) ?? onOff(wChild(checkBox, 'default')) ?? false);
        reader.fields.push({ inCode: true, code: '', checkbox: checked });
    } else if (type === 'separate') {
        const field = reader.fields.at(-1);
        const outer = reader.fields.at(-2);
        if (field) {
            field.inCode = (outer?.inCode ?? false) || pageNumberKind(field.code) !== undefined;
            field.link = hyperlinkField(reader, field.code) ?? outer?.link;
            field.toc = outer?.toc || /^TOC\b/i.test(field.code.trim());
        }
    } else if (type === 'end') {
        const field = reader.fields.pop();
        const kind = field && pageNumberKind(field.code);
        if (reader.fields.at(-1)?.inCode) return;
        if (field?.checkbox !== undefined) context.pieces.push({ kind: 'checkbox', checked: field.checkbox });
        else if (kind) context.pieces.push({ kind: 'node', node: { type: 'pageNumber', attrs: { kind } } });
    }
}

// PAGE and NUMPAGES whatever their switches; a field's name is case-insensitive.
function pageNumberKind(code: string): PageNumberKind | undefined {
    const name = code.trim().split(/\s/, 1)[0]?.toUpperCase();
    return PAGE_NUMBER_KINDS.find((kind) => PAGE_NUMBER_FIELDS[kind] === name);
}

function linkOf(reader: Reader, element: XmlElement, scope: Scope): Link | undefined {
    const id = xmlAttr(element, R_NS, 'id');
    const anchor = w(element, 'anchor');
    const rel = id ? scope.part.rels.get(id) : undefined;
    const base = rel?.external ? rel.target : '';
    if (!base && anchor) return { title: null };
    return linkTo(reader, anchor ? `${base}#${anchor}` : base, w(element, 'tooltip'));
}

// The writer made links into this instance absolute; they come back root-relative.
function linkTo(reader: Reader, href: string, tooltip: string | undefined): Link | undefined {
    const trimmed = href.trim();
    if (!trimmed || !isAllowedUri(trimmed)) return undefined;
    return { href: rootRelativeHref(trimmed, reader.publicOrigin), title: tooltip || null };
}

// The writer's absoluteHref inverted: a link into this instance comes back root-relative, never as `//host`, which leaves it.
function rootRelativeHref(href: string, publicOrigin: string | undefined): string {
    if (!publicOrigin || !href.startsWith(publicOrigin)) return href;
    const path = href.slice(publicOrigin.length);
    return /^\/(?![/\\])/.test(path) ? path : href;
}

// HYPERLINK "target" [\l "anchor"] [\o "tooltip"], read quote by quote: a regex retries each start of a long run.
function hyperlinkField(reader: Reader, code: string): Link | undefined {
    const trimmed = code.trim();
    if (!/^HYPERLINK\b/i.test(trimmed)) return undefined;
    const args = trimmed.slice('HYPERLINK'.length);
    let target = '';
    let anchor = '';
    let tooltip: string | undefined;
    let quoted = false;
    for (let at = 0, open = args.indexOf('"'); open >= 0; open = args.indexOf('"', at)) {
        const close = args.indexOf('"', open + 1);
        if (close < 0) break;
        // The switch a value follows, whitespace between.
        let start = open;
        while (start > at && /\s/.test(args[start - 1])) start--;
        const flag = args.slice(Math.max(at, start - 2), start).toLowerCase();
        const value = args.slice(open + 1, close);
        if (flag === '\\l') anchor = value;
        else if (flag === '\\o') tooltip = value;
        else if (!/^\\[a-z]$/.test(flag)) target = value;
        quoted = true;
        at = close + 1;
    }
    if (!quoted) target = args.trim().split(/\s+/)[0] ?? '';
    if (!target && anchor) return { title: null };
    return linkTo(reader, anchor ? `${target}#${anchor}` : target, tooltip);
}

// An equation's text is set off from the text beside it by a space where none is, as inlineText sets off an equation.
export function pushText(
    reader: Reader,
    text: string,
    direct: DocxRunProps,
    context: RunContext,
    equation?: true,
): void {
    if (!text) return;
    const last = context.pieces.at(-1);
    const before = last?.kind === 'node' && last.node.type === 'text' ? last : undefined;
    const joins = before && !/\s$/.test(before.node.text ?? '') && !/^\s/.test(text);
    const spaced = joins && (equation || before.equation) ? ` ${text}` : text;
    for (const { text: part, marks, small, font, italic } of marksOf(reader, spaced, direct, context)) {
        const node = marks.length > 0 ? { type: 'text', text: part, marks } : { type: 'text', text: part };
        context.pieces.push({ kind: 'node', node, small, font, italic, ...(equation && { equation }) });
    }
}

type Marks = NonNullable<JSONContent['marks']>;

// Small print is at most this share of the body size, so the writer's 9 pt in 11 is small and a body style a point
// smaller is still body text: a line of it may be a figure's caption.
const SMALL_PRINT = 0.85;

// Link looks a re-save writes as direct formatting, color to whether it underlines: the editor's, Google Docs' and
// Word's Hyperlink style; any color from the theme's link colors underlines too. The editor draws its own, so on a link
// they are no mark.
const LINK_LOOKS = new Map([
    [LINK_LOOK.color, false],
    ['1155CC', true],
    ['0563C1', true],
]);

// A link style's colors that are the link look: those, and the defaults of Word's Hyperlink style before themes and of
// LibreOffice's Internet Link. A link style in any other color is a look of its own, which Word draws.
const LINK_STYLE_COLORS = new Set([...LINK_LOOKS.keys(), '0000FF', '000080']);

// Word resolves a run's look from the defaults, the table style, the paragraph style, the character style and the
// run itself, the toggles of the two styles flipping each other. A look the paragraph's node already draws is no mark.
function marksOf(
    reader: Reader,
    text: string,
    direct: DocxRunProps,
    context: RunContext,
): { text: string; marks: Marks; small: boolean; font?: string; italic?: boolean }[] {
    const { styles } = reader;
    const { role, scope, link } = context;
    const absorbed = ABSORBED[role.kind];
    const paraRun = mergeRun(scope.tableRun ?? {}, styles.run(context.paraStyle));
    const charRun = { ...styles.run(direct.style) };
    // A link to a bookmark is no link, its look the run's, but in a table of contents: Word draws its link look there
    // in the paragraph's.
    const asLink = !!link?.href || (!!link && !!reader.fields.at(-1)?.toc);
    // A link draws its own color and underline; the Hyperlink style on text that links nowhere is just a look, and so is
    // a link style in a color of its own. Its link color still covers the paragraph's, as Word draws it.
    const ownLook = !!charRun.color?.hex && !charRun.color.link && !LINK_STYLE_COLORS.has(charRun.color.hex);
    if (asLink && !ownLook) {
        if (charRun.color) charRun.color = { hex: '', link: false };
        delete charRun.underline;
    }
    const full = mergeRun(styles.docRun, paraRun, charRun, direct);
    if (full.vanish) return [];
    if (absorbed === 'all') {
        const faces = byFace(text, full.fonts, full, false, reader.pkg.chargePiece);
        return faces.map((face) => ({ ...face, marks: [], small: false }));
    }
    const own = { ...paraRun };
    for (const key of absorbed) delete own[key];
    const props = mergeRun(own, charRun, direct);
    for (const toggle of TOGGLES) {
        const fromStyles =
            own[toggle] === undefined && charRun[toggle] === undefined
                ? undefined
                : !!own[toggle] !== !!charRun[toggle];
        props[toggle] = direct[toggle] ?? fromStyles;
    }

    const isSmall = (complex: boolean) => {
        const size = complex ? props.sizeCs : props.size;
        return size !== undefined && size <= SMALL_PRINT * (complex ? reader.bodySizeCs : reader.bodySize);
    };
    // The docx's body draws at the doc's body size, and a heading or a title at its own, so only a size apart from
    // the one its node draws is a mark; in half-points, Word's default 10 pt where none is set.
    const nodeRun = absorbed.includes('size')
        ? mergeRun(styles.docRun, paraRun)
        : { size: reader.bodySize, sizeCs: reader.bodySizeCs };
    const fontSizeOf = (complex: boolean) => {
        const sizeOf = (run: DocxRunProps) => (complex ? (run.sizeCs ?? run.size) : run.size) ?? 20;
        const size = sizeOf(full);
        return size === sizeOf(nodeRun) ? undefined : readFontSize(size / 2);
    };
    const complexLook =
        !!props.boldCs !== !!props.bold ||
        !!props.italicCs !== !!props.italic ||
        fontSizeOf(true) !== fontSizeOf(false);
    const faces = byFace(text, full.fonts, full, complexLook, reader.pkg.chargePiece);

    const shade = props.highlight || props.shading || '';
    const marks: Marks = [];
    if (link?.href) marks.push({ type: 'link', attrs: { href: link.href, title: link.title } });
    const linkLook = asLink ? props.color?.link || LINK_LOOKS.get(props.color?.hex ?? '') : undefined;
    if (props.underline && !linkLook) marks.push({ type: 'underline' });
    if (props.strike) marks.push({ type: 'strike' });
    if (props.vertAlign === 'superscript') marks.push({ type: 'superscript' });
    if (props.vertAlign === 'subscript') marks.push({ type: 'subscript' });
    // Explicit black is Word's and Google Docs' default, a mark lost in dark mode; auto on a dark highlight is white.
    const hex = props.color?.hex;
    const color =
        hex &&
        hex !== reader.baseColor &&
        hex !== '000000' &&
        linkLook === undefined &&
        !(scope.onFill && !isFill(shade) && isLight(hex))
            ? hex
            : !full.color?.hex && !asLink && isFill(shade) && isDark(shade)
              ? 'FFFFFF'
              : undefined;
    // Word draws capitals over small caps.
    const caps: Caps | null = props.caps ? 'all' : props.smallCaps ? 'small' : null;
    const highlight: Marks = isFill(shade)
        ? [{ type: 'highlight', attrs: { color: shade === DEFAULT_HIGHLIGHT ? null : markColor(shade) } }]
        : [];
    return faces.map(({ text: part, font, complex }) => {
        const small = isSmall(complex);
        const shape: Marks = [];
        if (complex ? props.boldCs : props.bold) shape.push({ type: 'bold' });
        const italic = !!(complex ? props.italicCs : props.italic);
        // Code is a monospace run in a code style or on a light grey, the editor's look of any shade; a foreign
        // monospace run alone is a font.
        const code =
            isMonospaceFont(font, reader.fontTable) && (styles.isCodeCharacter(direct.style) || isLightNeutral(shade));
        if (code && !link?.href) return { text: part, marks: [{ type: 'code' }], small: false, font };
        const fontFamily = fontMark(font, reader.fontTable, reader.normal.font);
        const fontSize = fontSizeOf(complex);
        const textStyle: Marks =
            color || fontFamily || caps || fontSize
                ? [
                      {
                          type: 'textStyle',
                          attrs: {
                              color: color ? markColor(color) : null,
                              fontFamily: fontFamily ?? null,
                              fontSize: fontSize ?? null,
                              caps,
                          },
                      },
                  ]
                : [];
        return { text: part, marks: [...marks, ...shape, ...textStyle, ...highlight], small, font, italic };
    });
}
