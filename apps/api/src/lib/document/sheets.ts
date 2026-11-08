// A workbook's Yjs doc, read and written on the server. The transform process reads it as Sheet[], for example for an
// export or a preview, and replays the pending ops over the snapshot as a browser does. It also folds the ops into a
// new snapshot when the document closes. Some writers change the doc through it, such as an import that adds tabs or
// a version restore that stamps a fresh base.

import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    decodeSheetsSnapshot,
    encodeSheetsSnapshot,
    readSheetsBase,
    readSheetsSnapshotJson,
    sheetsOpLog,
    stampSheetsBase,
} from '@workspace/lib/sheets';
import type { DrivePathType } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_SHEETS } from '@workspace/lib/types/drive';
import {
    copySheetName,
    decodeOrDefault,
    mapChartRefs,
    recalcSheets,
    renameSheetTexts,
    replaySheetsOps,
    sheetFinder,
    sheetNameKey,
    withMaterializedData,
} from '@workspace/sheet/engine';
import type * as Y from 'yjs';

// What the server's recalc lets an untrusted workbook's formulas cost. Past any bound the recalc fails like any other,
// and the sheets keep the values they hold.
export const SERVER_RECALC_BUDGET = {
    // The slots the dependency index lists each range in, the range cut to its sheet. A range lies in the 64 × 16 blocks
    // it meets, but a long range from the top or left takes one slot per column or row instead.
    maxDependencySlots: 280_000_000,
    // The index entries the formula cells' lookups visit, whether a range covers the cell or not. A range that covers
    // no cell makes no link, so the links alone would not bound the time spent counting.
    maxDependencyVisits: 90_000_000,
    // The links between formulas, one per formula cell a formula reads. They bound the graph's memory, which the slots
    // don't, because a whole column costs one slot but many formulas reading it make many links.
    maxDependencyEdges: 40_000_000,
    // The cells the evaluation of ranges reads, which bounds the recalc time.
    maxCellsRead: 32_000_000,
};

// Every reader of a stored workbook reads it in the transform process, which loads the Yjs doc first. `recalcError` is
// set when the recalc failed and the sheets keep their replayed values. The caller decides how to report it, such as a
// warning on the export.
export function readSheetsFromDoc(
    doc: Y.Doc,
    { recalc = true }: { recalc?: boolean } = {},
): { sheets: Sheet[]; recalcError: string | null } {
    const { sheets, computed } = decodeOrDefault(readSheetsSnapshotJson(doc));
    // The snapshot stores cells as a list, but the renderers' conditional formats and the cross-sheet formula resolver
    // read the dense `data` matrix, so every sheet gets one. One far-flung cell, such as XFD1048576, makes a huge grid,
    // and the transform's deadline bounds it.
    const replayed = replaySheetsOps(sheets, sheetsOpLog(doc).toArray()).map(withMaterializedData);

    // Only a workbook nobody computed is recalculated here, such as an xlsx import whose recalc failed. Only the export
    // asks for it, because a recalc can outlast a preview or a search extract. A recalc that fails leaves the replayed
    // values, because an export must not fail on it.
    if (!recalc || computed) return { sheets: replayed, recalcError: null };
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
// caller to log.
export function compactSheetsSnapshot(
    snapshotJson: string | null,
    batchesJson: string,
): { snapshot: string; dropped: number } {
    const { sheets, computed } = decodeOrDefault(snapshotJson);
    let dropped = 0;
    const replayed = replaySheetsOps(sheets, JSON.parse(batchesJson), () => dropped++);
    // The compaction never recalculates, so a workbook nobody computed stays uncomputed, and an export computes it.
    return { snapshot: encodeSheetsSnapshot(replayed, { computed }), dropped };
}

// The workbook as a tab opening the doc shows it, with every pending op replayed.
export function readLiveSheets(doc: Y.Doc): Sheet[] {
    return replaySheetsOps(decodeOrDefault(readSheetsSnapshotJson(doc)).sheets, sheetsOpLog(doc).toArray());
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
// Formulas, conditional formats, list sources and links name a sheet by name. Charts and link cells name it by id. `current` is the workbook as readLiveSheets reads it in the same write.
export function appendSheetsToYjs(doc: Y.Doc, snapshotJson: string, current: Sheet[]): void {
    const imported = decodeSheetsSnapshot(snapshotJson);
    const taken = current.map((sheet) => sheet.name);
    const renames = new Map<string, string>();
    const fresh = imported.map((sheet) => {
        const clashes = taken.some((other) => sheetNameKey(other) === sheetNameKey(sheet.name));
        const name = clashes ? copySheetName(sheet.name, taken) : sheet.name;
        if (name !== sheet.name) renames.set(sheet.name, name);
        taken.push(name);
        return { id: crypto.randomUUID(), name };
    });
    const ids = new Map(imported.map((sheet, i) => [sheet.id, fresh[i].id]));
    const findImported = sheetFinder(imported);

    const added = imported.map((source, i): Op => {
        const { id, name } = fresh[i];
        const sheet = renameSheetTexts(source, findImported, renames);
        for (const { v } of sheet.celldata ?? []) {
            if (v?.hl) v.hl.id = id;
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
