import { useCollabDoc } from '@workspace/lib/collab';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SCENE_META,
    DEFAULT_SHAPE_ROUNDNESS,
    DEFAULT_TEXT_PROPS,
    ELEMENT_FIELDS,
    generateKeyBetween,
    generateNKeysBetween,
    isValidFractionalIndex,
    readVectorFromDoc,
    type VectorElementType,
    type VectorImageElement,
    type VectorScene,
    type VectorShapeElement,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { nanoid } from 'nanoid';
import { useCallback, useState } from 'react';
import * as Y from 'yjs';

// Origin sentinel for writes the UndoManager must IGNORE. Its trackedOrigins defaults to {null}
// (the ctor below passes none), so any non-null transaction origin escapes capture — while the sync
// provider still broadcasts it (y-websocket echoes every transaction whose origin isn't the provider
// itself). Used for the pending→real image swap after a cross-mount paste, so the paste is ONE undo
// step (⌘Z reverts the insert; peers converge via its inverse) instead of two.
const UNTRACKED_ORIGIN = Symbol('vector-untracked-write');

// A partial patch over the write/read allow-list — every field optional, so a caller sets any
// subset of any element variant's fields (the union members share the geometry base). id/type
// are never patched; z-order changes rewrite `index`.
export type VectorElementPatch = Partial<Omit<VectorShapeElement, 'id' | 'type'>> &
    Partial<Omit<VectorTextElement, 'id' | 'type'>> &
    Partial<Omit<VectorImageElement, 'id' | 'type'>>;

// addElement input: the caller names a `type` and overrides whatever it likes; the hook fills
// the rest from lib defaults and generates id/seed/index.
export type NewVectorElement = { type: VectorElementType } & VectorElementPatch;

// Per-type default record, keyed only by ELEMENT_FIELDS members (the allow-list is authoritative).
function elementDefaults(type: VectorElementType): Record<string, unknown> {
    const base = { x: 0, y: 0, width: 0, height: 0, angle: 0, ...DEFAULT_ELEMENT_PROPS };
    if (type === 'text') return { ...base, ...DEFAULT_TEXT_PROPS };
    if (type === 'image') return { ...base, mediaName: '' };
    return { ...base, roundness: DEFAULT_SHAPE_ROUNDNESS };
}

// Live topmost fractional index in the map. Skips non-map entries and malformed index strings —
// a corrupt peer write must not make generateKeyBetween throw and brick adding elements
// (read-vector heals them on read).
function topmostIndex(elementsMap: Y.Map<unknown>): string | null {
    let topmost: string | null = null;
    for (const value of elementsMap.values()) {
        if (!(value instanceof Y.Map)) continue;
        const idx = value.get('index');
        if (typeof idx !== 'string' || !isValidFractionalIndex(idx, undefined, undefined)) continue;
        if (topmost === null || idx > topmost) topmost = idx;
    }
    return topmost;
}

