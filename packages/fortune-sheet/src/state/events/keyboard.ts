import { cloneDeep, isEmpty, isNil } from 'es-toolkit/compat';
import type { CellMatrix } from '../../engine/types';
import { hideCRCount, removeActiveImage } from '..';
import { type Context, getFlowdata } from '../context';
import { cancelNormalSelected, updateCell } from '../modules/cell';
import { handleCut } from '../modules/clipboard';
import { handleFormulaInput } from '../modules/formula-ui';
import { jfrefreshgrid } from '../modules/refresh';
import {
    deleteSelectedCellText,
    moveHighlightCell,
    moveHighlightRange,
    selectAll,
    selectionCache,
} from '../modules/selection';
import { handleBold } from '../modules/toolbar';
import type { GlobalCache, Selection } from '../types';
import { getNowDateTime, getSheetIndex, isAllowEdit } from '../utils';
import { handleCopy } from './copy';

export function handleGlobalEnter(
    ctx: Context,
    cellInput: HTMLDivElement,
    e: KeyboardEvent,
    canvas?: CanvasRenderingContext2D,
) {
    if ((e.altKey || e.metaKey) && ctx.luckysheetCellUpdate.length > 0) {
        e.preventDefault();
    } else if (ctx.luckysheetCellUpdate.length > 0) {
        const [r, c] = ctx.luckysheetCellUpdate;
        updateCell(ctx, r, c, cellInput, undefined, canvas);
        ctx.luckysheet_select_save = [
            {
                row: [r, r],
                column: [c, c],
                row_focus: r,
                column_focus: c,
            },
        ];
        moveHighlightCell(ctx, 'down', 1, 'rangeOfSelect');
        e.preventDefault();
    } else if ((ctx.luckysheet_select_save?.length ?? 0) > 0) {
        const last = ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1];
        if (last.row_focus == null || last.column_focus == null) return;
        ctx.luckysheetCellUpdate = [last.row_focus, last.column_focus];
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
            !isNil(sheetData?.[r]?.[c]?.v) &&
            (isNil(sheetData?.[r - rowDelta]?.[c - colDelta]?.v) || isNil(sheetData?.[r + rowDelta]?.[c + colDelta]?.v))
        ) {
            break;
        }
        r += rowDelta;
        c += colDelta;
    }
    return colDelta === 0 ? r : c;
}

function handleControlPlusArrowKey(ctx: Context, e: KeyboardEvent, shiftPressed: boolean) {
    if (ctx.luckysheetCellUpdate.length > 0) return;

    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    if (isNil(idx)) return;

    const file = ctx.luckysheetfile[idx];
    if (!file?.row || !file.column) return;
    const maxRow = file.row;
    const maxCol = file.column;
    const last: Selection | undefined =
        ctx.luckysheet_select_save && ctx.luckysheet_select_save.length > 0
            ? ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1]
            : undefined;
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

    const sheetData = file.data;
    if (!sheetData) return;
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

