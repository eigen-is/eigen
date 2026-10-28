// The rectangle kind: a box with treated corners, drawn rough, and the text it holds drawn over it. An arrow aims at
// it along its corner diagonals, as in Excalidraw.

import { isUnpainted } from '../fill';
import type { Point } from '../geometry';
import { boxCenter, hitTestBox, rotatePoint } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import type { VectorRectangleElement } from '../types';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_SHAPE_TEXT_PROPS } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';
import { plainText, readTextual, textRender, textualDefaults } from './textual';

// Excalidraw shrinks a rectangle's projection diagonals by 15px at each end
// (getDiagonalsForBindableElement) — the focus points behave oddly right at the corners.
const DIAGONAL_SHRINK = 15;

export const rectangleKind = defineKind<VectorRectangleElement>({
    type: 'rectangle',
    is: (el): el is VectorRectangleElement => el.type === 'rectangle',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: true,
        edges: false,
        strokeOptional: true,
        bindable: true,
        text: true,
        silhouette: 'box',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        corners: style.corners,
        ...textualDefaults(style, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    read: (src, base) => ({
        ...base,
        type: 'rectangle',
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        ...readTextual(src, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // The rectangle is Excalidraw's one exception to the center-line default: a straight arrow's bind-time
    // aim projects onto its two corner diagonals, pulled in by DIAGONAL_SHRINK at both ends.
    aimLines: (el) => {
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
    paintsNothing: (el) => isUnpainted(el) && plainText(el) === '',
    render: (el) => textRender(el, renderRoughShape(el)),
    searchText: plainText,
});

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
