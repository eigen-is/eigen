import { escapeHtml } from '@workspace/lib/html';
import type { Context } from '../context';
import type { RangeOrWholeAxis, Rect } from '../types';
import { seletedHighlistByindex } from '.';
import { getRangetxt, mergeMoveMain } from './cell';
import { colors } from './color';
import { moveToEnd } from './cursor';
import { formulaUIState, setFunctionHTMLIndex } from './formula-cache';
import { israngeseleciton } from './formula-editor';
import { getcellrange } from './formula-exec';
import { colLocation, mousePosition, rowLocation } from './location';

function parseElement(eleString: string) {
    return new DOMParser().parseFromString(eleString, 'text/html').body.childNodes[0];
}

export function createFormulaRangeSelect(ctx: Context, select: { rangeIndex: number } & Rect) {
    ctx.formulaRangeSelect = select;
}

export function createRangeHightlight(ctx: Context, inputInnerHtmlStr: string, ignoreRangeIndex = -1) {
    const $span = parseElement(`<div>${inputInnerHtmlStr}</div>`) as HTMLElement;
    const formulaRanges: {
        rangeIndex: number;
        left: number;
        top: number;
        width: number;
        height: number;
        backgroundColor: string;
    }[] = [];
    for (const ele of $span.querySelectorAll('span.fortune-formula-functionrange-cell')) {
        const rangeIndex = parseInt(ele.getAttribute('rangeindex') || '0', 10);
        if (rangeIndex === ignoreRangeIndex) continue;
        const cellrange = getcellrange(ctx, ele.textContent || '');
        if (rangeIndex === ctx.formulaCache.selectingRangeIndex || cellrange == null) continue;
        if (
            cellrange.sheetId === ctx.currentSheetId ||
            (!cellrange.sheetId && ctx.formulaCache.rangetosheet === ctx.currentSheetId)
        ) {
            const rect = seletedHighlistByindex(
                ctx,
                cellrange.row[0],
                cellrange.row[1],
                cellrange.column[0],
                cellrange.column[1],
            );
            if (rect) {
                formulaRanges.push({
                    rangeIndex,
                    ...rect,
                    backgroundColor: colors[rangeIndex],
                });
            }
        }
    }
    ctx.formulaRangeHighlight = formulaRanges;
}

export function setCaretPosition(ctx: Context, textDom: HTMLElement, children: number, pos: number) {
    try {
        const el = textDom;
        const range = document.createRange();
        const sel = window.getSelection();
        range.setStart(el.childNodes[children], pos);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        el.focus();
    } catch (err) {
        console.error(err);
        moveToEnd(ctx.formulaCache.rangeResizeTo![0]);
    }
}

export function rangeSetValue(
    ctx: Context,
    cellInput: HTMLDivElement,
    selected: RangeOrWholeAxis,
    fxInput?: HTMLDivElement | null,
) {
    let $editor = cellInput;
    let $copyTo = fxInput;
    if (document.activeElement?.id === 'luckysheet-functionbox-cell') {
        $editor = fxInput!;
        $copyTo = cellInput;
    }
    let range = '';
    const rf = selected.row[0];
    const cf = selected.column[0];
    if (rf !== null && cf !== null && ctx.config.merge != null && `${rf}_${cf}` in ctx.config.merge) {
        range = getRangetxt(
            ctx,
            ctx.currentSheetId,
            {
                column: [cf, cf],
                row: [rf, rf],
            },
            ctx.formulaCache.rangetosheet,
        );
    } else {
        range = getRangetxt(ctx, ctx.currentSheetId, selected, ctx.formulaCache.rangetosheet);
    }

    if (
        !israngeseleciton(ctx) &&
        (ctx.formulaCache.rangestart || ctx.formulaCache.rangedrag_column_start || ctx.formulaCache.rangedrag_row_start)
    ) {
        const span = $editor.querySelector(
            `span[rangeindex='${ctx.formulaCache.rangechangeindex}']`,
        ) as HTMLSpanElement;
        if (span) {
            // `range` embeds the sheet's name, which updateSheetName only screens for the
            // six characters a reference may not contain — markup is a legal sheet name,
            // and this is innerHTML. The caret offset stays the RAW length: that is what
            // the browser renders, where the escaped markup is longer (commit ac3ff70df).
            span.innerHTML = escapeHtml(range);
            setCaretPosition(ctx, span, 0, range.length);
        }
    } else {
        const function_str = `<span class="fortune-formula-functionrange-cell" rangeindex="${formulaUIState.functionHTMLIndex}" dir="auto" style="color:${colors[formulaUIState.functionHTMLIndex]};">${escapeHtml(range)}</span>`;
        const newEle = parseElement(function_str);
        const refEle = ctx.formulaCache.rangeSetValueTo;
        if (refEle?.parentNode) {
            const leftPar = document.getElementsByClassName('luckysheet-formula-text-lpar')?.[0];

            // handle case when user autocompletes the formula
            if (leftPar?.parentElement?.classList.contains('luckysheet-formula-text-color')) {
                document.getElementsByClassName('luckysheet-formula-text-lpar')?.[0].parentNode?.appendChild(newEle);
            } else {
                refEle.parentNode.insertBefore(newEle, refEle.nextSibling);
            }
        } else {
            $editor.appendChild(newEle);
        }
        ctx.formulaCache.rangechangeindex = formulaUIState.functionHTMLIndex;
        const span = $editor.querySelector(
            `span[rangeindex='${ctx.formulaCache.rangechangeindex}']`,
        ) as HTMLSpanElement;

        setCaretPosition(ctx, span, 0, range.length);
        setFunctionHTMLIndex(formulaUIState.functionHTMLIndex + 1);
    }

    if ($copyTo) $copyTo.innerHTML = $editor.innerHTML;
}

