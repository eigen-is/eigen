// A workbook's collab protocol in the editor: the stored snapshot plus a log of op batches, both in one Yjs document.
// It decodes the snapshot with the log replayed on top for the Workbook, pushes the Workbook's own batches onto the
// log, and hands a peer's batches to the Workbook's applyOp, queueing them while a grid mounts. The server folds the log
// into the snapshot when the workbook closes. A tab keeps its grid through such a compaction of what it already holds,
// and remounts on any other new snapshot.

import { useCollabDoc } from '@workspace/lib/collab';
import type { Sheet } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsBase, readSheetsSnapshotJson } from '@workspace/lib/sheets';
import type { Op, WorkbookInstance } from '@workspace/sheet';
import { createDefaultSheets, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

// Applies a peer's batch to the grid and says whether it applied. A throw escaping the Yjs observer would kill the app,
// so a batch that fails is logged.
function applyBatch(workbook: WorkbookInstance | null, ops: Op[]): boolean {
    try {
        return workbook?.applyOp(ops) ?? false;
    } catch (e) {
        console.error('[sheet] Failed to apply remote op:', e);
        return false;
    }
}

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
) {
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [snapshotVersion, setSnapshotVersion] = useState(0);
    // The workbook shows the defaults fallback; the consumer renders it read-only and says so.
    const [loadFailed, setLoadFailed] = useState(false);

    const isLocalOpRef = useRef(false);
    const readyForOpsRef = useRef(false);
    // Same fact for handleOp: ops built against the fallback workbook must not reach peers.
    const loadedRef = useRef(false);
    // The base of the snapshot the grid shows. It is null when the workbook has none, when the grid shows the defaults
    // after a failed load, when it keeps its view after a failed mid-session decode, and when it rejected a peer's batch.
    const baseIdRef = useRef<string | null>(null);
    // A peer's batches that arrive while a grid mounts on `data`. They wait for that grid, never the one it replaces.
    const pendingRef = useRef<{ data: Sheet[]; batches: Op[][] } | null>(null);

    // Decodes the snapshot with the log replayed on top, so a peer's batches that the snapshot lacks show too. A
    // failure locks the workbook read-only, because what it shows may differ from the truth on the wire. The doc must
    // still open, since a throw escaping the Yjs handler kills the app. On the initial load the tab shows the blank
    // defaults. Mid-session it keeps the workbook on screen, because defaults would wipe the user's view. It returns
    // whether it seeded a new view, so a mid-session caller knows whether to remount.
    const loadSnapshot = (doc: Y.Doc, keepViewOnFailure = false): boolean => {
        const snapshot = readSheetsSnapshotJson(doc);
        const pending = doc.getArray<Op[]>('ops').toArray();
        let data = createDefaultSheets();
        let loaded = true;
        try {
            if (snapshot) data = decodeSheetsSnapshot(snapshot);
            if (pending.length > 0) data = replaySheetsOps(data, pending);
        } catch (e) {
            loaded = false;
            console.error('[sheet] Failed to load the snapshot, opening read-only:', e);
        }
        loadedRef.current = loaded;
        baseIdRef.current = loaded ? (readSheetsBase(doc)?.id ?? null) : null;
        // A persistent banner in the editor, gated on loadFailed, says why the sheet is read-only. A toast would be
        // dismissed, and a blank read-only sheet then looks like data loss.
        setLoadFailed(!loaded);
        if (!loaded && keepViewOnFailure) return false;
        pendingRef.current = { data, batches: [] };
        setInitialData(data);
        return true;
    };

    // The grid's own seed runs in its effect, before this host's, so the queue applies on top of the seed.
    useEffect(() => {
        const pending = pendingRef.current;
        if (!pending || pending.data !== initialData || !workbookRef.current) return;
        pendingRef.current = null;
        for (const ops of pending.batches) {
            if (!applyBatch(workbookRef.current, ops)) baseIdRef.current = null;
        }
    }, [initialData, workbookRef]);

    // useCollabDoc owns the doc and provider lifecycle, and sheets layers its op log and snapshot on top through onInit
    // and onSync. There is no UndoManager, because the sheet engine's own op stack owns undo.
    const { docRef, provider, synced, offline, loaded, storageUnavailable, storageGone, unsyncedEdits } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        onInit: ({ doc }) => {
            readyForOpsRef.current = false;
            loadedRef.current = false;
            baseIdRef.current = null;

            const stateMap = doc.getMap('state');
            const opsArray = doc.getArray<Op[]>('ops');
            // The same object as stateMap. A transaction's set of changed types does not accept a YMap's type, but it
            // accepts the plain type that doc.get returns.
            const stateRoot = doc.get('state');

            // Whether this transaction writes a new snapshot that the grid must remount on. It keeps the grid only for
            // a compaction of exactly what the grid shows. The new base must name the base the grid loaded. Every
            // struct the transaction deletes must be one this tab held, or the compaction folded a batch the tab never
            // applied, such as one sent while it was offline. Yjs runs the two observers below in no fixed order, so
            // the verdict is taken once, before either of them.
            let remountGrid = false;
            const judgeTransaction = (tr: Y.Transaction) => {
                remountGrid = tr.changed.has(stateRoot);
                if (!remountGrid || baseIdRef.current === null) return;
                if (readSheetsBase(doc)?.compactedFrom !== baseIdRef.current) return;
                for (const [client, deletes] of tr.deleteSet.clients) {
                    const held = tr.beforeState.get(client) ?? 0;
                    if (deletes.some((d) => d.clock + d.len > held)) return;
                }
                remountGrid = false;
            };
            doc.on('beforeObserverCalls', judgeTransaction);

            const handleOps = (event: Y.YArrayEvent<Op[]>) => {
                if (!readyForOpsRef.current) return;
                if (isLocalOpRef.current) {
                    isLocalOpRef.current = false;
                    return;
                }
                // A new snapshot that remounts the grid replays the whole log, these batches too.
                if (remountGrid) return;
                for (const delta of event.changes.delta) {
                    if (delta.insert && Array.isArray(delta.insert)) {
                        for (const ops of delta.insert as Op[][]) {
                            if (pendingRef.current) pendingRef.current.batches.push(ops);
                            else if (!applyBatch(workbookRef.current, ops)) baseIdRef.current = null;
                        }
                    }
                }
            };
            opsArray.observe(handleOps);

            const handleState = () => {
                if (!readyForOpsRef.current) return;
                // A compaction of what the grid shows only moves the grid to the new base.
                if (!remountGrid) {
                    baseIdRef.current = readSheetsBase(doc)?.id ?? null;
                    return;
                }
                if (loadSnapshot(doc, true)) setSnapshotVersion((v) => v + 1);
            };
            stateMap.observe(handleState);

            return () => {
                readyForOpsRef.current = false;
                // Unregister the listeners before the shared hook destroys the provider and doc, so a WS message
                // racing teardown can't fire against a destroyed doc.
                doc.off('beforeObserverCalls', judgeTransaction);
                opsArray.unobserve(handleOps);
                stateMap.unobserve(handleState);
            };
        },
        onSync: ({ doc }, isSynced) => {
            if (!isSynced) return;
            if (!readyForOpsRef.current) {
                loadSnapshot(doc);
                readyForOpsRef.current = true;
                return;
            }
            // A loaded grid caught up through the observers, so only a reconnect after a failed load reads again.
            if (!loadedRef.current && loadSnapshot(doc, true)) setSnapshotVersion((v) => v + 1);
        },
    });

    const handleOp = useCallback(
        (ops: Op[]) => {
            const doc = docRef.current;
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

    return {
        initialData,
        snapshotVersion,
        loadFailed,
        synced,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
        handleOp,
        docRef,
        provider,
    };
}
