import _ from "lodash";
import type {Context} from "../context";
import type {Rect} from "../types";
import {columnCharToIndex, indexToColumnChar} from "../utils";
import {getRangetxt, mergeMoveMain} from "./cell";
import {error} from "./validation";
import {moveToEnd} from "./cursor";
import {colLocation, mousePosition, rowLocation} from "./location";
import {seletedHighlistByindex} from ".";
import {
    colors,
    formulaUIState,
    getcellrange,
    iscelldata,
    operatorjson,
    setFunctionHTMLIndex,
} from "./formula-ui";
import {israngeseleciton} from "./formula-editor";

function parseElement(eleString: string) {
    return new DOMParser().parseFromString(eleString, "text/html").body
        .childNodes[0];
}

export function createFormulaRangeSelect(
    ctx: Context,
    select: { rangeIndex: number } & Rect
) {
    ctx.formulaRangeSelect = select;
}

export function createRangeHightlight(
    ctx: Context,
    inputInnerHtmlStr: string,
    ignoreRangeIndex = -1
) {
    const $span = parseElement(`<div>${inputInnerHtmlStr}</div>`) as HTMLElement;
    const formulaRanges: {
        rangeIndex: number;
        left: number;
        top: number;
        width: number;
        height: number;
        backgroundColor: string;
    }[] = [];
    $span
        .querySelectorAll("span.fortune-formula-functionrange-cell")
        .forEach((ele) => {
            const rangeIndex = parseInt(ele.getAttribute("rangeindex") || "0", 10);
            if (rangeIndex === ignoreRangeIndex) return;
            const cellrange = getcellrange(ctx, ele.textContent || "");
            if (
                rangeIndex === ctx.formulaCache.selectingRangeIndex ||
                cellrange == null
            )
                return;
            if (
                cellrange.sheetId === ctx.currentSheetId ||
                (!cellrange.sheetId &&
                    ctx.formulaCache.rangetosheet === ctx.currentSheetId)
            ) {
                const rect = seletedHighlistByindex(
                    ctx,
                    cellrange.row[0],
                    cellrange.row[1],
                    cellrange.column[0],
                    cellrange.column[1]
                );
                if (rect) {
                    formulaRanges.push({
                        rangeIndex,
                        ...rect,
                        backgroundColor: colors[rangeIndex],
                    });
                }
            }
        });
    ctx.formulaRangeHighlight = formulaRanges;
}

export function setCaretPosition(
    ctx: Context,
    textDom: HTMLElement,
    children: number,
    pos: number
) {
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
        moveToEnd(ctx.formulaCache.rangeResizeTo[0]);
    }
}

