// The grid's keyboard. The Workbook hands each keydown to handleGlobalKeyDown, which moves the selection, commits an
// open edit on Enter or Tab, runs the ⌘ shortcuts and opens a cell when a key types into it. While a cell is open,
// the in-cell editor handles every other key, and a key during an IME composition is the IME's. SHEET_HOTKEYS defines
// every letter shortcut once: the key handlers match against it through TanStack's hotkey matcher, as the other apps'
// shortcuts do, and the menus show it.

import type { Hotkey } from '@tanstack/react-hotkeys';
import { matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import { REDO_ALT_HOTKEY, REDO_HOTKEY, UNDO_HOTKEY } from '@workspace/lib/constants/hotkeys';
import dayjs from 'dayjs';
import { cloneDeep, isEmpty, isNil } from 'es-toolkit/compat';
import { cellValue } from '../../engine/format';
import type { CellMatrix } from '../../engine/types';
import { moveCountPastHiddenRowCol } from '..';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { cancelNormalSelected, updateCell } from '../modules/cell';
import { openCellEditor } from '../modules/cell-editor';
import { cellFocus, checkboxChange, getCellDataValidation } from '../modules/data-validation';
import { fillFromEdge } from '../modules/drop-cell';
import { moveHighlightCell, moveHighlightRange, normalizeSelection, selectAll } from '../modules/selection';
import { handleBold, handleItalic, handleUnderline } from '../modules/toolbar';
import { getSheetIndex } from '../utils';
import { clearSelectedContents } from './clear';
import { handleCopy, handleCut } from './copy';

// Mod is ⌘ on a Mac and Ctrl elsewhere. A menu row shows its shortcut with formatForDisplay. Undo and redo are the
// keys of every other editor.
export const SHEET_HOTKEYS = {
    undo: UNDO_HOTKEY,
    redo: REDO_HOTKEY,
    redoAlt: REDO_ALT_HOTKEY,
    cut: 'Mod+X',
    copy: 'Mod+C',
    paste: 'Mod+V',
    bold: 'Mod+B',
    italic: 'Mod+I',
    underline: 'Mod+U',
    selectAll: 'Mod+A',
    fillDown: 'Mod+D',
    fillRight: 'Mod+R',
    focusLock: 'Control+Shift+F',
} as const satisfies Record<string, Hotkey>;

// Enter and Tab commit the open edit and select the edited cell, then each moves on from it.
function commitEdit(ctx: Context, cellInput: HTMLDivElement) {
    const [r, c] = ctx.editingCellPosition;
    updateCell(ctx, r, c, cellInput);
    ctx.selections = normalizeSelection(ctx, [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }]);
}

// Whether a key changes an editor's text, or only moves or commands: Backspace, Space and Delete do, and so does a
// key past the system keys that is no function key, NumLock or numpad equals. Of the Ctrl keys only a paste does.
export function typesIntoEditor(e: KeyboardEvent) {
    const key = e.keyCode;
    if (key === 8 || key === 32 || key === 46) return true;
    if (e.ctrlKey) return key === 86;
    return !e.altKey && key > 46 && !(key >= 112 && key <= 123) && key !== 144 && key !== 108;
}

// A key the IME is taking: anything during a composition, or a 229 in an open cell, because Safari fires the Enter that
// confirms a composition just after compositionend. On a closed cell a 229 is the key that starts typing, and opens it.
export function imeOwnsKey(e: KeyboardEvent, editing: boolean) {
    return e.isComposing || (editing && e.keyCode === 229);
}

export function handleGlobalEnter(ctx: Context, cellInput: HTMLDivElement, e: KeyboardEvent) {
    if ((e.altKey || e.metaKey) && ctx.editingCellPosition.length > 0) {
        e.preventDefault();
    } else if (ctx.editingCellPosition.length > 0) {
        commitEdit(ctx, cellInput);
        moveHighlightCell(ctx, 'down', 1, 'rangeOfSelect');
        e.preventDefault();
    } else if ((ctx.selections?.length ?? 0) > 0) {
        const last = ctx.selections?.at(-1);
        if (last?.row_focus == null || last.column_focus == null) return;
        openCellEditor(ctx, last.row_focus, last.column_focus, { caret: 'end' });
        e.preventDefault();
    }
}

