import type { Op, Sheet, WorkbookInstance } from '@workspace/fortune-sheet';
import { replaySheetsOps } from '@workspace/fortune-sheet/engine';
import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { restoreYjsDoc } from '@workspace/lib/collab';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

const DEFAULT_SHEETS: Sheet[] = [
    {
        name: 'Sheet1',
        id: 'sheet-1',
        order: 0,
        celldata: [],
        config: {},
    },
];

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
) {
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [synced, setSynced] = useState(false);
    const [snapshotVersion, setSnapshotVersion] = useState(0);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const isLocalOpRef = useRef(false);
    const isLocalSnapshotRef = useRef(false);
    const readyForOpsRef = useRef(false);
    const latestDataRef = useRef<Sheet[] | null>(null);

    const flushSnapshot = useCallback(() => {
        const doc = docRef.current;
        const data = latestDataRef.current;
        if (!doc || !data) return;
        let json: string;
        try {
            json = JSON.stringify(data);
        } catch {
            return;
        }
        isLocalSnapshotRef.current = true;
        doc.transact(() => {
            doc.getMap('state').set('snapshot', json);
            const opsArray = doc.getArray('ops');
            if (opsArray.length > 0) {
                opsArray.delete(0, opsArray.length);
            }
        });
    }, []);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;
        readyForOpsRef.current = false;
        latestDataRef.current = null;

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

        stateMap.observe(() => {
            if (!readyForOpsRef.current) return;
            if (isLocalSnapshotRef.current) {
                isLocalSnapshotRef.current = false;
                return;
            }
            const snapshot = stateMap.get('snapshot') as string | undefined;
            if (!snapshot) return;
            try {
                const data = JSON.parse(snapshot) as Sheet[];
                latestDataRef.current = data;
                setInitialData(data);
                setSnapshotVersion((v) => v + 1);
            } catch (e) {
                console.error('[sheet] Failed to apply remote snapshot:', e);
            }
        });

        wsProvider.on('sync', (isSynced: boolean) => {
            if (!isSynced) return;
            const snapshot = stateMap.get('snapshot') as string | undefined;
            let initial: Sheet[] = DEFAULT_SHEETS;
            if (snapshot) {
                try {
                    initial = JSON.parse(snapshot) as Sheet[];
                } catch (e) {
                    console.warn('[sheet] Failed to parse initial snapshot, falling back to defaults:', e);
                }
            }
            const pending = opsArray.toArray() as Op[][];
            const data = pending.length > 0 ? replaySheetsOps(initial, pending) : initial;
            latestDataRef.current = data;
            setInitialData(data);
            setSynced(true);
            readyForOpsRef.current = true;
        });

        const handleBeforeUnload = () => flushSnapshot();
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            flushSnapshot();
            readyForOpsRef.current = false;
            wsProvider.disconnect();
            doc.destroy();
            docRef.current = null;
            providerRef.current = null;
        };
    }, [ownerId, mountId, pathId, workbookRef, flushSnapshot]);

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

    const onDataChange = useCallback((data: Sheet[]) => {
        latestDataRef.current = data;
    }, []);

    const handleRestore = useCallback((state: Uint8Array) => {
        const doc = docRef.current;
        if (!doc) return;

        isLocalSnapshotRef.current = true;
        restoreYjsDoc(doc, state, (v) => v);

        const stateMap = doc.getMap('state');
        const snapshot = stateMap.get('snapshot') as string | undefined;
        if (snapshot) {
            try {
                const data = JSON.parse(snapshot) as Sheet[];
                latestDataRef.current = data;
                setInitialData(data);
                setSnapshotVersion((v) => v + 1);
            } catch (e) {
                console.error('[sheet] handleRestore: failed:', e);
            }
        }
    }, []);

    return {
        initialData,
        snapshotVersion,
        synced,
        handleOp,
        onDataChange,
        handleRestore,
    };
}
