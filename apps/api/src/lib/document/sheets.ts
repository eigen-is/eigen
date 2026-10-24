import type { Op, Sheet, SheetWithCalcChain } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot } from '@workspace/lib/sheets';
import {
    copySheetName,
    createDefaultSheets,
    iscelldata,
    mapChartRefs,
    recalcSheets,
    renameSheetRefs,
    replaySheetsOps,
    sheetsNeedRecalc,
    withMaterializedData,
} from '@workspace/sheet/engine';
import type * as Y from 'yjs';

// What the server's recalc lets an untrusted workbook's formulas cost. Past either bound the recalc fails like any
// other, and the sheets keep the values they hold.
export const SERVER_RECALC_BUDGET = {
    // In the dependency index's 64 × 16 blocks (dependencyBlocks), each range cut to its sheet: four times the
    // 1,062-workbook corpus's most (68.8 million, 3.3 s); an 81 KB file of whole-column sums reaches it in 9.9 s at
    // 3.2 GB.
    maxDependencyBlocks: 280_000_000,
    // The cells its ranges' evaluation reads: past the most a corpus workbook that recalcs in under 10 s reads
    // (30 million, 9.9 s), and 2,000 COUNTIFs over A1:Z1048576 fail at it in 17 s, well inside the 120 s deadline.
    maxCellsRead: 32_000_000,
};

// Materialized Yjs doc → Sheet[]. Every consumer of a persisted workbook reads it in
// the document-transform process, so there is no Mount-side loader here: capture
// (collab-source.ts) + materialize (yjs-loader.ts) is the only path in. `recalcError`
// is non-null when recalc fell back to replayed values — the caller decides how to
// surface it (a TransformWarning in the transform).
export function readSheetsFromDoc(
    doc: Y.Doc,
    { recalc = true }: { recalc?: boolean } = {},
): { sheets: Sheet[]; recalcError: string | null } {
    const snapshot = readSheetsSnapshotJson(doc);
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
    // One far-flung cell (XFD1048576) makes this a huge grid; the transform deadline caps it.
    const replayed = replaySheetsOps(sheets, opBatches).map(withMaterializedData);

    // Server-side recalc for docs the client never computed for us — legacy xlsx
    // imports from before the import transform persisted computed values + calcChain.
    // Gated on the needs-recompute signal (formula cells but no calcChain), so
    // live-edited docs pay nothing — and only the export read opts in: recalc of a
    // large legacy workbook is unbounded (~39s measured), which a preview or search
    // extract must never pay inside its 30s transform deadline. Those readers pass
    // { recalc: false } and serve the replayed values as-is. Any recalc failure
    // falls back to the replayed stale-but-valid sheets — an export must never 500
    // because recalc hiccuped. See docs/SHEETS.md § The editor computes on write.
    if (!recalc || !sheetsNeedRecalc(replayed)) return { sheets: replayed, recalcError: null };
    try {
        return {
            sheets: recalcSheets(replayed, SERVER_RECALC_BUDGET),
            recalcError: null,
        };
    } catch (e) {
        return { sheets: replayed, recalcError: e instanceof Error ? e.message : String(e) };
    }
}

// The workbook's snapshot JSON; undefined before the first flush.
export function readSheetsSnapshotJson(doc: Y.Doc): string | undefined {
    return doc.getMap<string>('state').get('snapshot');
}

// The import commit: an already-serialized snapshot goes straight into the live
// doc, so the transform's snapshot JSON is never parsed and re-stringified here.
export function writeSheetsSnapshotToYjs(doc: Y.Doc, snapshotJson: string): void {
    doc.transact(() => {
        doc.getMap<string>('state').set('snapshot', snapshotJson);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}

// Import… as new tabs: the file's sheets go in after the workbook's own as addSheet ops, the way a peer's new tab
// arrives, so an open tab adds them live and keeps its unflushed edits. Each takes a fresh id, and one whose name the
// workbook holds is renamed as Duplicate names a copy. What the file says about its own sheets follows: formulas,
// conditional formats, list sources and links name a sheet by name; charts, link cells and the calc chain by id.
export function appendSheetsToYjs(doc: Y.Doc, snapshotJson: string): void {
    const snapshot = readSheetsSnapshotJson(doc);
    const ops = doc.getArray<Op[]>('ops');
    // A doc never flushed opens on the default sheets, as the editor and readSheetsFromDoc both read it.
    const current = replaySheetsOps(snapshot ? decodeSheetsSnapshot(snapshot) : createDefaultSheets(), ops.toArray());
    const imported: SheetWithCalcChain[] = decodeSheetsSnapshot(snapshotJson);

    const taken = current.map((sheet) => sheet.name);
    const renames = new Map<string, string>();
    const fresh = imported.map((sheet) => {
        const name = taken.includes(sheet.name) ? copySheetName(sheet.name, taken) : sheet.name;
        if (name !== sheet.name) renames.set(sheet.name, name);
        taken.push(name);
        return { id: crypto.randomUUID(), name };
    });
    const ids = new Map(imported.map((sheet, i) => [sheet.id, fresh[i].id]));
    const rename = (txt: string) => renameSheetRefs(txt, renames);

    const added = imported.map((sheet, i): Op => {
        const { id, name } = fresh[i];
        for (const { v } of sheet.celldata ?? []) {
            if (typeof v?.f === 'string') v.f = rename(v.f);
            if (v?.hl) v.hl.id = id;
        }
        for (const entry of sheet.calcChain ?? []) entry.id = id;
        for (const rule of sheet.conditionalFormatRules ?? []) {
            if (rule.type === 'default' && rule.conditionName === 'formula') {
                rule.conditionValue = rule.conditionValue.map((value) =>
                    typeof value === 'string' ? rename(value) : value,
                );
            }
        }
        for (const rule of Object.values(sheet.dataVerification ?? {})) {
            if (rule.type === 'dropdown' && iscelldata(rule.value1)) rule.value1 = rename(rule.value1);
        }
        for (const link of Object.values(sheet.hyperlink ?? {})) {
            if (link.linkType === 'sheet') link.linkAddress = renames.get(link.linkAddress) ?? link.linkAddress;
            else if (link.linkType === 'cellrange') link.linkAddress = rename(link.linkAddress);
        }
        const charts = Object.fromEntries(
            Object.entries(sheet.charts ?? {}).map(([key, chart]) => [
                key,
                mapChartRefs(chart, (ref) => {
                    const sheetId = ids.get(ref.sheetId);
                    return sheetId ? { ...ref, sheetId } : ref;
                }),
            ]),
        );
        const value: Sheet = { ...sheet, id, name, order: current.length + i, charts };
        return { op: 'addSheet', id, path: [], value };
    });
    ops.push([added]);
}