export function handleWithCtrlOrMetaKey(
    ctx: Context,
    cache: GlobalCache,
    e: KeyboardEvent,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    handleUndo: () => void,
    handleRedo: () => void,
) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (e.shiftKey) {
        ctx.luckysheet_shiftpositon = cloneDeep(ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1]);
        ctx.luckysheet_shiftkeydown = true;

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            // Ctrl + Shift + Arrow: extend selection toward next edge
            handleControlPlusArrowKey(ctx, e, true);
        } else if ([';', '"', ':', "'"].includes(e.key)) {
            const last = ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
            if (!last || last.row_focus == null || last.column_focus == null) return;

            const row_index = last.row_focus;
            const col_index = last.column_focus;
            updateCell(ctx, row_index, col_index, cellInput);
            ctx.luckysheetCellUpdate = [row_index, col_index];

            cache.ignoreWriteCell = true;
            cellInput.innerText = getNowDateTime(2);
            handleFormulaInput(ctx, fxInput, cellInput, e.keyCode);
        } else if (e.code === 'KeyZ') {
            // Ctrl + Shift + Z: redo
            handleRedo();
            e.stopPropagation();
            return;
        }
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        handleControlPlusArrowKey(ctx, e, false);
    } else if (e.code === 'KeyB') {
        // Ctrl + B: bold
        handleBold(ctx, cellInput);
    } else if (e.code === 'KeyC') {
        // Ctrl + C: copy
        handleCopy(ctx);
        e.stopPropagation();
        return;
    } else if (e.code === 'KeyF') {
        // Ctrl + F: find
        ctx.showSearch = true;
    } else if (e.code === 'KeyH') {
        // Ctrl + H: replace
        ctx.showReplace = true;
    } else if (e.code === 'KeyV') {
        // Ctrl + V: paste — multi-range selections are not supported, bail
        if ((ctx.luckysheet_select_save?.length ?? 0) > 1) {
            return;
        }

        selectionCache.isPasteAction = true;
        e.stopPropagation();
        return;
    } else if (e.code === 'KeyX') {
        handleCut(ctx);
        e.stopPropagation();
        return;
    } else if (e.code === 'KeyZ') {
        // Ctrl + Z: undo
        handleUndo();
        e.stopPropagation();
        return;
    } else if (e.code === 'KeyA') {
        // Ctrl + A: select all
        selectAll(ctx);
    } else if (e.code === 'KeyD') {
        if (!ctx.luckysheet_select_save || ctx.luckysheet_select_save.length === 0) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const selectedRange = ctx.luckysheet_select_save[0];
        const { row, column } = selectedRange;

        if (!row || !column) return;
        if (!isAllowEdit(ctx)) return;

        for (let col = column[0]; col <= column[1]; col += 1) {
            const sourceCell = flowdata?.[row[0]]?.[col];

            if (!sourceCell) continue;

            const sourceValue = sourceCell.v;
            const sourceFormula = sourceCell.f;

            for (let r = row[0] + 1; r <= row[1]; r += 1) {
                if (sourceFormula) {
                    // Shift relative row refs down by the row offset; keep $-anchored absolutes
                    const newFormula = sourceFormula.replace(
                        /(\$?[A-Z]+)(\$?)(\d+)/g,
                        (match, colRef, dollar, rowNum) => {
                            return dollar ? match : `${colRef}${parseInt(rowNum, 10) + (r - row[0])}`;
                        },
                    );

                    updateCell(ctx, r, col, null, newFormula);
                } else {
                    updateCell(ctx, r, col, null, sourceValue);
                }
            }
        }

        jfrefreshgrid(ctx, null, undefined);
    } else if (e.code === 'KeyR') {
        if (!ctx.luckysheet_select_save || ctx.luckysheet_select_save.length === 0) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const selectedRange = ctx.luckysheet_select_save[0];
        const { row, column } = selectedRange;

        if (!row || !column) return;
        if (!isAllowEdit(ctx)) return;

        for (let r = row[0]; r <= row[1]; r += 1) {
            const sourceCell = flowdata?.[r]?.[column[0]];

            if (!sourceCell) continue;

            const sourceValue = sourceCell.v;
            const sourceFormula = sourceCell.f;

            for (let c = column[0] + 1; c <= column[1]; c += 1) {
                if (sourceFormula) {
                    // Shift relative col refs right by the col offset; keep $-anchored absolutes
                    const newFormula = sourceFormula.replace(
                        /(\$?[A-Z]+)(\$?)(\d+)/g,
                        (match, colRef, dollar, rowNum) => {
                            if (dollar) return match;
                            const colIndex = colRef.charCodeAt(0) - 65 + (c - column[0]);
                            return `${String.fromCharCode(65 + colIndex)}${rowNum}`;
                        },
                    );

                    updateCell(ctx, r, c, null, newFormula);
                } else {
                    updateCell(ctx, r, c, null, sourceValue);
                }
            }
        }

        jfrefreshgrid(ctx, null, undefined);
    }

    e.preventDefault();
}

