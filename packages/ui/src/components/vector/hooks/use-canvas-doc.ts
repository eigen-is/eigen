import { useCollabDoc } from '@workspace/lib/collab';
import {
    arrowsBoundTo,
    DEFAULT_SCENE_META,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    followBindings,
    generateNKeysBetween,
    isVectorElementType,
    parseBinding,
    readElementFromFields,
    readVectorFromDoc,
    type StyleDefaults,
    type VectorArrowElement,
    type VectorElement,
    type VectorElementType,
    type VectorFrame,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorMeta,
    type VectorRichTextElement,
    type VectorScene,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { useCallback, useRef, useState } from 'react';
import * as Y from 'yjs';
import { duplicateElementsInDoc, topmostIndex, writeElementInDoc } from './element-writes';
import {
    addFrameInDoc,
    deleteFrameInDoc,
    duplicateFrameInDoc,
    moveFrameInDoc,
    updateFramesInDoc,
} from './frame-writes';

// Origin sentinel for writes the UndoManager must IGNORE. Its trackedOrigins defaults to {null}
// (the ctor below passes none), so any non-null transaction origin escapes capture — while the sync
// provider still broadcasts it (y-websocket echoes every transaction whose origin isn't the provider
// itself). Used for the pending→real image swap after a cross-mount paste, so the paste is ONE undo
// step (⌘Z reverts the insert; peers converge via its inverse) instead of two.
const UNTRACKED_ORIGIN = Symbol('vector-untracked-write');

// One discrete op = one undo step. Y.UndoManager merges everything inside a 500ms capture window, so a
// discrete op seals on BOTH sides: nothing that happened just before it (a nudge) and nothing that
// follows joins its step. The canvas' element ops, the panel's writes and the frame ops all go through
// this — a gesture that deliberately coalesces (a nudge, a keystroke) simply doesn't call it.
export function sealed<T>(undoManager: Y.UndoManager | null, op: () => T): T {
    undoManager?.stopCapturing();
    const result = op();
    undoManager?.stopCapturing();
    return result;
}

// The continuous counterpart of `sealed`: one GESTURE = one undo step, however long it lasts. A
// slider drag writes live so the canvas updates under the pointer, and merely leaving those writes
// unsealed is not enough — Y.UndoManager only merges changes that land within `captureTimeout` of
// each other, so a slow drag, or a pause to look at the result, silently splits into several steps.
// Hold the window open for the gesture instead, and seal at both ends. Returns the release, which is
// idempotent: a gesture can end more than once (Radix commits AND the pointer-up fires, or an unmount
// cleanup follows a commit), and a second restore would write back the Infinity the first one left.
export function holdCapture(undoManager: Y.UndoManager | null): () => void {
    if (!undoManager) return () => {};
    const previous = undoManager.captureTimeout;
    // A hold is already open, so this one is a no-op: capturing Infinity as the timeout to restore would
    // make the inner release leave the window open forever, and sealing here would split the outer
    // gesture's step in two. The outer hold stays in charge.
    if (previous === Number.POSITIVE_INFINITY) return () => {};
    undoManager.stopCapturing();
    undoManager.captureTimeout = Number.POSITIVE_INFINITY;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        undoManager.captureTimeout = previous;
        undoManager.stopCapturing();
    };
}

// A partial patch over the write/read allow-list — every field optional, so a caller sets any
// subset of any element variant's fields (the union members share the geometry base). id/type
// are never patched; z-order changes rewrite `index`.
export type VectorElementPatch = Partial<Omit<VectorShapeElement, 'id' | 'type'>> &
    Partial<Omit<VectorRichTextElement, 'id' | 'type'>> &
    Partial<Omit<VectorImageElement, 'id' | 'type'>> &
    Partial<Omit<VectorLinearElement, 'id' | 'type'>> &
    Partial<Omit<VectorArrowElement, 'id' | 'type'>>;

// addElement input: the caller names a `type` and overrides whatever it likes; the hook fills
// the rest from lib defaults and generates id/seed/index.
export type NewVectorElement = { type: VectorElementType } & VectorElementPatch;