export function rangeSetValue(
    ctx: Context,
    cellInput: HTMLDivElement,
    selected: any,
    fxInput?: HTMLDivElement | null
) {
    let $editor = cellInput;
    let $copyTo = fxInput;
    if (document.activeElement?.id === "luckysheet-functionbox-cell") {
        $editor = fxInput!;
        $copyTo = cellInput;
    }
    let range = "";
    const rf = selected.row[0];
    const cf = selected.column[0];
    if (ctx.config.merge != null && `${rf}_${cf}` in ctx.config.merge) {
        range = getRangetxt(
            ctx,
            ctx.currentSheetId,
            {
                column: [cf, cf],
                row: [rf, rf],
            },
            ctx.formulaCache.rangetosheet
        );
    } else {
        range = getRangetxt(
            ctx,
            ctx.currentSheetId,
            selected,
            ctx.formulaCache.rangetosheet
        );
    }

    if (
        !israngeseleciton(ctx) &&
        (ctx.formulaCache.rangestart ||
            ctx.formulaCache.rangedrag_column_start ||
            ctx.formulaCache.rangedrag_row_start)
    ) {
        const span = $editor.querySelector(
            `span[rangeindex='${ctx.formulaCache.rangechangeindex}']`
        ) as HTMLSpanElement;
        if (span) {
            span.innerHTML = range;
            setCaretPosition(ctx, span, 0, range.length);
        }
    } else {
        const function_str = `<span class="fortune-formula-functionrange-cell" rangeindex="${formulaUIState.functionHTMLIndex}" dir="auto" style="color:${colors[formulaUIState.functionHTMLIndex]};">${range}</span>`;
        const newEle = parseElement(function_str);
        const refEle = ctx.formulaCache.rangeSetValueTo;
        if (refEle && refEle.parentNode) {
            const leftPar = document.getElementsByClassName(
                "luckysheet-formula-text-lpar"
            )?.[0];

            // handle case when user autocompletes the formula
            if (
                leftPar?.parentElement?.classList.contains(
                    "luckysheet-formula-text-color"
                )
            ) {
                document
                    .getElementsByClassName("luckysheet-formula-text-lpar")?.[0]
                    .parentNode?.appendChild(newEle);
            } else {
                refEle.parentNode.insertBefore(newEle, refEle.nextSibling);
            }
        } else {
            $editor.appendChild(newEle);
        }
        ctx.formulaCache.rangechangeindex = formulaUIState.functionHTMLIndex;
        const span = $editor.querySelector(
            `span[rangeindex='${ctx.formulaCache.rangechangeindex}']`
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

function setRangeSelect(
    container: HTMLDivElement,
    left: number,
    top: number,
    height: number,
    width: number
) {
    const rangeElement = container.querySelector(
        ".fortune-formula-functionrange-select"
    ) as HTMLDivElement;
    if (rangeElement == null) return;
    rangeElement.style.left = `${left}px`;
    rangeElement.style.top = `${top}px`;
    rangeElement.style.height = `${height}px`;
    rangeElement.style.width = `${width}px`;
}

export function rangeDrag(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollLeft: number,
    scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null
) {
    const {func_selectedrange} = ctx.formulaCache;
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

    const changeparam = mergeMoveMain(
        ctx,
        columnseleted,
        rowseleted,
        func_selectedrange,
        top,
        height,
        left,
        width
    );
    if (changeparam != null) {
        // @ts-ignore
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
        fxInput
    );

    setRangeSelect(container, left, top, height, width);
    e.preventDefault();
}

export function rangeDragColumn(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollLeft: number,
    scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null
) {
    const {func_selectedrange} = ctx.formulaCache;
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

    const {visibledatarow} = ctx;
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
        width
    );
    if (changeparam != null) {
        // @ts-ignore
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
        fxInput
    );

    setRangeSelect(container, left, row_pre, row - row_pre - 1, width);
}

export function rangeDragRow(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollLeft: number,
    scrollTop: number,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null
) {
    const {func_selectedrange} = ctx.formulaCache;
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

    const {visibledatacolumn} = ctx;
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
        col - col_pre - 1
    );
    if (changeparam != null) {
        // @ts-ignore
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
        fxInput
    );
    setRangeSelect(container, col_pre, top, height, col - col_pre - 1);
}

function isfreezonFuc(txt: string) {
    const row = txt.replace(/[^0-9]/g, "");
    const col = txt.replace(/[^A-Za-z]/g, "");
    const row$ = txt.substr(txt.indexOf(row) - 1, 1);
    const col$ = txt.substr(txt.indexOf(col) - 1, 1);
    const ret = [false, false];

    if (row$ === "$") {
        ret[0] = true;
    }
    if (col$ === "$") {
        ret[1] = true;
    }

    return ret;
}

function updateparam(orient: string, txt: string, step: number) {
    const val = txt.split("!");
    let rangetxt;
    let prefix = "";

    if (val.length > 1) {
        [, rangetxt] = val;
        prefix = `${val[0]}!`;
    } else {
        [rangetxt] = val;
    }

    if (rangetxt.indexOf(":") === -1) {
        let row = parseInt(rangetxt.replace(/[^0-9]/g, ""), 10);
        let col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ""));
        const freezonFuc = isfreezonFuc(rangetxt);
        const $row = freezonFuc[0] ? "$" : "";
        const $col = freezonFuc[1] ? "$" : "";

        if (orient === "u" && !freezonFuc[0]) {
            row -= step;
        } else if (orient === "r" && !freezonFuc[1]) {
            col += step;
        } else if (orient === "l" && !freezonFuc[1]) {
            col -= step;
        } else if (orient === "d" && !freezonFuc[0]) {
            row += step;
        }

        if (!Number.isNaN(row) && !Number.isNaN(col)) {
            return prefix + $col + indexToColumnChar(col) + $row + row;
        }
        if (!Number.isNaN(row)) {
            return prefix + $row + row;
        }
        if (!Number.isNaN(col)) {
            return prefix + $col + indexToColumnChar(col);
        }
        return txt;
    }
    rangetxt = rangetxt.split(":");
    const row = [];
    const col = [];

    row[0] = parseInt(rangetxt[0].replace(/[^0-9]/g, ""), 10);
    row[1] = parseInt(rangetxt[1].replace(/[^0-9]/g, ""), 10);
    if (row[0] > row[1]) {
        return txt;
    }

    col[0] = columnCharToIndex(rangetxt[0].replace(/[^A-Za-z]/g, ""));
    col[1] = columnCharToIndex(rangetxt[1].replace(/[^A-Za-z]/g, ""));
    if (col[0] > col[1]) {
        return txt;
    }

    const freezonFuc0 = isfreezonFuc(rangetxt[0]);
    const freezonFuc1 = isfreezonFuc(rangetxt[1]);
    const $row0 = freezonFuc0[0] ? "$" : "";
    const $col0 = freezonFuc0[1] ? "$" : "";
    const $row1 = freezonFuc1[0] ? "$" : "";
    const $col1 = freezonFuc1[1] ? "$" : "";

    if (orient === "u") {
        if (!freezonFuc0[0]) {
            row[0] -= step;
        }

        if (!freezonFuc1[0]) {
            row[1] -= step;
        }
    } else if (orient === "r") {
        if (!freezonFuc0[1]) {
            col[0] += step;
        }

        if (!freezonFuc1[1]) {
            col[1] += step;
        }
    } else if (orient === "l") {
        if (!freezonFuc0[1]) {
            col[0] -= step;
        }

        if (!freezonFuc1[1]) {
            col[1] -= step;
        }
    } else if (orient === "d") {
        if (!freezonFuc0[0]) {
            row[0] += step;
        }

        if (!freezonFuc1[0]) {
            row[1] += step;
        }
    }

    if (row[0] < 0 || col[0] < 0) {
        return error.r;
    }

    if (Number.isNaN(col[0]) && Number.isNaN(col[1])) {
        return `${prefix + $row0 + row[0]}:${$row1}${row[1]}`;
    }
    if (Number.isNaN(row[0]) && Number.isNaN(row[1])) {
        return `${
            prefix + $col0 + indexToColumnChar(col[0])
        }:${$col1}${indexToColumnChar(col[1])}`;
    }
    return `${
        prefix + $col0 + indexToColumnChar(col[0]) + $row0 + row[0]
    }:${$col1}${indexToColumnChar(col[1])}${$row1}${row[1]}`;
}

