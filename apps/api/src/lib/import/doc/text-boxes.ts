// A Word text box as the doc holds it: a wps shape alone in its drawing, or a VML shape holding a v:textbox, becomes a
// text box with the box's size, fill, outline, insets, vertical alignment and rounded corners, its paragraphs read as a
// note's are. The drawing walk finds one in the body, reads its paragraphs in textBoxScope and calls readTextBox; a
// band's, a note's and a group's boxes keep their paragraphs after their anchor's.

import type { JSONContent } from '@tiptap/core';
import type { CellBorderStyle, FigureFrameAttrs } from '@workspace/lib/docs/eigendoc';
import {
    cellBorderValue,
    flattenNestedStories,
    MAX_CELL_BORDER_PX,
    MAX_TEXT_BOX_PADDING,
    MIN_CELL_BORDER_PX,
    newStoryId,
    ptToPx,
    readCellBackground,
    readTextBoxSide,
    TEXT_BOX_INSET,
    TEXT_BOX_MIN_SIDE,
} from '@workspace/lib/docs/eigendoc';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlElements } from '../../core/xml';
import { DEFAULT_LINE_WIDTH_EMU, drawingColor, lineWidthEmu, strokeStyleOf } from '../../ooxml/drawingml';
import { A_NS, EMU_PER_PX, POINTS_PER_UNIT, V_NS, WPS_NS } from '../../ooxml/ooxml';
import type { Item } from './assemble';
import { buildBlocks } from './assemble';
import { descendants, roundedInt } from './package';
import type { Reader, Scope } from './paragraphs';
import { storyParagraphs } from './paragraphs';

// The look a box draws in, read off a wps shape or a VML one.
type BoxLook = {
    width: number | null;
    height: number | null;
    fill: string | null;
    outline: string | null;
    paddingX: number | null;
    paddingY: number | null;
    verticalAlign: 'middle' | 'bottom' | null;
    rounded: boolean;
};

const VERTICAL_ALIGNS = new Map<string, BoxLook['verticalAlign']>([
    ['ctr', 'middle'],
    ['b', 'bottom'],
]);

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
    if (preset !== 'rect' && preset !== 'roundRect') reader.lost('text-simplified');
    if (bodyPr && (Number(xmlAttr(bodyPr, '', 'rot') ?? 0) !== 0 || (xmlAttr(bodyPr, '', 'vert') ?? 'horz') !== 'horz'))
        reader.lost('text-simplified');
    if (spPr && Number(xmlAttr(xmlChild(spPr, A_NS, 'xfrm') ?? spPr, '', 'rot') ?? 0) !== 0)
        reader.lost('text-simplified');
    const look: BoxLook = {
        width: cx > 0 ? Math.min(room, cx / EMU_PER_PX) : null,
        height: grows || cy <= 0 ? null : cy / EMU_PER_PX,
        fill: shapeFill(reader, spPr, style),
        outline: shapeOutline(reader, spPr, style),
        ...insets(bodyPr),
        verticalAlign: VERTICAL_ALIGNS.get(bodyPr ? (xmlAttr(bodyPr, '', 'anchor') ?? 't') : 't') ?? null,
        rounded: preset === 'roundRect',
    };
    // A box that continues another's story holds none of its own: the chain's first box holds it all, as Word stores it.
    if (!xmlChild(shape, WPS_NS, 'txbx')) reader.lost('text-simplified');
    return textBoxNode(reader, items, look, layout);
}

