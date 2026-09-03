import { useCollabDoc } from '@workspace/lib/collab';
import {
    arrowsBoundTo,
    baseDefaultsFor,
    DEFAULT_SCENE_META,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    followBindings,
    generateKeyBetween,
    generateNKeysBetween,
    isVectorElementType,
    readVectorFromDoc,
    VECTOR_STYLE_DEFAULTS,
    type VectorArrowElement,
    type VectorElementType,
    type VectorFrame,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorMeta,
    type VectorRichTextElement,
    type VectorScene,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { useCallback, useState } from 'react';
import * as Y from 'yjs';
import { duplicateElementsInDoc, hasSeed, newElementId, topmostIndex } from './element-writes';
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

// Per-type defaults: the geometry box, the shared base props, and the kind's own fields straight from
// the registry — a new kind needs no entry here.
function elementDefaults(type: VectorElementType): Record<string, unknown> {
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
        ...ELEMENT_KINDS[type].defaults(VECTOR_STYLE_DEFAULTS),
    };
}

// After a patch, re-run followBindings and write the geometry into the same transact for every
// arrow bound to a patched SHAPE — and for every patched BOUND ARROW, so a nudge/align/rotate of a bound
// arrow alone re-glues its endpoints to the stationary shape instead of leaving them detached until the
// shape's next move teleports them (bound endpoints stay glued, Excalidraw's model; only a drag past the
// unbind threshold detaches). A shape+arrow moved rigidly no-ops via followBindings' null return.
function followBoundArrows(doc: Y.Doc, elementsMap: Y.Map<unknown>, patchedIds: Set<string>): void {
    let touched = false;
    for (const id of patchedIds) {
        const m = elementsMap.get(id);
        const t = m instanceof Y.Map ? m.get('type') : undefined;
        if (isVectorElementType(t) && ELEMENT_KINDS[t].capabilities.bindable) touched = true;
        else if (t === 'arrow' && m instanceof Y.Map && (m.get('startBinding') || m.get('endBinding'))) touched = true;
        if (touched) break;
    }
    if (!touched) return;

    // An arrow-free scene skips the full doc read a shape patch would otherwise pay on every gesture.
    let hasArrow = false;
    for (const value of elementsMap.values()) {
        if (value instanceof Y.Map && value.get('type') === 'arrow') {
            hasArrow = true;
            break;
        }
    }
    if (!hasArrow) return;

    const elements = readVectorFromDoc(doc).elements;
    const bound = arrowsBoundTo(elements);
    const byId = new Map(elements.map((el) => [el.id, el]));
    const arrowIds = new Set<string>();
    for (const id of patchedIds) {
        for (const aid of bound.get(id) ?? []) arrowIds.add(aid);
        // A dangling binding reads as '' here, so only live-bound patched arrows re-follow.
        const el = byId.get(id);
        if (el?.type === 'arrow' && (el.startBinding !== '' || el.endBinding !== '')) arrowIds.add(id);
    }
    if (arrowIds.size === 0) return;
    for (const aid of arrowIds) {
        const arrow = byId.get(aid);
        if (arrow?.type !== 'arrow') continue;
        const next = followBindings(arrow, byId);
        const arrowMap = elementsMap.get(aid);
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

export const useCanvasDoc = (ownerId: string, mountId: string, pathId: string) => {
    const [scene, setScene] = useState<VectorScene>({ elements: [], frames: [], meta: DEFAULT_SCENE_META });

    // Shared lifecycle: doc/provider/UndoManager creation + teardown. The UndoManager tracks the two
    // element roots with default trackedOrigins, so UNTRACKED_ORIGIN writes escape capture (below).
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

    const addElement = useCallback((partial: NewVectorElement) => {
        const doc = docRef.current;
        if (!doc) return;
        const id = newElementId();
        // Honor a caller-supplied seed so a drag-create preview and its committed element share
        // the same roughjs jitter (no visual pop on release); otherwise generate one. undefined on a
        // seedless kind drops the key (the write loop skips undefined).
        const seed = hasSeed(partial.type) ? (partial.seed ?? Math.floor(Math.random() * 2 ** 31)) : undefined;
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

    // Batch add — the whole set in ONE transact (paste's element ADDS: one gesture = one
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
                const id = newElementId();
                const seed = hasSeed(partial.type) ? (partial.seed ?? Math.floor(Math.random() * 2 ** 31)) : undefined;
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
                        if ((ELEMENT_FIELDS as readonly string[]).includes(k)) elMap.set(k, v);
                    }
                    patchedIds.add(id);
                }
                // Arrows follow their bound shapes in the SAME transact (one undo step, one broadcast), so
                // every caller — nudge, drag-commit, align, paste-move — gets it for free.
                followBoundArrows(doc, elementsMap, patchedIds);
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
    // add/duplicate return the new frame id so the caller can activate it.
    const addFrame = useCallback(
        (afterId?: string) => (docRef.current ? addFrameInDoc(docRef.current, afterId) : undefined),
        [],
    );

    const deleteFrame = useCallback((id: string) => {
        if (docRef.current) deleteFrameInDoc(docRef.current, id);
    }, []);

    const duplicateFrame = useCallback(
        (id: string) => (docRef.current ? duplicateFrameInDoc(docRef.current, id) : undefined),
        [],
    );

    // `afterId` null moves the frame to the front.
    const moveFrame = useCallback((id: string, afterId: string | null) => {
        if (docRef.current) moveFrameInDoc(docRef.current, id, afterId);
    }, []);

    const updateFrames = useCallback((patches: { id: string; fields: Partial<VectorFrame> }[]) => {
        if (docRef.current) updateFramesInDoc(docRef.current, patches);
    }, []);

    const updateFrame = useCallback(
        (id: string, fields: Partial<VectorFrame>) => updateFrames([{ id, fields }]),
        [updateFrames],
    );

    // The scene's own settings (background, grid). One sealed write, like every discrete panel op.
    const updateMeta = useCallback((fields: Partial<VectorMeta>) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const metaMap = doc.getMap('meta');
            for (const [key, value] of Object.entries(fields)) {
                if (value !== undefined) metaMap.set(key, value);
            }
        });
    }, []);

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
