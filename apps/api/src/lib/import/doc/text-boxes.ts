// A Word text box as the doc holds it. A wps shape alone in its drawing, or a VML shape holding a v:textbox, becomes a
// text box with the shape's size, fill, outline, insets, vertical alignment and rounded corners. Its paragraphs read as
// a note's are. The drawing walk finds a box in the body, reads its paragraphs in textBoxScope and calls readTextBox.
// A box elsewhere, such as in a band, a note or a group, keeps its paragraphs after its anchor's.

import type { JSONContent } from '@tiptap/core';
import type { CellBorderStyle, FigureFrameAttrs, TextBoxEdit } from '@workspace/lib/docs/eigendoc';
import {
    cellBorderValue,
    flattenNestedStories,
    isStoryNode,
    MAX_TEXT_BOX_PADDING,
    newStoryId,
    readCellBackground,
    readTextBoxSide,
    TEXT_BOX_INSET,
} from '@workspace/lib/docs/eigendoc';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlElements } from '../../core/xml';
import {
    ALIGN_BY_ANCHOR,
    DEFAULT_LINE_WIDTH_EMU,
    drawingColor,
    lineWidthEmu,
    strokeStyleOf,
} from '../../ooxml/drawingml';
import { A_NS, EMU_PER_PX, V_NS, W10_NS, WPS_NS } from '../../ooxml/ooxml';
import type { Item } from './assemble';
import { buildBlocks } from './assemble';
import { descendants, floatSide, roundedInt, vmlPx, vmlStyle } from './package';
import type { Reader, Scope } from './paragraphs';
import { storyParagraphs } from './paragraphs';
import { fitBorderPx } from './styles';

// The look a box draws in, read off a wps shape or a VML one. A width is null where the shape gives none.
type BoxLook = Required<
    Pick<TextBoxEdit, 'height' | 'fill' | 'outline' | 'paddingX' | 'paddingY' | 'verticalAlign' | 'rounded'>
> & { width: number | null };

// VML's v-text-anchor names the line first, as in middle-center: only that word is the box's vertical alignment.
const VML_TEXT_ANCHORS = new Map<string, BoxLook['verticalAlign']>([
    ['middle', 'middle'],
    ['bottom', 'bottom'],
]);

// The w10:wrap types that wrap the body's text on a side of the box.
const VML_FLOATING_WRAPS = new Set(['square', 'tight', 'through']);

// A box's paragraphs own no spacing, as a cell's don't, its text sits on its fill, and it holds no table of contents.
export const textBoxScope = (scope: Scope): Scope => ({ ...scope, box: true, onFill: true, inShape: true });

// The wps shape a drawing's graphic holds alone, when it holds text: a text box. A group, a canvas or a picture is no
// box.
export function loneTextBox(frame: XmlElement): XmlElement | undefined {
    const graphic = xmlChild(frame, A_NS, 'graphic');
    const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
    const [only, ...others] = data ? xmlElements(data) : [];
    if (!only || others.length > 0 || !hasXmlName(only, WPS_NS, 'wsp')) return undefined;
    return xmlChild(only, WPS_NS, 'txbx') || xmlChild(only, WPS_NS, 'linkedTxbx') ? only : undefined;
}

// Whether Word draws the shape, by its own fill or line or its style's: a box around a lone picture stays one if it does.
export function paintsBox(reader: Reader, shape: XmlElement): boolean {
    const spPr = xmlChild(shape, WPS_NS, 'spPr');
    const style = xmlChild(shape, WPS_NS, 'style');
    return shapeFill(reader, spPr, style) !== null || shapeOutline(reader, spPr, style) !== null;
}

// A wps text box at its place and size: its width from the extent, capped at `room`, and its height a minimum, none for
// a box Word grows with its text. A box that holds no text and draws nothing is dropped, uncounted.
export function readTextBox(
    reader: Reader,
    shape: XmlElement,
    extent: XmlElement | undefined,
    layout: FigureFrameAttrs,
    room: number,
    items: Item[],
): JSONContent | null {
    const spPr = xmlChild(shape, WPS_NS, 'spPr');
    const style = xmlChild(shape, WPS_NS, 'style');
    const bodyPr = xmlChild(shape, WPS_NS, 'bodyPr');
    const cx = roundedInt(extent && xmlAttr(extent, '', 'cx')) ?? 0;
    const cy = roundedInt(extent && xmlAttr(extent, '', 'cy')) ?? 0;
    const grows = !!bodyPr && xmlElements(bodyPr).some((child) => child.local === 'spAutoFit');
    const geometry = spPr && xmlChild(spPr, A_NS, 'prstGeom');
    const preset = geometry ? xmlAttr(geometry, '', 'prst') : 'rect';
    // An odd shape, a turned shape or turned text is drawn simpler. So is a box that continues another's story: Word
    // stores the whole story in the chain's first box, so this one holds none of its own.
    const simplified =
        (preset !== 'rect' && preset !== 'roundRect') ||
        (!!bodyPr &&
            (Number(xmlAttr(bodyPr, '', 'rot') ?? 0) !== 0 || (xmlAttr(bodyPr, '', 'vert') ?? 'horz') !== 'horz')) ||
        (!!spPr && Number(xmlAttr(xmlChild(spPr, A_NS, 'xfrm') ?? spPr, '', 'rot') ?? 0) !== 0) ||
        !xmlChild(shape, WPS_NS, 'txbx');
    const look: BoxLook = {
        width: cx > 0 ? Math.min(room, cx / EMU_PER_PX) : null,
        height: grows || cy <= 0 ? null : cy / EMU_PER_PX,
        fill: shapeFill(reader, spPr, style),
        outline: shapeOutline(reader, spPr, style),
        ...insets(bodyPr),
        verticalAlign: boxAlign(bodyPr && xmlAttr(bodyPr, '', 'anchor')),
        rounded: preset === 'roundRect',
    };
    return textBoxNode(reader, items, look, layout, simplified);
}