// A VML shape holding a v:textbox outside a Fallback: its CSS style places and sizes it, its fill and stroke paint it.
// One it can't place, absolute in the flow of no paragraph, keeps its paragraphs after its anchor's, as before: null.
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
    const css = new Map(
        (xmlAttr(shape, '', 'style') ?? '')
            .split(';')
            .map((part) => part.split(':').map((side) => side.trim().toLowerCase()))
            .filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1]),
    );
    const px = (name: string) => cssPx(css.get(name));
    const absolute = css.get('position') === 'absolute';
    const relativeV = css.get('mso-position-vertical-relative') ?? 'paragraph';
    const relativeH = css.get('mso-position-horizontal-relative') ?? 'column';
    const placed = absolute && relativeH === 'column' && (relativeV === 'paragraph' || relativeV === 'line');
    if (absolute && !placed) return null;
    const behind = Number(css.get('z-index') ?? 0) < 0;
    const wrapped = css.get('mso-wrap-style') === 'square' && !absolute;
    const layout: FigureFrameAttrs = placed
        ? {
              layout: behind ? 'behind' : 'front',
              offsetX: px('margin-left') ?? 0,
              offsetY: (px('margin-top') ?? 0) - (relativeV === 'paragraph' ? spaceBefore : 0),
          }
        : wrapped
          ? { layout: 'wrap-left' }
          : {};
    const width = px('width');
    const height = px('height');
    const filled = xmlAttr(shape, '', 'filled') !== 'f' && xmlAttr(shape, '', 'filled') !== 'false';
    const stroked = xmlAttr(shape, '', 'stroked') !== 'f' && xmlAttr(shape, '', 'stroked') !== 'false';
    const weight = cssPx(xmlAttr(shape, '', 'strokeweight') ?? '0.75pt') ?? 1;
    const strokeColor = readCellBackground(xmlAttr(shape, '', 'strokecolor') ?? '#000000');
    const inset = (xmlAttr(textbox, '', 'inset') ?? '').split(',').map((side) => cssPx(side.trim()));
    const [left, top, right, bottom] = inset;
    const look: BoxLook = {
        width: width === null ? null : Math.min(room, width),
        height: css.get('mso-fit-shape-to-text') === 't' ? null : height,
        fill: filled ? readCellBackground(xmlAttr(shape, '', 'fillcolor') ?? '#ffffff') : null,
        outline:
            stroked && strokeColor
                ? cellBorderValue({ width: clampPen(weight), style: 'solid', color: strokeColor })
                : null,
        paddingX: meanPadding(left ?? null, right ?? null, TEXT_BOX_INSET.x),
        paddingY: meanPadding(top ?? null, bottom ?? null, TEXT_BOX_INSET.y),
        verticalAlign: null,
        rounded: shape.local === 'roundrect',
    };
    return textBoxNode(reader, items, look, layout);
}

// The box's paragraphs, read as a note's: a list's, a heading's or a table's become paragraphs, counted, and a nested
// box or note its text.
function textBoxNode(reader: Reader, items: Item[], look: BoxLook, layout: FigureFrameAttrs): JSONContent | null {
    const blocks = buildBlocks(items);
    if (blocks.some((block) => block.type !== 'paragraph')) reader.lost('text-simplified');
    const paragraphs = blocks.flatMap(storyParagraphs);
    const shows = paragraphs.some((paragraph) => (paragraph.content ?? []).length > 0);
    if (!shows && !look.fill && !look.outline) return null;
    return flattenNestedStories({
        type: 'textBox',
        attrs: {
            id: newStoryId(),
            ...layout,
            width: readTextBoxSide(look.width) ?? undefined,
            height: look.height === null ? null : Math.max(TEXT_BOX_MIN_SIDE, look.height),
            fill: look.fill,
            outline: look.outline,
            paddingX: look.paddingX,
            paddingY: look.paddingY,
            verticalAlign: look.verticalAlign,
            rounded: look.rounded,
        },
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
    return cellBorderValue({ width: clampPen(width), style: kind, color });
}

const clampPen = (px: number) => Math.min(MAX_CELL_BORDER_PX, Math.max(MIN_CELL_BORDER_PX, px));

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

// A VML length in px: a number with a CSS unit, or EMU with none, as an inset writes it.
function cssPx(value: string | undefined): number | null {
    const match = value && /^(-?[\d.]+)([a-z]*)$/.exec(value.trim());
    if (!match) return null;
    const number = Number(match[1]);
    const unit = match[2] ?? '';
    if (!Number.isFinite(number)) return null;
    if (unit === 'px') return number;
    if (unit === '') return number / EMU_PER_PX;
    const points = POINTS_PER_UNIT.get(unit);
    return points === undefined ? null : ptToPx(number * points);
}
