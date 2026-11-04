// A canvas document as React sees it: the scene read from the Y.Doc, and every write the editor makes to it. A host
// such as the Vector or Slides editor calls useCanvasDoc once and hands the result to the canvas whole. Each writer is
// one transaction, so one gesture is one undo step and one broadcast. The untracked writers fix up the document under
// an origin the UndoManager ignores, so the user never undoes a fixup as a step of its own.

import { useCollabDoc } from '@workspace/lib/collab';
import type {
    NewVectorElement,
    StyleDefaults,
    VectorArrowElement,
    VectorElement,
    VectorElementPatch,
    VectorFrame,
    VectorMeta,
    VectorScene,
    ZOp,
} from '@workspace/lib/vector';
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
    topmostIndex,
    writeElementInDoc,
} from '@workspace/lib/vector';
import { sealed } from '@workspace/ui/components/properties-panel';
import { useCallback, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
    deleteCommentCardInDoc,
    duplicateElementsInDoc,
    reorderElementsInDoc,
    replaceElementInDoc,
} from './element-writes';
import {
    addFrameInDoc,
    deleteFrameInDoc,
    duplicateFrameInDoc,
    moveFrameInDoc,
    updateFramesInDoc,
    updateMetaInDoc,
} from './frame-writes';

// The origin of a write the UndoManager must ignore. It tracks only the null origin, because useCollabDoc gives it no
// tracked origins, so a write under any other origin is never captured. The provider still sends it to peers. An
// example is the swap of a pasted image's pending name for its real one: the paste stays one undo step, and ⌘Z takes
// back the insert, not the swap.
const UNTRACKED_ORIGIN = Symbol('vector-untracked-write');

export const useCanvasDoc = (ownerId: string, mountId: string, pathId: string, defaults: StyleDefaults) => {
    const [scene, setScene] = useState<VectorScene>({ elements: [], frames: [], meta: DEFAULT_SCENE_META });
    // The host's style table, read when an element is added, so the add callbacks never change.
    const defaultsRef = useRef(defaults);
    defaultsRef.current = defaults;

    // useCollabDoc makes and tears down the doc, the provider and the UndoManager. The UndoManager tracks the three
    // scene roots, the elements, frames and meta, so a write under UNTRACKED_ORIGIN escapes it.
    const {
        docRef,
        doc: yjsDoc,
        provider,
        undoManager,
        synced,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
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
            // readVectorFromDoc is the whole read path. It reads each element's map through the ELEMENT_FIELDS
            // whitelist, orders the elements by fractional index and heals a broken run of keys.
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

    // Adds the whole set in one transaction, so a paste is one undo step. The keys run on above the current top, so
    // the caller's order becomes the pasted stack's order. Returns the new ids in that order, so a paste can select
    // them.
    const addElements = useCallback((partials: readonly NewVectorElement[]): string[] => {
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

    // Patches the whole set in one transaction, so a group move or a nudge is one undo step and one broadcast. An id
    // that is gone writes nothing, because a peer may delete an element during a gesture. The null origin is tracked,
    // so the write can be undone.
    const updateElements = useCallback(
        (patches: readonly { id: string; fields: VectorElementPatch }[], origin: unknown = null) => {
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
                // Arrows follow their bound shapes in the same transaction, so every caller, such as a nudge or an
                // align, moves them in the same undo step and broadcast.
                followBoundArrows(elementsMap, patchedIds);
            }, origin);
        },
        [],
    );

    const updateElement = useCallback(
        (id: string, fields: VectorElementPatch) => updateElements([{ id, fields }]),
        [updateElements],
    );

    // A fixup the user never undoes as a step of their own, such as an arrow label's measured width. Peers still get it.
    const updateElementsUntracked = useCallback(
        (patches: readonly { id: string; fields: VectorElementPatch }[]) => updateElements(patches, UNTRACKED_ORIGIN),
        [updateElements],
    );

    const updateElementUntracked = useCallback(
        (id: string, fields: VectorElementPatch) => updateElementsUntracked([{ id, fields }]),
        [updateElementsUntracked],
    );

    const deleteElements = useCallback((ids: readonly string[], origin: unknown = null) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            for (const id of ids) elementsMap.delete(id);
        }, origin);
    }, []);

    // Removes a placeholder that will never become real, such as an image whose upload failed. ⌘Z must not bring it
    // back as a step of its own, and peers still get the delete.
    const deleteElementsUntracked = useCallback(
        (ids: readonly string[]) => deleteElements(ids, UNTRACKED_ORIGIN),
        [deleteElements],
    );

    const duplicateElements = useCallback(
        (ids: string[], dx: number, dy: number): string[] =>
            docRef.current ? duplicateElementsInDoc(docRef.current, ids, dx, dy) : [],
        [],
    );

    const replaceElement = useCallback(
        (id: string, partials: NewVectorElement[]): string[] =>
            docRef.current ? replaceElementInDoc(docRef.current, id, partials, defaultsRef.current) : [],
        [],
    );

    const reorderElements = useCallback((ids: string[], selectedIds: string[], op: ZOp) => {
        if (docRef.current) reorderElementsInDoc(docRef.current, ids, selectedIds, op);
    }, []);

    const deleteCommentCard = useCallback((cardId: string) => {
        if (docRef.current) deleteCommentCardInDoc(docRef.current, cardId, UNTRACKED_ORIGIN);
    }, []);

    // The frame writes. Each is a discrete op, so each is sealed: adding a page and then renaming it are two undo
    // steps. Adding and duplicating return the new frame's id, so the caller can show it.
    const addFrame = useCallback(
        (afterId: string | null) => {
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
            if (doc) sealed(undoManager, () => updateMetaInDoc(doc, fields));
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
        updateElementsUntracked,
        deleteElements,
        deleteElementsUntracked,
        duplicateElements,
        replaceElement,
        reorderElements,
        deleteCommentCard,
        addFrame,
        deleteFrame,
        duplicateFrame,
        moveFrame,
        updateFrame,
        updateFrames,
        updateMeta,
        undoManager,
        // For awareness: the cursors and the remote selections.
        provider,
        // The live Y.Doc, for the comments, which live in its `comments` map. It is null until the effect runs, and the
        // editor reads comments only once `synced` is true, like the rest of the panel.
        yjsDoc,
        synced,
        offline,
        // True from the first load on. The editor shows its loading screen on this, not on `synced`, so a dropped
        // connection never unmounts the canvas and its selection and previews survive.
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
    };
};

