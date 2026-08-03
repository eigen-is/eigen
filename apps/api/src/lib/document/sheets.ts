import type { Op, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { createDefaultSheets, recalcSheets, replaySheetsOps, sheetsNeedRecalc } from '@workspace/sheet/engine';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// Materialized Yjs doc → Sheet[]. Shared by the main-thread readers below and the
// document-transform Worker, so replay and recalc behave identically on and off
// thread. `recalcError` is non-null when recalc fell back to replayed values —
// the caller decides how to surface it (console.warn here, a TransformWarning in
// the Worker).
export function readSheetsFromDoc(doc: Y.Doc): { sheets: Sheet[]; recalcError: string | null } {
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    const opBatches = doc.getArray<Op[]>('ops').toArray();
    // No snapshot + pending ops = a fresh doc closed before its first
    // flushSnapshot. The ops were recorded against the editor's default sheets
    // (they reference 'sheet-1'), so replay must start from the same base — an
    // empty base silently drops every edit. A doc with neither stays [].
    const sheets = snapshot ? (JSON.parse(snapshot) as Sheet[]) : opBatches.length > 0 ? createDefaultSheets() : [];
    const replayed = replaySheetsOps(sheets, opBatches);

    // Server-side recalc for docs the client never computed for us — xlsx
    // imports never opened in an editor, or crash/race divergence. Gated on the
    // needs-recompute signal (formula cells but no calcChain), so live-edited
    // docs (which already persist fresh v/m as ops) pay nothing. Any recalc
    // failure falls back to the replayed stale-but-valid sheets — an export must
    // never 500 because recalc hiccuped. See docs/SHEETS.md § Server-side recalc.
    if (!sheetsNeedRecalc(replayed)) return { sheets: replayed, recalcError: null };
    try {
        return { sheets: recalcSheets(replayed), recalcError: null };
    } catch (e) {
        return { sheets: replayed, recalcError: e instanceof Error ? e.message : String(e) };
    }
}

// Returns Sheet[] directly (vs. {content, mediaByName} like the doc/slides readers)
// because the sheets export and preview pipelines fetch media lazily from the mount
// per-cell rather than bundling it upfront — see lib/export/sheets/{render,to-xlsx}.ts.
export async function readSheetsContent(mount: Mount, drivePath: DrivePath): Promise<Sheet[]> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigensheets data.db missing');

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);
    const { sheets, recalcError } = readSheetsFromDoc(doc);
    if (recalcError) console.warn('[sheets] server recalc failed, serving replayed values:', recalcError);
    return sheets;
}

// The import commit: an already-serialized snapshot goes straight into the live
// doc, so the Worker's snapshot JSON is never parsed and re-stringified here.
export function writeSheetsSnapshotToYjs(doc: Y.Doc, snapshotJson: string): void {
    doc.transact(() => {
        doc.getMap('state').set('snapshot', snapshotJson);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}

export function writeSheetsToYjs(doc: Y.Doc, sheets: Sheet[]): void {
    writeSheetsSnapshotToYjs(doc, JSON.stringify(sheets));
}
