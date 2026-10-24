// The editor's multi-element passes over a vector Y.Doc: replace and duplicate, over the shared writer
// (write-vector.ts). Plain functions over the doc, the way the tools modules are plain functions over
// the scene, so the hook stays the thin React surface.

import type { NewVectorElement, StyleDefaults, ZOp } from '@workspace/lib/vector';
import {
    generateNKeysBetween,
    isValidFractionalIndex,
    newElementId,
    randomSeed,
    remapBinding,
    storedElementFields,
    topmostIndex,
    writeElementInDoc,
    zOrderKeys,
} from '@workspace/lib/vector';
import * as Y from 'yjs';

// The lowest valid stored index above `index`: the top of the z slot an element at `index` holds.
function indexAbove(elementsMap: Y.Map<unknown>, index: string): string | null {
    let above: string | null = null;
    for (const value of elementsMap.values()) {
        if (!(value instanceof Y.Map)) continue;
        const idx = value.get('index');
        if (typeof idx !== 'string' || idx <= index || !isValidFractionalIndex(idx, undefined, undefined)) continue;
        if (above === null || idx < above) above = idx;
    }
    return above;
}

// One element replaced by new ones in ONE transact, in its z slot and in the given order (Convert to
// shapes), each with a fresh id and the caller's seed. Arrows bound to it keep their endpoints and lose the
// binding, as on delete. A malformed index (read-vector healed it somewhere) puts them on top, like an add.
export function replaceElementInDoc(
    doc: Y.Doc,
    id: string,
    partials: NewVectorElement[],
    style: StyleDefaults,
): string[] {
    const elementsMap = doc.getMap('elements');
    const target = elementsMap.get(id);
    if (!(target instanceof Y.Map)) return [];
    const ids: string[] = [];
    doc.transact(() => {
        const index = target.get('index');
        const below =
            typeof index === 'string' && isValidFractionalIndex(index, undefined, undefined)
                ? index
                : topmostIndex(elementsMap);
        const keys = generateNKeysBetween(
            below,
            below === null ? null : indexAbove(elementsMap, below),
            partials.length,
        );
        elementsMap.delete(id);
        for (const [i, partial] of partials.entries()) ids.push(writeElementInDoc(doc, partial, keys[i], style));
    });
    return ids;
}

// A stored fractional index, or '' when the entry has none — the duplicate pass only needs the relative
// order, and zOrderKeys repairs a malformed one.
function indexOf(element: Y.Map<unknown>): string {
    const index = element.get('index');
    return typeof index === 'string' ? index : '';
}

// A z-order move over the STORED keys of `ids` (the canvas' scope: one frame's elements in frame mode), in
// ONE transact. The scene's keys are healed in memory only, so a move computed from them would skip the
// repair of a stored tie, and the next read would heal the tie around the moved element and undo the move.
export function reorderElementsInDoc(doc: Y.Doc, ids: string[], selectedIds: string[], op: ZOp): void {
    const elementsMap = doc.getMap('elements');
    const stored = ids.flatMap((id) => {
        const element = elementsMap.get(id);
        return element instanceof Y.Map ? [{ id, index: indexOf(element) }] : [];
    });
    doc.transact(() => {
        for (const { id, index } of zOrderKeys(stored, selectedIds, op)) {
            const element = elementsMap.get(id);
            if (element instanceof Y.Map) element.set('index', index);
        }
    });
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
            for (const [field, v] of storedElementFields(src)) clone.set(field, v);
            clone.set('id', id);
            clone.set('seed', randomSeed());
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
