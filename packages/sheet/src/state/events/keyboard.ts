// The grid's keyboard. The Workbook hands each keydown to handleGlobalKeyDown, which moves the selection, commits an
// open edit on Enter or Tab, runs the ⌘ shortcuts and opens a cell when a key types into it. While a cell is open,
// the in-cell editor handles every other key. SHEET_HOTKEYS defines every letter shortcut once: the key handlers
// match against it through TanStack's hotkey matcher, as the other apps' shortcuts do, and the menus show it.

import type { Hotkey } from '@tanstack/react-hotkeys';
import { matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import { cloneDeep, isEmpty, isNil } from 'es-toolkit/compat';
import { cellValue } from '../../engine/format';
import type { CellMatrix } from '../../engine/types';
import { hideCRCount } from '..';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { cancelNormalSelected, updateCell } from '../modules/cell';
import { handleCut } from '../modules/clipboard';
import { cellFocus, checkboxChange, getCellDataVerification } from '../modules/data-verification';
import { fillFromEdge } from '../modules/drop-cell';
import { handleFormulaInput } from '../modules/formula-editor';
import { moveHighlightCell, moveHighlightRange, selectAll, selectionCache } from '../modules/selection';
import { handleBold, handleItalic, handleUnderline } from '../modules/toolbar';
import type { GlobalCache, Selection } from '../types';
import { getNowDateTime, getSheetIndex, isAllowEdit } from '../utils';
import { clearSelectedContents } from './clear';
import { handleCopy } from './copy';

// Mod is ⌘ on a Mac and Ctrl elsewhere. A menu row shows its shortcut with formatForDisplay.
export const SHEET_HOTKEYS = {
    undo: 'Mod+Z',
    redo: 'Mod+Shift+Z',
    redoAlt: 'Mod+Y',
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
function commitEdit(ctx: Context, cellInput: HTMLDivElement, canvas?: CanvasRenderingContext2D) {
    const [r, c] = ctx.editingCellPosition;
    updateCell(ctx, r, c, cellInput, undefined, canvas);
    ctx.selections = [
        {
            row: [r, r],
            column: [c, c],
            row_focus: r,
            column_focus: c,
        },
    ];
}

export function handleGlobalEnter(
    ctx: Context,
    cellInput: HTMLDivElement,
    e: KeyboardEvent,
    canvas?: CanvasRenderingContext2D,
) {
    if ((e.altKey || e.metaKey) && ctx.editingCellPosition.length > 0) {
        e.preventDefault();
    } else if (ctx.editingCellPosition.length > 0) {
        commitEdit(ctx, cellInput, canvas);
        moveHighlightCell(ctx, 'down', 1, 'rangeOfSelect');
        e.preventDefault();
    } else if ((ctx.selections?.length ?? 0) > 0) {
        const last = ctx.selections?.at(-1);
        if (last?.row_focus == null || last.column_focus == null) return;
        ctx.editingCellPosition = [last.row_focus, last.column_focus];
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
    const last: Selection | undefined =
        ctx.selections && ctx.selections.length > 0 ? ctx.selections[ctx.selections.length - 1] : undefined;
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

export function handleWithCtrlOrMetaKey(
    ctx: Context,
    cache: GlobalCache,
    e: KeyboardEvent,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (e.shiftKey) {
        ctx.shiftAnchor = cloneDeep(ctx.selections?.[ctx.selections.length - 1]);
        ctx.shiftKeyDown = true;

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            // Ctrl + Shift + Arrow: extend selection toward next edge
            handleControlPlusArrowKey(ctx, e, true);
        } else if ([';', '"', ':', "'"].includes(e.key)) {
            const last = ctx.selections?.[ctx.selections.length - 1];
            if (!last || last.row_focus == null || last.column_focus == null) return;

            const row_index = last.row_focus;
            const col_index = last.column_focus;
            updateCell(ctx, row_index, col_index, cellInput);
            ctx.editingCellPosition = [row_index, col_index];

            cache.ignoreWriteCell = true;
            cellInput.innerText = getNowDateTime(2);
            handleFormulaInput(ctx, fxInput, cellInput, e.keyCode);
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
        // A paste into several ranges is not supported.
        if ((ctx.selections?.length ?? 0) > 1) {
            return;
        }

        selectionCache.isPasteAction = true;
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

    ctx.shiftAnchor = cloneDeep(ctx.selections?.[ctx.selections.length - 1]);
    ctx.shiftKeyDown = true;

    // Shift + Arrow: extend selection by one cell
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

    const moveCount = hideCRCount(ctx, e.key);
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

// Space/Enter toggle the focused tick box — Google's keyboard route to the box
// the mousedown hit-test reaches. Returns false for every other cell, so the
// normal Enter/printable-input handling runs unchanged.
function toggleFocusedCheckbox(ctx: Context, kstr: string) {
    if (kstr !== ' ' && kstr !== 'Enter') return false;
    if (ctx.editingCellPosition.length > 0) return false;
    const selection = ctx.selections?.[ctx.selections.length - 1];
    if (selection?.row_focus == null || selection.column_focus == null) return false;
    return checkboxChange(ctx, selection.row_focus, selection.column_focus);
}

// Alt+Down opens the focused cell's list — Excel's and Google's shortcut, and the
// keyboard's only route to the chevron the canvas paints on every list cell.
// cellFocus is what positions the hidden Radix anchor, so it runs first, exactly as
// the mousedown path does. Returns false for every other cell and key.
function openFocusedDropdown(ctx: Context, e: KeyboardEvent) {
    if (!e.altKey || e.key !== 'ArrowDown') return false;
    if (ctx.editingCellPosition.length > 0 || !isAllowEdit(ctx)) return false;
    const selection = ctx.selections?.[ctx.selections.length - 1];
    if (selection?.row_focus == null || selection.column_focus == null) return false;
    const { row_focus: r, column_focus: c } = selection;
    if (getCellDataVerification(ctx, r, c)?.type !== 'dropdown') return false;
    cellFocus(ctx, r, c);
    ctx.dataVerificationDropDownList = true;
    return true;
}

export function handleGlobalKeyDown(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    e: KeyboardEvent,
    cache: GlobalCache,
    canvas?: CanvasRenderingContext2D,
) {
    ctx.selectionActive = false;
    const kcode = e.keyCode;
    const kstr = e.key;
    if (ctx.filterContextMenu) {
        return;
    }

    if (kstr === 'Escape' && ctx.formulaRangeSelections) {
        ctx.formulaRangeSelections = [];
    }

    const allowEdit = isAllowEdit(ctx);

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

    // SHEET_HOTKEYS.focusLock toggles the sheet's focus lock: released, keys fall through to the host
    // app so a keyboard user can tab out of the grid. Runs independently of sheetFocused so the
    // lock can be re-taken from anywhere inside the workbook — the keydown listener is on the
    // workbook container, so focus that has left it can't come back this way.
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
        handleGlobalEnter(ctx, cellInput, e, canvas);
    } else if (kstr === 'Tab') {
        if (ctx.editingCellPosition.length > 0) commitEdit(ctx, cellInput, canvas);
        moveHighlightCell(ctx, 'right', e.shiftKey ? -1 : 1, 'rangeOfSelect');
        e.preventDefault();
    } else if (kstr === 'F2') {
        if (!allowEdit) return;
        if (ctx.editingCellPosition.length > 0) {
            return;
        }

        const last = ctx.selections?.[ctx.selections.length - 1];
        if (!last || last.row_focus == null || last.column_focus == null) return;

        ctx.editingCellPosition = [last.row_focus, last.column_focus];
        e.preventDefault();
    } else if (kstr === 'Escape' && ctx.editingCellPosition.length > 0) {
        cancelNormalSelected(ctx);
        moveHighlightCell(ctx, 'down', 0, 'rangeOfSelect');
        e.preventDefault();
    } else if (kstr === 'Escape') {
        // Not editing: bubble to document (skip the tail's focus-steal + stopPropagation) so the
        // shared find bar's document-level Escape hotkey can dismiss it.
        return;
    } else if (e.ctrlKey || e.metaKey) {
        handleWithCtrlOrMetaKey(ctx, cache, e, cellInput, fxInput);
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
    } else if (
        // Allow printable input through to the cell input box. Reject:
        // function keys (F1-F12 = 112-123), modifier/system keys (kcode <= 46
        // except backspace/space/delete/0), NumLock (144), Numpad equals (108),
        // and modified key combos handled elsewhere — but always allow
        // Backspace (8), Space (32), Delete (46) and key 0.
        !(
            (kcode >= 112 && kcode <= 123) ||
            kcode <= 46 ||
            kcode === 144 ||
            kcode === 108 ||
            e.ctrlKey ||
            e.altKey ||
            (e.shiftKey && (kcode === 37 || kcode === 38 || kcode === 39 || kcode === 40))
        ) ||
        kcode === 8 ||
        kcode === 32 ||
        kcode === 46 ||
        kcode === 0
    ) {
        if (!allowEdit) return;
        if (!isEmpty(ctx.selections) && kstr !== 'CapsLock' && kcode !== 18) {
            // Activate the input box and forward the keypress to it.
            const last = ctx.selections?.at(-1);
            if (last?.row_focus == null || last.column_focus == null) return;
            ctx.editingCellPosition = [last.row_focus, last.column_focus];
            cache.overwriteCell = true;

            handleFormulaInput(ctx, fxInput, cellInput, kcode);
        }
    }

    if (cellInput !== document.activeElement) {
        cellInput?.focus();
    }

    e.stopPropagation();
}