function downparam(txt: string, step: number) {
    return updateparam("d", txt, step);
}

function upparam(txt: string, step: number) {
    return updateparam("u", txt, step);
}

function leftparam(txt: string, step: number) {
    return updateparam("l", txt, step);
}

function rightparam(txt: string, step: number) {
    return updateparam("r", txt, step);
}

function functionStrChange_range(
    txt: string,
    type: string,
    rc: "row" | "col",
    orient: string | null,
    stindex: number,
    step: number
) {
    const val = txt.split("!");
    let rangetxt;
    let prefix = "";

    if (val.length > 1) {
        [, rangetxt] = val;
        prefix = `${val[0]}!`;
    } else {
        [rangetxt] = val;
    }

    let r1;
    let r2;
    let c1;
    let c2;
    let $row0;
    let $row1;
    let $col0;
    let $col1;

    if (rangetxt.indexOf(":") === -1) {
        r1 = parseInt(rangetxt.replace(/[^0-9]/g, ""), 10) - 1;
        r2 = r1;
        c1 = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ""));
        c2 = c1;

        const freezonFuc = isfreezonFuc(rangetxt);

        $row0 = freezonFuc[0] ? "$" : "";
        $row1 = $row0;
        $col0 = freezonFuc[1] ? "$" : "";
        $col1 = $col0;
    } else {
        rangetxt = rangetxt.split(":");

        r1 = parseInt(rangetxt[0].replace(/[^0-9]/g, ""), 10) - 1;
        r2 = parseInt(rangetxt[1].replace(/[^0-9]/g, ""), 10) - 1;
        if (r1 > r2) {
            return txt;
        }

        c1 = columnCharToIndex(rangetxt[0].replace(/[^A-Za-z]/g, ""));
        c2 = columnCharToIndex(rangetxt[1].replace(/[^A-Za-z]/g, ""));
        if (c1 > c2) {
            return txt;
        }

        const freezonFuc0 = isfreezonFuc(rangetxt[0]);
        $row0 = freezonFuc0[0] ? "$" : "";
        $col0 = freezonFuc0[1] ? "$" : "";

        const freezonFuc1 = isfreezonFuc(rangetxt[1]);
        $row1 = freezonFuc1[0] ? "$" : "";
        $col1 = freezonFuc1[1] ? "$" : "";
    }

    if (type === "del") {
        if (rc === "row") {
            if (r1 >= stindex && r2 <= stindex + step - 1) {
                return error.r;
            }

            if (r1 > stindex + step - 1) {
                r1 -= step;
            } else if (r1 >= stindex) {
                r1 = stindex;
            }

            if (r2 > stindex + step - 1) {
                r2 -= step;
            } else if (r2 >= stindex) {
                r2 = stindex - 1;
            }

            if (r1 < 0) {
                r1 = 0;
            }

            if (r2 < r1) {
                r2 = r1;
            }
        } else if (rc === "col") {
            if (c1 >= stindex && c2 <= stindex + step - 1) {
                return error.r;
            }

            if (c1 > stindex + step - 1) {
                c1 -= step;
            } else if (c1 >= stindex) {
                c1 = stindex;
            }

            if (c2 > stindex + step - 1) {
                c2 -= step;
            } else if (c2 >= stindex) {
                c2 = stindex - 1;
            }

            if (c1 < 0) {
                c1 = 0;
            }

            if (c2 < c1) {
                c2 = c1;
            }
        }

        if (r1 === r2 && c1 === c2) {
            if (!Number.isNaN(r1) && !Number.isNaN(c1)) {
                return prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1);
            }
            if (!Number.isNaN(r1)) {
                return prefix + $row0 + (r1 + 1);
            }
            if (!Number.isNaN(c1)) {
                return prefix + $col0 + indexToColumnChar(c1);
            }
            return txt;
        }
        if (Number.isNaN(c1) && Number.isNaN(c2)) {
            return `${prefix + $row0 + (r1 + 1)}:${$row1}${r2 + 1}`;
        }
        if (Number.isNaN(r1) && Number.isNaN(r2)) {
            return `${
                prefix + $col0 + indexToColumnChar(c1)
            }:${$col1}${indexToColumnChar(c2)}`;
        }
        return `${
            prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1)
        }:${$col1}${indexToColumnChar(c2)}${$row1}${r2 + 1}`;
    }
    if (type === "add") {
        if (rc === "row") {
            if (orient === "lefttop") {
                if (r1 >= stindex) {
                    r1 += step;
                }

                if (r2 >= stindex) {
                    r2 += step;
                }
            } else if (orient === "rightbottom") {
                if (r1 > stindex) {
                    r1 += step;
                }

                if (r2 > stindex) {
                    r2 += step;
                }
            }
        } else if (rc === "col") {
            if (orient === "lefttop") {
                if (c1 >= stindex) {
                    c1 += step;
                }

                if (c2 >= stindex) {
                    c2 += step;
                }
            } else if (orient === "rightbottom") {
                if (c1 > stindex) {
                    c1 += step;
                }

                if (c2 > stindex) {
                    c2 += step;
                }
            }
        }

        if (r1 === r2 && c1 === c2) {
            if (!Number.isNaN(r1) && !Number.isNaN(c1)) {
                return prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1);
            }
            if (!Number.isNaN(r1)) {
                return prefix + $row0 + (r1 + 1);
            }
            if (!Number.isNaN(c1)) {
                return prefix + $col0 + indexToColumnChar(c1);
            }
            return txt;
        }
        if (Number.isNaN(c1) && Number.isNaN(c2)) {
            return `${prefix + $row0 + (r1 + 1)}:${$row1}${r2 + 1}`;
        }
        if (Number.isNaN(r1) && Number.isNaN(r2)) {
            return `${
                prefix + $col0 + indexToColumnChar(c1)
            }:${$col1}${indexToColumnChar(c2)}`;
        }
        return `${
            prefix + $col0 + indexToColumnChar(c1) + $row0 + (r1 + 1)
        }:${$col1}${indexToColumnChar(c2)}${$row1}${r2 + 1}`;
    }
    return "";
}

