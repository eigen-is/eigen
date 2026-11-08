// Where a pptx shape lands on a slide: a shape's center, extents, turn and flips carried through each enclosing group
// and the slide's scale into a box in the frame, as PowerPoint draws it. The shape reader asks it for each shape's box
// and whether that box is on the slide. Only arithmetic lives here, so nothing in it reads the file.

import { normalizeAngle } from '@workspace/lib/vector';
import { isSideways } from '../../ooxml/drawingml';
import type { Xfrm } from './inherit';
import type { DeckWalk } from './package';

// x' = a·x + c·y, y' = b·x + d·y: a turn after the flips, as DrawingML applies them about a box's center.
type Turn = [a: number, b: number, c: number, d: number];

function apply(m: Turn, x: number, y: number): { x: number; y: number } {
    return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

// `rot` degrees clockwise (y down) after the flips.
function turn(rot: number, flipH: boolean, flipV: boolean): Turn {
    const r = (rot * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const [h, v] = [flipH ? -1 : 1, flipV ? -1 : 1];
    return [cos * h, sin * h, -sin * v, cos * v];
}

// A shape as DrawingML places it: its center, extents, turn and flips.
type Placement = { x: number; y: number; width: number; height: number; rot: number; flipH: boolean; flipV: boolean };

// From a shape tree's coordinates, in EMU, to the frame's px: through each enclosing group, then the slide's scale.
export type Place = (shape: Placement) => Placement;

// A group lays its children out in its chOff/chExt space, scaled onto its off/ext, then flips and turns them about its
// center. A child is never skewed: its center and turn move, its extents scale along the group's axes.
export function inGroup(outer: Place, xfrm: Xfrm): Place {
    const child = xfrm.child ?? { x: xfrm.x, y: xfrm.y, cx: xfrm.cx, cy: xfrm.cy };
    const kx = child.cx > 0 ? xfrm.cx / child.cx : 1;
    const ky = child.cy > 0 ? xfrm.cy / child.cy : 1;
    const [cx, cy] = [xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2];
    const turned = turn(xfrm.rot, xfrm.flipH, xfrm.flipV);
    const mirrors = xfrm.flipH !== xfrm.flipV;
    return (shape) => {
        const center = apply(turned, xfrm.x + (shape.x - child.x) * kx - cx, xfrm.y + (shape.y - child.y) * ky - cy);
        const sideways = isSideways(shape.rot);
        return outer({
            x: cx + center.x,
            y: cy + center.y,
            width: shape.width * (sideways ? ky : kx),
            height: shape.height * (sideways ? kx : ky),
            rot: (mirrors ? -shape.rot : shape.rot) + xfrm.rot,
            flipH: shape.flipH !== xfrm.flipH,
            flipV: shape.flipV !== xfrm.flipV,
        });
    };
}

// A SmartArt drawing is laid out from its graphic frame's corner, at the frame's own scale.
export function inFrame(outer: Place, xfrm: Xfrm): Place {
    return inGroup(outer, { ...xfrm, child: { x: 0, y: 0, cx: xfrm.cx, cy: xfrm.cy } });
}

export type Box = { x: number; y: number; width: number; height: number; angle: number };

// A leaf's box in the frame. A mirrored one keeps its box, and a pie its mirrored arc.
export type Placed = {
    box: Box;
    mirrored: boolean;
    start: { x: number; y: number };
    end: { x: number; y: number };
    xfrm: Xfrm;
};

export function place(placeIn: Place, xfrm: Xfrm): Placed {
    const { x, y, width, height, rot, flipH, flipV } = placeIn({
        x: xfrm.x + xfrm.cx / 2,
        y: xfrm.y + xfrm.cy / 2,
        width: xfrm.cx,
        height: xfrm.cy,
        rot: xfrm.rot,
        flipH: xfrm.flipH,
        flipV: xfrm.flipV,
    });
    const corner = apply(turn(rot, flipH, flipV), width / 2, height / 2);
    return {
        // A flipV box turns half round, as PowerPoint draws its text; a flipH one keeps its turn.
        box: { x: x - width / 2, y: y - height / 2, width, height, angle: normalizeAngle(rot + (flipV ? 180 : 0)) },
        mirrored: flipH !== flipV,
        start: { x: x - corner.x, y: y - corner.y },
        end: { x: x + corner.x, y: y + corner.y },
        xfrm,
    };
}

// A box wholly off the slide, such as a master's guide copied onto every slide, would be stored unseen past the frame
// or drawn in the bands beside a letterboxed slide. A box a group scaled past what a double holds is on no slide.
export function onSlide(box: Box, deck: DeckWalk): boolean {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return false;
    const r = (box.angle * Math.PI) / 180;
    const [cos, sin] = [Math.abs(Math.cos(r)), Math.abs(Math.sin(r))];
    const [halfWidth, halfHeight] = [
        (box.width * cos + box.height * sin) / 2,
        (box.width * sin + box.height * cos) / 2,
    ];
    const [cx, cy] = [box.x + box.width / 2 - deck.offset.x, box.y + box.height / 2 - deck.offset.y];
    return (
        cx + halfWidth >= 0 &&
        cx - halfWidth <= deck.slide.width &&
        cy + halfHeight >= 0 &&
        cy - halfHeight <= deck.slide.height
    );
}

// A box turned about its center: a quarter turn, or three, swaps its sides.
export function turned(box: Box, turn: number): Box {
    if (turn === 0) return box;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    const [width, height] = turn % 180 === 0 ? [box.width, box.height] : [box.height, box.width];
    return { x: cx - width / 2, y: cy - height / 2, width, height, angle: normalizeAngle(box.angle + turn) };
}
