import { useCollabDoc } from '@workspace/lib/collab';
import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type { Op, Sheet, WorkbookInstance } from '@workspace/sheet';
import { createDefaultSheets, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useRef, useState } from 'react';
import type * as Y from 'yjs';

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
) {
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [snapshotVersion, setSnapshotVersion] = useState(0);
    // True while the workbook shows the defaults fallback: the consumer renders it
    // read-only and says so, instead of letting an hour of edits go nowhere.
    const [loadFailed, setLoadFailed] = useState(false);

    const isLocalOpRef = useRef(false);
    const isLocalSnapshotRef = useRef(false);
    const readyForOpsRef = useRef(false);
    // Set only by a decode (+ pending-op replay) that succeeded. A workbook that opened on
    // the createDefaultSheets fallback must never be flushed: that would write the blank
    // workbook over state.snapshot and clear the op log — the real document, gone.
    const loadedRef = useRef(false);
    const latestDataRef = useRef<Sheet[] | null>(null);

    // useCollabDoc owns the doc/provider lifecycle; sheets layers its op-log + snapshot protocol on
    // top via onInit/onSync. No UndoManager — the sheet engine's own op stack owns undo. The op-log
    // (readyForOps gating, echo suppression, flush-on-unmount, replay) is NOT collab-scaffold
    // duplication, so it stays here over the shared lifecycle.
    const { docRef, provider, synced } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        onInit: ({ doc }) => {
            readyForOpsRef.current = false;
            loadedRef.current = false;
            latestDataRef.current = null;

            const stateMap = doc.getMap('state');
            const opsArray = doc.getArray('ops');

            const flushSnapshot = () => {
                const data = latestDataRef.current;
                if (!loadedRef.current || !data) return;
                let json: string;
                try {
                    // computed: true — the client recomputes dependents inside the op-emitting produce.
                    json = encodeSheetsSnapshot(data, { computed: true });
                } catch {
                    return;
                }
                isLocalSnapshotRef.current = true;
                doc.transact(() => {
                    stateMap.set('snapshot', json);
                    if (opsArray.length > 0) {
                        opsArray.delete(0, opsArray.length);
                    }
                });
            };

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
                    const initial = decodeSheetsSnapshot(snapshot);
                    const pending = opsArray.toArray() as Op[][];
                    const data = pending.length > 0 ? replaySheetsOps(initial, pending) : initial;
                    loadedRef.current = true;
                    latestDataRef.current = data;
                    setLoadFailed(false);
                    setInitialData(data);
                    setSnapshotVersion((v) => v + 1);
                } catch (e) {
                    console.error('[sheet] Failed to apply remote snapshot:', e);
                }
            };
            stateMap.observe(handleState);

            const handleBeforeUnload = () => flushSnapshot();
            window.addEventListener('beforeunload', handleBeforeUnload);

            return () => {
                window.removeEventListener('beforeunload', handleBeforeUnload);
                flushSnapshot();
                readyForOpsRef.current = false;
                // Unregister observers (held by reference) before the shared hook destroys the
                // provider/doc, so a WS message racing teardown can't fire against a destroyed doc.
                opsArray.unobserve(handleOps);
                stateMap.unobserve(handleState);
            };
        },
        onSync: ({ doc }, isSynced) => {
            if (!isSynced) return;
            const stateMap = doc.getMap('state');
            const opsArray = doc.getArray('ops');
            const snapshot = stateMap.get('snapshot') as string | undefined;
            let initial: Sheet[] = createDefaultSheets();
            // Stays false on any fallback below: the editor still opens, but nothing it
            // shows may be persisted over the document it failed to load.
            let loaded = true;
            if (snapshot) {
                try {
                    initial = decodeSheetsSnapshot(snapshot);
                } catch (e) {
                    loaded = false;
                    console.error('[sheet] Failed to parse initial snapshot, opening defaults without persistence:', e);
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
                    loaded = false;
                    console.error('[sheet] Failed to replay pending ops, opening without them:', e);
                }
            }
            loadedRef.current = loaded;
            if (loaded) latestDataRef.current = data;
            setLoadFailed(!loaded);
            setInitialData(data);
            readyForOpsRef.current = true;
        },
    });

    const handleOp = useCallback(
        (ops: Op[]) => {
            const doc = docRef.current;
            // Same gate as flushSnapshot: ops built against the fallback workbook must not reach peers.
            if (!doc || !loadedRef.current || ops.length === 0) return;
            isLocalOpRef.current = true;
            try {
                doc.transact(() => {
                    doc.getArray('ops').push([ops]);
                });
            } catch (e) {
                isLocalOpRef.current = false;
                throw e;
            }
        },
        [docRef],
    );

    const onDataChange = useCallback((data: Sheet[]) => {
        latestDataRef.current = data;
    }, []);

    return {
        initialData,
        snapshotVersion,
        loadFailed,
        synced,
        handleOp,
        onDataChange,
        docRef,
        provider,
    };
}