export function functionStrChange(
    txt: string,
    type: string,
    rc: "row" | "col",
    orient: string | null,
    stindex: number,
    step: number
) {
    if (!txt) {
        return "";
    }
    if (txt.substring(0, 1) === "=") {
        txt = txt.substring(1);
    }

    const funcstack = txt.split("");
    let i = 0;
    let str = "";
    let function_str = "";

    const matchConfig = {
        bracket: 0, // bracket
        comma: 0, // comma
        squote: 0, // single quote
        dquote: 0, // double quote
    };

    while (i < funcstack.length) {
        const s = funcstack[i];

        if (s === "(" && matchConfig.dquote === 0) {
            matchConfig.bracket += 1;

            if (str.length > 0) {
                function_str += `${str}(`;
            } else {
                function_str += "(";
            }

            str = "";
        } else if (s === ")" && matchConfig.dquote === 0) {
            matchConfig.bracket -= 1;
            function_str += `${functionStrChange(
                str,
                type,
                rc,
                orient,
                stindex,
                step
            )})`;
            str = "";
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                function_str += `${str}"`;
                matchConfig.dquote -= 1;
                str = "";
            } else {
                matchConfig.dquote += 1;
                str += '"';
            }
        } else if (s === "," && matchConfig.dquote === 0) {
            function_str += `${functionStrChange(
                str,
                type,
                rc,
                orient,
                stindex,
                step
            )},`;
            str = "";
        } else if (s === "&" && matchConfig.dquote === 0) {
            if (str.length > 0) {
                function_str += `${functionStrChange(
                    str,
                    type,
                    rc,
                    orient,
                    stindex,
                    step
                )}&`;
                str = "";
            } else {
                function_str += "&";
            }
        } else if (s in operatorjson && matchConfig.dquote === 0) {
            let s_next = "";

            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            let p = i - 1;
            let s_pre = null;

            if (p >= 0) {
                do {
                    s_pre = funcstack[(p -= 1)];
                } while (p >= 0 && s_pre === " ");
            }

            if (s + s_next in operatorjson) {
                if (str.length > 0) {
                    function_str +=
                        functionStrChange(str, type, rc, orient, stindex, step) +
                        s +
                        s_next;
                    str = "";
                } else {
                    function_str += s + s_next;
                }

                i += 1;
            } else if (
                !/[^0-9]/.test(s_next) &&
                s === "-" &&
                (s_pre === "(" ||
                    s_pre == null ||
                    s_pre === "," ||
                    s_pre === " " ||
                    s_pre in operatorjson)
            ) {
                str += s;
            } else {
                if (str.length > 0) {
                    function_str +=
                        functionStrChange(str, type, rc, orient, stindex, step) + s;
                    str = "";
                } else {
                    function_str += s;
                }
            }
        } else {
            str += s;
        }

        if (i === funcstack.length - 1) {
            if (iscelldata(_.trim(str))) {
                function_str += functionStrChange_range(
                    _.trim(str),
                    type,
                    rc,
                    orient,
                    stindex,
                    step
                );
            } else {
                function_str += _.trim(str);
            }
        }

        i += 1;
    }

    return function_str;
}

