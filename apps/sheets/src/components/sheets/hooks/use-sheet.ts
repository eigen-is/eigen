// A workbook's collab protocol in the editor: the stored snapshot plus a log of op batches, both in one Yjs document.
// It decodes the snapshot with the log replayed on top for the Workbook, which mounts once, pushes the Workbook's own
// batches onto the log, and hands a peer's batches to the Workbook. The grid ends as the log's order says, wherever in
// the log a peer's batch lands. A new snapshot, such as the server's compaction or a version restore, loads into the
// grid in place: the tab keeps its view and loses its undo steps.

import type { CollabDoc } from '@workspace/lib/collab';
import { useCollabDoc } from '@workspace/lib/collab';
import type { Sheet } from '@workspace/lib/sheets';
import {
    readSheetsLog,
    readSheetsSnapshotJson,
    sheetsBatchOf,
    sheetsLogStartsWith,
    sheetsOpLog,
    sheetsStateMap,
} from '@workspace/lib/sheets';
import type { Op, WorkbookInstance, Sheet as WorkbookSheet } from '@workspace/sheet';
import { commutes } from '@workspace/sheet';
import { createDefaultSheets, decodeOrDefault, replaySheetsOps } from '@workspace/sheet/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

// The sheets the grid showed once it had applied the log's first `at` batches. A peer's batch that lands before batches
// the grid already applied takes the grid back to the nearest one and applies the log again from there.
type Anchor = { at: number; sheets: WorkbookSheet[] };

// How many batches pass between two anchors. A rollback applies every batch after its anchor again, so fewer anchors
// make it slower, while an anchor shares every row nobody changed since and is cheap to keep.
const ANCHOR_EVERY = 20;

// How many anchors the grid keeps, the oldest dropped first.
const MAX_ANCHORS = 10;

type UseSheet = Omit<CollabDoc, 'doc' | 'undoManager'> & {
    initialData: Sheet[] | null;
    // The grid shows the defaults or the last view it had, and the editor renders it read-only and says why.
    loadFailed: boolean;
    handleOp: (ops: Op[]) => void;
};