export function onFormulaRangeDragEnd(ctx: Context) {
    if (ctx.formulaCache.func_selectedrange) {
        const {
            left_move: left,
            top_move: top,
            width_move: width,
            height_move: height,
        } = ctx.formulaCache.func_selectedrange;
        if (
            left != null &&
            top != null &&
            width != null &&
            height != null &&
            (ctx.formulaCache.rangestart ||
                ctx.formulaCache.rangedrag_column_start ||
                ctx.formulaCache.rangedrag_row_start)
        )
            ctx.formulaRangeSelect = {
                rangeIndex: ctx.formulaCache.rangeIndex || 0,
                left,
                top,
                width,
                height,
            };
    }
    ctx.formulaCache.selectingRangeIndex = -1;
}

// The formula range select renders once per overlay pane region; write every
// copy — each region's clip shows exactly its portion.
function setRangeSelect(container: HTMLDivElement, left: number, top: number, height: number, width: number) {
    for (const rangeElement of container.querySelectorAll<HTMLDivElement>('.fortune-formula-functionrange-select')) {
        rangeElement.style.left = `${left}px`;
        rangeElement.style.top = `${top}px`;
        rangeElement.style.height = `${height}px`;
        rangeElement.style.width = `${width}px`;
    }
}

export function rangeDrag(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollLeft: number,
    scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const { func_selectedrange } = ctx.formulaCache;
    if (
        !func_selectedrange ||
        func_selectedrange.left == null ||
        func_selectedrange.height == null ||
        func_selectedrange.top == null ||
        func_selectedrange.width == null
    )
        return;
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop;

    const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);

    const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

    let top = 0;
    let height = 0;
    let rowseleted = [];

    if (func_selectedrange.top > row_pre) {
        top = row_pre;
        height = func_selectedrange.top + func_selectedrange.height - row_pre;
        rowseleted = [row_index, func_selectedrange.row[1]];
    } else if (func_selectedrange.top === row_pre) {
        top = row_pre;
        height = func_selectedrange.top + func_selectedrange.height - row_pre;
        rowseleted = [row_index, func_selectedrange.row[0]];
    } else {
        top = func_selectedrange.top;
        height = row - func_selectedrange.top - 1;
        rowseleted = [func_selectedrange.row[0], row_index];
    }

    let left = 0;
    let width = 0;
    let columnseleted = [];

    if (func_selectedrange.left > col_pre) {
        left = col_pre;
        width = func_selectedrange.left + func_selectedrange.width - col_pre;
        columnseleted = [col_index, func_selectedrange.column[1]];
    } else if (func_selectedrange.left === col_pre) {
        left = col_pre;
        width = func_selectedrange.left + func_selectedrange.width - col_pre;
        columnseleted = [col_index, func_selectedrange.column[0]];
    } else {
        left = func_selectedrange.left;
        width = col - func_selectedrange.left - 1;
        columnseleted = [func_selectedrange.column[0], col_index];
    }

    const changeparam = mergeMoveMain(ctx, columnseleted, rowseleted, func_selectedrange, top, height, left, width);
    if (changeparam != null) {
        [columnseleted, rowseleted, top, height, left, width] = changeparam;
    }

    func_selectedrange.row = rowseleted;
    func_selectedrange.column = columnseleted;

    func_selectedrange.left_move = left;
    func_selectedrange.width_move = width;
    func_selectedrange.top_move = top;
    func_selectedrange.height_move = height;

    rangeSetValue(
        ctx,
        cellInput,
        {
            row: rowseleted,
            column: columnseleted,
        },
        fxInput,
    );

    setRangeSelect(container, left, top, height, width);
    e.preventDefault();
}