function handleShiftWithArrowKey(ctx: Context, e: KeyboardEvent) {
    if (ctx.luckysheetCellUpdate.length > 0) return;

    ctx.luckysheet_shiftpositon = cloneDeep(ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1]);
    ctx.luckysheet_shiftkeydown = true;

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
    if (
        ctx.luckysheetCellUpdate.length > 0 ||
        ctx.luckysheet_cell_selected_move ||
        ctx.luckysheet_cell_selected_extend
    ) {
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

export function handleGlobalKeyDown(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    e: KeyboardEvent,
    cache: GlobalCache,
    handleUndo: () => void,
    handleRedo: () => void,
    canvas?: CanvasRenderingContext2D,
) {
    ctx.luckysheet_select_status = false;
    const kcode = e.keyCode;
    const kstr = e.key;
    if (!isEmpty(ctx.contextMenu) || ctx.filterContextMenu) {
        return;
    }

    if (kstr === 'Escape' && !!ctx.luckysheet_selection_range) {
        ctx.luckysheet_selection_range = [];
    }

    const allowEdit = isAllowEdit(ctx);

    if (
        ctx.luckysheetCellUpdate.length > 0 &&
        kstr !== 'Enter' &&
        kstr !== 'Tab' &&
        kstr !== 'ArrowUp' &&
        kstr !== 'ArrowDown' &&
        kstr !== 'ArrowLeft' &&
        kstr !== 'ArrowRight'
    ) {
        return;
    }

    // Ctrl + Shift + F toggles focus between the sheet (cell input) and the host app toolbar.
    // Runs independently of sheetFocused so the user can grab focus back from the toolbar.
    if (e.ctrlKey && e.shiftKey && kstr === 'F') {
        ctx.sheetFocused = !ctx.sheetFocused;
        e.preventDefault();

        if (ctx.sheetFocused) {
            const selectedCell = document.querySelector<HTMLElement>('.luckysheet-cell-input');
            if (selectedCell) {
                selectedCell.setAttribute('tabindex', '-1');
                selectedCell.focus();
            }
        } else {
            const toolbar = document.querySelector<HTMLElement>('.fortune-toolbar');
            if (toolbar) {
                toolbar.setAttribute('tabindex', '-1');
                toolbar.focus();
            }
        }

        return;
    }
    if (!ctx.sheetFocused) {
        return;
    }
    if (kstr === 'Enter') {
        if (!allowEdit) return;
        handleGlobalEnter(ctx, cellInput, e, canvas);
    } else if (kstr === 'Tab') {
        if (ctx.luckysheetCellUpdate.length > 0) {
            return;
        }

        if (e.shiftKey) {
            moveHighlightCell(ctx, 'right', -1, 'rangeOfSelect');
        } else {
            moveHighlightCell(ctx, 'right', 1, 'rangeOfSelect');
        }
        e.preventDefault();
    } else if (kstr === 'F2') {
        if (!allowEdit) return;
        if (ctx.luckysheetCellUpdate.length > 0) {
            return;
        }

        const last = ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1];
        if (!last || last.row_focus == null || last.column_focus == null) return;

        ctx.luckysheetCellUpdate = [last.row_focus, last.column_focus];
        e.preventDefault();
    } else if (kstr === 'F4' && ctx.luckysheetCellUpdate.length > 0) {
        // TODO: toggle absolute/relative refs in the formula editor (formula.setfreezonFuc)
        e.preventDefault();
    } else if (kstr === 'Escape' && ctx.luckysheetCellUpdate.length > 0) {
        cancelNormalSelected(ctx);
        moveHighlightCell(ctx, 'down', 0, 'rangeOfSelect');
        e.preventDefault();
    } else if (e.ctrlKey || e.metaKey) {
        handleWithCtrlOrMetaKey(ctx, cache, e, cellInput, fxInput, handleUndo, handleRedo);
        return;
    } else if (
        e.shiftKey &&
        (kstr === 'ArrowUp' || kstr === 'ArrowDown' || kstr === 'ArrowLeft' || kstr === 'ArrowRight')
    ) {
        handleShiftWithArrowKey(ctx, e);
    } else if (kstr === 'Escape') {
        ctx.contextMenu = {};
    } else if (kstr === 'Delete' || kstr === 'Backspace') {
        if (!allowEdit) return;
        if (ctx.activeImg != null) {
            removeActiveImage(ctx);
        } else {
            deleteSelectedCellText(ctx);
        }

        jfrefreshgrid(ctx, null, undefined);
        e.preventDefault();
    } else if (kstr === 'ArrowUp' || kstr === 'ArrowDown' || kstr === 'ArrowLeft' || kstr === 'ArrowRight') {
        handleArrowKey(ctx, e);
    } else if (
        // Allow printable input through to the cell input box. Reject:
        // function keys (F1-F12 = 112-123), modifier/system keys (kcode <= 46
        // except backspace/space/delete/0), NumLock (144), Numpad equals (108),
        // and modified key combos handled elsewhere — but always allow
        // Backspace (8), Space (32), Delete (46), key 0, and Ctrl+V (86).
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
        kcode === 0 ||
        (e.ctrlKey && kcode === 86)
    ) {
        if (!allowEdit) return;
        if (!isEmpty(ctx.luckysheet_select_save) && kstr !== 'CapsLock' && kcode !== 18) {
            // Activate the input box and forward the keypress to it.
            const last = ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1];
            if (last.row_focus == null || last.column_focus == null) return;
            ctx.luckysheetCellUpdate = [last.row_focus, last.column_focus];
            cache.overwriteCell = true;

            handleFormulaInput(ctx, fxInput, cellInput, kcode);
        }
    }

    if (cellInput !== document.activeElement) {
        cellInput?.focus();
    }

    e.stopPropagation();
}
