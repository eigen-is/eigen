// The text-editing SESSION model + its pure builders, factored out of vector-canvas.tsx so the canvas
// only DISPATCHES (the ground-rule that the canvas file must not grow). A session drives the TextOverlay
// and is committed back by the canvas' commitEditing.
//
// The arrow label is the only plain-text path left on the canvas: the session edits a live arrow's label
// field in place (the arrow already exists), so commit writes `text` + `labelWidth`, empty clears both,
// and it never deletes the arrow. Rich text gets its own in-place editor.

import {
    arrowLabelBox,
    arrowLabelCenter,
    linearLocalToScene,
    type Point,
    type TextAlign,
    type VectorArrowElement,
} from '@workspace/lib/vector';

export type EditingState = {
    kind: 'arrow';
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
    textAlign: TextAlign;
    strokeColor: string;
};

// An arrow's label (select-tool double-click), centered on the label anchor — the polyline's
// index-midpoint in the arrow's local frame, mapped to the scene. The box is the committed
// label rect (empty when the arrow has no label yet), so the overlay rotates with the arrow exactly as
// the rendered label does. The label is always centered, so no textAlign choice. `route` (the derived
// elbow polyline) overrides the stored endpoints so an elbow arrow's overlay opens on its routed
// midpoint. null for a degenerate arrow (< 2 points) with no label anchor.
export function arrowLabelEditing(el: VectorArrowElement, route?: Point[]): EditingState | null {
    const center = arrowLabelCenter(el, route);
    if (!center) return null;
    const label = arrowLabelBox(el, route); // null until the arrow carries a label
    const width = label?.width ?? 0;
    const height = label?.height ?? 0;
    const scene = linearLocalToScene(el, center);
    return {
        kind: 'arrow',
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
        textAlign: 'center',
        strokeColor: el.strokeColor,
    };
}
