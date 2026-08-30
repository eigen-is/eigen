// The text-editing SESSION model + its pure builders, factored out of vector-canvas.tsx so the canvas
// only DISPATCHES (the ground-rule that the canvas file must not grow). A session drives the TextOverlay
// and is committed back by the canvas' commitEditing.
//
// A `text` element stays LOCAL (id never written) until its first commit — an empty discard writes
// nothing; re-editing an existing one commits one update, or deletes it when committed empty. An `arrow`
// session edits a live arrow's label field in place (the arrow already exists): commit writes `text` +
// `labelWidth`, empty clears both, and never deletes the arrow.

import {
    arrowLabelBox,
    arrowLabelCenter,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    linearLocalToScene,
    type TextAlign,
    type VectorArrowElement,
    type VectorTextElement,
} from '@workspace/lib/vector';

export type EditingState = {
    kind: 'text' | 'arrow';
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

// A fresh, still-LOCAL text element at the scene point (text-tool click on empty canvas / a non-text hit).
export function newTextEditing(x: number, y: number): EditingState {
    return {
        kind: 'text',
        id: '__new_text__',
        isNew: true,
        x,
        y,
        width: 0,
        height: 0,
        angle: 0,
        text: '',
        fontSize: DEFAULT_FONT_SIZE,
        fontFamily: DEFAULT_FONT_FAMILY,
        textAlign: 'left',
        strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
    };
}

// An existing text element (text-tool click that hits it, or select-tool double-click).
export function textEditing(el: VectorTextElement): EditingState {
    return {
        kind: 'text',
        id: el.id,
        isNew: false,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        angle: el.angle,
        text: el.text,
        fontSize: el.fontSize,
        fontFamily: el.fontFamily,
        textAlign: el.textAlign,
        strokeColor: el.strokeColor,
    };
}

// An arrow's label (select-tool double-click), centered on the label anchor — the polyline's
// index-midpoint in the arrow's local frame, mapped to the scene (R3.12). The box is the committed
// label rect (empty when the arrow has no label yet), so the overlay rotates with the arrow exactly as
// the rendered label does. The label is always centered, so no textAlign choice. null for a degenerate
// arrow (< 2 points) with no label anchor.
export function arrowLabelEditing(el: VectorArrowElement): EditingState | null {
    const center = arrowLabelCenter(el);
    if (!center) return null;
    const label = arrowLabelBox(el); // null until the arrow carries a label
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
