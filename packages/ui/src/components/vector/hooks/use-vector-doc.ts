import { getCollabWebSocketUrl } from '@workspace/lib/api';
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

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

    // Batch update — the whole set in ONE transact, so a group move / nudge / z-order rewrite is a
    // single undo step and a single broadcast (CONTRACT §A: one gesture = one transact). Missing ids
    // no-op (a peer may have deleted one mid-gesture).
    const updateElements = useCallback((patches: { id: string; fields: VectorElementPatch }[]) => {
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
        });
    }, []);

    const updateElement = useCallback(
        (id: string, fields: VectorElementPatch) => updateElements([{ id, fields }]),
        [updateElements],
    );

    const deleteElements = useCallback((ids: string[]) => {
        const doc = docRef.current;
        if (!doc) return;
        doc.transact(() => {
            const elementsMap = doc.getMap('elements');
            for (const id of ids) elementsMap.delete(id);
        });
    }, []);

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
        updateElement,
        updateElements,
        deleteElements,
        duplicateElements,
        undoManager: undoManager.current,
        // Exposed for awareness (cursors + remote selections) — same ref-current shape as undoManager.
        provider: providerRef.current,
        // The live Y.Doc, for the document-level comment lifecycle (its `comments` Y.Map). Null until
        // the effect runs; the editor gates comment reads on `synced` like the rest of the panel.
        yjsDoc: docRef.current,
        synced: isSynced,
    };
};
