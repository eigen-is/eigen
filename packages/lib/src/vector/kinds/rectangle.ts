// The rectangle kind: a box with treated corners, drawn rough, and the text it holds drawn over it. A rectangle with
// `autoFit` is a text box: it grows to fit its text, its text starts at the top left, and its renderer always emits
// the text body so the editor can measure it. An arrow aims at a plain rectangle along its corner diagonals, as in
// Excalidraw, and at a text box along its center lines.

import { isBordered, isUnpainted } from '../fill';
import type { Point } from '../geometry';
import { boxCenter, hitTestBox, rotatePoint } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import type { VectorRectangleElement } from '../types';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_SHAPE_TEXT_PROPS, DEFAULT_TEXT_BOX_PROPS } from '../types';
import type { StyleDefaults } from './kind';
import { BOX_CAPABILITIES, boxAimLines, defineKind, readBoxShape } from './kind';
import { bool, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';
import { hasText, plainText, richTextCssText, textRender, textualDefaults } from './textual';

// Excalidraw shrinks a rectangle's projection diagonals by 15px at each end
// (getDiagonalsForBindableElement) — the focus points behave oddly right at the corners.
const DIAGONAL_SHRINK = 15;

export const rectangleKind = defineKind<VectorRectangleElement>({
    type: 'rectangle',
    is: (el): el is VectorRectangleElement => el.type === 'rectangle',
    capabilities: BOX_CAPABILITIES,
    defaults: (style) => ({
        fill: style.fill,
        corners: style.corners,
        ...textualDefaults(style, DEFAULT_SHAPE_TEXT_PROPS),
        autoFit: false,
    }),
    read: (src, base) => {
        const autoFit = bool(src.get('autoFit'), false);
        return {
            ...base,
            type: 'rectangle',
            ...readBoxShape(src, autoFit ? DEFAULT_TEXT_BOX_PROPS : DEFAULT_SHAPE_TEXT_PROPS),
            corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
            autoFit,
        };
    },
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // The rectangle is Excalidraw's one exception to the center-line default: a straight arrow's bind-time
    // aim projects onto its two corner diagonals, pulled in by DIAGONAL_SHRINK at both ends. A text box keeps
    // the default.
    aimLines: (el) => {
        if (el.autoFit) return boxAimLines(el);
        const center = boxCenter(el);
        const rot = (p: Point): Point => rotatePoint(p, center, el.angle);
        const { x, y, width: w, height: h } = el;
        const down = shrink({ x, y }, { x: x + w, y: y + h });
        const up = shrink({ x: x + w, y }, { x, y: y + h });
        return [
            [rot(down[0]), rot(down[1])],
            [rot(up[0]), rot(up[1])],
        ];
    },
    paintsNothing: (el) => isUnpainted(el) && !hasText(el),
    // A text box emits its body even when empty, because the editor measures it to fit the box. It paints no backdrop
    // while it has neither fill nor border.
    render: (el) =>
        el.autoFit
            ? { html: el.html, style: richTextCssText(el), svg: isUnpainted(el) ? '' : renderRoughShape(el) }
            : textRender(el, renderRoughShape(el)),
    searchText: plainText,
});

// Whether an element is a text box: a rectangle with `autoFit`. Generic, so a new element's partial narrows too.
export function isTextBox<T extends { type: string; autoFit?: boolean }>(
    el: T,
): el is T & { type: 'rectangle'; autoFit: true } {
    return el.type === 'rectangle' && el.autoFit === true;
}

// What a new text box starts with over a new rectangle. It paints no border until the user picks a color, where a new
// rectangle draws one in ink. Its text starts at the top left, flush with its edge.
export function textBoxOverrides(style: StyleDefaults) {
    return { strokeColor: 'transparent', ...textualDefaults(style, DEFAULT_TEXT_BOX_PROPS), autoFit: true };
}

// A text box's height grows with its text. Whatever renders the box measures its body and writes the fit back when the
// text needs more room than the box has. The stored height is the user's minimum, never a maximum: extra height is what
// `verticalAlign` works with, so nothing shrinks a box by itself, and a manual resize sets a new minimum. `contentHeight`
// is the body's own extent, and the stored height is the border box, so the inset and the border ride inside it. It
// returns null when the box is tall enough. That is also the loop guard: every peer measures the same box, and only a
// shortfall of 1 px or more is written.
export function textBoxFitHeight(el: VectorRectangleElement, contentHeight: number): number | null {
    const needed = contentHeight + 2 * el.padding + (isBordered(el) ? 2 * el.strokeWidth : 0);
    // A sub-pixel shortfall is left alone: the body overflows visibly rather than clipping, so writing
    // for it would only cost every peer a round of updates.
    return needed - el.height >= 1 ? Math.ceil(needed) : null;
}

// Pull a segment in by DIAGONAL_SHRINK at each end, along its own direction. A segment with no room for
// both bites is returned unchanged — shrinking it would reverse it and aim the arrow back out.
function shrink(a: Point, b: Point): [Point, Point] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 2 * DIAGONAL_SHRINK) return [a, b];
    const ox = (dx / len) * DIAGONAL_SHRINK;
    const oy = (dy / len) * DIAGONAL_SHRINK;
    return [
        { x: a.x + ox, y: a.y + oy },
        { x: b.x - ox, y: b.y - oy },
    ];
}
