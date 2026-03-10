import {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {getCollabWebSocketUrl} from '@workspace/lib/api';
import type {WorkbookInstance} from '@fortune-sheet/react';

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

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;
        readyForOpsRef.current = false;

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
                    (delta.insert as any[][]).forEach((ops) => {
                        try {
                            workbookRef.current!.applyOp(ops);
                        } catch (e) {
                            console.error('Failed to apply remote op:', e);
                        }
                    });
                }
            });
        });

        wsProvider.on('sync', (isSynced: boolean) => {
            if (isSynced) {
                const snapshot = stateMap.get('snapshot') as string | undefined;
                let data: SheetData[];
                if (snapshot) {
                    try {
                        data = JSON.parse(snapshot);
                    } catch {
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
            }
        });

        return () => {
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
            const opsArray = doc.getArray('ops');
            opsArray.push([ops]);
        });
    }, []);

    const saveSnapshot = useCallback((data: SheetData[]) => {
        if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = setTimeout(() => {
            const doc = docRef.current;
            if (!doc) return;
            doc.transact(() => {
                const stateMap = doc.getMap('state');
                stateMap.set('snapshot', JSON.stringify(data));
            });
        }, 2000);
    }, []);

    const handleRestore = useCallback((state: Uint8Array) => {
        const doc = docRef.current;
        if (!doc) return;
        Y.applyUpdate(doc, state);
        const stateMap = doc.getMap('state');
        const snapshot = stateMap.get('snapshot') as string | undefined;
        if (snapshot) {
            try {
                const data = JSON.parse(snapshot) as SheetData[];
                setInitialData(data);
                if (workbookRef.current) {
                    workbookRef.current.updateSheet(data);
                }
            } catch {
                // ignore
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
