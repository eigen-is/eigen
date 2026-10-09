import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import type { Caps } from '@workspace/lib/docs/eigendoc';
import { hex as dingbat } from 'dingbat-to-unicode';
import { DEFAULT_HIGHLIGHT, M_NS, R_NS, W_NS, W14_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText } from '../../core/xml';
import { LINK_LOOK } from '../../export/doc/looks';
import type { Item } from './assemble';
import { bundledFontOf, byFace, fontMark, MONOSPACE_FONT } from './docx-fonts';
import { readDrawing, readVml } from './drawings';
import { alternative, descendants, isAlternateContent, isOn, onOff, w, wChild } from './package';
import type { Reader, Scope } from './paragraphs';
import { ABSORBED, isFill, isLightNeutral, mergeRun, type Role, type RunProps, readRunProps, TOGGLES } from './styles';
import { isLight } from './tables';

// A paragraph's content, run by run: text with its marks, breaks, checkboxes and rules, which the paragraph sorts out.
export type Piece =
    | { kind: 'node'; node: JSONContent; small?: boolean; font?: string }
    | { kind: 'break' }
    | { kind: 'clear' }
    | { kind: 'checkbox'; checked: boolean }
    | { kind: 'hr' };

export type Link = { href: string; title: string | null };

// Each open field carries what the fields around it say too, so the innermost answers alone: whether any is still in
// its code, and the link its result shows.
export type Field = { inCode: boolean; code: string; link?: Link; checkbox?: boolean };

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
            const text = mathText(element);
            if (text) pushText(reader, text, {}, context);
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
                const link = hyperlinkField(reader, w(element, 'instr') ?? '');
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

// G14: math as text until the schema holds math; each object and run of an equation is a word of its own.
function mathText(element: XmlElement): string {
    const equations = element.local === 'oMath' ? [element] : descendants(element, M_NS, 'oMath');
    return equations
        .flatMap((equation) => xmlElements(equation).map((part) => descendants(part, M_NS, 't').map(xmlText).join('')))
        .filter(Boolean)
        .join(' ');
}

function readRunContent(reader: Reader, children: XmlElement[], direct: RunProps, context: RunContext): void {
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
                pushText(reader, xmlText(child).replace(/[\r\n]/g, ' '), direct, linked);
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
                const font = w(child, 'font') ?? '';
                const code = w(child, 'char') ?? '';
                // Word's private-use spelling, F0xx, is the font's own xx.
                const unicode =
                    dingbat(font, code) ?? (/^F0..$/i.test(code) ? dingbat(font, code.slice(2)) : undefined);
                if (unicode) pushText(reader, unicode.string, direct, linked);
                break;
            }
            case 'br':
            case 'cr': {
                const type = w(child, 'type');
                if (type === 'page') {
                    // A note isn't paged.
                    if (!context.scope.inNote) context.pieces.push({ kind: 'break' });
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

// A complex field keeps its result and drops its code; a HYPERLINK field links its result, a form checkbox is a checkbox.
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
            field.inCode = outer?.inCode ?? false;
            field.link = hyperlinkField(reader, field.code) ?? outer?.link;
        }
    } else if (type === 'end') {
        const field = reader.fields.pop();
        if (field?.checkbox !== undefined && !reader.fields.at(-1)?.inCode)
            context.pieces.push({ kind: 'checkbox', checked: field.checkbox });
    }
}

