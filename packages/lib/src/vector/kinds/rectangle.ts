import { boxCenter, hitTestBox, type Point, rotatePoint } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import { CORNERS, DEFAULT_CORNERS, type VectorRectangleElement } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf } from './read-fields';
import { isUnpainted, renderRoughShape } from './render-utils';

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
        silhouette: 'box',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        corners: style.corners,
    }),
    read: (src, base) => ({
        ...base,
        type: 'rectangle',
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // The rectangle is Excalidraw's one exception to the centre-line default: a straight arrow's bind-time
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
    paintsNothing: isUnpainted,
    render: (el) => ({ svg: renderRoughShape(el) }),
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
