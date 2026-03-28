import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { normalizeDeck } from '../normalize-deck';
import { DEFAULT_TEXT_OBJECT, type DeckData, type SlideObject } from '../types';

type ApplyTo = 'this' | 'this-and-following' | 'all';

const OBJECT_FIELDS = [
    'id',
    'slideId',
    'type',
    'x',
    'y',
    'w',
    'h',
    'rotation',
    'borderColor',
    'borderWidth',
    'borderRadius',
    'text',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'textDecoration',
    'textAlign',
    'verticalAlign',
    'color',
    'letterSpacing',
    'lineHeight',
    'highlightColor',
    'backgroundColor',
    'mediaName',
    'objectFit',
] as const;

function yMapToObject(yMap: Y.Map<unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const field of OBJECT_FIELDS) {
        const val = yMap.get(field);
        if (val !== undefined) obj[field] = val;
    }
    return obj;
}

export const useDeck = (ownerId: string, mountId: string, pathId: string) => {
    const [deck, setDeck] = useState<DeckData>({ slides: {}, objects: {}, slideOrder: [] });
    const [activeSlideId, setActiveSlideId] = useState<string | null>(null);

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
            objYMap.set('h', 324);
            objectsMap.set(objId, objYMap);

            const slideYMap = new Y.Map();
            slideYMap.set('id', slideId);
            slideYMap.set('backgroundColor', '#e60076');
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
                newState.slides[slideId] = {
                    id: slideId,
                    objectIds: objIds,
                    backgroundColor: (slideMap.get('backgroundColor') as string) || '#ffffff',
                    backgroundMediaName: (slideMap.get('backgroundMediaName') as string) || '',
                };
            }
            for (const [objId, objMapValue] of objectsMap) {
                const objMap = objMapValue as Y.Map<unknown>;
                const obj = yMapToObject(objMap) as SlideObject;
                newState.objects[objId] = obj;
            }
            setDeck(newState);
        };

        slidesMap.observeDeep(updateReactState);
        objectsMap.observeDeep(updateReactState);
        slideOrderArray.observe(updateReactState);
        updateReactState();

        wsProvider.on('sync', (isSynced: boolean) => {
            if (isSynced && slidesMap.size === 0) {
                initializeDefaultDeck(doc);
            }
        });

        return () => {
            providerRef.current?.disconnect();
            docRef.current?.destroy();
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

    const addSlide = useCallback((backgroundColor = '#ffffff') => {
        const doc = docRef.current;
        if (!doc) return;
        const slideId = `slide-${nanoid(6)}`;
        doc.transact(() => {
            const slidesMap = doc.getMap('slides');
            const slideOrderArray = doc.getArray('slideOrder');
            const slideYMap = new Y.Map();
            slideYMap.set('id', slideId);
            slideYMap.set('backgroundColor', backgroundColor);
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
                        else objYMap.set(k, v);
                    }
                    objectsMap.set(newObjId, objYMap);
                    newObjIds.push(newObjId);
                }

                const slideYMap = new Y.Map();
                slideYMap.set('id', newSlideId);
                slideYMap.set('backgroundColor', slide.backgroundColor);
                slideYMap.set('backgroundMediaName', slide.backgroundMediaName || '');
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
        (slideId: string, color: string, applyTo: ApplyTo = 'this') => {
            const doc = docRef.current;
            if (!doc) return;
            const targetIds = getTargetSlideIds(slideId, applyTo);
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                for (const id of targetIds) {
                    const slideMap = slidesMap.get(id) as Y.Map<unknown> | undefined;
                    if (slideMap) slideMap.set('backgroundColor', color);
                }
            });
        },
        [getTargetSlideIds],
    );

    const updateSlideBackgroundImage = useCallback(
        (slideId: string, mediaName: string, applyTo: ApplyTo = 'this') => {
            const doc = docRef.current;
            if (!doc) return;
            const targetIds = getTargetSlideIds(slideId, applyTo);
            doc.transact(() => {
                const slidesMap = doc.getMap('slides');
                for (const id of targetIds) {
                    const slideMap = slidesMap.get(id) as Y.Map<unknown> | undefined;
                    if (!slideMap) continue;
                    slideMap.set('backgroundMediaName', mediaName);
                }
            });
        },
        [getTargetSlideIds],
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

    return {
        deck,
        activeSlideId,
        setActiveSlideId,
        addSlide,
        deleteSlide,
        duplicateSlide,
        updateSlideBackground,
        updateSlideBackgroundImage,
        addObject,
        updateObject,
        updateObjects,
        deleteObject,
        deleteObjects,
        moveObjectUp,
        moveObjectDown,
        moveObjectToFront,
        moveObjectToBack,
        yjsDoc: docRef.current,
        undoManager: undoManager.current,
    };
};