// After a patch, re-run followBindings and write the geometry into the same transact for every
// arrow bound to a patched SHAPE — and for every patched BOUND ARROW, so a nudge/align/rotate of a bound
// arrow alone re-glues its endpoints to the stationary shape instead of leaving them detached until the
// shape's next move teleports them (bound endpoints stay glued, Excalidraw's model; only a drag past the
// unbind threshold detaches). A shape+arrow moved rigidly no-ops via followBindings' null return.
function followBoundArrows(elementsMap: Y.Map<unknown>, patchedIds: Set<string>): void {
    let touched = false;
    for (const id of patchedIds) {
        const m = elementsMap.get(id);
        const t = m instanceof Y.Map ? m.get('type') : undefined;
        if (isVectorElementType(t) && ELEMENT_KINDS[t].capabilities.bindable) touched = true;
        else if (t === 'arrow' && m instanceof Y.Map && (m.get('startBinding') || m.get('endBinding'))) touched = true;
        if (touched) break;
    }
    if (!touched) return;

    // Only the arrows are materialized, not the scene: this runs inside every gesture's transact, and
    // the reverse index needs each arrow's two bindings and nothing else. An arrow-free scene stops here.
    const arrowById = new Map<string, VectorArrowElement>();
    for (const value of elementsMap.values()) {
        if (!(value instanceof Y.Map) || value.get('type') !== 'arrow') continue;
        const el = readElementFromFields(value);
        if (el?.type === 'arrow') arrowById.set(el.id, el);
    }
    if (arrowById.size === 0) return;

    const bound = arrowsBoundTo([...arrowById.values()]);
    const arrows = new Set<VectorArrowElement>();
    for (const id of patchedIds) {
        for (const aid of bound.get(id) ?? []) {
            const arrow = arrowById.get(aid);
            if (arrow) arrows.add(arrow);
        }
        const patched = arrowById.get(id);
        if (patched && (patched.startBinding !== '' || patched.endBinding !== '')) arrows.add(patched);
    }
    if (arrows.size === 0) return;

    // The other half of what followBindings reads: the shapes those arrows dock on, and only those —
    // it reaches the map through boundShape on the arrow's own two bindings. A binding whose target is
    // gone resolves to null there, which is what an unbound end already means.
    const byId = new Map<string, VectorElement>();
    for (const arrow of arrows) {
        for (const binding of [arrow.startBinding, arrow.endBinding]) {
            const target = parseBinding(binding);
            if (!target || byId.has(target.elementId)) continue;
            const el = readElementFromFields(elementsMap.get(target.elementId));
            if (el) byId.set(el.id, el);
        }
    }
    for (const arrow of arrows) {
        const next = followBindings(arrow, byId);
        const arrowMap = elementsMap.get(arrow.id);
        if (!next || !(arrowMap instanceof Y.Map)) continue;
        arrowMap.set('x', next.x);
        arrowMap.set('y', next.y);
        arrowMap.set('width', next.width);
        arrowMap.set('height', next.height);
        arrowMap.set('points', next.points);
        // Pinned segments co-shift with the re-normalized origin so they hold their scene position while
        // the bound endpoint follows the shape. '' for every non-pinned arrow.
        arrowMap.set('fixedSegments', next.fixedSegments);
    }
}

