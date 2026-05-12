import { isNil } from 'es-toolkit/compat';
import type { Context } from '../context';
import { getSheetByIndex } from '../utils';

// All four readers gate on `aut.sheet`: a missing authority field, missing
// `sheet`, or `sheet === 0` means the sheet is unprotected. The cell-level
// `lo` flag (an explicit per-cell lock) overrides this for `checkCellIsLocked`.

export function checkCellIsLocked(ctx: Context, r: number, c: number, sheetId: string) {
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return false;
    }
    const cell = sheetFile.data?.[r]?.[c];
    if (!isNil(cell?.lo)) {
        return !!cell?.lo;
    }
    const aut = sheetFile.config?.authority;
    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return false;
    }
    return true;
}

export function checkProtectionSelectLockedOrUnLockedCells(ctx: Context, r: number, c: number, sheetId: string) {
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return true;
    }
    const aut = sheetFile.config?.authority;
    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }

    const cell = sheetFile.data?.[r]?.[c];
    // lo === 0 means the cell is explicitly editable
    if (cell && cell.lo === 0) {
        return aut.selectunLockedCells === 1 || isNil(aut.selectunLockedCells);
    }
    return aut.selectLockedCells === 1 || isNil(aut.selectLockedCells);
}

export function checkProtectionAllSelected(ctx: Context, sheetId: string) {
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return true;
    }
    const aut = sheetFile.config?.authority;
    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }
    const selectunLocked = aut.selectunLockedCells === 1 || isNil(aut.selectunLockedCells);
    const selectLocked = aut.selectLockedCells === 1 || isNil(aut.selectLockedCells);
    return selectunLocked && selectLocked;
}

// formatCells authority, bl cl fc fz ff ct  border etc.
export function checkProtectionFormatCells(ctx: Context) {
    const sheetFile = getSheetByIndex(ctx, ctx.currentSheetId);
    if (isNil(sheetFile)) {
        return true;
    }
    const aut = sheetFile.config?.authority;
    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }
    ctx.warnDialog = aut.hintText || aut.defaultSheetHintText;
    return false;
}
