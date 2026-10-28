// A workbook's Yjs doc, read and written on the server. The transform process reads it as Sheet[] for an export, a
// preview or a search extract, replaying the pending ops over the snapshot as a browser does. An xlsx import writes it:
// a replace as a new snapshot, an insert as addSheet ops, weighed with the workbook against the caps of one import.

import type { Op, Sheet, SheetWithCalcChain } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '@workspace/lib/sheets';
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
import { ApiError } from '../core/errors';
import { IMPORT_MESSAGES } from '../import/messages';
import { MAX_CELLS, MAX_TEXT } from '../import/sheets/limits';

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

// Every reader of a stored workbook reads it in the transform process, which loads the Yjs doc first. `recalcError` is
// set when the recalc failed and the sheets keep their replayed values. The caller decides how to report it, such as a
// warning on the export.
export function readSheetsFromDoc(
    doc: Y.Doc,
    { recalc = true }: { recalc?: boolean } = {},
): { sheets: Sheet[]; recalcError: string | null } {
    const snapshot = readSheetsSnapshotJson(doc);
    const opBatches = doc.getArray<Op[]>('ops').toArray();
    // Ops without a snapshot come from a new workbook closed before its first flush. They were recorded against the
    // editor's default sheets, so the replay starts from those, or it drops every edit. A doc with neither stays empty.
    const sheets = snapshot ? decodeSheetsSnapshot(snapshot) : opBatches.length > 0 ? createDefaultSheets() : [];
    // The snapshot stores cells as a list, but the renderers' conditional formats and the cross-sheet formula resolver
    // read the dense `data` matrix, so every sheet gets one. One far-flung cell, such as XFD1048576, makes a huge grid,
    // and the transform's deadline bounds it.
    const replayed = replaySheetsOps(sheets, opBatches).map(withMaterializedData);

    // Only a workbook nobody computed, with formulas but no calc chain, is recalculated here, such as an old xlsx
    // import. An edited workbook pays nothing. Only the export asks for it: a large recalc took 39 s, past the 30 s a
    // preview or a search extract has, so those read the replayed values. A recalc that fails leaves the replayed
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

// The workbook's snapshot JSON; undefined before the first flush.
export function readSheetsSnapshotJson(doc: Y.Doc): string | undefined {
    return doc.getMap<string>('state').get('snapshot');
}

// A replacing import's commit. The transform's snapshot goes into the live doc as it came, never parsed here, and the
// pending ops go with the workbook they edited.
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
    const stored = snapshot ? decodeSheetsSnapshot(snapshot) : createDefaultSheets();
    const current = replaySheetsOps(stored, ops.toArray());
    const imported: SheetWithCalcChain[] = decodeSheetsSnapshot(snapshotJson);

    // The reader bounds each file alone, so the file is weighed here with the workbook it joins, against the same caps.
    // The cells are counted on the sheets this append decodes anyway, and the text is the snapshot's length. A sheet
    // added since the last flush is only an op until an open tab writes a new snapshot, so it is encoded to be measured.
    const { tooLarge } = IMPORT_MESSAGES.xlsx;
    const cells = [...current, ...imported].reduce((sum, sheet) => sum + (sheet.celldata?.length ?? 0), 0);
    if (cells > MAX_CELLS) throw new ApiError(413, tooLarge);
    const storedIds = new Set(stored.map((sheet) => sheet.id));
    const unflushed = current.filter((sheet) => !storedIds.has(sheet.id));
    const unflushedText = unflushed.length > 0 ? encodeSheetsSnapshot(unflushed, { computed: false }).length : 0;
    if ((snapshot?.length ?? 0) + unflushedText + snapshotJson.length > MAX_TEXT) throw new ApiError(413, tooLarge);

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
