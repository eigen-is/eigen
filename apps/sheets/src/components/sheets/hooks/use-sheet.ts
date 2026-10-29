// A workbook's collab protocol in the editor: the stored snapshot plus a log of op batches, both in one Yjs document.
// It decodes the snapshot with the log replayed on top for the Workbook, pushes the Workbook's own batches onto the
// log, and hands a peer's batches to the Workbook, queueing them while a grid mounts. The grid ends as the log's order
// says, wherever in the log a peer's batch lands. The server folds the log into the snapshot when the workbook closes.
// A tab keeps its grid through such a compaction of what it already holds, and remounts on any other new snapshot.

import { useCollabDoc } from '@workspace/lib/collab';
import type { Sheet } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, readSheetsBase, readSheetsSnapshotJson } from '@workspace/lib/sheets';
import type { Op, WorkbookInstance, Sheet as WorkbookSheet } from '@workspace/sheet';
import { createDefaultSheets, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

// The sheets the grid showed once it had applied the log's first `at` batches. A peer's batch that lands before batches
// the grid already applied takes the grid back to the nearest one and applies the log again from there.
type Anchor = { at: number; sheets: WorkbookSheet[] };

// How many batches pass between two anchors. Restoring one costs nothing, since the sheets share all they did not change,
// but each batch after it is applied again.
const ANCHOR_EVERY = 50;

// Keeps the sheets the grid shows as the anchor at `at`, when the last anchor lies far enough back. The caller makes
// sure the grid holds exactly the log's first `at` batches.
function keepAnchor(anchors: Anchor[], at: number, workbook: WorkbookInstance) {
    const last = anchors.at(-1);
    if (!last || at - last.at >= ANCHOR_EVERY) anchors.push({ at, sheets: workbook.getAllSheets() });
}

// Whether the fresh batches, applied after the overtaken ones, still give the workbook the log's order gives. They do
// when no batch adds, deletes or moves sheets, rows or columns, and no op of one side writes a path an op of the other
// writes, or a path inside or above it. The recalc list counts too: two formula cells added at once both append to it.
function commutes(fresh: Iterable<Op[]>, overtaken: Op[][]): boolean {
    const written = new Set<string>();
    const above = new Set<string>();
    for (const ops of overtaken) {
        for (const op of ops) {
            const keys = pathKeys(op);
            if (!keys) return false;
            const [key, ...up] = keys;
            written.add(key);
            for (const k of up) above.add(k);
        }
    }
    for (const ops of fresh) {
        for (const op of ops) {
            const keys = pathKeys(op);
            if (!keys || above.has(keys[0]) || keys.some((key) => written.has(key))) return false;
        }
    }
    return true;
}

// The key of the path an op writes, its sheet first, then the key of each path above it. An add or remove at an array
// index moves the entries after it, so it writes the whole array. Null for an op on sheets, rows or columns.
function pathKeys(op: Op): string[] | null {
    if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') return null;
    const last = op.path.at(-1);
    const wholeArray = (op.op !== 'replace' && typeof last === 'number') || last === 'length';
    const path = [op.id, ...(wholeArray ? op.path.slice(0, -1) : op.path)].map(String);
    return path.map((_, i) => JSON.stringify(path.slice(0, path.length - i)));
}

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
            };
            doc.on('beforeObserverCalls', judgeTransaction);

            // Positions come from the change's retains: Yjs hands the observer one change per transaction, so a
            // transaction that adds several batches is handled once, from the first of them.
            const handleOps = (event: Y.YArrayEvent<Op[]>) => {
                // A new snapshot that remounts the grid replays the whole log, these batches too.
                if (!readyForOpsRef.current || remountGrid) return;
                const log = opsArray.toArray();
                const added: Op[][] = [];
                // What the transaction added that the grid has not applied yet.
                const fresh = new Set<Op[]>();
                let index = 0;
                let kept = 0;
                let folded = 0;
                for (const change of event.changes.delta) {
                    if (change.retain) {
                        index += change.retain;
                        kept += change.retain;
                    }
                    // A compaction folds the head of the log into the snapshot. Batches deleted after one it keeps
                    // would leave the grid with an order no anchor holds, so the grid loads again.
                    if (change.delete && kept > 0) return reload(doc);
                    if (change.delete) folded += change.delete;
                    if (Array.isArray(change.insert)) {
                        for (const ops of log.slice(index, index + change.insert.length)) {
                            added.push(ops);
                            if (!ownRef.current.has(ops)) fresh.add(ops);
                        }
                        index += change.insert.length;
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
                    const anchor = anchors.findLast((a) => a.at <= from);
                    // A batch that lands before the batches the grid replayed at load has no anchor.
                    if (!anchor) return reload(doc);
                    try {
                        workbook.replayOps(anchor.sheets, log.slice(anchor.at), fresh);
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

            const handleState = () => {
                if (!readyForOpsRef.current) return;
                // A compaction of what the grid shows only moves the grid to the new base.
                if (!remountGrid) {
                    baseIdRef.current = readSheetsBase(doc)?.id ?? null;
                    return;
                }
                reload(doc);
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
