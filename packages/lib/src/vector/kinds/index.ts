// The kind registry: one entry per element type, and the answers derived from it, such as the stored fields, the
// creatable kinds and each element's capabilities. Every vector module that dispatches on a kind asks it.
// TypeScript forces every member of VectorElementType to have an entry, so a new kind can't be half added.

import type {
    ElementOfType,
    VectorBindableElement,
    VectorElement,
    VectorElementBase,
    VectorElementType,
    VectorTextualElement,
} from '../types';
import { BASE_ELEMENT_FIELDS, DEFAULT_ELEMENT_PROPS, prop } from '../types';
import { arrowKind } from './arrow';
import { chartKind } from './chart';
import { diamondKind } from './diamond';
import { ellipseKind } from './ellipse';
import { freedrawKind } from './freedraw';
import { imageKind } from './image';
import type { Capabilities, ElementKind, StyleDefaults } from './kind';
import { lineKind } from './line';
import { pathKind } from './path';
import { pieKind } from './pie';
import type { YMapLike } from './read-fields';
import { isYMapLike } from './read-fields';
import { isTextBox, rectangleKind } from './rectangle';
import { hasText } from './textual';

export type { RenderOutput, StyleDefaults } from './kind';
export { NEW_TEXT_BOX_SIZE, SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from './kind';
export { isTextBox, textBoxFitHeight, textBoxOverrides } from './rectangle';
// The text block every kind with text shares. The in-place editor styles its box with the same CSS the renderer
// writes, richTextCssText, so the two can't drift.
export { hasText, richTextCssText, textualDefaults } from './textual';

// Each entry keeps its own element type, so `ELEMENT_KINDS.rectangle.defaults(style)` is the rectangle's
// field set and a generic `ELEMENT_KINDS[el.type]` lookup still answers with the union.
export type ElementKindRegistry = { [K in VectorElementType]: ElementKind<ElementOfType<K>> };

export const ELEMENT_KINDS: ElementKindRegistry = {
    rectangle: rectangleKind,
    diamond: diamondKind,
    ellipse: ellipseKind,
    pie: pieKind,
    path: pathKind,
    chart: chartKind,
    image: imageKind,
    freedraw: freedrawKind,
    line: lineKind,
    arrow: arrowKind,
};

// What one element supports: its kind's table with the kind's overrides for that element. Some answers depend on
// the element's shape, as an open freehand stroke paints no fill. So code holding an element calls this and never
// reads `ELEMENT_KINDS[type].capabilities`.
export function capabilitiesOf(el: VectorElement): Capabilities {
    return ELEMENT_KINDS[el.type].capabilitiesOf(el);
}

// Whether this element puts nothing on the page, such as an empty text box, a shape with neither fill nor border,
// or an image with no picture. Only the editor uses it: the canvas rings such an element so it stays findable,
// while a thumbnail, present mode and an export show the page as it is. Each kind answers for itself.
export function paintsNothing(el: VectorElement): boolean {
    return ELEMENT_KINDS[el.type].paintsNothing(el);
}

// What Convert to shapes writes in the element's place, or none for an element with nothing to unpack, such as
// anything but a chart that draws.
export function convertToShapes(el: VectorElement): VectorElement[] {
    return ELEMENT_KINDS[el.type].toShapes(el);
}

// Whether an arrow's end may bind to this element, read off its capabilities. Every caller, such as the reader
// and the elbow router, asks this one guard, so they agree. A new kind opts in by declaring the capability and
// not by joining a list.
export function isBindable(el: VectorElement): el is VectorBindableElement {
    return capabilitiesOf(el).bindable;
}

// The elements that hold rich text, such as a rectangle or an ellipse: the ones the in-place editor, the panel's
// text rows and the renderer act on. Read through the capability accessor.
export function isTextual(el: VectorElement): el is VectorTextualElement {
    return capabilitiesOf(el).text;
}

// The elements that draw a text body: a text box always, even empty, because it grows to fit it, and any other element
// with text once it holds some. An export writes a body for exactly these.
export function drawsTextBody(el: VectorElement): el is VectorTextualElement {
    return isTextual(el) && (isTextBox(el) || hasText(el));
}

// Whether a stored `type` names a kind, checked against the registry itself. It uses hasOwn and not `in`, because
// `'constructor' in ELEMENT_KINDS` is true and would reach Object's constructor.
export function isVectorElementType(v: unknown): v is VectorElementType {
    return typeof v === 'string' && Object.hasOwn(ELEMENT_KINDS, v);
}

// The shared base props a new element of this kind is created with, under the kind's own overrides, such as an
// image's border, which starts as none. The creation paths and the previews spread it before the kind's own fields.
export function baseDefaultsFor(
    type: VectorElementType,
    style: StyleDefaults,
): Pick<VectorElementBase, keyof typeof DEFAULT_ELEMENT_PROPS> {
    // The shared table's roughness is the reader's 0, and a new element is as sketchy as its host's table says.
    return { ...DEFAULT_ELEMENT_PROPS, roughness: style.roughness, ...ELEMENT_KINDS[type].baseDefaults };
}

// The kinds a tool can create, in toolbar order, which the toolbar's tools derive from. The literal tuple gives
// `CreationToolType` a narrow union, so a UI table keyed by it must cover every kind. The registry test pins the
// tuple to the capabilities, so the two can't disagree.
const CREATION_ORDER = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw'] as const;

type CreationToolType = (typeof CREATION_ORDER)[number];
export const CREATION_TOOL_TYPES: readonly CreationToolType[] = CREATION_ORDER;

// The stored fields every writer writes and the reader reads: the base fields and then each kind's own, in registry
// order, without repeats. It walks the registry, so a new kind's fields are stored the day it joins.
export const ELEMENT_FIELDS: readonly string[] = [
    ...new Set([...BASE_ELEMENT_FIELDS, ...Object.values(ELEMENT_KINDS).flatMap((kind) => kind.fields)]),
];

// A record's stored fields off a Y.Map or a plain record, in the list's order, without undefined values. That is all
// a writer sets into a Y.Map, so a key the list doesn't hold never reaches the doc.
export function storedFields(source: YMapLike | object, fields: readonly string[]): [string, unknown][] {
    const out: [string, unknown][] = [];
    for (const field of fields) {
        const value = isYMapLike(source) ? source.get(field) : prop(source, field);
        if (value !== undefined) out.push([field, value]);
    }
    return out;
}

// What a duplicate, a copy and a paste store of an element.
export function storedElementFields(source: YMapLike | Readonly<Record<string, unknown>>): [string, unknown][] {
    return storedFields(source, ELEMENT_FIELDS);
}