function moveToEdge(
    sheetData: CellMatrix,
    key: string,
    curr: number,
    rowDelta: 0 | 1 | -1,
    colDelta: 0 | 1 | -1,
    startR: number,
    endR: number,
    startC: number,
    endC: number,
    maxRow: number,
    maxCol: number,
) {
    let selectedLimit = -1;
    if (key === 'ArrowUp') selectedLimit = startR - 1;
    else if (key === 'ArrowDown') selectedLimit = endR + 1;
    else if (key === 'ArrowLeft') selectedLimit = startC - 1;
    else if (key === 'ArrowRight') selectedLimit = endC + 1;

    const maxRowCol = colDelta === 0 ? maxRow : maxCol;
    let r = colDelta === 0 ? selectedLimit : curr;
    let c = colDelta === 0 ? curr : selectedLimit;

    while (r >= 0 && c >= 0 && (colDelta === 0 ? r : c) < maxRowCol - 1) {
        if (
            !isNil(cellValue(sheetData[r]?.[c])) &&
            (isNil(cellValue(sheetData[r - rowDelta]?.[c - colDelta])) ||
                isNil(cellValue(sheetData[r + rowDelta]?.[c + colDelta])))
        ) {
            break;
        }
        r += rowDelta;
        c += colDelta;
    }
    return colDelta === 0 ? r : c;
}

function handleControlPlusArrowKey(ctx: Context, e: KeyboardEvent, shiftPressed: boolean) {
    if (ctx.editingCellPosition.length > 0) return;

    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    if (isNil(idx)) return;

    // The grid's own size: a sheet's `row` and `column` are set only once a row or column is inserted.
    const sheetData = ctx.sheets[idx]?.data;
    if (!sheetData?.length) return;
    const maxRow = sheetData.length;
    const maxCol = sheetData[0]?.length ?? 0;
    const last = ctx.selections?.at(-1);
    if (!last) return;

    const currR = last.row_focus;
    const currC = last.column_focus;
    if (isNil(currR) || isNil(currC)) return;

    const startR = last.row[0];
    const endR = last.row[1];
    const startC = last.column[0];
    const endC = last.column[1];

    const horizontalOffset = currC - endC !== 0 ? currC - endC : currC - startC;
    const verticalOffset = currR - endR !== 0 ? currR - endR : currR - startR;

    let selectedLimit: number;

    switch (e.key) {
        case 'ArrowUp':
            selectedLimit = moveToEdge(sheetData, e.key, currC, -1, 0, startR, endR, startC, endC, maxRow, maxCol);
            if (shiftPressed) {
                moveHighlightRange(ctx, 'down', verticalOffset, 'rangeOfSelect');
                moveHighlightRange(ctx, 'down', selectedLimit - currR, 'rangeOfSelect');
            } else {
                moveHighlightCell(ctx, 'down', selectedLimit - currR, 'rangeOfSelect');
            }
            break;
        case 'ArrowDown':
            selectedLimit = moveToEdge(sheetData, e.key, currC, 1, 0, startR, endR, startC, endC, maxRow, maxCol);
            if (shiftPressed) {
                moveHighlightRange(ctx, 'down', verticalOffset, 'rangeOfSelect');
                moveHighlightRange(ctx, 'down', selectedLimit - currR, 'rangeOfSelect');
            } else {
                moveHighlightCell(ctx, 'down', selectedLimit - currR, 'rangeOfSelect');
            }
            break;
        case 'ArrowLeft':
            selectedLimit = moveToEdge(sheetData, e.key, currR, 0, -1, startR, endR, startC, endC, maxRow, maxCol);
            if (shiftPressed) {
                moveHighlightRange(ctx, 'right', horizontalOffset, 'rangeOfSelect');
                moveHighlightRange(ctx, 'right', selectedLimit - currC, 'rangeOfSelect');
            } else {
                moveHighlightCell(ctx, 'right', selectedLimit - currC, 'rangeOfSelect');
            }
            break;
        case 'ArrowRight':
            selectedLimit = moveToEdge(sheetData, e.key, currR, 0, 1, startR, endR, startC, endC, maxRow, maxCol);
            if (shiftPressed) {
                moveHighlightRange(ctx, 'right', horizontalOffset, 'rangeOfSelect');
                moveHighlightRange(ctx, 'right', selectedLimit - currC, 'rangeOfSelect');
            } else {
                moveHighlightCell(ctx, 'right', selectedLimit - currC, 'rangeOfSelect');
            }
            break;
        default:
            break;
    }
}

const floatingObjectSelected = (ctx: Context) => ctx.activeObject != null;

