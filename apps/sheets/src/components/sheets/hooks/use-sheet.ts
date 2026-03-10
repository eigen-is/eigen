import {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {getCollabWebSocketUrl} from '@workspace/lib/api';
import type {WorkbookInstance} from '@workspace/fortune-sheet';

export type SheetData = Record<string, any> & { name: string };

const DEFAULT_SHEETS: SheetData[] = [{
    name: 'Sheet1',
    id: 'sheet-1',
    order: 0,
    celldata: [],
    config: {},
}];

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
) {
    const [initialData, setInitialData] = useState<SheetData[] | null>(null);
    const [synced, setSynced] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const isLocalOpRef = useRef(false);
    const readyForOpsRef = useRef(false);
    const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSnapshotRef = useRef<string | null>(null);
    const hasFlushedRef = useRef(false);

    const flushSnapshot = useCallback(() => {
        const doc = docRef.current;
        const pending = pendingSnapshotRef.current;
        if (!doc || !pending) {
            console.log('[sheet] flushSnapshot: skip (doc=%s, pending=%s)', !!doc, !!pending);
            return;
        }
        pendingSnapshotRef.current = null;
        if (snapshotTimerRef.current) {
            clearTimeout(snapshotTimerRef.current);
            snapshotTimerRef.current = null;
        }
        console.log('[sheet] flushSnapshot: writing %d bytes to Y.Map', pending.length);
        doc.transact(() => {
            doc.getMap('state').set('snapshot', pending);
        });
        hasFlushedRef.current = true;
        console.log('[sheet] flushSnapshot: done');
    }, []);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;
        readyForOpsRef.current = false;
        hasFlushedRef.current = false;

        const stateMap = doc.getMap('state');
        const opsArray = doc.getArray('ops');

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        console.log('[sheet] connecting to', wsUrl);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        opsArray.observe((event) => {
            if (!readyForOpsRef.current) return;
            if (isLocalOpRef.current) {
                isLocalOpRef.current = false;
                return;
            }
            if (!workbookRef.current) return;
            event.changes.delta.forEach((delta) => {
                if (delta.insert && Array.isArray(delta.insert)) {
                    (delta.insert as any[][]).forEach((ops) => {
                        try {
                            workbookRef.current!.applyOp(ops);
                        } catch (e) {
                            console.error('[sheet] Failed to apply remote op:', e);
                        }
                    });
                }
            });
        });

        wsProvider.on('sync', (isSynced: boolean) => {
            if (!isSynced) return;
            const snapshot = stateMap.get('snapshot') as string | undefined;
            console.log('[sheet] sync: snapshot present=%s, length=%d', !!snapshot, snapshot?.length ?? 0);

            let data: SheetData[];
            if (snapshot) {
                try {
                    data = JSON.parse(snapshot);
                } catch {
                    console.warn('[sheet] sync: failed to parse snapshot, using defaults');
                    data = DEFAULT_SHEETS;
                }
            } else {
                console.log('[sheet] sync: no snapshot, initializing with defaults');
                data = DEFAULT_SHEETS;
                doc.transact(() => {
                    stateMap.set('snapshot', JSON.stringify(data));
                });
            }
            setInitialData(data);
            setSynced(true);
            readyForOpsRef.current = true;
        });

        const handleBeforeUnload = () => {
            const pending = pendingSnapshotRef.current;
            if (pending && docRef.current) {
                console.log('[sheet] beforeunload: flushing pending snapshot');
                docRef.current.transact(() => {
                    docRef.current!.getMap('state').set('snapshot', pending);
                });
                pendingSnapshotRef.current = null;
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            handleBeforeUnload();
            if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
            readyForOpsRef.current = false;
            wsProvider.disconnect();
            doc.destroy();
            docRef.current = null;
            providerRef.current = null;
        };
    }, [ownerId, mountId, pathId, workbookRef]);

    const handleOp = useCallback((ops: any[]) => {
        const doc = docRef.current;
        if (!doc || ops.length === 0) return;
        isLocalOpRef.current = true;
        doc.transact(() => {
            doc.getArray('ops').push([ops]);
        });
    }, []);

    const saveSnapshot = useCallback((data: SheetData[]) => {
        let json: string;
        try {
            json = JSON.stringify(data);
        } catch (e) {
            console.error('[sheet] saveSnapshot: JSON.stringify failed:', e);
            return;
        }
        pendingSnapshotRef.current = json;
        console.log('[sheet] saveSnapshot: queued %d bytes (%d sheets)', json.length, data.length);

        if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
        if (!hasFlushedRef.current) {
            flushSnapshot();
        } else {
            snapshotTimerRef.current = setTimeout(flushSnapshot, 1000);
        }
    }, [flushSnapshot]);

    const handleRestore = useCallback((state: Uint8Array) => {
        const doc = docRef.current;
        if (!doc) return;

        const tempDoc = new Y.Doc();
        Y.applyUpdate(tempDoc, state);

        const allKeys = new Set([...doc.share.keys(), ...tempDoc.share.keys()]);

        doc.transact(() => {
            for (const key of allKeys) {
                const localType = doc.get(key);
                if (localType instanceof Y.Map) {
                    const json = tempDoc.getMap(key).toJSON();
                    for (const k of [...localType.keys()]) localType.delete(k);
                    for (const [k, v] of Object.entries(json)) {
                        localType.set(k, v as any);
                    }
                } else if (localType instanceof Y.Array) {
                    const json = tempDoc.getArray(key).toJSON();
                    localType.delete(0, localType.length);
                    localType.push(json);
                }
            }
        });
        tempDoc.destroy();

        const stateMap = doc.getMap('state');
        const snapshot = stateMap.get('snapshot') as string | undefined;
        console.log('[sheet] handleRestore: snapshot present=%s', !!snapshot);
        if (snapshot) {
            try {
                const data = JSON.parse(snapshot) as SheetData[];
                setInitialData(data);
                if (workbookRef.current) {
                    workbookRef.current.updateSheet(data);
                }
            } catch (e) {
                console.error('[sheet] handleRestore: failed:', e);
            }
        }
    }, [workbookRef]);

    return {
        initialData,
        synced,
        handleOp,
        saveSnapshot,
        handleRestore,
    };
}
