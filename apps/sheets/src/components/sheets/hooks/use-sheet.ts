import {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {getCollabWebSocketUrl} from '@workspace/lib/api';
import type {Op, Sheet, WorkbookInstance} from '@workspace/fortune-sheet';

const DEFAULT_SHEETS: Sheet[] = [{
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
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [synced, setSynced] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const isLocalOpRef = useRef(false);
    const readyForOpsRef = useRef(false);
    const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSnapshotRef = useRef<string | null>(null);
    const hasFlushedRef = useRef(false);

    // First call flushes immediately; subsequent calls are debounced at 1s.
    // This ensures the initial state is persisted without delay while avoiding
    // excessive Yjs transactions during active editing.
    const flushSnapshot = useCallback(() => {
        const doc = docRef.current;
        const pending = pendingSnapshotRef.current;
        if (!doc || !pending) {
            return;
        }
        pendingSnapshotRef.current = null;
        if (snapshotTimerRef.current) {
            clearTimeout(snapshotTimerRef.current);
            snapshotTimerRef.current = null;
        }
        doc.transact(() => {
            doc.getMap('state').set('snapshot', pending);
            // Compact: the snapshot captures full state, so historical ops are no longer needed.
            // Remote clients joining after this point will get the snapshot instead of replaying ops.
            const opsArray = doc.getArray('ops');
            if (opsArray.length > 0) {
                opsArray.delete(0, opsArray.length);
            }
        });
        hasFlushedRef.current = true;
    }, []);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;
        readyForOpsRef.current = false;
        hasFlushedRef.current = false;

        const stateMap = doc.getMap('state');
        const opsArray = doc.getArray('ops');

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
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
                    (delta.insert as Op[][]).forEach((ops) => {
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

            let data: Sheet[];
            if (snapshot) {
                try {
                    data = JSON.parse(snapshot);
                } catch {
                    console.warn('[sheet] sync: failed to parse snapshot, using defaults');
                    data = DEFAULT_SHEETS;
                }
            } else {
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

    const handleOp = useCallback((ops: Op[]) => {
        const doc = docRef.current;
        if (!doc || ops.length === 0) return;
        isLocalOpRef.current = true;
        try {
            doc.transact(() => {
                doc.getArray('ops').push([ops]);
            });
        } catch (e) {
            isLocalOpRef.current = false;
            throw e;
        }
    }, []);

    const saveSnapshot = useCallback((data: Sheet[]) => {
        let json: string;
        try {
            json = JSON.stringify(data);
        } catch (e) {
            console.error('[sheet] saveSnapshot: JSON.stringify failed:', e);
            return;
        }
        pendingSnapshotRef.current = json;

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
                        // Yjs toJSON() returns Record<string, any>; no narrower type available
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        localType.set(k, v as any);
                    }
                } else if (localType instanceof Y.Array) {
                    const json = tempDoc.getArray(key).toJSON();
                    localType.delete(0, localType.length);
                    localType.push(json);
                }
            }
            // Clear ops array: the restored snapshot is the new source of truth.
            // Stale ops from before the restore must not be replayed by remote clients.
            const opsArray = doc.getArray('ops');
            if (opsArray.length > 0) {
                opsArray.delete(0, opsArray.length);
            }
        });
        tempDoc.destroy();

        const stateMap = doc.getMap('state');
        const snapshot = stateMap.get('snapshot') as string | undefined;
        if (snapshot) {
            try {
                const data = JSON.parse(snapshot) as Sheet[];
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