function handleWithCtrlOrMetaKey(ctx: Context, e: KeyboardEvent, cellInput: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (e.shiftKey) {
        ctx.shiftAnchor = cloneDeep(ctx.selections?.at(-1));
        ctx.shiftKeyDown = true;

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            handleControlPlusArrowKey(ctx, e, true);
        } else if ([';', '"', ':', "'"].includes(e.key)) {
            const last = ctx.selections?.at(-1);
            if (ctx.allowEdit === false || last?.row_focus == null || last.column_focus == null) return;

            const html = dayjs().format('YYYY-MM-DD HH:mm:ss');
            openCellEditor(ctx, last.row_focus, last.column_focus, { html, caret: 'end' });
        }
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        handleControlPlusArrowKey(ctx, e, false);
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.copy)) {
        // A selected chart or image copies itself in the Workbook's copy listener, and the cells behind it are not
        // marked copied.
        if (!floatingObjectSelected(ctx)) handleCopy(ctx);
        e.stopPropagation();
        return;
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.paste)) {
        // The browser fires its paste next, which the Workbook takes.
        e.stopPropagation();
        return;
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.cut)) {
        if (!floatingObjectSelected(ctx)) handleCut(ctx);
        e.stopPropagation();
        return;
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.bold)) {
        // Bold comes after cut, and italic after copy. The matcher falls back to the physical key, and Dvorak types
        // x on the B key and c on the I key.
        handleBold(ctx, cellInput);
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.italic)) {
        handleItalic(ctx, cellInput);
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.underline)) {
        handleUnderline(ctx, cellInput);
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.selectAll)) {
        selectAll(ctx);
    } else if (matchesKeyboardEvent(e, SHEET_HOTKEYS.fillDown) || matchesKeyboardEvent(e, SHEET_HOTKEYS.fillRight)) {
        const range = ctx.selections?.[0];
        if (!range) return;

        e.preventDefault();
        e.stopPropagation();
        fillFromEdge(ctx, range, matchesKeyboardEvent(e, SHEET_HOTKEYS.fillDown) ? 'down' : 'right');
    }

    e.preventDefault();
}

function handleShiftWithArrowKey(ctx: Context, e: KeyboardEvent) {
    if (ctx.editingCellPosition.length > 0) return;

    ctx.shiftAnchor = cloneDeep(ctx.selections?.at(-1));
    ctx.shiftKeyDown = true;

    switch (e.key) {
        case 'ArrowUp':
            moveHighlightRange(ctx, 'down', -1, 'rangeOfSelect');
            break;
        case 'ArrowDown':
            moveHighlightRange(ctx, 'down', 1, 'rangeOfSelect');
            break;
        case 'ArrowLeft':
            moveHighlightRange(ctx, 'right', -1, 'rangeOfSelect');
            break;
        case 'ArrowRight':
            moveHighlightRange(ctx, 'right', 1, 'rangeOfSelect');
            break;
        default:
            break;
    }

    e.preventDefault();
}

export function handleArrowKey(ctx: Context, e: KeyboardEvent) {
    if (ctx.editingCellPosition.length > 0 || ctx.cellSelectMoving || ctx.cellSelectExtending) {
        return;
    }

    const moveCount = moveCountPastHiddenRowCol(ctx, e.key);
    switch (e.key) {
        case 'ArrowUp':
            moveHighlightCell(ctx, 'down', -moveCount, 'rangeOfSelect');
            break;
        case 'ArrowDown':
            moveHighlightCell(ctx, 'down', moveCount, 'rangeOfSelect');
            break;
        case 'ArrowLeft':
            moveHighlightCell(ctx, 'right', -moveCount, 'rangeOfSelect');
            break;
        case 'ArrowRight':
            moveHighlightCell(ctx, 'right', moveCount, 'rangeOfSelect');
            break;
        default:
            break;
    }
}

// Space and Enter toggle the focused tick box, as in Google Sheets. Returns false for every other cell, so Enter and
// typing work as usual.
function toggleFocusedCheckbox(ctx: Context, kstr: string) {
    if (kstr !== ' ' && kstr !== 'Enter') return false;
    if (ctx.editingCellPosition.length > 0) return false;
    const selection = ctx.selections?.at(-1);
    if (selection?.row_focus == null || selection.column_focus == null) return false;
    return checkboxChange(ctx, selection.row_focus, selection.column_focus);
}

// Alt+Down opens the focused cell's list, as in Excel and Google Sheets. cellFocus positions the hidden Radix anchor,
// so it runs first, as on a mousedown. Returns false for every other cell and key.
function openFocusedDropdown(ctx: Context, e: KeyboardEvent) {
    if (!e.altKey || e.key !== 'ArrowDown') return false;
    if (ctx.editingCellPosition.length > 0 || ctx.allowEdit === false) return false;
    const selection = ctx.selections?.at(-1);
    if (selection?.row_focus == null || selection.column_focus == null) return false;
    const { row_focus: r, column_focus: c } = selection;
    if (getCellDataValidation(ctx, r, c)?.type !== 'dropdown') return false;
    cellFocus(ctx, r, c);
    ctx.validationListOpen = true;
    return true;
}

