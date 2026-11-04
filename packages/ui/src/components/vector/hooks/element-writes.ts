// The editor's multi-element passes over a vector Y.Doc, such as replace, duplicate, reorder and a comment
// card's delete, over the shared element writer. Plain functions over the doc, the way the tools modules
// are plain functions over the scene, so the hook stays the thin React surface.

import type { NewVectorElement, StyleDefaults, ZOp } from '@workspace/lib/vector';
import {
    generateNKeysBetween,
    isValidFractionalIndex,
    newElementId,
    parseIdList,
    randomSeed,
    remapBinding,
    serializeIdList,
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

// Replaces one element with new ones in one transaction, as Convert to shapes does. They take its place in the z
// order, in the given order, each with a fresh id and the caller's seed. An arrow bound to the element keeps its
// endpoints and loses the binding, as on a delete. An element whose stored index is malformed puts them on top, as an
// add does.
export function replaceElementInDoc(
    doc: Y.Doc,
    id: string,
    partials: readonly NewVectorElement[],
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

// A stored fractional index, or '' when the entry has none. The callers only need the relative order, and
// zOrderKeys repairs a malformed index.
function indexOf(element: Y.Map<unknown>): string {
    const index = element.get('index');
    return typeof index === 'string' ? index : '';
}

// A z-order move over the stored keys of `ids`, in one transaction. `ids` is the canvas' scope, such as one frame's
// elements in frame mode. The scene heals its keys in memory only. A move computed from them would skip the repair of
// a stored tie, and the next read would heal the tie around the moved element and undo the move.
export function reorderElementsInDoc(
    doc: Y.Doc,
    ids: readonly string[],
    selectedIds: readonly string[],
    op: ZOp,
): void {
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

// Clones elements, moved by (dx, dy), in one transaction. The clones go on top in the same relative z order, each with
// a fresh id and seed. It returns the new ids, so the caller can select the clones.
export function duplicateElementsInDoc(doc: Y.Doc, ids: readonly string[], dx: number, dy: number): string[] {
    const newIds: string[] = [];
    doc.transact(() => {
        const elementsMap = doc.getMap('elements');
        const sources = ids
            .map((id) => elementsMap.get(id))
            .filter((m): m is Y.Map<unknown> => m instanceof Y.Map)
            .sort((a, b) => compareIndex(indexOf(a), indexOf(b)));
        if (sources.length === 0) return;
        const keys = generateNKeysBetween(topmostIndex(elementsMap), null, sources.length);
        // Every clone id comes first, so the bindings can be remapped across the set. An arrow bound to a shape that
        // was duplicated too points at its clone. A binding to a shape outside the set clears.
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
            // A copy starts with no comments. The cards belong to the element that was commented on.
            clone.set('commentCardIds', '');
            if (src.get('type') === 'arrow') {
                const sb = src.get('startBinding');
                const eb = src.get('endBinding');
                clone.set('startBinding', remapBinding(typeof sb === 'string' ? sb : '', idMap));
                clone.set('endBinding', remapBinding(typeof eb === 'string' ? eb : '', idMap));
            }
            // The position comes from the source, because the clone is not in the doc yet.
            const x = src.get('x');
            const y = src.get('y');
            if (typeof x === 'number') clone.set('x', x + dx);
            if (typeof y === 'number') clone.set('y', y + dy);
            elementsMap.set(id, clone);
        }
    });
    return newIds;
}

// Deletes a comment card in one transaction under the caller's origin. The canvas passes an origin the UndoManager
// ignores. The card stays in the `comments` map, marked deleted, and its id leaves every element that holds it. The
// map is outside the undo scope, so an undo that put the ids back would show a card that was deleted.
export function deleteCommentCardInDoc(doc: Y.Doc, cardId: string, origin: unknown): void {
    doc.transact(() => {
        const card = doc.getMap('comments').get(cardId);
        if (card instanceof Y.Map) card.set('deletedAt', Date.now());
        for (const element of doc.getMap('elements').values()) {
            if (!(element instanceof Y.Map)) continue;
            const stored = element.get('commentCardIds');
            const ids = parseIdList(typeof stored === 'string' ? stored : '');
            if (ids.includes(cardId)) element.set('commentCardIds', serializeIdList(ids.filter((id) => id !== cardId)));
        }
    }, origin);
}
