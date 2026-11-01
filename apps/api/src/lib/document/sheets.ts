// A workbook's Yjs doc, read and written on the server. The transform process reads it as Sheet[], for example for an
// export or a preview, and replays the pending ops over the snapshot as a browser does. It also folds the ops into a
// new snapshot when the document closes. Writers, such as an import or a compaction, change the doc through it.

import type { Op, Sheet, SheetWithCalcChain } from '@workspace/lib/sheets';
import {
    decodeSheetsSnapshot,
    decodeSheetsWorkbook,
    encodeSheetsSnapshot,
    readSheetsBase,
    readSheetsSnapshotJson,
    sheetsOpLog,
    stampSheetsBase,
    writeSheetsSnapshot,
} from '@workspace/lib/sheets';
import type { DrivePathType } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_SHEETS } from '@workspace/lib/types/drive';
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
    // Counted in the dependency index's 64 × 16 blocks (dependencyBlocks), each range cut to its sheet. The most a
    // workbook of the 1,062-file corpus needs is 68.8 million (3.3 s), and this is four times that. An 81 KB file of
    // whole-column sums reaches it in 9.9 s at 3.2 GB.
    maxDependencyBlocks: 280_000_000,
    // The cells the evaluation of its ranges reads. The most a corpus workbook reads that recalcs in under 10 s is
    // 30 million (9.9 s), just under this. 2,000 COUNTIFs over A1:Z1048576 fail at it in 17 s, well inside an export's
    // deadline.
    maxCellsRead: 32_000_000,
};

// Every reader of a stored workbook reads it in the transform process, which loads the Yjs doc first. `recalcError` is
// set when the recalc failed and the sheets keep their replayed values. The caller decides how to report it, such as a
// warning on the export.
export function readSheetsFromDoc(
    doc: Y.Doc,
    { recalc = true }: { recalc?: boolean } = {},
): { sheets: Sheet[]; recalcError: string | null } {
    const snapshot = readSheetsSnapshotJson(doc);
    const opBatches = sheetsOpLog(doc).toArray();
    // Ops without a snapshot come from a new workbook closed before its first compaction. They were recorded against the
    // editor's default sheets, so the replay starts from those, or it drops every edit. A doc with neither stays empty.
    const sheets = snapshot ? decodeSheetsSnapshot(snapshot) : opBatches.length > 0 ? createDefaultSheets() : [];
    // The snapshot stores cells as a list, but the renderers' conditional formats and the cross-sheet formula resolver
    // read the dense `data` matrix, so every sheet gets one. One far-flung cell, such as XFD1048576, makes a huge grid,
    // and the transform's deadline bounds it.
    const replayed = replaySheetsOps(sheets, opBatches).map(withMaterializedData);

    // Only a workbook nobody computed, with formulas but no calc chain, is recalculated here, such as an old xlsx
    // import. An edited workbook pays nothing. Only the export asks for it. A large recalc took 39 s, more than a
    // preview or a search extract may take, so those read the replayed values. A recalc that fails leaves the replayed
    // values, because an export must not fail on it.
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

// A compaction, in the transform process. It replays the log over the snapshot and encodes the result as an import
// does, and the main thread swaps it in. The batches come as JSON text, which crosses to the process much faster than
// the objects. A batch the replay rejects is skipped, as every reader skips it, and `dropped` counts them for the
// caller to log. A workbook with no snapshot yet starts from the default sheets the editor made its edits against.
export function compactSheetsSnapshot(
    snapshotJson: string | null,
    batchesJson: string,
): { snapshot: string; dropped: number } {
    const { sheets, computed } = snapshotJson
        ? decodeSheetsWorkbook(snapshotJson)
        : { sheets: createDefaultSheets(), computed: true };
    let dropped = 0;
    const replayed = replaySheetsOps(sheets, JSON.parse(batchesJson), () => dropped++);
    if (computed && !sheetsNeedRecalc(replayed)) {
        return { snapshot: encodeSheetsSnapshot(replayed, { computed: true }), dropped };
    }
    // A workbook nobody computed, such as an import whose recalc failed, is computed here, and so is one with a tab an
    // import added. Its exports then stop paying for the recalc. A recalc that fails stores the replayed values, and
    // an export tries again.
    try {
        return {
            snapshot: encodeSheetsSnapshot(recalcSheets(replayed, SERVER_RECALC_BUDGET), { computed: true }),
            dropped,
        };
    } catch (e) {
        console.warn('[sheets] server recalc failed, storing replayed values:', e instanceof Error ? e.message : e);
        return { snapshot: encodeSheetsSnapshot(replayed, { computed: false }), dropped };
    }
}

// The workbook as a tab opening the doc shows it: the stored snapshot, or the default sheets for a workbook with no
// snapshot yet, with every pending op replayed.
export function readLiveSheets(doc: Y.Doc): Sheet[] {
    const snapshot = readSheetsSnapshotJson(doc);
    const stored = snapshot ? decodeSheetsSnapshot(snapshot) : createDefaultSheets();
    return replaySheetsOps(stored, sheetsOpLog(doc).toArray());
}

// Puts a new snapshot into the live doc and empties the op log, whose edits the snapshot holds. The snapshot goes in as
// it came, never parsed here. A replacing import starts a fresh base, so an open tab loads the snapshot anew. A
// compaction passes its origin and names the base it folded, so a tab that holds that base keeps its grid.
export function writeSheetsSnapshotToYjs(doc: Y.Doc, snapshotJson: string, compactionOrigin?: symbol): void {
    doc.transact(() => {
        writeSheetsSnapshot(doc, snapshotJson, compactionOrigin ? (readSheetsBase(doc)?.id ?? null) : null);
        const ops = sheetsOpLog(doc);
        if (ops.length > 0) ops.delete(0, ops.length);
    }, compactionOrigin);
}

// A workbook opened without a base, such as a new one or one stored before bases existed, gets one. Then its first
// compaction names the base an open tab already holds, and the tab keeps its grid.
export function stampMissingSheetsBase(type: DrivePathType, doc: Y.Doc): void {
    if (type === DRIVE_TYPE_SHEETS && readSheetsBase(doc) === null) stampSheetsBase(doc, null);
}

// A version restore puts back the base the version was saved with. A workbook gets a fresh one, so an open tab can't
// take the restored snapshot for a compaction of the one it holds.
export function restampRestoredSheetsBase(type: DrivePathType, doc: Y.Doc): void {
    if (type === DRIVE_TYPE_SHEETS) stampSheetsBase(doc, null);
}

// Import… as new tabs. The file's sheets go in after the workbook's own as addSheet ops, the way a peer's new tab
// arrives, so an open tab adds them live and keeps its view and its undo. Each sheet takes a fresh id. One whose name the
// workbook already has is renamed the way Duplicate names a copy. The file's references to its own sheets follow them.
// Formulas, conditional formats, list sources and links name a sheet by name. Charts, link cells and the calc chain
// name it by id. `current` is the workbook as readLiveSheets reads it in the same write.
export function appendSheetsToYjs(doc: Y.Doc, snapshotJson: string, current: Sheet[]): void {
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
    sheetsOpLog(doc).push([added]);
}