export function handleGlobalKeyDown(ctx: Context, cellInput: HTMLDivElement, e: KeyboardEvent) {
    if (imeOwnsKey(e, ctx.editingCellPosition.length > 0)) return;

    ctx.selectionActive = false;
    const kstr = e.key;
    if (ctx.filterContextMenu) {
        return;
    }

    if (kstr === 'Escape' && ctx.formulaRangeSelections) {
        ctx.formulaRangeSelections = [];
    }

    const allowEdit = ctx.allowEdit !== false;

    if (
        ctx.editingCellPosition.length > 0 &&
        kstr !== 'Enter' &&
        kstr !== 'Tab' &&
        kstr !== 'ArrowUp' &&
        kstr !== 'ArrowDown' &&
        kstr !== 'ArrowLeft' &&
        kstr !== 'ArrowRight'
    ) {
        return;
    }

    // A released focus lock lets keys fall through to the host app, so a keyboard user can tab out of the grid. This
    // runs whatever sheetFocused says, so the lock can be re-taken from anywhere inside the workbook.
    if (matchesKeyboardEvent(e, SHEET_HOTKEYS.focusLock)) {
        ctx.sheetFocused = !ctx.sheetFocused;
        e.preventDefault();

        if (ctx.sheetFocused) {
            cellInput.setAttribute('tabindex', '-1');
            cellInput.focus();
        }

        return;
    }
    if (!ctx.sheetFocused) {
        return;
    }
    if (toggleFocusedCheckbox(ctx, kstr)) {
        e.preventDefault();
    } else if (openFocusedDropdown(ctx, e)) {
        e.preventDefault();
    } else if (kstr === 'Enter') {
        if (!allowEdit) return;
        handleGlobalEnter(ctx, cellInput, e);
    } else if (kstr === 'Tab') {
        if (ctx.editingCellPosition.length > 0) commitEdit(ctx, cellInput);
        moveHighlightCell(ctx, 'right', e.shiftKey ? -1 : 1, 'rangeOfSelect');
        e.preventDefault();
    } else if (kstr === 'F2') {
        if (!allowEdit) return;
        if (ctx.editingCellPosition.length > 0) {
            return;
        }

        const last = ctx.selections?.at(-1);
        if (last?.row_focus == null || last.column_focus == null) return;

        openCellEditor(ctx, last.row_focus, last.column_focus, { caret: 'end' });
        e.preventDefault();
    } else if (kstr === 'Escape' && ctx.editingCellPosition.length > 0) {
        cancelNormalSelected(ctx);
        moveHighlightCell(ctx, 'down', 0, 'rangeOfSelect');
        e.preventDefault();
    } else if (kstr === 'Escape') {
        // Not editing: the key bubbles to the document, where the find bar's Escape hotkey dismisses it.
        return;
    } else if (e.ctrlKey || e.metaKey) {
        handleWithCtrlOrMetaKey(ctx, e, cellInput);
        return;
    } else if (
        e.shiftKey &&
        (kstr === 'ArrowUp' || kstr === 'ArrowDown' || kstr === 'ArrowLeft' || kstr === 'ArrowRight')
    ) {
        handleShiftWithArrowKey(ctx, e);
    } else if (kstr === 'Delete' || kstr === 'Backspace') {
        if (!allowEdit) return;
        clearSelectedContents(ctx);
        e.preventDefault();
    } else if (kstr === 'ArrowUp' || kstr === 'ArrowDown' || kstr === 'ArrowLeft' || kstr === 'ArrowRight') {
        handleArrowKey(ctx, e);
    } else if (typesIntoEditor(e) || e.keyCode === 0) {
        if (!allowEdit) return;
        // With no selection a typed key has no cell to open, so it must not land in the hidden editor either. A key
        // typed into another field of the workbook, such as a toolbar input, still reaches that field.
        if (isEmpty(ctx.selections)) {
            if (e.target === cellInput) e.preventDefault();
        } else {
            const last = ctx.selections?.at(-1);
            if (last?.row_focus == null || last.column_focus == null) return;
            openCellEditor(ctx, last.row_focus, last.column_focus, { html: '' });
        }
    }

    if (cellInput !== document.activeElement) {
        cellInput?.focus();
    }

    e.stopPropagation();
}