export const useCanvasDoc = (ownerId: string, mountId: string, pathId: string, defaults: StyleDefaults) => {
    const [scene, setScene] = useState<VectorScene>({ elements: [], frames: [], meta: DEFAULT_SCENE_META });
    // The host's style table, read at write time so the add callbacks stay dependency-free.
    const defaultsRef = useRef(defaults);
    defaultsRef.current = defaults;

    // Shared lifecycle: doc/provider/UndoManager creation + teardown. The UndoManager tracks the three
    // scene roots (elements, frames, meta) with default trackedOrigins, so UNTRACKED_ORIGIN writes
    // escape capture (below).
    const {
        docRef,
        doc: yjsDoc,
        provider,
        undoManager,
        synced,
        offline,
        loaded,
        storageUnavailable,
        unsyncedEdits,
    } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        undoScope: (doc) => [doc.getMap('elements'), doc.getMap('frames'), doc.getMap('meta')],
        onInit: ({ doc }) => {
            const elementsMap = doc.getMap('elements');
            const framesMap = doc.getMap('frames');
            const metaMap = doc.getMap('meta');
            // readVectorFromDoc materializes each per-element Y.Map through the ELEMENT_FIELDS
            // whitelist, orders by fractional index, and heals invalid runs — the whole read path.
            const updateReactState = () => setScene(readVectorFromDoc(doc));
            elementsMap.observeDeep(updateReactState);
            framesMap.observeDeep(updateReactState);
            metaMap.observeDeep(updateReactState);
            updateReactState();
            return () => {
                elementsMap.unobserveDeep(updateReactState);
                framesMap.unobserveDeep(updateReactState);
                metaMap.unobserveDeep(updateReactState);
            };
        },
    });

    // Batch add — the whole set in ONE transact (paste's element ADDS: one gesture = one
    // transact / one undo step). Consecutive fractional keys above the current top preserve the
    // callers' order as the pasted stack's relative z-order. Returns the new ids in input order so the
    // caller reselects the paste.
    const addElements = useCallback((partials: NewVectorElement[]): string[] => {
        const doc = docRef.current;
        if (!doc || partials.length === 0) return [];
        const ids: string[] = [];
        doc.transact(() => {
            const keys = generateNKeysBetween(topmostIndex(doc.getMap('elements')), null, partials.length);
            for (const [i, partial] of partials.entries()) {
                ids.push(writeElementInDoc(doc, partial, keys[i], defaultsRef.current));
            }
        });
        return ids;
    }, []);

    const addElement = useCallback(
        (partial: NewVectorElement): string | undefined => addElements([partial])[0],
        [addElements],
    );

    // Batch update — the whole set in ONE transact, so a group move / nudge / z-order rewrite is a
    // single undo step and a single broadcast — one gesture = one transact. Missing ids
    // no-op (a peer may have deleted one mid-gesture).
    // `origin` defaults to null (tracked/undoable). Pass UNTRACKED_ORIGIN for a technical fixup the
    // user never undoes as their own step (the cross-mount pending→real swap) — still broadcast.
    const updateElements = useCallback(
        (patches: { id: string; fields: VectorElementPatch }[], origin: unknown = null) => {
            const doc = docRef.current;
            if (!doc) return;
            doc.transact(() => {
                const elementsMap = doc.getMap('elements');
                const patchedIds = new Set<string>();
                for (const { id, fields } of patches) {
                    const elMap = elementsMap.get(id);
                    if (!(elMap instanceof Y.Map)) continue;
                    for (const [k, v] of Object.entries(fields)) {
                        if (k === 'id' || k === 'type' || v === undefined) continue;
                        if (ELEMENT_FIELDS.includes(k)) elMap.set(k, v);
                    }
                    patchedIds.add(id);
                }
                // Arrows follow their bound shapes in the SAME transact (one undo step, one broadcast), so
                // every caller — nudge, drag-commit, align, paste-move — gets it for free.
                followBoundArrows(elementsMap, patchedIds);
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

    const duplicateElements = useCallback(
        (ids: string[], dx: number, dy: number): string[] =>
            docRef.current ? duplicateElementsInDoc(docRef.current, ids, dx, dy) : [],
        [],
    );

    // Frame ops: thin wrappers over frame-writes.ts, the way the element ops wrap element-writes.ts.
    // Each is a discrete op, so each is `sealed` — adding a page then renaming it must be two undo
    // steps. add/duplicate return the new frame id so the caller can activate it.
    const addFrame = useCallback(
        (afterId?: string) => {
            const doc = docRef.current;
            return doc ? sealed(undoManager, () => addFrameInDoc(doc, afterId)) : undefined;
        },
        [undoManager],
    );

    const deleteFrame = useCallback(
        (id: string) => {
            const doc = docRef.current;
            if (doc) sealed(undoManager, () => deleteFrameInDoc(doc, id));
        },
        [undoManager],
    );

    const duplicateFrame = useCallback(
        (id: string) => {
            const doc = docRef.current;
            return doc ? sealed(undoManager, () => duplicateFrameInDoc(doc, id)) : undefined;
        },
        [undoManager],
    );

    // `afterId` null moves the frame to the front.
    const moveFrame = useCallback(
        (id: string, afterId: string | null) => {
            const doc = docRef.current;
            if (doc) sealed(undoManager, () => moveFrameInDoc(doc, id, afterId));
        },
        [undoManager],
    );

    const updateFrames = useCallback(
        (patches: { id: string; fields: Partial<VectorFrame> }[]) => {
            const doc = docRef.current;
            if (doc) sealed(undoManager, () => updateFramesInDoc(doc, patches));
        },
        [undoManager],
    );

    const updateFrame = useCallback(
        (id: string, fields: Partial<VectorFrame>) => updateFrames([{ id, fields }]),
        [updateFrames],
    );

    // The scene's own settings. Sealed like the frame ops: picking a background is a discrete op, and
    // unsealed it would merge into whatever the user did in the half second before it.
    const updateMeta = useCallback(
        (fields: Partial<VectorMeta>) => {
            const doc = docRef.current;
            if (!doc) return;
            sealed(undoManager, () =>
                doc.transact(() => {
                    const metaMap = doc.getMap('meta');
                    for (const [key, value] of Object.entries(fields)) {
                        if (value !== undefined) metaMap.set(key, value);
                    }
                }),
            );
        },
        [undoManager],
    );

    return {
        elements: scene.elements,
        frames: scene.frames,
        meta: scene.meta,
        addElement,
        addElements,
        updateElement,
        updateElementUntracked,
        updateElements,
        deleteElements,
        deleteElementsUntracked,
        duplicateElements,
        addFrame,
        deleteFrame,
        duplicateFrame,
        moveFrame,
        updateFrame,
        updateFrames,
        updateMeta,
        undoManager,
        // Exposed for awareness (cursors + remote selections).
        provider,
        // The live Y.Doc, for the document-level comment lifecycle (its `comments` Y.Map). Null until
        // the effect runs; the editor gates comment reads on `synced` like the rest of the panel.
        yjsDoc,
        synced,
        offline,
        // Latched first-load flag — the editor gates its loading screen on this, not `synced`, so a
        // WS blip never unmounts the canvas (transient selection/preview state survives).
        loaded,
        storageUnavailable,
        unsyncedEdits,
    };
};

// Everything a canvas host owns of its document: the scene, every writer, the collab lifecycle. The
// editor takes it whole rather than fifteen threaded props.
export type CanvasDoc = ReturnType<typeof useCanvasDoc>;