export function linkOf(reader: Reader, element: XmlElement, scope: Scope): Link | undefined {
    const id = xmlAttr(element, R_NS, 'id');
    const anchor = w(element, 'anchor');
    const rel = id ? scope.part.rels.get(id) : undefined;
    const base = rel?.external ? rel.target : '';
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

// HYPERLINK "target" [\l "anchor"] [\o "tooltip"]
function hyperlinkField(reader: Reader, code: string): Link | undefined {
    const match = code.trim().match(/^HYPERLINK\b(.*)$/i);
    if (!match) return undefined;
    const args = match[1] ?? '';
    const quoted = [...args.matchAll(/(\\[a-z])?\s*"([^"]*)"/gi)];
    let target = '';
    let anchor = '';
    let tooltip: string | undefined;
    for (const [, flag, value = ''] of quoted) {
        if (!flag) target = value;
        else if (flag.toLowerCase() === '\\l') anchor = value;
        else if (flag.toLowerCase() === '\\o') tooltip = value;
    }
    if (!quoted.length) target = args.trim().split(/\s+/)[0] ?? '';
    return linkTo(reader, anchor ? `${target}#${anchor}` : target, tooltip);
}

export function pushText(reader: Reader, text: string, direct: RunProps, context: RunContext): void {
    if (!text) return;
    for (const { text: part, marks, small, font } of marksOf(reader, text, direct, context)) {
        const node = marks.length > 0 ? { type: 'text', text: part, marks } : { type: 'text', text: part };
        context.pieces.push({ kind: 'node', node, small, font });
    }
}

type Marks = NonNullable<JSONContent['marks']>;

// P8: small print is at most this share of the body size, so the writer's 9 pt in 11 is small and a body style a point
// smaller is still body text.
export const SMALL_PRINT = 0.85;

// Link looks a re-save writes as direct formatting, color to whether it underlines: the editor's, Google Docs' and
// Word's Hyperlink style; any color from the theme's link colors underlines too. The editor draws its own, so on a link
// they are no mark.
const LINK_LOOKS = new Map([
    [LINK_LOOK.color, false],
    ['1155CC', true],
    ['0563C1', true],
]);

// Word resolves a run's look from the defaults, the table style, the paragraph style, the character style and the
// run itself, the toggles of the two styles flipping each other. A look the paragraph's node already draws is no mark.
function marksOf(
    reader: Reader,
    text: string,
    direct: RunProps,
    context: RunContext,
): { text: string; marks: Marks; small: boolean; font?: string }[] {
    const { styles } = reader;
    const { role, scope, link } = context;
    const absorbed = ABSORBED[role.kind];
    const paraRun = mergeRun(scope.tableRun ?? {}, styles.run(context.paraStyle));
    const charRun = { ...styles.run(direct.style) };
    // A link draws its own color and underline; the Hyperlink style on text that links nowhere is just a look.
    if (link) {
        delete charRun.color;
        delete charRun.linkColor;
        delete charRun.underline;
    }
    const full = mergeRun(styles.docRun, paraRun, charRun, direct);
    const faces = byFace(text, full.fonts, full);
    if (full.vanish) return [];
    if (absorbed === 'all') return faces.map((face) => ({ ...face, marks: [], small: false }));
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

    const shade = props.highlight || props.shading || '';
    const marks: Marks = [];
    if (link) marks.push({ type: 'link', attrs: { href: link.href, title: link.title } });
    if (props.bold) marks.push({ type: 'bold' });
    if (props.italic) marks.push({ type: 'italic' });
    const linkLook = link ? props.linkColor || LINK_LOOKS.get(props.color ?? '') : undefined;
    if (props.underline && !linkLook) marks.push({ type: 'underline' });
    if (props.strike) marks.push({ type: 'strike' });
    if (props.vertAlign === 'superscript') marks.push({ type: 'superscript' });
    if (props.vertAlign === 'subscript') marks.push({ type: 'subscript' });
    const small = props.size !== undefined && props.size <= SMALL_PRINT * reader.bodySize;
    if (small) marks.push({ type: 'small' });
    // Explicit black is Word's and Google Docs' spelling of the default; as a mark it would vanish in dark mode.
    const color =
        props.color &&
        props.color !== reader.baseColor &&
        props.color !== '000000' &&
        linkLook === undefined &&
        !(scope.onFill && !isFill(shade) && isLight(props.color))
            ? props.color
            : undefined;
    // Word draws capitals over small caps.
    const caps: Caps | null = props.caps ? 'all' : props.smallCaps ? 'small' : null;
    const highlight: Marks = isFill(shade)
        ? [{ type: 'highlight', attrs: { color: shade === DEFAULT_HIGHLIGHT ? null : `#${shade.toLowerCase()}` } }]
        : [];
    return faces.map(({ text: part, font }) => {
        // Code is a monospace run in a code style or on a light grey, the editor's look of any shade; a foreign
        // monospace run alone is a font.
        const code =
            bundledFontOf(font, reader.fontTable) === MONOSPACE_FONT &&
            (styles.isCodeCharacter(direct.style) || isLightNeutral(shade));
        if (code && !link) return { text: part, marks: [{ type: 'code' }], small: false, font };
        const fontFamily = fontMark(font, reader.fontTable);
        const textStyle: Marks =
            color || fontFamily || caps
                ? [
                      {
                          type: 'textStyle',
                          attrs: {
                              color: color ? `#${color.toLowerCase()}` : null,
                              fontFamily: fontFamily ?? null,
                              caps,
                          },
                      },
                  ]
                : [];
        return { text: part, marks: [...marks, ...textStyle, ...highlight], small, font };
    });
}
