// The docx writer's inline content: one run per text node, with its marks as run properties written in the ECMA-376
// sequence, as a paragraph's are. Links, breaks, equations, page numbers and note references are runs too. A
// paragraph writes its runs through runsXml.

import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { EIGEN_FONT_NAMES, getFontName, readFontSize } from '@workspace/lib/constants/fonts';
import { readPageNumberKind } from '@workspace/lib/docs/eigendoc';
import { escapeXml, escapeXmlText, stripNonXmlChars } from '@workspace/lib/xml';
import { writeOmml } from '@workspace/math';
import { cssColorToHex, isTransparentCssColor } from '../../../document/colors';
import { readStoredEquation } from '../../../document/equation';
import type { RunFace } from '../../../document/looks';
import { cssPt, halfPoints, SMALL_LOOK, twips } from '../../../document/looks';
import { proseValue } from '../../../document/prose-css';
import { uriReference } from '../../../ooxml/opc';
import type { StyleId } from '../../../ooxml/wordml';
import { DEFAULT_HIGHLIGHT, PAGE_NUMBER_FIELDS } from '../../../ooxml/wordml';
import { absoluteHref } from '../render';
import { useFace } from './fonts';
import type { Context } from './package';

// size in half-points, spacing in twips, colors as RRGGBB.
export type RunProps = {
    style?: StyleId;
    font?: string;
    bold?: true;
    // false undoes a style's italic.
    italic?: boolean;
    caps?: true;
    smallCaps?: true;
    // false undoes a style's strike.
    strike?: boolean;
    color?: string;
    spacing?: number;
    size?: number;
    underline?: true;
    shading?: string;
    vertAlign?: 'subscript' | 'superscript';
};

export function rPrXml(props: RunProps): string {
    const { style, font, bold, italic, caps, smallCaps, strike, color, spacing, size, underline, shading, vertAlign } =
        props;
    return [
        style && `<w:rStyle w:val="${style}"/>`,
        font && `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
        bold && '<w:b/><w:bCs/>',
        italic === true && '<w:i/><w:iCs/>',
        italic === false && '<w:i w:val="0"/><w:iCs w:val="0"/>',
        caps && '<w:caps/>',
        smallCaps && '<w:smallCaps/>',
        strike === true && '<w:strike/>',
        strike === false && '<w:strike w:val="0"/>',
        color && `<w:color w:val="${color}"/>`,
        spacing !== undefined && `<w:spacing w:val="${spacing}"/>`,
        size !== undefined && `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
        underline && '<w:u w:val="single"/>',
        shading && `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`,
        vertAlign && `<w:vertAlign w:val="${vertAlign}"/>`,
    ]
        .filter(Boolean)
        .join('');
}

// A run is written in its paragraph's style.
export const INLINES = new Map<
    string,
    (node: JSONContent, linked: boolean, context: Context, style: StyleId | undefined, faces: RunFace[]) => string
