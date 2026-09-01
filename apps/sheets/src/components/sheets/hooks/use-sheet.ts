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
    // The workbook shows the defaults fallback; the consumer renders it read-only and says so.
    const [loadFailed, setLoadFailed] = useState(false);

    const isLocalOpRef = useRef(false);
    const isLocalSnapshotRef = useRef(false);
    const readyForOpsRef = useRef(false);
    // Same fact for the callbacks: a fallback workbook must never be flushed over state.snapshot.
    const loadedRef = useRef(false);
    const latestDataRef = useRef<Sheet[] | null>(null);

    // Decodes state.snapshot with the pending ops replayed on top (browser A flushes while B
    // has unflushed local ops: B's edits survive the Yjs merge and must be reapplied). A failure
    // disarms persistence: what this client shows must never be flushed over a snapshot it
    // could not read — and the doc must still open, a throw escaping the Yjs handler kills the app.
    // Returns whether the on-screen view was (re)seeded, so the mid-session caller knows whether
    // to remount. `keepViewOnFailure` distinguishes the two failure paths: the initial load shows
    // the blank defaults fallback (nothing on screen yet); a peer's undecodable mid-session flush
    // keeps the populated workbook already on screen — replacing it with defaults would wipe the
    // user's view — and only arms the read-only lock + banner.
    const loadSnapshot = (doc: Y.Doc, keepViewOnFailure = false): boolean => {
        const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
        const pending = doc.getArray('ops').toArray() as Op[][];
        let data = createDefaultSheets();
        let loaded = true;
        try {
            if (snapshot) data = decodeSheetsSnapshot(snapshot);
            if (pending.length > 0) data = replaySheetsOps(data, pending);
        } catch (e) {
            loaded = false;
            console.error('[sheet] Failed to load the snapshot, opening read-only without persistence:', e);
        }
        // Read-only lock either way: local state may now diverge from the truth on the wire, so
        // writes must stop (loadedRef gates flushSnapshot + handleOp; loadFailed gates allowEdit).
        loadedRef.current = loaded;
        // The read-only lock plus a persistent in-editor banner (editor.tsx, gated on loadFailed)
        // surface the failure. A toast was wrong here: it dismissed on click, leaving a blank
        // read-only sheet indistinguishable from data loss.
        setLoadFailed(!loaded);
        if (!loaded && keepViewOnFailure) return false;
        latestDataRef.current = data;
        setInitialData(data);
        return true;
    };

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
                // Mid-session: a decodable flush reseeds initialData and remounts the workbook to
                // it; an undecodable one keeps the current view (no remount) and only locks it.
                if (loadSnapshot(doc, true)) setSnapshotVersion((v) => v + 1);
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
            loadSnapshot(doc);
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