// Everything a canvas host owns of its document: the scene, every writer and the collab state. The editor takes it
// whole rather than as a prop per writer.
export type CanvasDoc = ReturnType<typeof useCanvasDoc>;

// After a patch, runs followBindings again for every arrow bound to a patched shape, and for every patched arrow that
// is bound, and writes their geometry in the same transaction. So a nudge, align or rotate of a bound arrow alone glues
// its ends back to the shape that stayed put. Without it they would hang loose until the shape's next move jumped them
// back. Bound ends stay glued, as in Excalidraw, and only a drag past the unbind threshold detaches one. A shape and its
// arrow moved together write nothing, because followBindings returns null for them.
function followBoundArrows(elementsMap: Y.Map<unknown>, patchedIds: ReadonlySet<string>): void {
    const touched = [...patchedIds].some((id) => {
        const m = elementsMap.get(id);
        if (!(m instanceof Y.Map)) return false;
        const type = m.get('type');
        if (isVectorElementType(type) && ELEMENT_KINDS[type].capabilities.bindable) return true;
        return type === 'arrow' && Boolean(m.get('startBinding') || m.get('endBinding'));
    });
    if (!touched) return;

    // Only the arrows are read, not the scene. This runs inside every gesture's transaction, and the reverse index
    // needs nothing but each arrow's two bindings. A scene without arrows stops here.
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

    // The other half of what followBindings reads: the shapes those arrows dock on, and only those, because it looks
    // up nothing but the arrow's own two bindings. A binding whose shape is gone reads as an unbound end.
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
        // The pinned segments move with the arrow's new origin, so they keep their place in the scene while the bound
        // end follows the shape. An arrow without pins stores ''.
        arrowMap.set('fixedSegments', next.fixedSegments);
    }
}
