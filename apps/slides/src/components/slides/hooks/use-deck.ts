import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import { yMapToObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { normalizeDeck } from '../normalize-deck';
import { type ApplyTo, DEFAULT_TEXT_OBJECT, type DeckData, type SlideObject } from '../types';

// commentCardIds may still be a legacy Y.Array (yMapToObject tolerates it on read) — normalize
// before rewriting so an anchor write can't silently drop the existing ids.
function readCommentCardIds(objMap: Y.Map<unknown>): string[] {
    const raw = objMap.get('commentCardIds');
    if (raw && typeof (raw as Y.Array<string>).toArray === 'function') return (raw as Y.Array<string>).toArray();
    return Array.isArray(raw) ? [...raw] : [];
}

export const useDeck = (ownerId: string, mountId: string, pathId: string) => {
    const [deck, setDeck] = useState<DeckData>({ slides: {}, objects: {}, slideOrder: [] });
    const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
    const [isSynced, setIsSynced] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManager = useRef<Y.UndoManager | null>(null);

    const initializeDefaultDeck = useCallback((doc: Y.Doc) => {
        const slidesMap = doc.getMap('slides');
        if (slidesMap.size > 0) return;

        doc.transact(() => {
            const objectsMap = doc.getMap('objects');
            const slideOrderArray = doc.getArray('slideOrder');

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

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const slidesMap = doc.getMap('slides');
        const objectsMap = doc.getMap('objects');
        const slideOrderArray = doc.getArray('slideOrder');

        undoManager.current = new Y.UndoManager([slidesMap, objectsMap, slideOrderArray]);

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        const updateReactState = () => {
            normalizeDeck(doc);
            const newState: DeckData = {
                slides: {},
                objects: {},
                slideOrder: slideOrderArray.toArray() as string[],
            };
            for (const [slideId, slideMapValue] of slidesMap) {
                const slideMap = slideMapValue as Y.Map<unknown>;
                const objIdsArray = slideMap.get('objectIds') as Y.Array<string>;
                const objIds = objIdsArray ? (objIdsArray.toArray() as string[]) : [];
                const bgRaw = slideMap.get('background');
                newState.slides[slideId] = {
                    id: slideId,
                    objectIds: objIds,
                    background: bgRaw && typeof bgRaw === 'object' ? (bgRaw as BackgroundFill) : null,
                };
            }
            for (const [objId, objMapValue] of objectsMap) {
                const objMap = objMapValue as Y.Map<unknown>;
                newState.objects[objId] = yMapToObject(objMap);
            }
            setDeck(newState);
        };

        slidesMap.observeDeep(updateReactState);
        objectsMap.observeDeep(updateReactState);
        slideOrderArray.observe(updateReactState);
        updateReactState();

        wsProvider.on('sync', (synced: boolean) => {
            setIsSynced(synced);
            if (synced && slidesMap.size === 0) {
                initializeDefaultDeck(doc);
            }
        });

        return () => {
            setIsSynced(false);
            // Unregister observers and tear down the UndoManager + provider; the effect re-runs on
            // pathId change without an unmount, so without this the old ones leak (and fire on
            // torn-down state). provider.destroy() before doc.destroy() — it detaches its own doc listener.
            slidesMap.unobserveDeep(updateReactState);
            objectsMap.unobserveDeep(updateReactState);
            slideOrderArray.unobserve(updateReactState);
            undoManager.current?.destroy();
            undoManager.current = null;
            wsProvider.destroy();
            doc.destroy();
        };
    }, [ownerId, mountId, pathId, initializeDefaultDeck]);

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
            const slidesMap = doc.getMap('slides');
            const slideOrderArray = doc.getArray('slideOrder');
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
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const objectsMap = doc.getMap('objects');
                const slideOrderArray = doc.getArray('slideOrder');

                const slideMap = slidesMap.get(slideId) as Y.Map<unknown> | undefined;
                if (slideMap) {
                    const objIds = ((slideMap.get('objectIds') as Y.Array<string>)?.toArray() as string[]) || [];
                    for (const objId of objIds) objectsMap.delete(objId);
                }

                const order = slideOrderArray.toArray() as string[];
                const idx = order.indexOf(slideId);
                if (idx !== -1) slideOrderArray.delete(idx, 1);
                slidesMap.delete(slideId);
            });
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
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const objectsMap = doc.getMap('objects');
                const slideOrderArray = doc.getArray('slideOrder');

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

                const order = slideOrderArray.toArray() as string[];
                const idx = order.indexOf(slideId);
                slideOrderArray.insert(idx + 1, [newSlideId]);
            });
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
                const slidesMap = doc.getMap('slides');
                for (const id of targetIds) {
                    const slideMap = slidesMap.get(id) as Y.Map<unknown> | undefined;
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
            doc.transact(() => {
                const objectsMap = doc.getMap('objects');
                const slidesMap = doc.getMap('slides');
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
                    const slideMap = slidesMap.get(src.slideId) as Y.Map<unknown> | undefined;
                    if (slideMap) {
                        const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                        if (objIdsArr) objIdsArr.push([newObjId]);
                    }
                    newIds.push(newObjId);
                }
            });
            return newIds;
        },
        [deck],
    );

    const addObject = useCallback((slideId: string, obj: Omit<SlideObject, 'id' | 'slideId'>) => {
        const doc = docRef.current;
        if (!doc) return;
        const objId = `obj-${nanoid(6)}`;
        doc.transact(() => {
            const objectsMap = doc.getMap('objects');
            const slidesMap = doc.getMap('slides');
            const objYMap = new Y.Map();
            objYMap.set('id', objId);
            objYMap.set('slideId', slideId);
            for (const [k, v] of Object.entries(obj)) {
                objYMap.set(k, v);
            }
            objectsMap.set(objId, objYMap);

            const slideMap = slidesMap.get(slideId) as Y.Map<unknown> | undefined;
            if (slideMap) {
                const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                if (objIdsArr) objIdsArr.push([objId]);
            }
        });
        return objId;
    }, []);

    const updateObject = useCallback((objId: string, updates: Partial<SlideObject>) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = doc.getMap('objects');
            const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
            if (!objMap) return;
            for (const [k, v] of Object.entries(updates)) {
                if (k === 'id' || k === 'slideId') continue;
                objMap.set(k, v);
            }
        });
    }, []);

    const moveObjectUp = useCallback(
        (objId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            const obj = deck.objects[objId];
            if (!obj) return;
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const slideMap = slidesMap.get(obj.slideId) as Y.Map<unknown> | undefined;
                if (!slideMap) return;
                const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                if (!objIdsArr) return;
                const arr = objIdsArr.toArray() as string[];
                const idx = arr.indexOf(objId);
                if (idx === -1 || idx === arr.length - 1) return;
                objIdsArr.delete(idx, 1);
                objIdsArr.insert(idx + 1, [objId]);
            });
        },
        [deck.objects],
    );

    const moveObjectDown = useCallback(
        (objId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            const obj = deck.objects[objId];
            if (!obj) return;
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const slideMap = slidesMap.get(obj.slideId) as Y.Map<unknown> | undefined;
                if (!slideMap) return;
                const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                if (!objIdsArr) return;
                const arr = objIdsArr.toArray() as string[];
                const idx = arr.indexOf(objId);
                if (idx <= 0) return;
                objIdsArr.delete(idx, 1);
                objIdsArr.insert(idx - 1, [objId]);
            });
        },
        [deck.objects],
    );

    const moveObjectToFront = useCallback(
        (objId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            const obj = deck.objects[objId];
            if (!obj) return;
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const slideMap = slidesMap.get(obj.slideId) as Y.Map<unknown> | undefined;
                if (!slideMap) return;
                const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                if (!objIdsArr) return;
                const arr = objIdsArr.toArray() as string[];
                const idx = arr.indexOf(objId);
                if (idx === -1 || idx === arr.length - 1) return;
                objIdsArr.delete(idx, 1);
                objIdsArr.push([objId]);
            });
        },
        [deck.objects],
    );

    const moveObjectToBack = useCallback(
        (objId: string) => {
            const doc = docRef.current;
            if (!doc) return;
            const obj = deck.objects[objId];
            if (!obj) return;
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                const slideMap = slidesMap.get(obj.slideId) as Y.Map<unknown> | undefined;
                if (!slideMap) return;
                const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                if (!objIdsArr) return;
                const arr = objIdsArr.toArray() as string[];
                const idx = arr.indexOf(objId);
                if (idx <= 0) return;
                objIdsArr.delete(idx, 1);
                objIdsArr.insert(0, [objId]);
            });
        },
        [deck.objects],
    );

    const updateObjects = useCallback((objIds: string[], updates: Partial<SlideObject>) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const objectsMap = doc.getMap('objects');
            for (const objId of objIds) {
                const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
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
        doc.transact(() => {
            const objectsMap = doc.getMap('objects');
            const slidesMap = doc.getMap('slides');
            for (const objId of objIds) {
                const obj = objectsMap.get(objId) as Y.Map<unknown> | undefined;
                if (obj) {
                    const slideId = obj.get('slideId') as string;
                    const slideMap = slidesMap.get(slideId) as Y.Map<unknown> | undefined;
                    if (slideMap) {
                        const objIdsArr = slideMap.get('objectIds') as Y.Array<string>;
                        if (objIdsArr) {
                            const arr = objIdsArr.toArray() as string[];
                            const idx = arr.indexOf(objId);
                            if (idx !== -1) objIdsArr.delete(idx, 1);
                        }
                    }
                }
                objectsMap.delete(objId);
            }
        });
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
            const objectsMap = doc.getMap('objects');
            const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
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
            const objectsMap = doc.getMap('objects');
            const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
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
        yjsDoc: docRef.current,
        undoManager: undoManager.current,
    };
};
