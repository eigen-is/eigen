// The arrow label's editing session: where the label editor opens and what it starts with. The canvas starts one when
// an arrow is opened, such as by a double-click, draws it with TextOverlay and commits it in commitEditing. It edits the
// label of an arrow that already exists, so the commit writes its text only and never deletes the arrow. Rich text has
// an editor of its own, inside the element's layer.

import type { Point, VectorArrowElement } from '@workspace/lib/vector';
import { arrowLabelBox, arrowLabelCenter, linearLocalToScene } from '@workspace/lib/vector';

export type EditingState = {
    id: string;
    isNew: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    text: string;
    fontSize: number;
    fontFamily: string;
    strokeColor: string;
};

// The session opens on the label's anchor, the middle of the polyline, mapped from the arrow's frame to the scene.
// Its box is the stored label's, or empty while the arrow has none, so the editor turns with the arrow just as the
// drawn label does. An elbow arrow passes its derived `route`, so the editor opens on the middle of the route. Null
// for an arrow of fewer than 2 points, which has no anchor.
export function arrowLabelEditing(el: VectorArrowElement, route?: Point[]): EditingState | null {
    const center = arrowLabelCenter(el, route);
    if (!center) return null;
    const label = arrowLabelBox(el, route);
    const width = label?.width ?? 0;
    const height = label?.height ?? 0;
    const scene = linearLocalToScene(el, center);
    return {
        id: el.id,
        isNew: el.text === '',
        x: scene.x - width / 2,
        y: scene.y - height / 2,
        width,
        height,
        angle: el.angle,
        text: el.text,
        fontSize: el.fontSize,
        fontFamily: el.fontFamily,
        strokeColor: el.strokeColor,
    };
}