export const useVectorDoc = (ownerId: string, mountId: string, pathId: string) => {
    const [scene, setScene] = useState<VectorScene>({ elements: [], meta: DEFAULT_SCENE_META });

    // Shared lifecycle: doc/provider/UndoManager creation + teardown. The UndoManager tracks the two
    // element roots with default trackedOrigins, so UNTRACKED_ORIGIN writes escape capture (below).
    const {
        docRef,
        doc: yjsDoc,
        provider,
        undoManager,
        synced,
    } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        undoScope: (doc) => [doc.getMap('elements'), doc.getMap('meta')],
        onInit: ({ doc }) => {
            const elementsMap = doc.getMap('elements');
            const metaMap = doc.getMap('meta');
            // readVectorFromDoc materializes each per-element Y.Map through the ELEMENT_FIELDS
            // whitelist, orders by fractional index, and heals invalid runs — the whole read path.
            const updateReactState = () => setScene(readVectorFromDoc(doc));
            elementsMap.observeDeep(updateReactState);
            metaMap.observeDeep(updateReactState);
            updateReactState();
            return () => {
                elementsMap.unobserveDeep(updateReactState);
                metaMap.unobserveDeep(updateReactState);
            };
        },
    });

    const addElement = useCallback((partial: NewVectorElement) => {
        const doc = docRef.current;
        if (!doc) return;
        const id = `el-${nanoid(10)}`;
        // Honor a caller-supplied seed so a drag-create preview and its committed element share
        // the same roughjs jitter (no visual pop on release); otherwise generate one.
        const seed = partial.seed ?? Math.floor(Math.random() * 2 ** 31);
        const record: Record<string, unknown> = {
            ...elementDefaults(partial.type),
            ...partial,
            id,
            type: partial.type,
            seed,
        };
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            // Place on top: read the live topmost index (each transact commits before the next
            // add, so successive adds get a0, a1, a2… — reading React state would collide them).
            record.index = generateKeyBetween(topmostIndex(elementsMap), null);

            const elMap = new Y.Map();
            for (const field of ELEMENT_FIELDS) {
                const v = record[field];
                if (v !== undefined) elMap.set(field, v);
            }
            elementsMap.set(id, elMap);
        });
        return id;
    }, []);

    // Batch add — the whole set in ONE transact (paste's element ADDS: CONTRACT §A one gesture = one
    // transact / one undo step). Consecutive fractional keys above the current top preserve the
    // callers' order as the pasted stack's relative z-order. Each element gets a fresh id + seed (or a
    // caller-supplied seed). Returns the new ids in input order so the caller reselects the paste.
    const addElements = useCallback((partials: NewVectorElement[]): string[] => {
        const doc = docRef.current;
        if (!doc || partials.length === 0) return [];
        const ids: string[] = [];
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            const keys = generateNKeysBetween(topmostIndex(elementsMap), null, partials.length);
            partials.forEach((partial, i) => {
                const id = `el-${nanoid(10)}`;
                const seed = partial.seed ?? Math.floor(Math.random() * 2 ** 31);
                const record: Record<string, unknown> = {
                    ...elementDefaults(partial.type),
                    ...partial,
                    id,
                    type: partial.type,
                    seed,
                    index: keys[i],
                };
                const elMap = new Y.Map();
                for (const field of ELEMENT_FIELDS) {
                    const v = record[field];
                    if (v !== undefined) elMap.set(field, v);
                }
                elementsMap.set(id, elMap);
                ids.push(id);
            });
        });
        return ids;
    }, []);

    // Batch update — the whole set in ONE transact, so a group move / nudge / z-order rewrite is a
    // single undo step and a single broadcast (CONTRACT §A: one gesture = one transact). Missing ids
    // no-op (a peer may have deleted one mid-gesture).
    // `origin` defaults to null (tracked/undoable). Pass UNTRACKED_ORIGIN for a technical fixup the
    // user never undoes as their own step (the cross-mount pending→real swap) — still broadcast.
    const updateElements = useCallback(
        (patches: { id: string; fields: VectorElementPatch }[], origin: unknown = null) => {
            const doc = docRef.current;
            if (!doc) return;
            doc.transact(() => {
                const elementsMap = doc.getMap('elements');
                for (const { id, fields } of patches) {
                    const elMap = elementsMap.get(id);
                    if (!(elMap instanceof Y.Map)) continue;
                    for (const [k, v] of Object.entries(fields)) {
                        if (k === 'id' || k === 'type' || v === undefined) continue;
                        if ((ELEMENT_FIELDS as readonly string[]).includes(k)) elMap.set(k, v);
                    }
                }
            }, origin);
        },
        [],
    );

    const updateElement = useCallback(
        (id: string, fields: VectorElementPatch) => updateElements([{ id, fields }]),
        [updateElements],
    );

    // Non-undoable single-element update (see UNTRACKED_ORIGIN): the paste's insert stays the sole
    // undo step, but peers still receive the write.
    const updateElementUntracked = useCallback(
        (id: string, fields: VectorElementPatch) => updateElements([{ id, fields }], UNTRACKED_ORIGIN),
        [updateElements],
    );

    const deleteElements = useCallback((ids: string[], origin: unknown = null) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            for (const id of ids) elementsMap.delete(id);
        }, origin);
    }, []);

    // Non-undoable delete (see UNTRACKED_ORIGIN): cleanup of a failed optimistic insert — ⌘Z must
    // not resurrect a broken pending element as its own step; peers still receive the delete.
    const deleteElementsUntracked = useCallback(
        (ids: string[]) => deleteElements(ids, UNTRACKED_ORIGIN),
        [deleteElements],
    );

    // Clone elements offset by (dx, dy) in ONE transact, stacked on top preserving their relative
    // z-order, each with a fresh id + seed. Returns the new ids so the caller reselects the clones.
    const duplicateElements = useCallback((ids: string[], dx: number, dy: number): string[] => {
        const doc = docRef.current;
        if (!doc) return [];
        const newIds: string[] = [];
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            const sources = ids
                .map((id) => elementsMap.get(id))
                .filter((m): m is Y.Map<unknown> => m instanceof Y.Map)
                .sort((a, b) => {
                    const ia = typeof a.get('index') === 'string' ? (a.get('index') as string) : '';
                    const ib = typeof b.get('index') === 'string' ? (b.get('index') as string) : '';
                    return ia < ib ? -1 : ia > ib ? 1 : 0;
                });
            if (sources.length === 0) return;
            const keys = generateNKeysBetween(topmostIndex(elementsMap), null, sources.length);
            sources.forEach((src, i) => {
                const id = `el-${nanoid(10)}`;
                const clone = new Y.Map();
                for (const field of ELEMENT_FIELDS) {
                    const v = src.get(field);
                    if (v !== undefined) clone.set(field, v);
                }
                clone.set('id', id);
                clone.set('seed', Math.floor(Math.random() * 2 ** 31));
                clone.set('index', keys[i]);
                // Read x/y from the source map — the clone is not integrated into the doc yet
                const x = src.get('x');
                const y = src.get('y');
                if (typeof x === 'number') clone.set('x', x + dx);
                if (typeof y === 'number') clone.set('y', y + dy);
                elementsMap.set(id, clone);
                newIds.push(id);
            });
        });
        return newIds;
    }, []);

    return {
        elements: scene.elements,
        meta: scene.meta,
        addElement,
        addElements,
        updateElement,
        updateElementUntracked,
        updateElements,
        deleteElements,
        deleteElementsUntracked,
        duplicateElements,
        undoManager,
        // Exposed for awareness (cursors + remote selections).
        provider,
        // The live Y.Doc, for the document-level comment lifecycle (its `comments` Y.Map). Null until
        // the effect runs; the editor gates comment reads on `synced` like the rest of the panel.
        yjsDoc,
        synced,
    };
};