export function useSheet(
    ownerId: string,
    mountId: string,
    pathId: string,
    workbookRef: React.RefObject<WorkbookInstance | null>,
): UseSheet {
    const [initialData, setInitialData] = useState<Sheet[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    // False until the first sync read the snapshot, so a batch that arrives before then waits for that read.
    const readyForOpsRef = useRef(false);
    // False while the grid shows the defaults after a failed load. A batch built on those must not reach peers.
    const loadedRef = useRef(false);
    // The snapshot and the log's entries that the sheets a grid mounts on hold, until that grid caught up with the doc.
    const mountingRef = useRef<{ snapshot: string | undefined; entries: unknown[] } | null>(null);
    // The mounted grid's anchors, in log order.
    const anchorsRef = useRef<Anchor[]>([]);

    // The snapshot with the log replayed on top, which a mounted grid takes through `show`. A failure of either returns
    // null and locks the workbook read-only, since what it shows may differ from the wire, and is caught because a
    // throw escaping the Yjs handler kills the app.
    const readSheets = (doc: Y.Doc, show?: (sheets: Sheet[]) => void): Sheet[] | null => {
        let sheets: Sheet[] | null = null;
        try {
            const read = replaySheetsOps(decodeOrDefault(readSheetsSnapshotJson(doc)).sheets, readSheetsLog(doc));
            show?.(read);
            sheets = read;
        } catch (e) {
            console.error('[sheet] Failed to load the workbook, now read-only:', e);
        }
        loadedRef.current = sheets !== null;
        setLoadFailed(sheets === null);
        return sheets;
    };

    // The mounted grid takes the snapshot and the whole log in place, so it has caught up with the doc. On a snapshot
    // it can't read, the grid keeps the workbook on screen, because defaults would wipe the user's view.
    const reset = (doc: Y.Doc) => {
        const workbook = workbookRef.current;
        if (!workbook || !readSheets(doc, (sheets) => workbook.replayOps(sheets, [], new Set()))) return;
        mountingRef.current = null;
        anchorsRef.current = [{ at: sheetsOpLog(doc).length, sheets: workbook.getAllSheets() }];
    };

    // useCollabDoc owns the doc and provider lifecycle, and sheets layers its op log and snapshot on top through onInit
    // and onSync. There is no UndoManager, because the sheet engine's own op stack owns undo.
    const { docRef, provider, synced, offline, loaded, storageUnavailable, storageGone, unsyncedEdits } = useCollabDoc({
        ownerId,
        mountId,
        pathId,
        onInit: ({ doc }) => {
            readyForOpsRef.current = false;
            loadedRef.current = false;

            const stateMap = sheetsStateMap(doc);
            const opsArray = sheetsOpLog(doc);
            // A transaction's set of changed types takes the plain type that doc.get returns, not the typed map.
            const stateRoot = doc.get('state');

            // Yjs calls this once per transaction, with one change that holds every batch it added or deleted and, in
            // its retains, their places in the log. The tab's own batch, one per keystroke, reads nothing of the log.
            const handleOps = (event: Y.YArrayEvent<unknown>) => {
                // A grid that mounts catches up once it mounted, and a new snapshot loads the whole log, these batches
                // too. Yjs runs this observer and the map's in no fixed order.
                if (!readyForOpsRef.current || mountingRef.current || event.transaction.changed.has(stateRoot)) return;
                // What the transaction added, and the log index of the first.
                const added: unknown[] = [];
                let from = -1;
                let kept = 0;
                for (const change of event.changes.delta) {
                    if (change.retain) kept += change.retain;
                    // Batches deleted with no new snapshot would leave the grid with cells no joiner has.
                    if (change.delete) return reset(doc);
                    if (Array.isArray(change.insert)) {
                        if (from === -1) from = kept;
                        added.push(...change.insert);
                    }
                }
                // The batches the grid has not applied yet. It applied the tab's own at its call, and a peer's arrive
                // through Y.applyUpdate, whose transaction is never local, so a transaction adds one kind or the other.
                const fresh = new Set(event.transaction.local ? [] : added.map(sheetsBatchOf));
                // Every batch after the first fresh one is fresh too, or the fresh ones overtook it.
                const overtaken =
                    fresh.size === 0 || opsArray.length - from === fresh.size
                        ? []
                        : readSheetsLog(doc, from).filter((ops) => !fresh.has(ops));

                const workbook = workbookRef.current;
                if (!workbook) return;
                // An anchor stays true up to the first fresh batch.
                const anchors = anchorsRef.current.filter((anchor) => fresh.size === 0 || anchor.at <= from);
                try {
                    if (overtaken.length === 0 || commutes(fresh, overtaken)) {
                        for (const ops of fresh) workbook.applyOp(ops);
                    } else {
                        const anchor = anchors.at(-1);
                        // A batch that lands before the oldest anchor, such as one before the batches the grid replayed
                        // at load, has none.
                        if (!anchor) return reset(doc);
                        workbook.replayOps(anchor.sheets, readSheetsLog(doc, anchor.at), fresh);
                    }
                } catch (e) {
                    // A throw escaping the Yjs observer would kill the app, and the grid may hold part of a batch.
                    console.error('[sheet] Failed to apply the log, loading it again:', e);
                    return reset(doc);
                }
                keepAnchor(anchors, opsArray.length, workbook);
                anchorsRef.current = anchors;
            };
            opsArray.observe(handleOps);

            const handleState = () => {
                if (readyForOpsRef.current) reset(doc);
            };
            stateMap.observe(handleState);

            return () => {
                readyForOpsRef.current = false;
                // Unregister the listeners before the shared hook destroys the provider and doc, so a WS message
                // racing teardown can't fire against a destroyed doc.
                opsArray.unobserve(handleOps);
                stateMap.unobserve(handleState);
            };
        },
        onSync: ({ doc }, isSynced) => {
            if (!isSynced) return;
            if (!readyForOpsRef.current) {
                mountingRef.current = { snapshot: readSheetsSnapshotJson(doc), entries: sheetsOpLog(doc).toArray() };
                // After a failed first load the tab shows the blank defaults.
                setInitialData(readSheets(doc) ?? createDefaultSheets());
                readyForOpsRef.current = true;
                return;
            }
            // A loaded grid caught up through the observers, so only a reconnect after a failed load reads again.
            if (!loadedRef.current) reset(doc);
        },
    });

    // The grid seeds its workbook as it mounts, before this effect. While the doc still starts with what the seed
    // holds, the grid lacks only the batches after those. Any other change loads the snapshot and the log again.
    useEffect(() => {
        const mounting = mountingRef.current;
        const workbook = workbookRef.current;
        const doc = docRef.current;
        if (!mounting || !workbook || !doc) return;
        mountingRef.current = null;
        if (readSheetsSnapshotJson(doc) !== mounting.snapshot || !sheetsLogStartsWith(doc, mounting.entries)) {
            reset(doc);
            return;
        }
        const at = mounting.entries.length;
        const late = readSheetsLog(doc, at);
        anchorsRef.current = [{ at, sheets: workbook.getAllSheets() }];
        try {
            for (const ops of late) workbook.applyOp(ops);
        } catch (e) {
            console.error('[sheet] Failed to apply the log, loading it again:', e);
            reset(doc);
            return;
        }
        keepAnchor(anchorsRef.current, at + late.length, workbook);
    }, [initialData, workbookRef, docRef]);

    const handleOp = useCallback(
        (ops: Op[]) => {
            const doc = docRef.current;
            if (!doc || !loadedRef.current || ops.length === 0) return;
            sheetsOpLog(doc).push([ops]);
        },
        [docRef],
    );

    return {
        initialData,
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

// Keeps the sheets the grid shows as the anchor at `at`, when the last anchor lies far enough back, and drops the
// oldest anchor past the cap. The caller makes sure the grid holds exactly the log's first `at` batches.
function keepAnchor(anchors: Anchor[], at: number, workbook: WorkbookInstance) {
    const last = anchors.at(-1);
    if (last && at - last.at < ANCHOR_EVERY) return;
    anchors.push({ at, sheets: workbook.getAllSheets() });
    if (anchors.length > MAX_ANCHORS) anchors.shift();
}
