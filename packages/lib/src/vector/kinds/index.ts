// The registry. TypeScript forces every member of VectorElementType to have an entry, so a new kind
// cannot be half-added.

import { BASE_ELEMENT_FIELDS, type VectorElementType } from '../types';
import { arrowKind } from './arrow';
import { diamondKind } from './diamond';
import { ellipseKind } from './ellipse';
import { freedrawKind } from './freedraw';
import { imageKind } from './image';
import type { ElementKind, StyleDefaults } from './kind';
import { lineKind } from './line';
import { rectangleKind } from './rectangle';
import { richTextKind } from './richtext';

export type {
    Capabilities,
    ElementKind,
    FieldSource,
    KindSpec,
    RenderContext,
    RenderOutput,
    StyleDefaults,
} from './kind';
export { defineKind } from './kind';
export { richTextStyle } from './richtext';

export const ELEMENT_KINDS: Record<VectorElementType, ElementKind> = {
    rectangle: rectangleKind,
    diamond: diamondKind,
    ellipse: ellipseKind,
    image: imageKind,
    richtext: richTextKind,
    freedraw: freedrawKind,
    line: lineKind,
    arrow: arrowKind,
};

// Toolbar order (Excalidraw's, with rich text where the hand text tool used to sit). Every type appears
// exactly once; the registry test pins that against Object.keys(ELEMENT_KINDS).
export const TOOL_ORDER: VectorElementType[] = [
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

export type CreationToolType = (typeof CREATION_ORDER)[number];
export const CREATION_TOOL_TYPES: readonly CreationToolType[] = CREATION_ORDER;

// The stored-key whitelist every writer iterates and the reader materializes: the base fields plus every
// kind's own, in declaration order, de-duplicated. A new kind extends it by existing.
export const ELEMENT_FIELDS: readonly string[] = buildElementFields();

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

// The vector app's style table: roughness 1, hachure, Excalifont, curved corners. Slides' table lands
// with the slides shell.
export const VECTOR_STYLE_DEFAULTS: StyleDefaults = {
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    fill: '{"type":"solid","color":"transparent"}',
    fillStyle: 'hachure',
    roughness: 1,
    corners: 'curved',
    fontFamily: 'Excalifont',
    fontSize: 20,
    color: '#1e1e1e',
};