export function rangeDragColumn(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollLeft: number,
    _scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const { func_selectedrange } = ctx.formulaCache;
    if (
        !func_selectedrange ||
        func_selectedrange.left == null ||
        func_selectedrange.height == null ||
        func_selectedrange.top == null ||
        func_selectedrange.width == null
    )
        return;
    const mouse = mousePosition(e.pageX, e.pageY, ctx);
    const x = mouse[0] + scrollLeft;

    const { visibledatarow } = ctx;
    const row_index = visibledatarow.length - 1;
    const row = visibledatarow[row_index];
    const row_pre = 0;

    const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

    let left = 0;
    let width = 0;
    let columnseleted = [];

    if (func_selectedrange.left > col_pre) {
        left = col_pre;
        width = func_selectedrange.left + func_selectedrange.width - col_pre;
        columnseleted = [col_index, func_selectedrange.column[1]];
    } else if (func_selectedrange.left === col_pre) {
        left = col_pre;
        width = func_selectedrange.left + func_selectedrange.width - col_pre;
        columnseleted = [col_index, func_selectedrange.column[0]];
    } else {
        left = func_selectedrange.left;
        width = col - func_selectedrange.left - 1;
        columnseleted = [func_selectedrange.column[0], col_index];
    }

    const changeparam = mergeMoveMain(
        ctx,
        columnseleted,
        [0, row_index],
        func_selectedrange,
        row_pre,
        row - row_pre - 1,
        left,
        width,
    );
    if (changeparam != null) {
        [columnseleted, , , , left, width] = changeparam;
    }

    func_selectedrange.column = columnseleted;
    func_selectedrange.left_move = left;
    func_selectedrange.width_move = width;

    rangeSetValue(
        ctx,
        cellInput,
        {
            row: [null, null],
            column: columnseleted,
        },
        fxInput,
    );

    setRangeSelect(container, left, row_pre, row - row_pre - 1, width);
}

export function rangeDragRow(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    _scrollLeft: number,
    scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const { func_selectedrange } = ctx.formulaCache;
    if (
        !func_selectedrange ||
        func_selectedrange.left == null ||
        func_selectedrange.height == null ||
        func_selectedrange.top == null ||
        func_selectedrange.width == null
    )
        return;

    const mouse = mousePosition(e.pageX, e.pageY, ctx);
    const y = mouse[1] + scrollTop;

    const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);

    const { visibledatacolumn } = ctx;
    const col_index = visibledatacolumn.length - 1;
    const col = visibledatacolumn[col_index];
    const col_pre = 0;

    let top = 0;
    let height = 0;
    let rowseleted = [];

    if (func_selectedrange.top > row_pre) {
        top = row_pre;
        height = func_selectedrange.top + func_selectedrange.height - row_pre;
        rowseleted = [row_index, func_selectedrange.row[1]];
    } else if (func_selectedrange.top === row_pre) {
        top = row_pre;
        height = func_selectedrange.top + func_selectedrange.height - row_pre;
        rowseleted = [row_index, func_selectedrange.row[0]];
    } else {
        top = func_selectedrange.top;
        height = row - func_selectedrange.top - 1;
        rowseleted = [func_selectedrange.row[0], row_index];
    }

    const changeparam = mergeMoveMain(
        ctx,
        [0, col_index],
        rowseleted,
        func_selectedrange,
        top,
        height,
        col_pre,
        col - col_pre - 1,
    );
    if (changeparam != null) {
        [, rowseleted, top, height] = changeparam;
    }

    func_selectedrange.row = rowseleted;
    func_selectedrange.top_move = top;
    func_selectedrange.height_move = height;

    rangeSetValue(
        ctx,
        cellInput,
        {
            row: rowseleted,
            column: [null, null],
        },
        fxInput,
    );
    setRangeSelect(container, col_pre, top, height, col - col_pre - 1);
}
