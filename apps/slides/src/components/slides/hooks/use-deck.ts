import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import { getIdArray, getIdArrayRoot, getItemMapRoot, useCollabDoc } from '@workspace/lib/collab';
import { yMapToObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { ZOp } from '@workspace/ui/components/properties-panel';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { normalizeDeck } from '../normalize-deck';
import { type ApplyTo, DEFAULT_TEXT_OBJECT, type DeckData, type SlideObject } from '../types';

// Copy — the stored array is aliased into React state, so mutate a copy and re-set.
function readCommentCardIds(objMap: Y.Map<unknown>): string[] {
    const raw = objMap.get('commentCardIds');
    return Array.isArray(raw) ? [...raw] : [];
}

export const useDeck = (ownerId: string, mountId: string, pathId: string) => {
    const [deck, setDeck] = useState<DeckData>({ slides: {}, objects: {}, slideOrder: [] });
    const [activeSlideId, setActiveSlideId] = useState<string | null>(null);

    const initializeDefaultDeck = useCallback((doc: Y.Doc) => {
        const slidesMap = getItemMapRoot(doc, 'slides');
        if (slidesMap.size > 0) return;

        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');

            const slideId = `slide-${nanoid(6)}`;
            const objId = `obj-${nanoid(6)}`;

            const objYMap = new Y.Map();
            objYMap.set('id', objId);
            objYMap.set('slideId', slideId);
            for (const [k, v] of Object.entries(DEFAULT_TEXT_OBJECT)) {
                objYMap.set(k, v);
            }
            objYMap.set('text', 'Welcome to Slides');
            objYMap.set('fontSize', 64);
            objYMap.set('color', '#ffffff');
            objYMap.set('y', 378);
            objYMap.set('height', 324);
            objectsMap.set(objId, objYMap);

            const slideYMap = new Y.Map();
            slideYMap.set('id', slideId);
            slideYMap.set('background', { type: 'solid', color: DEFAULT_FILL_COLOR } satisfies BackgroundFill);
            const objectIds = new Y.Array();
            objectIds.push([objId]);
            slideYMap.set('objectIds', objectIds);
            slidesMap.set(slideId, slideYMap);

            slideOrderArray.push([slideId]);
        });
    }, []);

    const {
        docRef,
        provider,
        undoManager,
        doc: yjsDoc,
        synced: isSynced,
        connected,
        loaded,
    } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        undoScope: (doc) => [doc.getMap('slides'), doc.getMap('objects'), doc.getArray('slideOrder')],
        onInit: ({ doc, provider, undoManager }) => {
            const slidesMap = getItemMapRoot(doc, 'slides');
            const objectsMap = getItemMapRoot(doc, 'objects');
            const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');

            // Normalize only on REMOTE merges — concurrent edits are what dupe/orphan a ref; local
            // edits are well-formed by construction, so a local tick just reads (U6d cadence fix; this
            // ran on every observer tick before). The initial read (no transaction) skips it too — the
            // doc is empty until sync, and onSync normalizes the loaded content.
            const updateReactState = (_events?: unknown, tr?: Y.Transaction) => {
                // Undo/redo re-applies historical state that may predate a repair, so it is exactly
                // as suspect as a remote merge (⌘Z after an orphan-rehome can resurrect a dupe).
                if (tr?.origin === provider || tr?.origin === undoManager) normalizeDeck(doc);
                const newState: DeckData = {
                    slides: {},
                    objects: {},
                    slideOrder: slideOrderArray.toArray(),
                };
                for (const [slideId, slideMap] of slidesMap) {
                    const objIds = getIdArray(slideMap, 'objectIds')?.toArray() ?? [];
                    const bgRaw = slideMap.get('background');
                    newState.slides[slideId] = {
                        id: slideId,
                        objectIds: objIds,
                        background: bgRaw && typeof bgRaw === 'object' ? (bgRaw as BackgroundFill) : null,
                    };
                }
                for (const [objId, objMap] of objectsMap) {
                    newState.objects[objId] = yMapToObject(objMap);
                }
                setDeck(newState);
            };

            slidesMap.observeDeep(updateReactState);
            objectsMap.observeDeep(updateReactState);
            slideOrderArray.observe(updateReactState);
            updateReactState();

            return () => {
                slidesMap.unobserveDeep(updateReactState);
                objectsMap.unobserveDeep(updateReactState);
                slideOrderArray.unobserve(updateReactState);
            };
        },
        onSync: ({ doc }, synced) => {
            if (!synced) return;
            // Once-on-sync: repair the freshly loaded content before the empty-check + seeding.
            normalizeDeck(doc);
            if (doc.getMap('slides').size === 0) {
                initializeDefaultDeck(doc);
            }
        },
    });

    // Seal discrete ops (delete/duplicate/arrange/z-order) as their own undo step — a stopCapturing()
    // bracket around each transact stops Y.UndoManager from merging it into the previous step within
    // its 500ms captureTimeout (vector's discipline, adopted in U6e). Held in a ref so the `[]`-deps
    // op callbacks read the live manager without re-creating. Nudges/text typing stay UNSEALED so they
    // coalesce.
    const undoManagerRef = useRef(undoManager);
    undoManagerRef.current = undoManager;

    useEffect(() => {
        if (deck.slideOrder.length > 0) {
            if (!activeSlideId || !deck.slideOrder.includes(activeSlideId)) {
                setActiveSlideId(deck.slideOrder[0]);
            }
        } else {
            setActiveSlideId(null);
        }
    }, [activeSlideId, deck.slideOrder]);

    const addSlide = useCallback((background: BackgroundFill | null = { type: 'solid', color: '#ffffff' }) => {
        const doc = docRef.current;
        if (!doc) return;
        const slideId = `slide-${nanoid(6)}`;
        doc.transact(() => {
            const slidesMap = getItemMapRoot(doc, 'slides');
            const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');
            const slideYMap = new Y.Map();
            slideYMap.set('id', slideId);
            slideYMap.set('background', background);
            slideYMap.set('objectIds', new Y.Array());
            slidesMap.set(slideId, slideYMap);
            slideOrderArray.push([slideId]);
        });
        setActiveSlideId(slideId);
    }, []);

    const deleteSlide = useCallback(
        (slideId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            undoManagerRef.current?.stopCapturing();
            doc.transact(() => {
                const slidesMap = getItemMapRoot(doc, 'slides');
                const objectsMap = getItemMapRoot(doc, 'objects');
                const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');

                const slideMap = slidesMap.get(slideId);
                if (slideMap) {
                    const objIds = getIdArray(slideMap, 'objectIds')?.toArray() ?? [];
                    for (const objId of objIds) objectsMap.delete(objId);
                }

                const order = slideOrderArray.toArray();
                const idx = order.indexOf(slideId);
                if (idx !== -1) slideOrderArray.delete(idx, 1);
                slidesMap.delete(slideId);
            });
            undoManagerRef.current?.stopCapturing();
            if (activeSlideId === slideId) {
                const remaining = deck.slideOrder.filter((id) => id !== slideId);
                setActiveSlideId(remaining[0] || null);
            }
        },
        [activeSlideId, deck.slideOrder],
    );

    const duplicateSlide = useCallback(
        (slideId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            const slide = deck.slides[slideId];
            if (!slide) return;

            const newSlideId = `slide-${nanoid(6)}`;
            undoManagerRef.current?.stopCapturing();
            doc.transact(() => {
                const slidesMap = getItemMapRoot(doc, 'slides');
                const objectsMap = getItemMapRoot(doc, 'objects');
                const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');

                const newObjIds: string[] = [];
                for (const objId of slide.objectIds) {
                    const srcObj = deck.objects[objId];
                    if (!srcObj) continue;
                    const newObjId = `obj-${nanoid(6)}`;
                    const objYMap = new Y.Map();
                    for (const [k, v] of Object.entries(srcObj)) {
                        if (k === 'id') objYMap.set('id', newObjId);
                        else if (k === 'slideId') objYMap.set('slideId', newSlideId);
                        else if (k === 'commentCardIds') continue;
                        else objYMap.set(k, v);
                    }
                    objectsMap.set(newObjId, objYMap);
                    newObjIds.push(newObjId);
                }

                const slideYMap = new Y.Map();
                slideYMap.set('id', newSlideId);
                slideYMap.set('background', slide.background ? structuredClone(slide.background) : null);
                const objIdsArr = new Y.Array();
                objIdsArr.push(newObjIds);
                slideYMap.set('objectIds', objIdsArr);
                slidesMap.set(newSlideId, slideYMap);

                const order = slideOrderArray.toArray();
                const idx = order.indexOf(slideId);
                slideOrderArray.insert(idx + 1, [newSlideId]);
            });
            undoManagerRef.current?.stopCapturing();
            setActiveSlideId(newSlideId);
        },
        [deck],
    );

    const getTargetSlideIds = useCallback(
        (slideId: string, applyTo: ApplyTo): string[] => {
            if (applyTo === 'this') return [slideId];
            const order = deck.slideOrder;
            if (applyTo === 'all') return [...order];
            const idx = order.indexOf(slideId);
            if (idx === -1) return [slideId];
            return order.slice(idx);
        },
        [deck.slideOrder],
    );

    const updateSlideBackground = useCallback(
        (slideId: string, background: BackgroundFill | null, applyTo: ApplyTo = 'this') => {
            const doc = docRef.current;
            if (!doc) return;
            const targetIds = getTargetSlideIds(slideId, applyTo);
            doc.transact(() => {
                const slidesMap = getItemMapRoot(doc, 'slides');
                for (const id of targetIds) {
                    const slideMap = slidesMap.get(id);
                    if (slideMap) slideMap.set('background', background);
                }
            });
        },
        [getTargetSlideIds],
    );

    const duplicateObjects = useCallback(
        (placements: { id: string; x: number; y: number }[]): string[] => {
            const doc = docRef.current;
            if (!doc) return [];
            const newIds: string[] = [];
            undoManagerRef.current?.stopCapturing();
            doc.transact(() => {
                const objectsMap = getItemMapRoot(doc, 'objects');
                const slidesMap = getItemMapRoot(doc, 'slides');
                for (const placement of placements) {
                    const src = deck.objects[placement.id];
                    if (!src) continue;
                    const newObjId = `obj-${nanoid(6)}`;
                    const objYMap = new Y.Map();
                    for (const [k, v] of Object.entries(src)) {
                        if (k === 'id') objYMap.set('id', newObjId);
                        else if (k === 'commentCardIds') continue;
                        else if (k === 'x') objYMap.set('x', placement.x);
                        else if (k === 'y') objYMap.set('y', placement.y);
                        else objYMap.set(k, v);
                    }
                    objectsMap.set(newObjId, objYMap);
                    const slideMap = slidesMap.get(src.slideId);
                    if (slideMap) getIdArray(slideMap, 'objectIds')?.push([newObjId]);
                    newIds.push(newObjId);
                }
            });
            undoManagerRef.current?.stopCapturing();
            return newIds;
        },
        [deck],
    );

    const addObject = useCallback((slideId: string, obj: Omit<SlideObject, 'id' | 'slideId'>) => {
        const doc = docRef.current;
        if (!doc) return;
        const objId = `obj-${nanoid(6)}`;
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const slidesMap = getItemMapRoot(doc, 'slides');
            const objYMap = new Y.Map();
            objYMap.set('id', objId);
            objYMap.set('slideId', slideId);
            for (const [k, v] of Object.entries(obj)) {
                objYMap.set(k, v);
            }
            objectsMap.set(objId, objYMap);

            const slideMap = slidesMap.get(slideId);
            if (slideMap) getIdArray(slideMap, 'objectIds')?.push([objId]);
        });
        return objId;
    }, []);

    const updateObject = useCallback((objId: string, updates: Partial<SlideObject>) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const objMap = objectsMap.get(objId);
            if (!objMap) return;
            for (const [k, v] of Object.entries(updates)) {
                if (k === 'id' || k === 'slideId') continue;
                objMap.set(k, v);
            }
        });
    }, []);

    // Z-order over the objectIds Y.Array (later in the array = painted on top): `forward`/`toFront`
    // move an id toward the end, `backward`/`toBack` toward the start. Every id in a multi-selection
    // is spliced inside ONE transact (one undo step) — `forward`/`toBack` iterate the block top-down,
    // `backward`/`toFront` bottom-up, indices recomputed live per id so single-step splices preserve
    // the block's relative stacking without leapfrogging within it. A non-contiguous selection moves each
    // id one step relative to its neighbours (no block-collapse — that's vector's fractional-index
    // model, not this Y.Array one).
    const moveObjectsZOrder = useCallback(
        (op: ZOp, objIds: string[]) => {
            const doc = docRef.current;
            if (!doc || objIds.length === 0) return;
            const first = deck.objects[objIds[0]];
            if (!first) return;
            undoManagerRef.current?.stopCapturing();
            doc.transact(() => {
                const slidesMap = getItemMapRoot(doc, 'slides');
                const slideMap = slidesMap.get(first.slideId);
                if (!slideMap) return;
                const objIdsArr = getIdArray(slideMap, 'objectIds');
                if (!objIdsArr) return;
                const currentOrder = objIdsArr.toArray();
                const inSel = objIds.filter((id) => currentOrder.includes(id));
                inSel.sort((a, b) => currentOrder.indexOf(a) - currentOrder.indexOf(b));
                const ordered = op === 'forward' || op === 'toBack' ? [...inSel].reverse() : inSel;
                // Step ops never swap past a selected neighbour: a block at the array edge would
                // otherwise oscillate its outer pair on repeated presses (and select-all would
                // rotate the whole stack). Mid-stack the neighbour is already-moved and unselected.
                const selSet = new Set(inSel);
                for (const id of ordered) {
                    const arr = objIdsArr.toArray();
                    const idx = arr.indexOf(id);
                    if (idx === -1) continue;
                    if (op === 'toFront') {
                        if (idx === arr.length - 1) continue;
                        objIdsArr.delete(idx, 1);
                        objIdsArr.push([id]);
                    } else if (op === 'toBack') {
                        if (idx === 0) continue;
                        objIdsArr.delete(idx, 1);
                        objIdsArr.insert(0, [id]);
                    } else if (op === 'forward') {
                        if (idx === arr.length - 1 || selSet.has(arr[idx + 1])) continue;
                        objIdsArr.delete(idx, 1);
                        objIdsArr.insert(idx + 1, [id]);
                    } else {
                        if (idx === 0 || selSet.has(arr[idx - 1])) continue;
                        objIdsArr.delete(idx, 1);
                        objIdsArr.insert(idx - 1, [id]);
                    }
                }
            });
            undoManagerRef.current?.stopCapturing();
        },
        [deck.objects],
    );

    // Single-object context-menu wiring delegates to the batched reorder (one id = one splice).
    const moveObjectUp = useCallback((objId: string) => moveObjectsZOrder('forward', [objId]), [moveObjectsZOrder]);
    const moveObjectDown = useCallback((objId: string) => moveObjectsZOrder('backward', [objId]), [moveObjectsZOrder]);
    const moveObjectToFront = useCallback(
        (objId: string) => moveObjectsZOrder('toFront', [objId]),
        [moveObjectsZOrder],
    );
    const moveObjectToBack = useCallback((objId: string) => moveObjectsZOrder('toBack', [objId]), [moveObjectsZOrder]);

    const updateObjects = useCallback((objIds: string[], updates: Partial<SlideObject>) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            for (const objId of objIds) {
                const objMap = objectsMap.get(objId);
                if (!objMap) continue;
                for (const [k, v] of Object.entries(updates)) {
                    if (k === 'id' || k === 'slideId') continue;
                    objMap.set(k, v);
                }
            }
        });
    }, []);

    const deleteObjects = useCallback((objIds: string[]) => {
        const doc = docRef.current;
        if (!doc) return;
        undoManagerRef.current?.stopCapturing();
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const slidesMap = getItemMapRoot(doc, 'slides');
            for (const objId of objIds) {
                const obj = objectsMap.get(objId);
                if (obj) {
                    const slideId = obj.get('slideId') as string;
                    const slideMap = slidesMap.get(slideId);
                    const objIdsArr = slideMap && getIdArray(slideMap, 'objectIds');
                    if (objIdsArr) {
                        const idx = objIdsArr.toArray().indexOf(objId);
                        if (idx !== -1) objIdsArr.delete(idx, 1);
                    }
                }
                objectsMap.delete(objId);
            }
        });
        undoManagerRef.current?.stopCapturing();
    }, []);

    const deleteObject = useCallback(
        (objId: string) => {
            deleteObjects([objId]);
        },
        [deleteObjects],
    );

    const addCommentToObject = useCallback((objId: string, cardId: string) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const objMap = objectsMap.get(objId);
            if (!objMap) return;
            const arr = readCommentCardIds(objMap);
            if (!arr.includes(cardId)) {
                arr.push(cardId);
                objMap.set('commentCardIds', arr);
            }
        }, 'comment');
    }, []);

    const removeCommentFromObject = useCallback((objId: string, cardId: string) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = getItemMapRoot(doc, 'objects');
            const objMap = objectsMap.get(objId);
            if (!objMap) return;
            objMap.set(
                'commentCardIds',
                readCommentCardIds(objMap).filter((c) => c !== cardId),
            );
        }, 'comment');
    }, []);

    return {
        deck,
        isSynced,
        connected,
        loaded,
        activeSlideId,
        setActiveSlideId,
        addSlide,
        deleteSlide,
        duplicateSlide,
        updateSlideBackground,
        addObject,
        duplicateObjects,
        updateObject,
        updateObjects,
        deleteObject,
        deleteObjects,
        addCommentToObject,
        removeCommentFromObject,
        moveObjectUp,
        moveObjectDown,
        moveObjectToFront,
        moveObjectToBack,
        moveObjectsZOrder,
        yjsDoc,
        undoManager,
        provider,
    };
};
