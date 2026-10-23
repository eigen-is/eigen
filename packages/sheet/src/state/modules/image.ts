import { CHART_MAX_SIDE } from '@workspace/lib/charts';
import { nextFloatingIndex, sheetFloatingBox } from '@workspace/lib/sheets';
import type { Patch } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import { type Context, getFlowdata } from '../context';
import type { GlobalCache } from '../types';
import { mergeBorder } from '.';
import { editableCurrentSheet } from './floating';

// A pending upload's name is swapped for the real one on every sheet: the user may have switched tabs since the insert.
export function replaceImageMediaName(ctx: Context, oldName: string, newName: string) {
    if (ctx.allowEdit === false) return;
    for (const sheet of ctx.sheets) {
        for (const image of Object.values(sheet.images ?? {}))
            if (image.mediaName === oldName) image.mediaName = newName;
    }
}

export function removeImageByMediaName(ctx: Context, name: string) {
    if (ctx.allowEdit === false) return;
    for (const sheet of ctx.sheets) {
        for (const image of Object.values(sheet.images ?? {}))
            if (image.mediaName === name) delete sheet.images?.[image.id];
    }
}

// The swap of a pending name records no undo step, so an entry that brings its image back, a redone insert or an undone
// delete, would still bring the pending name, which resolves to nothing; it takes the real name too.
export function replaceMediaNameInHistory(
    history: Pick<GlobalCache, 'undoList' | 'redoList'>,
    oldName: string,
    newName: string,
) {
    const rename = (patch: Patch): Patch =>
        patch.path[2] === 'images' && patch.path.length === 4 && patch.value?.mediaName === oldName
            ? { ...patch, value: { ...patch.value, mediaName: newName } }
            : patch;
    for (const entry of [...history.undoList, ...history.redoList]) {
        entry.patches = entry.patches.map(rename);
        entry.inversePatches = entry.inversePatches.map(rename);
    }
}

// Where an inserted or pasted floating object lands: the top-left of the selected cell, or of its merge.
export function selectedCellOrigin(ctx: Context): { x: number; y: number } {
    const last = ctx.selections?.[ctx.selections.length - 1];
    let rowIndex = last?.row_focus;
    let colIndex = last?.column_focus;
    if (!last) {
        rowIndex = 0;
        colIndex = 0;
    } else {
        if (rowIndex == null) {
            [rowIndex] = last.row;
        }
        if (colIndex == null) {
            [colIndex] = last.column;
        }
    }
    const flowdata = getFlowdata(ctx);
    let left = colIndex === 0 ? 0 : ctx.visibledatacolumn[colIndex - 1];
    let top = rowIndex === 0 ? 0 : ctx.visibledatarow[rowIndex - 1];
    if (flowdata) {
        const margeset = mergeBorder(ctx, flowdata, rowIndex, colIndex);
        if (margeset) {
            [top] = margeset.row;
            [left] = margeset.column;
        }
    }
    return { x: left, y: top };
}

// Stored at the size the caller gives (a fit to the pane, or a pasted item's own box), scaled down whole to the largest
// side every floating object is clamped to, so a large image keeps its aspect. The id is a uuid: two peers inserting
// at once must never write one key.
export function insertImage(ctx: Context, mediaName: string, width: number, height: number, angle = 0) {
    const sheet = editableCurrentSheet(ctx);
    if (!sheet) return;
    const id = uuidv4();
    const scale = Math.min(1, CHART_MAX_SIDE / width, CHART_MAX_SIDE / height);
    const images = (sheet.images ??= {});
    const box = sheetFloatingBox({ ...selectedCellOrigin(ctx), width: width * scale, height: height * scale, angle });
    images[id] = { id, index: nextFloatingIndex(sheet), mediaName, ...box };
}
