import { isNil } from 'es-toolkit/compat';
import type { Context } from '../context';
import { getSheetByIndex } from '../utils';

export function checkCellIsLocked(ctx: Context, r: number, c: number, sheetId: string) {
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return false;
    }
    const { data } = sheetFile;
    const cell = data?.[r]?.[c];
    // cell have lo attribute
    if (!isNil(cell?.lo)) {
        return !!cell?.lo;
    }

    // default locked status from sheet config
    const aut = sheetFile.config?.authority;
    const sheetInEditable = isNil(aut) || isNil(aut.sheet) || aut.sheet === 0;
    return !sheetInEditable;
}

export function checkProtectionSelectLockedOrUnLockedCells(ctx: Context, r: number, c: number, sheetId: string) {
    //   const _locale = locale();
    //   const local_protection = _locale.protection;
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return true;
    }

    if (isNil(sheetFile.config) || isNil(sheetFile.config.authority)) {
        return true;
    }

    const aut = sheetFile.config.authority;

    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }

    const { data } = sheetFile;
    const cell = data?.[r]?.[c];

    if (cell && cell.lo === 0) {
        // lo === 0 means the cell is editable
        if (aut.selectunLockedCells === 1 || isNil(aut.selectunLockedCells)) {
            return true;
        }
        return false;
    }
    // locked??
    const isAllEdit = false;
    // TODO  const isAllEdit = checkProtectionLockedSqref(
    //     r,
    //     c,
    //     aut,
    //     local_protection,
    //     false
    //   ); // dont alert password model
    if (isAllEdit) {
        // unlocked
        if (aut.selectunLockedCells === 1 || isNil(aut.selectunLockedCells)) {
            return true;
        }
        return false;
    }
    // locked
    if (aut.selectLockedCells === 1 || isNil(aut.selectLockedCells)) {
        return true;
    }
    return false;
}

export function checkProtectionAllSelected(ctx: Context, sheetId: string) {
    const sheetFile = getSheetByIndex(ctx, sheetId);
    if (isNil(sheetFile)) {
        return true;
    }

    if (isNil(sheetFile.config) || isNil(sheetFile.config.authority)) {
        return true;
    }

    const aut = sheetFile.config.authority;

    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }

    let selectunLockedCells = false;
    if (aut.selectunLockedCells === 1 || isNil(aut.selectunLockedCells)) {
        selectunLockedCells = true;
    }

    let selectLockedCells = false;
    if (aut.selectLockedCells === 1 || isNil(aut.selectLockedCells)) {
        selectLockedCells = true;
    }

    if (selectunLockedCells && selectLockedCells) {
        return true;
    }

    return false;
}

// formatCells authority, bl cl fc fz ff ct  border etc.
export function checkProtectionFormatCells(ctx: Context) {
    const sheetFile = getSheetByIndex(ctx, ctx.currentSheetId);

    if (isNil(sheetFile)) {
        return true;
    }
    if (isNil(sheetFile.config) || isNil(sheetFile.config.authority)) {
        return true;
    }
    const aut = sheetFile.config.authority;
    if (isNil(aut) || isNil(aut.sheet) || aut.sheet === 0) {
        return true;
    }

    let ht = '';
    if (!isNil(aut.hintText) && aut.hintText.length > 0) {
        ht = aut.hintText;
    } else {
        ht = aut.defaultSheetHintText;
    }
    ctx.warnDialog = ht;
    return false;
}
