// The element-writing primitives over a vector Y.Doc: fresh ids, the seed rule, the live topmost
// z-index, and the duplicate pass. Plain functions over the doc, the way the tools modules are plain
// functions over the scene, so the hook stays the thin React surface.

import {
    baseDefaultsFor,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    generateNKeysBetween,
    isValidFractionalIndex,
    isVectorElementType,
    remapBinding,
    type StyleDefaults,
    storedFields,
    type VectorElementType,
} from '@workspace/lib/vector';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import type { NewVectorElement } from './use-canvas-doc';

export function newElementId(): string {
    return `el-${nanoid(10)}`;
}

// A fresh roughjs jitter seed. One source: the creation paths, the duplicate pass and the draw drafts
// must draw from the same range or a preview pops on release.
export function randomSeed(): number {
    return Math.floor(Math.random() * 2 ** 31);
}

// Only the roughjs kinds declare a seed; writing one onto an image or a rich-text box is exactly the
// drift the ELEMENT_FIELDS whitelist exists to prevent.
export function hasSeed(type: unknown): boolean {
    return isVectorElementType(type) && ELEMENT_KINDS[type].fields.includes('seed');
}

// Per-type defaults: the geometry box, the shared base props, and the kind's own fields straight from
// the registry, styled by the HOST's table (vector draws rough and hatched, slides flat and solid) —
// a new kind needs no entry here, and a new host only a table.
function elementDefaults(type: VectorElementType, style: StyleDefaults): Record<string, unknown> {
    return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        angle: 0,
        // The shared base paint under the kind's overrides: rich text and images use the stroke as a
        // border, so a fresh one is unframed until the user picks a stroke colour. The panel's reset
        // rows read the same helper, so a reset restores what creation gave.
        ...baseDefaultsFor(type),
        ...ELEMENT_KINDS[type].defaults(style),
    };
}

// One element into the doc's `elements` map at the given fractional index, under the kind's defaults
// and the host's style table — THE element writer, shared by the editor's add path and the deck
// seeder. Honors a caller-supplied seed so a drag-create preview and its committed element share the
// same roughjs jitter (no visual pop on release); a seedless kind stores none. Nested in a live
// transact it joins that one, so a caller's origin and single-atom guarantee both survive.
export function writeElementInDoc(doc: Y.Doc, partial: NewVectorElement, index: string, style: StyleDefaults): string {
    const id = newElementId();
    const seed = hasSeed(partial.type) ? (partial.seed ?? randomSeed()) : undefined;
    const record = { ...elementDefaults(partial.type, style), ...partial, id, type: partial.type, seed, index };
    const element = new Y.Map<unknown>();
    for (const [field, value] of storedFields(record, ELEMENT_FIELDS)) element.set(field, value);
    doc.transact(() => doc.getMap('elements').set(id, element));
    return id;
}

// Live topmost fractional index in the map. Skips non-map entries and malformed index strings —
// a corrupt peer write must not make generateKeyBetween throw and brick adding elements
// (read-vector heals them on read).
export function topmostIndex(elementsMap: Y.Map<unknown>): string | null {
    let topmost: string | null = null;
    for (const value of elementsMap.values()) {
        if (!(value instanceof Y.Map)) continue;
        const idx = value.get('index');
        if (typeof idx !== 'string' || !isValidFractionalIndex(idx, undefined, undefined)) continue;
        if (topmost === null || idx > topmost) topmost = idx;
    }
    return topmost;
}

// A stored fractional index, or '' when the entry has none — the duplicate pass only needs the relative
// order, and read-vector heals a malformed index anyway.
function indexOf(element: Y.Map<unknown>): string {
    const index = element.get('index');
    return typeof index === 'string' ? index : '';
}

function compareIndex(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

// Clone elements offset by (dx, dy) in ONE transact, stacked on top preserving their relative z-order,
// each with a fresh id + seed. Returns the new ids so the caller reselects the clones.
export function duplicateElementsInDoc(doc: Y.Doc, ids: string[], dx: number, dy: number): string[] {
    const newIds: string[] = [];
    doc.transact(() => {
        const elementsMap = doc.getMap('elements');
        const sources = ids
            .map((id) => elementsMap.get(id))
            .filter((m): m is Y.Map<unknown> => m instanceof Y.Map)
            .sort((a, b) => compareIndex(indexOf(a), indexOf(b)));
        if (sources.length === 0) return;
        const keys = generateNKeysBetween(topmostIndex(elementsMap), null, sources.length);
        // Allocate every clone id FIRST, then remap bindings across the set: an arrow bound to a shape
        // that was duplicated too points at its clone; a bound shape outside the set clears.
        const idMap = new Map<string, string>();
        for (const src of sources) {
            const oldId = src.get('id');
            const id = newElementId();
            if (typeof oldId === 'string') idMap.set(oldId, id);
            newIds.push(id);
        }
        for (const [i, src] of sources.entries()) {
            const id = newIds[i];
            const clone = new Y.Map();
            for (const field of ELEMENT_FIELDS) {
                const v = src.get(field);
                if (v !== undefined) clone.set(field, v);
            }
            clone.set('id', id);
            if (hasSeed(src.get('type'))) clone.set('seed', randomSeed());
            clone.set('index', keys[i]);
            // A copy starts with no comments; the cards belong to the element that was commented on.
            clone.set('commentCardIds', '');
            if (src.get('type') === 'arrow') {
                const sb = src.get('startBinding');
                const eb = src.get('endBinding');
                clone.set('startBinding', remapBinding(typeof sb === 'string' ? sb : '', idMap));
                clone.set('endBinding', remapBinding(typeof eb === 'string' ? eb : '', idMap));
            }
            // Read x/y from the source map — the clone is not integrated into the doc yet
            const x = src.get('x');
            const y = src.get('y');
            if (typeof x === 'number') clone.set('x', x + dx);
            if (typeof y === 'number') clone.set('y', y + dy);
            elementsMap.set(id, clone);
        }
    });
    return newIds;
}
