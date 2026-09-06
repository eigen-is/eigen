import { decodeSheetsSnapshot, type Op, type Sheet } from '@workspace/lib/sheets';
import {
    createDefaultSheets,
    recalcSheets,
    replaySheetsOps,
    sheetsNeedRecalc,
    withMaterializedData,
} from '@workspace/sheet/engine';
import type * as Y from 'yjs';

// Materialized Yjs doc → Sheet[]. Every consumer of a persisted workbook reads it in
// the document-transform Worker, so there is no Mount-side loader here: capture
// (collab-source.ts) + materialize (yjs-loader.ts) is the only path in. `recalcError`
// is non-null when recalc fell back to replayed values — the caller decides how to
// surface it (a TransformWarning in the Worker).
export function readSheetsFromDoc(
    doc: Y.Doc,
    { recalc = true }: { recalc?: boolean } = {},
): { sheets: Sheet[]; recalcError: string | null } {
    const snapshot = doc.getMap<string>('state').get('snapshot');
    const opBatches = doc.getArray<Op[]>('ops').toArray();
    // No snapshot + pending ops = a fresh doc closed before its first
    // flushSnapshot. The ops were recorded against the editor's default sheets
    // (they reference 'sheet-1'), so replay must start from the same base — an
    // empty base silently drops every edit. A doc with neither stays [].
    const sheets = snapshot ? decodeSheetsSnapshot(snapshot) : opBatches.length > 0 ? createDefaultSheets() : [];
    // v2 snapshots are celldata-only, but the renderers' conditional-format pass and
    // the cross-sheet formula resolver read the dense `data` matrix (v1 editor
    // flushes carried it implicitly). Materialize it for every sheet so preview and
    // export see the same workbook regardless of which format persisted it.
    const replayed = replaySheetsOps(sheets, opBatches).map(withMaterializedData);

    // Server-side recalc for docs the client never computed for us — legacy xlsx
    // imports from before the import Worker persisted computed values + calcChain.
    // Gated on the needs-recompute signal (formula cells but no calcChain), so
    // live-edited docs pay nothing — and only the export read opts in: recalc of a
    // large legacy workbook is unbounded (~39s measured), which a preview or search
    // extract must never pay inside its 30s Worker deadline. Those readers pass
    // { recalc: false } and serve the replayed values as-is. Any recalc failure
    // falls back to the replayed stale-but-valid sheets — an export must never 500
    // because recalc hiccuped. See docs/SHEETS.md § Server-side recalc.
    if (!recalc || !sheetsNeedRecalc(replayed)) return { sheets: replayed, recalcError: null };
    try {
        return { sheets: recalcSheets(replayed), recalcError: null };
    } catch (e) {
        return { sheets: replayed, recalcError: e instanceof Error ? e.message : String(e) };
    }
}

// The import commit: an already-serialized snapshot goes straight into the live
// doc, so the Worker's snapshot JSON is never parsed and re-stringified here.
export function writeSheetsSnapshotToYjs(doc: Y.Doc, snapshotJson: string): void {
    doc.transact(() => {
        doc.getMap<string>('state').set('snapshot', snapshotJson);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}
