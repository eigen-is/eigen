// Sheet protection: whether a cell is locked, whether a click may select it and whether the sheet allows formatting.
// Callers such as the mouse handlers, find and replace and conditional formats ask before they act. A sheet is
// protected only when its `config.authority.sheet` is set and not 0. A cell's own `lo` flag, an explicit per-cell
// lock, overrides that for checkCellIsLocked.

import { isNil } from 'es-toolkit/compat';
import type { Context } from '../context';
import { findSheet } from '../utils';

export function checkCellIsLocked(ctx: Context, r: number, c: number, sheetId: string) {
    const sheetFile = findSheet(ctx, sheetId);
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
    const sheetFile = findSheet(ctx, sheetId);
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
    const sheetFile = findSheet(ctx, sheetId);
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

// A protected sheet refuses a format change and puts its hint text in the warning dialog.
export function checkProtectionFormatCells(ctx: Context) {
    const sheetFile = findSheet(ctx, ctx.currentSheetId);
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