>([
    [
        'text',
        (node, linked, context, style, faces) => {
            const content = textXml(node.text ?? '');
            return content && runXml(content, node, linked, context, style, faces);
        },
    ],
    ['hardBreak', () => '<w:r><w:br/></w:r>'],
    // A complex field, as Word writes it: Google Docs leaves a w:fldSimple PAGE in the body blank. Word lays out the
    // page and updates the field; 1 is what a reader without fields shows. Every run of the field gets the result's
    // look, and none takes marks: the Yjs binding stores none on an atom, so a reloaded doc holds none.
    [
        'pageNumber',
        (node, linked, context, style, faces) =>
            [
                '<w:fldChar w:fldCharType="begin"/>',
                `<w:instrText xml:space="preserve"> ${PAGE_NUMBER_FIELDS[readPageNumberKind(node.attrs?.['kind'])]} </w:instrText>`,
                '<w:fldChar w:fldCharType="separate"/>',
                textXml('1'),
                '<w:fldChar w:fldCharType="end"/>',
            ]
                .map((content) => runXml(content, {}, linked, context, style, faces))
                .join(''),
    ],
    // Word's reference, numbered as met, which is footnotesInOrder's order; its note is written to the notes part after
    // the body. The atom takes no marks, as the Yjs binding stores none on one.
    [
        'footnote',
        (node, _linked, context, style, faces) => {
            const id = context.pkg.footnotes.push(node);
            const props: RunProps = { style: 'FootnoteReference' };
            faces.push(useFace(context.pkg, props, style));
            return `<w:r><w:rPr>${rPrXml(props)}</w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
        },
    ],
    // A sibling of the runs, not a run; a displayed one alone in its paragraph (blocksOf). An empty one stays an empty
    // math zone, as the editor draws an empty box.
    [
        'equation',
        (node) => {
            const { row, display } = readStoredEquation(node.attrs ?? {});
            const math = writeOmml(row);
            return display ? `<m:oMathPara>${math}</m:oMathPara>` : math;
        },
    ],
]);

// A run in the node's marks.
function runXml(
    content: string,
    node: JSONContent,
    linked: boolean,
    context: Context,
    style: StyleId | undefined,
    faces: RunFace[],
): string {
    const props = runProps(node.marks ?? [], linked, context);
    faces.push(useFace(context.pkg, props, style));
    const rPr = rPrXml(props);
    return `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
}

// Runs that share a link share one w:hyperlink.
export function runsXml(nodes: JSONContent[], context: Context, style: StyleId | undefined, faces: RunFace[]): string {
    const links = nodes.map((node) => hyperlinkOf(node, context.pkg.publicOrigin));
    let xml = '';
    for (let i = 0; i < nodes.length; ) {
        const link = links[i];
        let runs = '';
        do runs += INLINES.get(nodes[i].type ?? '')?.(nodes[i], link !== undefined, context, style, faces) ?? '';
        while (++i < nodes.length && links[i]?.target === link?.target && links[i]?.tooltip === link?.tooltip);
        if (!link) {
            xml += runs;
            continue;
        }
        const id = context.pkg.partRels.relate('hyperlink', link.target, true);
        const tooltip = link.tooltip ? ` w:tooltip="${escapeXml(link.tooltip)}"` : '';
        xml += `<w:hyperlink r:id="${id}"${tooltip} w:history="1">${runs}</w:hyperlink>`;
    }
    return xml;
}

// Text turns each line break into w:br, a code block into a new paragraph.
export const LINE_BREAK = /\r\n|[\r\n\v]/;
const TEXT_CONTROLS = new RegExp(`(${LINE_BREAK.source}|\t)`);

// Split before escaping, which drops the controls Word spells as elements.
export function textXml(text: string): string {
    return text
        .split(TEXT_CONTROLS)
        .map((part, index) => {
            if (index % 2 === 1) return part === '\t' ? '<w:tab/>' : '<w:br/>';
            const escaped = escapeXmlText(part);
            return escaped && `<w:t xml:space="preserve">${escaped}</w:t>`;
        })
        .join('');
}

const MARKS = new Map<string, (attrs: Record<string, unknown>, context: Context) => RunProps>([
    ['bold', () => ({ bold: true })],
    ['italic', (_attrs, { upright }) => ({ italic: !upright })],
    ['underline', () => ({ underline: true })],
    ['strike', () => ({ strike: true })],
    ['subscript', () => ({ vertAlign: 'subscript' })],
    ['superscript', () => ({ vertAlign: 'superscript' })],
    // Direct formatting, not a style: a run holds one rStyle, and a link already takes it.
    ['small', () => ({ spacing: twips(SMALL_LOOK.letterSpacingPt), size: halfPoints(SMALL_LOOK.sizePt) })],
    [
        'code',
        // In a heading or title, code is sized against the heading, so the run takes a size of its own, as textStyle's
        // does. Elsewhere the run has no size key, since an undefined one would unset the size of a Small mark before it.
        (_attrs, { blockPt }) => ({
            style: 'Code',
            ...(blockPt !== undefined && {
                size: halfPoints(cssPt(proseValue('.eigen-prose code', 'font-size'), blockPt)),
            }),
        }),
    ],
    [
        'textStyle',
        ({ color, fontFamily, fontSize, caps }) => {
            const name = typeof fontFamily === 'string' ? getFontName(fontFamily) : undefined;
            const size = readFontSize(fontSize);
            return {
                color: colorOf(color),
                font: name && EIGEN_FONT_NAMES.includes(name) ? name : undefined,
                caps: caps === 'all' || undefined,
                smallCaps: caps === 'small' || undefined,
                // Only a size of its own, or it would unset Small's before it.
                ...(size !== undefined && { size: halfPoints(size) }),
            };
        },
    ],
    // A transparent color shades nothing; no color, or one Office can't spell (a named one), is the UA's yellow <mark>.
    [
        'highlight',
        ({ color }) =>
            typeof color === 'string' && isTransparentCssColor(color)
                ? {}
                : { shading: colorOf(color) ?? DEFAULT_HIGHLIGHT },
    ],
    // The w:hyperlink around the runs carries it.
    ['link', () => ({})],
    // A comment writes nothing; its text stays.
    ['comment', () => ({})],
]);

function runProps(marks: NonNullable<JSONContent['marks']>, linked: boolean, context: Context): RunProps {
    let props: RunProps = linked ? { style: 'Hyperlink' } : {};
    for (const mark of marks) {
        const write = MARKS.get(mark.type);
        if (!write) throw new Error(`no docx mapping for ${mark.type}`);
        props = { ...props, ...write(mark.attrs ?? {}, context) };
    }
    return props;
}

function colorOf(value: unknown): string | undefined {
    return typeof value === 'string' ? cssColorToHex(value) : undefined;
}

type Hyperlink = { target: string; tooltip: string | undefined };

function hyperlinkOf(node: JSONContent, publicOrigin: string | undefined): Hyperlink | undefined {
    const attrs = node.marks?.find((mark) => mark.type === 'link')?.attrs;
    const href = attrs?.['href'];
    if (typeof href !== 'string') return undefined;
    // Gated after the strip, or a character XML can't hold could hide a scheme; trimmed as a URL parser trims.
    const kept = stripNonXmlChars(href).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!kept || !isAllowedUri(kept)) return undefined;
    const target = uriReference(absoluteHref(kept, publicOrigin));
    const title = attrs?.['title'];
    return { target, tooltip: typeof title === 'string' && title ? title : undefined };
}