// A VML shape holding a v:textbox outside a Fallback: its CSS style places and sizes it, its w10:wrap says how the text
// wraps around it, and its fill and stroke paint it. Word's VML places from the column and the paragraph as `text`. One
// it can't place, absolute in the flow of no paragraph, keeps its paragraphs after its anchor's, as before: null.
// `spaceBefore` is the space Word draws above the paragraph, which a top counted from the paragraph includes.
export function readVmlTextBox(
    reader: Reader,
    shape: XmlElement,
    room: number,
    spaceBefore: number,
    items: Item[],
): JSONContent | null {
    const textbox = descendants(shape, V_NS, 'textbox')[0];
    if (!textbox) return null;
    const css = vmlStyle(shape);
    const px = (name: string) => vmlPx(css.get(name), 'px');
    const absolute = css.get('position') === 'absolute';
    const relativeV = css.get('mso-position-vertical-relative') ?? 'text';
    const relativeH = css.get('mso-position-horizontal-relative') ?? 'text';
    const placed = relativeH === 'text' && (relativeV === 'text' || relativeV === 'line');
    const wrap = xmlChild(shape, W10_NS, 'wrap');
    const wrapType = wrap ? xmlAttr(wrap, '', 'type') : undefined;
    // A box the text wraps above and below sits in its own line, as one in the flow.
    const inLine = !absolute || wrapType === 'topAndBottom';
    const wrapped = VML_FLOATING_WRAPS.has(wrapType ?? '');
    if (!inLine && !wrapped && !placed) return null;
    const behind = Number(css.get('z-index') ?? 0) < 0;
    const width = px('width');
    const height = px('height');
    const left = px('margin-left') ?? 0;
    const side = floatSide(css.get('mso-position-horizontal'), left + (width ?? 0) / 2, room);
    const layout: FigureFrameAttrs = inLine
        ? {}
        : wrapped
          ? { layout: `wrap-${side}` }
          : {
                layout: behind ? 'behind' : 'front',
                offsetX: left,
                offsetY: (px('margin-top') ?? 0) - (relativeV === 'text' ? spaceBefore : 0),
            };
    const filled = xmlAttr(shape, '', 'filled') !== 'f' && xmlAttr(shape, '', 'filled') !== 'false';
    const stroked = xmlAttr(shape, '', 'stroked') !== 'f' && xmlAttr(shape, '', 'stroked') !== 'false';
    const weight = vmlPx(xmlAttr(shape, '', 'strokeweight') ?? '0.75pt', 'emu') ?? 1;
    const strokeColor = readCellBackground(xmlAttr(shape, '', 'strokecolor') ?? '#000000');
    const inset = (xmlAttr(textbox, '', 'inset') ?? '').split(',').map((length) => vmlPx(length, 'emu'));
    const [insetLeft, insetTop, insetRight, insetBottom] = inset;
    const look: BoxLook = {
        width: width === null ? null : Math.min(room, width),
        height: [css, vmlStyle(textbox)].some((style) => style.get('mso-fit-shape-to-text') === 't') ? null : height,
        fill: filled ? readCellBackground(xmlAttr(shape, '', 'fillcolor') ?? '#ffffff') : null,
        outline:
            stroked && strokeColor
                ? cellBorderValue({ width: fitBorderPx(weight), style: 'solid', color: strokeColor })
                : null,
        paddingX: meanPadding(insetLeft ?? null, insetRight ?? null, TEXT_BOX_INSET.x),
        paddingY: meanPadding(insetTop ?? null, insetBottom ?? null, TEXT_BOX_INSET.y),
        verticalAlign: VML_TEXT_ANCHORS.get((css.get('v-text-anchor') ?? '').split('-')[0] ?? '') ?? null,
        rounded: shape.local === 'roundrect',
    };
    return textBoxNode(reader, items, look, layout, false);
}

