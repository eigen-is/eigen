import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type { Op, Sheet, WorkbookInstance } from '@workspace/sheet';
import { createDefaultSheets, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// selections is a per-client cursor — the ops path already drops it (filterPatch)
// and the snapshot encoder never writes it. Reads still strip, to heal legacy
// snapshots that already carry one (which showed phantom stats-bar values for an
// invisible selection on open).
function stripSelections(sheets: Sheet[]): Sheet[] {
    return sheets.map(({ selections: _selections, ...sheet }) => sheet);
}

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
) {
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [synced, setSynced] = useState(false);
    const [snapshotVersion, setSnapshotVersion] = useState(0);
    // Exposed so presence (use-presence) can attach a Yjs awareness listener to the
    // same provider without re-owning its lifecycle.
    const [provider, setProvider] = useState<WebsocketProvider | null>(null);

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
            // computed: true — the client recomputes dependents inside the op-emitting produce.
            json = encodeSheetsSnapshot(data, { computed: true });
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
        setProvider(wsProvider);

        const handleOps = (event: Y.YArrayEvent<unknown>) => {
            if (!readyForOpsRef.current) return;
            if (isLocalOpRef.current) {
                isLocalOpRef.current = false;
                return;
            }
            const workbook = workbookRef.current;
            if (!workbook) return;
            for (const delta of event.changes.delta) {
                if (delta.insert && Array.isArray(delta.insert)) {
                    for (const ops of delta.insert as Op[][]) {
                        try {
                            workbook.applyOp(ops);
                        } catch (e) {
                            console.error('[sheet] Failed to apply remote op:', e);
                        }
                    }
                }
            }
        };
        opsArray.observe(handleOps);

        const handleState = () => {
            if (!readyForOpsRef.current) return;
            if (isLocalSnapshotRef.current) {
                isLocalSnapshotRef.current = false;
                return;
            }
            const snapshot = stateMap.get('snapshot') as string | undefined;
            if (!snapshot) return;
            try {
                // Replay any pending ops on top of the remote snapshot. When browser
                // A flushes while B has unflushed local ops, B's edits survive Yjs
                // merge and must be reapplied here or they're lost on next render.
                const initial = stripSelections(decodeSheetsSnapshot(snapshot));
                const pending = opsArray.toArray() as Op[][];
                const data = pending.length > 0 ? replaySheetsOps(initial, pending) : initial;
                latestDataRef.current = data;
                setInitialData(data);
                setSnapshotVersion((v) => v + 1);
            } catch (e) {
                console.error('[sheet] Failed to apply remote snapshot:', e);
            }
        };
        stateMap.observe(handleState);

        wsProvider.on('sync', (isSynced: boolean) => {
            if (!isSynced) return;
            const snapshot = stateMap.get('snapshot') as string | undefined;
            let initial: Sheet[] = createDefaultSheets();
            if (snapshot) {
                try {
                    initial = stripSelections(decodeSheetsSnapshot(snapshot));
                } catch (e) {
                    console.warn('[sheet] Failed to parse initial snapshot, falling back to defaults:', e);
                }
            }
            const pending = opsArray.toArray() as Op[][];
            let data = initial;
            if (pending.length > 0) {
                // The doc must still open if the pending ops can't be replayed —
                // fall back to the snapshot (or defaults) rather than letting the
                // throw escape the Yjs sync handler and kill the app.
                try {
                    data = replaySheetsOps(initial, pending);
                } catch (e) {
                    console.error('[sheet] Failed to replay pending ops, opening without them:', e);
                }
            }
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
            // Unregister observers (held by reference) and destroy the provider so a WS message
            // racing teardown can't fire an observer against a destroyed doc on board switch.
            opsArray.unobserve(handleOps);
            stateMap.unobserve(handleState);
            wsProvider.destroy();
            doc.destroy();
            docRef.current = null;
            providerRef.current = null;
            setProvider(null);
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

    return {
        initialData,
        snapshotVersion,
        synced,
        handleOp,
        onDataChange,
        docRef,
        provider,
    };
}