export function functionCopy(
    ctx: Context,
    txt: string,
    mode: string,
    step: number
) {
    if (mode == null) {
        mode = "down";
    }

    if (step == null) {
        step = 1;
    }

    if (txt.substring(0, 1) === "=") {
        txt = txt.substring(1);
    }

    const funcstack = txt.split("");
    let i = 0;
    let str = "";
    let function_str = "";

    const matchConfig = {
        bracket: 0,
        comma: 0,
        squote: 0,
        dquote: 0,
    };

    while (i < funcstack.length) {
        const s = funcstack[i];

        if (s === "(" && matchConfig.dquote === 0) {
            matchConfig.bracket += 1;

            if (str.length > 0) {
                function_str += `${str}(`;
            } else {
                function_str += "(";
            }

            str = "";
        } else if (s === ")" && matchConfig.dquote === 0) {
            matchConfig.bracket -= 1;
            function_str += `${functionCopy(ctx, str, mode, step)})`;
            str = "";
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                function_str += `${str}"`;
                matchConfig.dquote -= 1;
                str = "";
            } else {
                matchConfig.dquote += 1;
                str += '"';
            }
        } else if (s === "," && matchConfig.dquote === 0) {
            function_str += `${functionCopy(ctx, str, mode, step)},`;
            str = "";
        } else if (s === "&" && matchConfig.dquote === 0) {
            if (str.length > 0) {
                function_str += `${functionCopy(ctx, str, mode, step)}&`;
                str = "";
            } else {
                function_str += "&";
            }
        } else if (s in operatorjson && matchConfig.dquote === 0) {
            let s_next = "";

            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            let p = i - 1;
            let s_pre = null;

            if (p >= 0) {
                do {
                    s_pre = funcstack[p];
                    p -= 1;
                } while (p >= 0 && s_pre === " ");
            }

            if (s + s_next in operatorjson) {
                if (str.length > 0) {
                    function_str += functionCopy(ctx, str, mode, step) + s + s_next;
                    str = "";
                } else {
                    function_str += s + s_next;
                }

                i += 1;
            } else if (
                !/[^0-9]/.test(s_next) &&
                s === "-" &&
                (s_pre === "(" ||
                    s_pre == null ||
                    s_pre === "," ||
                    s_pre === " " ||
                    s_pre in operatorjson)
            ) {
                str += s;
            } else {
                if (str.length > 0) {
                    function_str += functionCopy(ctx, str, mode, step) + s;
                    str = "";
                } else {
                    function_str += s;
                }
            }
        } else {
            str += s;
        }

        if (i === funcstack.length - 1) {
            if (iscelldata(_.trim(str))) {
                if (mode === "down") {
                    function_str += downparam(_.trim(str), step);
                } else if (mode === "up") {
                    function_str += upparam(_.trim(str), step);
                } else if (mode === "left") {
                    function_str += leftparam(_.trim(str), step);
                } else if (mode === "right") {
                    function_str += rightparam(_.trim(str), step);
                }
            } else {
                function_str += _.trim(str);
            }
        }

        i += 1;
    }

    return function_str;
}
