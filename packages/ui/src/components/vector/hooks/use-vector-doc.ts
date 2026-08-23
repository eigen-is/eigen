import { getCollabWebSocketUrl } from '@workspace/lib/api';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SCENE_META,
    DEFAULT_SHAPE_ROUNDNESS,
    DEFAULT_TEXT_PROPS,
    ELEMENT_FIELDS,
    generateKeyBetween,
    readVectorFromDoc,
    type VectorElement,
    type VectorElementType,
    type VectorScene,
    type VectorShapeElement,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// A partial patch over the write/read allow-list — every field optional, so a caller sets any
// subset of any element variant's fields (the union members share the geometry base). id/type
// are never patched; z-order changes rewrite `index`.
export type VectorElementPatch = Partial<Omit<VectorShapeElement, 'id' | 'type'>> &
    Partial<Omit<VectorTextElement, 'id' | 'type'>> &
    Partial<Omit<VectorElement, 'id' | 'type'>>;

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

export const useVectorDoc = (ownerId: string, mountId: string, pathId: string) => {
    const [scene, setScene] = useState<VectorScene>({ elements: [], meta: DEFAULT_SCENE_META });
    const [isSynced, setIsSynced] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManager = useRef<Y.UndoManager | null>(null);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const elementsMap = doc.getMap('elements');
        const metaMap = doc.getMap('meta');

        undoManager.current = new Y.UndoManager([elementsMap, metaMap]);

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        // readVectorFromDoc materializes each per-element Y.Map through the ELEMENT_FIELDS
        // whitelist, orders by fractional index, and heals invalid runs — the whole read path.
        const updateReactState = () => setScene(readVectorFromDoc(doc));

        elementsMap.observeDeep(updateReactState);
        metaMap.observeDeep(updateReactState);
        updateReactState();

        wsProvider.on('sync', (synced: boolean) => setIsSynced(synced));

        return () => {
            setIsSynced(false);
            // Unregister observers and tear down the UndoManager + provider; the effect re-runs on
            // pathId change without an unmount, so without this the old ones leak (and fire on
            // torn-down state). provider.destroy() before doc.destroy() — it detaches its own doc listener.
            elementsMap.unobserveDeep(updateReactState);
            metaMap.unobserveDeep(updateReactState);
            undoManager.current?.destroy();
            undoManager.current = null;
            wsProvider.destroy();
            doc.destroy();
        };
    }, [ownerId, mountId, pathId]);

    const addElement = useCallback((partial: NewVectorElement) => {
        const doc = docRef.current;
        if (!doc) return;
        const id = `el-${nanoid(10)}`;
        const seed = Math.floor(Math.random() * 2 ** 31);
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
            // add, so successive seeds get a0, a1, a2… — reading React state would collide them).
            let topmost: string | null = null;
            for (const value of elementsMap.values()) {
                const idx = (value as Y.Map<unknown>).get('index');
                if (typeof idx === 'string' && idx && (topmost === null || idx > topmost)) topmost = idx;
            }
            record.index = generateKeyBetween(topmost, null);

            const elMap = new Y.Map();
            for (const field of ELEMENT_FIELDS) {
                const v = record[field];
                if (v !== undefined) elMap.set(field, v);
            }
            elementsMap.set(id, elMap);
        });
        return id;
    }, []);

    const updateElement = useCallback((id: string, fields: VectorElementPatch) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const elMap = doc.getMap('elements').get(id) as Y.Map<unknown> | undefined;
            if (!elMap) return;
            for (const [k, v] of Object.entries(fields)) {
                if (k === 'id') continue;
                if ((ELEMENT_FIELDS as readonly string[]).includes(k)) elMap.set(k, v);
            }
        });
    }, []);

    const deleteElements = useCallback((ids: string[]) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            for (const id of ids) elementsMap.delete(id);
        });
    }, []);

    return {
        elements: scene.elements,
        meta: scene.meta,
        addElement,
        updateElement,
        deleteElements,
        undoManager: undoManager.current,
        synced: isSynced,
        loading: !isSynced,
    };
};
