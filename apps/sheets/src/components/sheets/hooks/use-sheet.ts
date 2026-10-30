// A workbook's collab protocol in the editor: the stored snapshot plus a log of op batches, both in one Yjs document.
// It decodes the snapshot with the log replayed on top for the Workbook, pushes the Workbook's own batches onto the
// log, and hands a peer's batches to the Workbook, queueing them while a grid mounts. The grid ends as the log's order
// says, wherever in the log a peer's batch lands. The server folds the log into the snapshot when the workbook closes.
// A tab keeps its grid through such a compaction of what it already holds, and remounts on any other new snapshot.

import { useCollabDoc } from '@workspace/lib/collab';
import type { Sheet } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsBase, readSheetsSnapshotJson } from '@workspace/lib/sheets';
import type { Op, WorkbookInstance, Sheet as WorkbookSheet } from '@workspace/sheet';
import { commutes } from '@workspace/sheet';
import { createDefaultSheets, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

// The sheets the grid showed once it had applied the log's first `at` batches. A peer's batch that lands before batches
// the grid already applied takes the grid back to the nearest one and applies the log again from there.
type Anchor = { at: number; sheets: WorkbookSheet[] };

// How many batches pass between two anchors. An anchor shares every row nobody changed since, so it is cheap to keep
// and to restore. Restoring one empties the formula engine, so the first formula edit after a rollback rebuilds its
// map. Each batch after the anchor is applied again, which on a sheet of 300,000 cells takes about 12 ms a batch, so
// twenty keeps that part of a rollback near a quarter second.
const ANCHOR_EVERY = 20;

// How many anchors the grid keeps, the oldest dropped first. On a sheet of 300,000 cells ten anchors hold about 2 MB.
// A rollback from the oldest applies some two hundred batches again, a few seconds there. A batch that lands further
// back loads the grid again, which costs no more.
const MAX_ANCHORS = 10;

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

    // The tab's own batches, which the grid applied at their call. Yjs hands the observer the pushed array itself.
    const ownRef = useRef(new WeakSet<Op[]>());
    const readyForOpsRef = useRef(false);
    // Same fact for handleOp: ops built against the fallback workbook must not reach peers.
    const loadedRef = useRef(false);
    // The base of the snapshot the grid shows. It is null when the workbook has none, when the grid shows the defaults
    // after a failed load, when it keeps its view after a failed mid-session decode, and when it rejected a peer's batch.
    const baseIdRef = useRef<string | null>(null);
    // The batches that arrive while a grid mounts on `data`, which holds the log's first `at`. They wait for that grid,
    // never the one it replaces.
    const pendingRef = useRef<{ data: Sheet[]; at: number; batches: Op[][] } | null>(null);
    // The mounted grid's anchors, in log order.
    const anchorsRef = useRef<Anchor[]>([]);

    // Decodes the snapshot with the log replayed on top, so a peer's batches that the snapshot lacks show too. A
    // failure locks the workbook read-only, because what it shows may differ from the truth on the wire. The doc must
    // still open, since a throw escaping the Yjs handler kills the app. On the initial load the tab shows the blank
    // defaults. Mid-session it keeps the workbook on screen, because defaults would wipe the user's view. It returns
    // whether it seeded a new view, so a mid-session caller knows whether to remount.
    const loadSnapshot = (doc: Y.Doc, keepViewOnFailure = false): boolean => {
        const snapshot = readSheetsSnapshotJson(doc);
        const log = doc.getArray<Op[]>('ops').toArray();
        let data = createDefaultSheets();
        let loaded = true;
        try {
            if (snapshot) data = decodeSheetsSnapshot(snapshot);
            if (log.length > 0) data = replaySheetsOps(data, log);
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
        pendingRef.current = { data, at: log.length, batches: [] };
        anchorsRef.current = [];
        setInitialData(data);
        return true;
    };

    // A new grid on the snapshot and the whole log, unless the snapshot fails to decode.
    const reload = (doc: Y.Doc) => {
        if (loadSnapshot(doc, true)) setSnapshotVersion((v) => v + 1);
    };

    // The grid's own seed runs in its effect, before this host's, so the queue applies on top of the seed. The seed is
    // the first anchor.
    useEffect(() => {
        const pending = pendingRef.current;
        const workbook = workbookRef.current;
        if (!pending || pending.data !== initialData || !workbook) return;
        pendingRef.current = null;
        anchorsRef.current = [{ at: pending.at, sheets: workbook.getAllSheets() }];
        for (const ops of pending.batches) {
            if (!applyBatch(workbook, ops)) baseIdRef.current = null;
        }
        keepAnchor(anchorsRef.current, pending.at + pending.batches.length, workbook);
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
                // The grid moves to the new base here, before the observers run. A batch of this transaction that the
                // grid rejects then clears it, whichever observer runs first.
                baseIdRef.current = readSheetsBase(doc)?.id ?? null;
            };
            doc.on('beforeObserverCalls', judgeTransaction);

            // Yjs calls this once per transaction, with one change that holds every batch it added or deleted. Their
            // places in the log come from the change's retains, and the grid handles them at once, from the first.
            const handleOps = (event: Y.YArrayEvent<Op[]>) => {
                // A new snapshot that remounts the grid replays the whole log, these batches too.
                if (!readyForOpsRef.current || remountGrid) return;
                const log = opsArray.toArray();
                const added: Op[][] = [];
                // What the transaction added that the grid has not applied yet.
                const fresh = new Set<Op[]>();
                let kept = 0;
                let folded = 0;
                for (const change of event.changes.delta) {
                    if (change.retain) kept += change.retain;
                    // A compaction folds the head of the log into the snapshot. Batches deleted after one it keeps
                    // would leave the grid with an order no anchor holds, so the grid loads again.
                    if (change.delete && kept > 0) return reload(doc);
                    if (change.delete) folded += change.delete;
                    if (Array.isArray(change.insert)) {
                        for (const ops of change.insert) {
                            added.push(ops);
                            if (!ownRef.current.has(ops)) fresh.add(ops);
                        }
                    }
                }
                const from = log.findIndex((ops) => fresh.has(ops));
                const overtaken = from === -1 ? [] : log.slice(from).filter((ops) => !fresh.has(ops));

                const pending = pendingRef.current;
                if (pending) {
                    // The grid that mounts holds the log up to `pending.at`, so it takes only batches added at the end.
                    // The tab's own come from the grid it replaces.
                    if (overtaken.length > 0 || folded > 0) return reload(doc);
                    pending.batches.push(...added);
                    return;
                }
                const workbook = workbookRef.current;
                if (!workbook) return;
                // An anchor stays true up to the first fresh batch, and a fold moves it back by the batches it folded.
                const anchors = anchorsRef.current
                    .map((anchor) => ({ at: anchor.at - folded, sheets: anchor.sheets }))
                    .filter((anchor) => anchor.at >= 0 && (from === -1 || anchor.at <= from));
                if (overtaken.length === 0 || commutes(fresh, overtaken)) {
                    for (const ops of fresh) {
                        if (!applyBatch(workbook, ops)) baseIdRef.current = null;
                    }
                } else {
                    const anchor = anchors.at(-1);
                    // A batch that lands before the oldest anchor, such as one before the batches the grid replayed at
                    // load, has none.
                    if (!anchor) return reload(doc);
                    try {
                        if (!workbook.replayOps(anchor.sheets, log.slice(anchor.at), fresh)) baseIdRef.current = null;
                    } catch (e) {
                        // A throw escaping the Yjs observer would kill the app.
                        console.error('[sheet] Failed to apply the log again:', e);
                        return reload(doc);
                    }
                }
                keepAnchor(anchors, log.length, workbook);
                anchorsRef.current = anchors;
            };
            opsArray.observe(handleOps);

            // A compaction of what the grid shows moved the grid to the new base before the observers ran.
            const handleState = () => {
                if (readyForOpsRef.current && remountGrid) reload(doc);
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
            if (!loadedRef.current) reload(doc);
        },
    });

    const handleOp = useCallback(
        (ops: Op[]) => {
            const doc = docRef.current;
            if (!doc || !loadedRef.current || ops.length === 0) return;
            ownRef.current.add(ops);
            doc.getArray('ops').push([ops]);
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

// Applies a peer's batch to the grid and says whether it applied. A throw escaping the Yjs observer would kill the app,
// so a batch that fails is logged.
function applyBatch(workbook: WorkbookInstance, ops: Op[]): boolean {
    try {
        return workbook.applyOp(ops);
    } catch (e) {
        console.error('[sheet] Failed to apply remote op:', e);
        return false;
    }
}

// Keeps the sheets the grid shows as the anchor at `at`, when the last anchor lies far enough back, and drops the
// oldest anchor past the cap. The caller makes sure the grid holds exactly the log's first `at` batches.
function keepAnchor(anchors: Anchor[], at: number, workbook: WorkbookInstance) {
    const last = anchors.at(-1);
    if (last && at - last.at < ANCHOR_EVERY) return;
    anchors.push({ at, sheets: workbook.getAllSheets() });
    if (anchors.length > MAX_ANCHORS) anchors.shift();
}