// The box's paragraphs, read as a note's: a list's, a heading's or a table's become paragraphs and a nested box or note
// its text, the box counted once with whatever its shape `simplified`.
function textBoxNode(
    reader: Reader,
    items: Item[],
    look: BoxLook,
    layout: FigureFrameAttrs,
    simplified: boolean,
): JSONContent | null {
    const blocks = buildBlocks(items);
    const paragraphs = blocks.flatMap(storyParagraphs);
    if (
        simplified ||
        blocks.some((block) => block.type !== 'paragraph') ||
        paragraphs.some((paragraph) => paragraph.content?.some((node) => isStoryNode(node.type)))
    )
        reader.lost('text-simplified');
    const shows = paragraphs.some((paragraph) => (paragraph.content ?? []).length > 0);
    if (!shows && !look.fill && !look.outline) return null;
    return flattenNestedStories({
        type: 'textBox',
        attrs: {
            id: newStoryId(),
            ...layout,
            ...look,
            width: readTextBoxSide(look.width) ?? undefined,
            height: readTextBoxSide(look.height),
        } satisfies TextBoxEdit & { id: string },
        content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
    });
}

// The shape's own fill, else its style's: a gradient's first stop, none for a:noFill.
function shapeFill(reader: Reader, spPr: XmlElement | undefined, style: XmlElement | undefined): string | null {
    const own = spPr && xmlElements(spPr).find((child) => child.ns === A_NS && child.local.endsWith('Fill'));
    if (own?.local === 'noFill') return null;
    if (own?.local === 'gradFill') {
        const stop = descendants(own, A_NS, 'gs')[0];
        return readCellBackground(drawingColor(stop, reader.colors)?.slice(0, 7));
    }
    if (own) return readCellBackground(drawingColor(own, reader.colors)?.slice(0, 7));
    const ref = style && xmlChild(style, A_NS, 'fillRef');
    if (!ref || Number(xmlAttr(ref, '', 'idx') ?? 0) === 0) return null;
    return readCellBackground(drawingColor(ref, reader.colors)?.slice(0, 7));
}

// The shape's own line, else its style's, in the cell-border form: its width in px between a cell border's bounds, its
// dash and its compound line read as the nearest style.
function shapeOutline(reader: Reader, spPr: XmlElement | undefined, style: XmlElement | undefined): string | null {
    const line = spPr && xmlChild(spPr, A_NS, 'ln');
    const ref = style && xmlChild(style, A_NS, 'lnRef');
    if (line && xmlChild(line, A_NS, 'noFill')) return null;
    const fill = line && xmlChild(line, A_NS, 'solidFill');
    const fromStyle = !fill && ref && Number(xmlAttr(ref, '', 'idx') ?? 0) > 0 ? ref : undefined;
    const color = readCellBackground(drawingColor(fill ?? fromStyle, reader.colors)?.slice(0, 7));
    if (!color) return null;
    const width = (lineWidthEmu(line ? xmlAttr(line, '', 'w') : undefined) ?? DEFAULT_LINE_WIDTH_EMU) / EMU_PER_PX;
    const dash = line && xmlChild(line, A_NS, 'prstDash');
    const kind: CellBorderStyle =
        line && xmlAttr(line, '', 'cmpd') === 'dbl' ? 'double' : strokeStyleOf(dash && xmlAttr(dash, '', 'val'));
    return cellBorderValue({ width: fitBorderPx(width), style: kind, color });
}

// A bodyPr anchor as the box's vertical alignment: DrawingML's center is the box's middle, and the top is its default.
function boxAlign(anchor: string | undefined): BoxLook['verticalAlign'] {
    const align = ALIGN_BY_ANCHOR.get(anchor ?? 't');
    return align === 'center' ? 'middle' : align === 'bottom' ? align : null;
}

// The insets, the mean of a rare asymmetric pair; none where bodyPr states none or Word's own, which a box draws when
// it stores none.
function insets(bodyPr: XmlElement | undefined): Pick<BoxLook, 'paddingX' | 'paddingY'> {
    const side = (name: string) => {
        const emu = roundedInt(bodyPr && xmlAttr(bodyPr, '', name));
        return emu === undefined ? null : emu / EMU_PER_PX;
    };
    return {
        paddingX: meanPadding(side('lIns'), side('rIns'), TEXT_BOX_INSET.x),
        paddingY: meanPadding(side('tIns'), side('bIns'), TEXT_BOX_INSET.y),
    };
}

// A pair of insets as one padding: none where both are unset or the mean is Word's own.
function meanPadding(a: number | null, b: number | null, word: number): number | null {
    if (a === null && b === null) return null;
    const mean = Math.min(MAX_TEXT_BOX_PADDING, Math.max(0, ((a ?? b ?? 0) + (b ?? a ?? 0)) / 2));
    return Math.abs(mean - word) < 0.01 ? null : mean;
}
