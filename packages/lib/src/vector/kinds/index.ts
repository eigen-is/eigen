// The registry. TypeScript forces every member of VectorElementType to have an entry, so a new kind
// cannot be half-added.

import {
    BASE_ELEMENT_FIELDS,
    DEFAULT_ELEMENT_PROPS,
    type ElementOfType,
    prop,
    type VectorBindableElement,
    type VectorElement,
    type VectorElementBase,
    type VectorElementType,
} from '../types';
import { arrowKind } from './arrow';
import { diamondKind } from './diamond';
import { ellipseKind } from './ellipse';
import { freedrawKind } from './freedraw';
import { imageKind } from './image';
import type { Capabilities, ElementKind, StyleDefaults } from './kind';
import { lineKind } from './line';
import { fontFamily } from './read-fields';
import { rectangleKind } from './rectangle';
import { richTextKind } from './richtext';

export type { RenderOutput, StyleDefaults } from './kind';
export { NEW_TEXT_BOX_SIZE, SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from './kind';
// The in-place editor paints its box with the SAME string the renderer emits, so the two cannot drift.
export { richTextCssText, richTextFitHeight } from './richtext';

// Each entry keeps its own element type, so `ELEMENT_KINDS.richtext.defaults(style)` is rich text's
// field set and a generic `ELEMENT_KINDS[el.type]` lookup still answers with the union.
export type ElementKindRegistry = { [K in VectorElementType]: ElementKind<ElementOfType<K>> };

export const ELEMENT_KINDS: ElementKindRegistry = {
    rectangle: rectangleKind,
    diamond: diamondKind,
    ellipse: ellipseKind,
    image: imageKind,
    richtext: richTextKind,
    freedraw: freedrawKind,
    line: lineKind,
    arrow: arrowKind,
};

// THE capability accessor: the kind's static table with its per-element overrides applied. Some answers
// depend on the element's geometry (an open freedraw paints no fill), so nothing holding an element reads
// `ELEMENT_KINDS[type].capabilities` directly — the panel, the tools and the binding code call this.
export function capabilitiesOf(el: VectorElement): Capabilities {
    return ELEMENT_KINDS[el.type].capabilitiesOf(el);
}

// Does this element put any ink on the page? False for an empty text box, a shape with neither fill nor
// border, and an image with no picture. Editing chrome only — the canvas rings such an element so it
// stays findable and selectable; a thumbnail, present mode, a preview and an export show the page as it
// is. A kind answers for itself (kind.ts), so nothing switches on `type` out here.
export function paintsNothing(el: VectorElement): boolean {
    return ELEMENT_KINDS[el.type].paintsNothing(el);
}

// Bindable targets for an arrow endpoint, read off the registry through the one capability accessor. A
// single predicate so every consumer — the reader's dangling-binding pass, the follow math, the elbow
// router's obstacles, the tool's candidate search — agrees, and a new kind opts in by declaring the
// capability rather than by being added to a list.
export function isBindable(el: VectorElement): el is VectorBindableElement {
    return capabilitiesOf(el).bindable;
}

// The registry answers the vocabulary question too, so a stored `type` is validated against the one
// table. hasOwn, not `in`: `'constructor' in ELEMENT_KINDS` is true and would dispatch to Object's.
export function isVectorElementType(v: unknown): v is VectorElementType {
    return typeof v === 'string' && Object.hasOwn(ELEMENT_KINDS, v);
}

// The shared base props a NEW element of this kind is created with, under the kind's own overrides —
// the two the creation path spreads before the kind's own fields. The panel's reset affordances read
// the same table, so "reset" restores exactly what "create" would have given: an image's border resets
// to none, a rectangle's to the shared ink colour.
export function baseDefaultsFor(
    type: VectorElementType,
    style: StyleDefaults,
): Pick<VectorElementBase, keyof typeof DEFAULT_ELEMENT_PROPS> {
    // The shared table's roughness is the READER's 0; a new element is as sketchy as its host says.
    return { ...DEFAULT_ELEMENT_PROPS, roughness: style.roughness, ...ELEMENT_KINDS[type].baseDefaults };
}

// Toolbar order (Excalidraw's), the order ELEMENT_FIELDS walks the kinds in. Every type appears
// exactly once — the registry test pins that through ELEMENT_FIELDS.
const TOOL_ORDER: VectorElementType[] = [
    'rectangle',
    'diamond',
    'ellipse',
    'arrow',
    'line',
    'freedraw',
    'richtext',
    'image',
];

// The kinds a tool can create, in toolbar order — VECTOR_TOOLS derives from this instead of hand-listing
// tools next to icons. The literal tuple is what gives `CreationToolType` a narrow union, so a UI table
// keyed by it is exhaustive-checked; the registry test pins the tuple against the capabilities so the two
// can never disagree.
const CREATION_ORDER = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'richtext'] as const;

type CreationToolType = (typeof CREATION_ORDER)[number];
export const CREATION_TOOL_TYPES: readonly CreationToolType[] = CREATION_ORDER;

// The EIGEN_FONTS families a scene draws text in: a kind that declares a `fontFamily` field, on an
// element that has text to draw. Derived from the registry, so the SVG export inlines the @font-face
// block of a new text-bearing kind the day it declares the field, instead of dropping its glyphs.
export function sceneFontFamilies(elements: VectorElement[]): Set<string> {
    const families = new Set<string>();
    for (const el of elements) {
        const kind = ELEMENT_KINDS[el.type];
        if (!kind.fields.includes('fontFamily') || kind.searchText(el) === '') continue;
        families.add(fontFamily(prop(el, 'fontFamily')));
    }
    return families;
}

// The stored-key whitelist every writer iterates and the reader materializes: the base fields plus every
// kind's own, in declaration order, de-duplicated. A new kind extends it by existing.
export const ELEMENT_FIELDS: readonly string[] = buildElementFields();

// A record's stored fields, in allow-list order, with undefined values dropped: exactly what a writer
// sets into a Y.Map and nothing else, so a spec-only or stale key can never reach the doc. Pass
// ELEMENT_FIELDS for an element and FRAME_FIELDS for a frame — the editor's add and duplicate passes,
// the deck seeder, the frame writer and the demo builders all store through this one filter.
export function storedFields(source: object, fields: readonly string[]): [string, unknown][] {
    const out: [string, unknown][] = [];
    for (const field of fields) {
        const value = prop(source, field);
        if (value !== undefined) out.push([field, value]);
    }
    return out;
}

function buildElementFields(): string[] {
    const out: string[] = [...BASE_ELEMENT_FIELDS];
    const seen = new Set<string>(out);
    for (const type of TOOL_ORDER) {
        for (const field of ELEMENT_KINDS[type].fields) {
            if (seen.has(field)) continue;
            seen.add(field);
            out.push(field);
        }
    }
    return out;
}
