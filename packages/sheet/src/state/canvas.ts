import { isEmpty, isPlainObject } from 'es-toolkit/compat';
import type { ComputeMap } from '../engine/conditional-format';
import type { CellMatrix } from '../engine/types';
import { type Context, getFlowdata } from './context';
import { checkCF, getComputeMap, getFilterButtonRects, validateCellData } from './modules';
import { getBorderInfoComputeRange } from './modules/border';
import { getRealCellValue, normalizedAttr } from './modules/cell';
import { isInlineStringCell } from './modules/inline-string';
import type { CellTextInfo } from './modules/text';
import { clearMeasureTextCache, defaultFont, getCellTextInfo, getFontSet, getMeasureText } from './modules/text';
import {
    colEndX,
    colStartX,
    HALF_PIXEL,
    headerVisibleRange,
    mainVisibleRange,
    rowEndY,
    rowStartY,
} from './render/geometry';
import { getSheetIndex, indexToColumnChar } from './utils';

export const defaultStyle = {
    fillStyle: '#000000',
    textBaseline: 'middle',
    strokeStyle: 'rgba(0, 0, 0, 0.1)',
    rowFillStyle: '#5e5e5e',
    textAlign: 'center',
} as const;

// Unlike the engine's stricter isRealNum, this accepts anything Number() can
// coerce (null, '', booleans); it only gates the forced-string indicator.
function coercesToNumber(val: unknown) {
    return !Number.isNaN(Number(val));
}

const BORDER_FIX = [-1, 0, 0, -1] as const;

// Border style index (the xlsx border-style ordinal) → style name.
const BORDER_TYPE: Record<string, string> = {
    '0': 'none',
    '1': 'Thin',
    '2': 'Hair',
    '3': 'Dotted',
    '4': 'Dashed',
    '5': 'DashDot',
    '6': 'DashDotDot',
    '7': 'Double',
    '8': 'Medium',
    '9': 'MediumDashed',
    '10': 'MediumDashDot',
    '11': 'MediumDashDotDot',
    '12': 'SlantedDashDot',
    '13': 'Thick',
};

function setLineDash(
    canvasborder: CanvasRenderingContext2D,
    type: number | string,
    hv: string,
    moveX: number,
    moveY: number,
    toX: number,
    toY: number,
) {
    const typeName = BORDER_TYPE[type.toString()] ?? '';

    if (typeName === 'Hair') {
        canvasborder.setLineDash([1, 2]);
    } else if (typeName.includes('DashDotDot')) {
        canvasborder.setLineDash([2, 2, 5, 2, 2]);
    } else if (typeName.includes('DashDot')) {
        canvasborder.setLineDash([2, 5, 2]);
    } else if (typeName.includes('Dotted')) {
        canvasborder.setLineDash([2]);
    } else if (typeName.includes('Dashed')) {
        canvasborder.setLineDash([3]);
    } else {
        canvasborder.setLineDash([0]);
    }

    canvasborder.beginPath();

    if (typeName.includes('Medium')) {
        if (hv === 'h') {
            canvasborder.moveTo(moveX, moveY - 0.5);
            canvasborder.lineTo(toX, toY - 0.5);
        } else {
            canvasborder.moveTo(moveX - 0.5, moveY);
            canvasborder.lineTo(toX - 0.5, toY);
        }

        canvasborder.lineWidth = 2;
    } else if (typeName === 'Thick') {
        canvasborder.moveTo(moveX, moveY);
        canvasborder.lineTo(toX, toY);
        canvasborder.lineWidth = 3;
    } else {
        canvasborder.moveTo(moveX, moveY);
        canvasborder.lineTo(toX, toY);
        canvasborder.lineWidth = 1;
    }
}

// Overflow map: per-row map of cell-column → the source-cell that overflows
// into this column (text wraps across adjacent empty cells).
type CellOverflowItem = { r: number; stc: number; edc: number };
type CellOverflowMap = Record<number, Record<number, CellOverflowItem> | undefined>;

// A visible cell scheduled for rendering. Merged cells accumulate the extent
// of their spanned rows/columns onto their first-seen item before the merge
// reprocess pass re-renders them full-size.
type CellRenderItem = {
    r: number;
    c: number;
    startX: number;
    startY: number;
    endY: number;
    endX: number;
    firstcolumnlen: number;
};

// Per-cell-key rects consumed by the border pass.
type BorderOffsetMap = Record<string, { startY: number; startX: number; endY: number; endX: number }>;

// Everything one drawMain pass shares with the per-cell render calls. Built
// once at the top of drawMain; freeze regions each get their own pass.
type RenderPass = {
    sheetCtx: Context;
    renderCtx: CanvasRenderingContext2D;
    offsetLeft: number;
    offsetTop: number;
    scrollWidth: number;
    scrollHeight: number;
    drawWidth: number;
    drawHeight: number;
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
    flowdata: CellMatrix;
    cfCompute: ComputeMap | null;
    dynamicArrayCompute: Record<string, { v: unknown }>;
    cellOverflowMap: CellOverflowMap;
    drawGridLines: boolean;
};

// Module-level cache that persists across Canvas instances.
// Previously this lived on the Canvas class and was reset to {} on every
// new Canvas(), making it completely useless. The existing setTimeout in
// drawMain invalidates it after 100ms of idle time.
let sharedCellOverflowMapCache: CellOverflowMap = {};
let sharedMeasureTextCacheTimeOut: ReturnType<typeof setTimeout> | undefined;

// Filter-button glyphs (24×24 viewBox): lucide chevron-down and the filled
// funnel the HTML buttons used. Created lazily — Path2D needs a DOM.
let filterGlyphs: { chevron: Path2D; funnel: Path2D } | undefined;
function getFilterGlyphs() {
    filterGlyphs ??= {
        chevron: new Path2D('m6 9 6 6 6-6'),
        funnel: new Path2D(
            'M18.14 4a1.5 1.5 0 0 1 1.16 2.44L14.7 12.15v6.4l-5.37-2.56v-3.96L4.5 6.31A1.5 1.5 0 0 1 5.76 4h12.38z',
        ),
    };
    return filterGlyphs;
}

export class Canvas {
    private canvasElement: HTMLCanvasElement;

    private sheetCtx: Context;

    constructor(canvasElement: HTMLCanvasElement, ctx: Context) {
        this.canvasElement = canvasElement;
        this.sheetCtx = ctx;
    }

    public drawRowHeader(scrollHeight: number, drawHeight?: number, offsetTop?: number) {
        drawHeight ??= this.sheetCtx.tableContentSize[1];
        offsetTop ??= this.sheetCtx.columnHeaderHeight;

        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);

        renderCtx.clearRect(0, offsetTop, this.sheetCtx.rowHeaderWidth - 1, drawHeight);

        renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
        renderCtx.textBaseline = defaultStyle.textBaseline;
        renderCtx.fillStyle = defaultStyle.fillStyle;

        const { start: rowStart, end: rowEnd } = headerVisibleRange(
            this.sheetCtx.visibledatarow,
            scrollHeight,
            drawHeight,
        );

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(0, offsetTop - 1, this.sheetCtx.rowHeaderWidth - 1, drawHeight - 2);
        renderCtx.clip();

        let prevEndY: number | undefined;
        for (let r = rowStart; r <= rowEnd; r += 1) {
            const startY = rowStartY(this.sheetCtx.visibledatarow, r, scrollHeight);
            const endY = rowEndY(this.sheetCtx.visibledatarow, r, scrollHeight);

            const firstOffset = rowStart === r ? -2 : 0;
            const lastOffset = rowEnd === r ? -2 : 0;
            // Triggered before row header cell render; return false to skip
            if (
                this.sheetCtx.hooks.beforeRenderRowHeaderCell?.(
                    `${r + 1}`,
                    r,
                    startY + offsetTop + firstOffset,
                    this.sheetCtx.rowHeaderWidth - 1,
                    endY - startY + 1 + lastOffset - firstOffset,
                    renderCtx,
                ) === false
            ) {
                continue;
            }

            if (this.sheetCtx.config?.rowhidden?.[r] == null) {
                renderCtx.fillStyle = '#ffffff';
                renderCtx.fillRect(
                    0,
                    startY + offsetTop + firstOffset,
                    this.sheetCtx.rowHeaderWidth - 1,
                    endY - startY + 1 + lastOffset - firstOffset,
                );
                renderCtx.fillStyle = '#000000';

                // Row header sequence number
                const textMetrics = getMeasureText(r + 1, renderCtx);

                const horizonAlignPos = (this.sheetCtx.rowHeaderWidth - textMetrics.width) / 2;
                const verticalAlignPos = startY + (endY - startY) / 2 + offsetTop;

                renderCtx.fillText(`${r + 1}`, horizonAlignPos, verticalAlignPos);
            }

            // Row header right edge
            renderCtx.beginPath();
            renderCtx.moveTo(this.sheetCtx.rowHeaderWidth - 2 + HALF_PIXEL, startY + offsetTop - 2);
            renderCtx.lineTo(this.sheetCtx.rowHeaderWidth - 2 + HALF_PIXEL, endY + offsetTop - 2);
            renderCtx.lineWidth = 1;

            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.stroke();
            renderCtx.closePath();

            // Row header horizontal line
            if (
                this.sheetCtx.config.rowhidden &&
                this.sheetCtx.config.rowhidden[r] == null &&
                this.sheetCtx.config.rowhidden[r + 1] != null
            ) {
                renderCtx.beginPath();
                renderCtx.moveTo(-1, endY + offsetTop - 4 + HALF_PIXEL);
                renderCtx.lineTo(this.sheetCtx.rowHeaderWidth - 1, endY + offsetTop - 4 + HALF_PIXEL);
                renderCtx.closePath();
                renderCtx.stroke();
            } else if (this.sheetCtx.config.rowhidden == null || this.sheetCtx.config.rowhidden[r] == null) {
                renderCtx.beginPath();
                renderCtx.moveTo(-1, endY + offsetTop - 2 + HALF_PIXEL);
                renderCtx.lineTo(this.sheetCtx.rowHeaderWidth - 1, endY + offsetTop - 2 + HALF_PIXEL);

                renderCtx.closePath();
                renderCtx.stroke();
            }

            if (this.sheetCtx.config?.rowhidden?.[r - 1] != null && prevEndY !== undefined) {
                renderCtx.beginPath();
                renderCtx.moveTo(-1, prevEndY + offsetTop + HALF_PIXEL);
                renderCtx.lineTo(this.sheetCtx.rowHeaderWidth - 1, prevEndY + offsetTop + HALF_PIXEL);
                renderCtx.closePath();
                renderCtx.stroke();
            }

            prevEndY = endY;

            this.sheetCtx.hooks.afterRenderRowHeaderCell?.(
                `${r + 1}`,
                r,
                startY + offsetTop + firstOffset,
                this.sheetCtx.rowHeaderWidth - 1,
                endY - startY + 1 + lastOffset - firstOffset,
                renderCtx,
            );
        }

        renderCtx.restore(); // header clip
        renderCtx.restore(); // device-pixel-ratio scale
    }

    public drawColumnHeader(scrollWidth: number, drawWidth?: number, offsetLeft?: number) {
        drawWidth ??= this.sheetCtx.tableContentSize[0];
        offsetLeft ??= this.sheetCtx.rowHeaderWidth;

        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);
        renderCtx.clearRect(offsetLeft, 0, drawWidth, this.sheetCtx.columnHeaderHeight - 1);

        renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
        renderCtx.textBaseline = defaultStyle.textBaseline;
        renderCtx.fillStyle = defaultStyle.fillStyle;

        const { start: colStart, end: colEnd } = headerVisibleRange(
            this.sheetCtx.visibledatacolumn,
            scrollWidth,
            drawWidth,
        );

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(offsetLeft - 1, 0, drawWidth, this.sheetCtx.columnHeaderHeight - 1);
        renderCtx.clip();

        let prevEndX: number | undefined;
        for (let c = colStart; c <= colEnd; c += 1) {
            const startX = colStartX(this.sheetCtx.visibledatacolumn, c, scrollWidth);
            const endX = colEndX(this.sheetCtx.visibledatacolumn, c, scrollWidth);

            const columnLabel = indexToColumnChar(c);
            // Triggered before column header cell render; return false to skip
            if (
                this.sheetCtx.hooks.beforeRenderColumnHeaderCell?.(
                    columnLabel,
                    c,
                    startX + offsetLeft - 1,
                    endX - startX,
                    this.sheetCtx.columnHeaderHeight - 1,
                    renderCtx,
                ) === false
            ) {
                continue;
            }

            if (this.sheetCtx.config?.colhidden?.[c] == null) {
                renderCtx.fillStyle = '#ffffff';
                renderCtx.fillRect(startX + offsetLeft - 1, 0, endX - startX, this.sheetCtx.columnHeaderHeight - 1);
                renderCtx.fillStyle = '#000000';

                // Column header sequence number
                const textMetrics = getMeasureText(columnLabel, renderCtx);

                const horizonAlignPos = Math.round(startX + (endX - startX) / 2 + offsetLeft - textMetrics.width / 2);
                const verticalAlignPos = Math.round(this.sheetCtx.columnHeaderHeight / 2);

                renderCtx.fillText(columnLabel, horizonAlignPos, verticalAlignPos);
            }

            // Column header vertical line
            if (
                this.sheetCtx.config.colhidden &&
                this.sheetCtx.config.colhidden[c] != null &&
                this.sheetCtx.config.colhidden[c + 1] != null
            ) {
                renderCtx.beginPath();
                renderCtx.moveTo(endX + offsetLeft - 4 + HALF_PIXEL, 0);
                renderCtx.lineTo(endX + offsetLeft - 4 + HALF_PIXEL, this.sheetCtx.columnHeaderHeight - 2);
                renderCtx.lineWidth = 1;
                renderCtx.strokeStyle = defaultStyle.strokeStyle;
                renderCtx.closePath();
                renderCtx.stroke();
            } else if (this.sheetCtx.config.colhidden == null || this.sheetCtx.config.colhidden[c] == null) {
                renderCtx.beginPath();
                renderCtx.moveTo(endX + offsetLeft - 2 + HALF_PIXEL, 0);
                renderCtx.lineTo(endX + offsetLeft - 2 + HALF_PIXEL, this.sheetCtx.columnHeaderHeight - 2);

                renderCtx.lineWidth = 1;
                renderCtx.strokeStyle = defaultStyle.strokeStyle;
                renderCtx.closePath();
                renderCtx.stroke();
            }

            if (this.sheetCtx.config?.colhidden?.[c - 1] != null && prevEndX !== undefined) {
                renderCtx.beginPath();
                renderCtx.moveTo(prevEndX + offsetLeft + HALF_PIXEL, 0);
                renderCtx.lineTo(prevEndX + offsetLeft + HALF_PIXEL, this.sheetCtx.columnHeaderHeight - 2);
                renderCtx.closePath();
                renderCtx.stroke();
            }

            // Column header bottom edge
            renderCtx.beginPath();
            renderCtx.moveTo(startX + offsetLeft - 1, this.sheetCtx.columnHeaderHeight - 2 + HALF_PIXEL);
            renderCtx.lineTo(endX + offsetLeft - 1, this.sheetCtx.columnHeaderHeight - 2 + HALF_PIXEL);
            renderCtx.stroke();
            renderCtx.closePath();

            prevEndX = endX;

            this.sheetCtx.hooks.afterRenderColumnHeaderCell?.(
                columnLabel,
                c,
                startX + offsetLeft - 1,
                endX - startX,
                this.sheetCtx.columnHeaderHeight - 1,
                renderCtx,
            );
        }

        renderCtx.restore(); // header clip
        renderCtx.restore(); // device-pixel-ratio scale
    }

    public drawMain({
        scrollWidth,
        scrollHeight,
        drawWidth,
        drawHeight,
        offsetLeft,
        offsetTop,
        columnOffsetCell,
        rowOffsetCell,
        clear,
    }: {
        scrollWidth: number;
        scrollHeight: number;
        drawWidth?: number;
        drawHeight?: number;
        offsetLeft?: number;
        offsetTop?: number;
        columnOffsetCell?: number;
        rowOffsetCell?: number;
        clear?: boolean;
    }) {
        const flowdata = getFlowdata(this.sheetCtx);
        if (flowdata == null) {
            return;
        }

        clearTimeout(sharedMeasureTextCacheTimeOut);

        drawWidth ??= this.sheetCtx.tableContentSize[0];
        drawHeight ??= this.sheetCtx.tableContentSize[1];
        offsetLeft ??= this.sheetCtx.rowHeaderWidth;
        offsetTop ??= this.sheetCtx.columnHeaderHeight;
        columnOffsetCell ??= 0;
        rowOffsetCell ??= 0;

        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);
        if (clear) {
            renderCtx.clearRect(0, 0, this.sheetCtx.tableContentSize[0], this.sheetCtx.tableContentSize[1]);
        }

        // Table render area: start/end row/column indices
        const { start: rowStart, end: rowEnd } = mainVisibleRange(
            this.sheetCtx.visibledatarow,
            scrollHeight,
            drawHeight,
            rowOffsetCell,
        );
        const { start: colStart, end: colEnd } = mainVisibleRange(
            this.sheetCtx.visibledatacolumn,
            scrollWidth,
            drawWidth,
            columnOffsetCell,
        );

        // Table render area: start/end coordinates
        const lastRowBottom = this.sheetCtx.visibledatarow[rowEnd];
        const lastColRight = this.sheetCtx.visibledatacolumn[colEnd];

        // Initialize table canvas area
        renderCtx.fillStyle = '#ffffff';
        renderCtx.fillRect(offsetLeft - 1, offsetTop - 1, lastColRight - scrollWidth, lastRowBottom - scrollHeight);
        renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
        renderCtx.fillStyle = defaultStyle.fillStyle;

        const drawGridLines = !this.sheetCtx.currentSheetIsPivot && this.sheetCtx.showGridLines;

        this.sheetCtx.hooks.beforeRenderCellArea?.(flowdata, renderCtx);

        const { cells, borderOffset } = this.collectVisibleCells(
            flowdata,
            rowStart,
            rowEnd,
            colStart,
            colEnd,
            scrollWidth,
            scrollHeight,
        );

        const pass: RenderPass = {
            sheetCtx: this.sheetCtx,
            renderCtx,
            offsetLeft,
            offsetTop,
            scrollWidth,
            scrollHeight,
            drawWidth,
            drawHeight,
            rowStart,
            rowEnd,
            colStart,
            colEnd,
            flowdata,
            cfCompute: getComputeMap(this.sheetCtx),
            dynamicArrayCompute: {},
            // Overflow cell configuration for render area
            cellOverflowMap: this.getCellOverflowMap(renderCtx, colStart, colEnd, rowStart, rowEnd),
            drawGridLines,
        };
        const mergedCells = this.renderCells(pass, cells);
        this.renderMergedCells(pass, mergedCells);

        this.drawCellBorders(pass, borderOffset);

        // Clear right gray area when last column is rendered to prevent overflow
        if (colEnd === this.sheetCtx.visibledatacolumn.length - 1) {
            renderCtx.clearRect(
                lastColRight - scrollWidth + offsetLeft - 1,
                offsetTop - 1,
                this.sheetCtx.ch_width - this.sheetCtx.visibledatacolumn[colEnd],
                lastRowBottom - scrollHeight,
            );
        }

        this.drawFilterUI(pass);

        renderCtx.restore();

        sharedMeasureTextCacheTimeOut = setTimeout(() => {
            clearMeasureTextCache();
            sharedCellOverflowMapCache = {};
        }, 100);
    }

    // Walk the visible grid, recording a render item per drawable cell and a
    // rect per cell key for the border pass. Visible members of a merge
    // accumulate the merge's on-screen extent onto its first-seen item
    // (endY grows per spanned row, endX per spanned column — subtle inherited
    // logic, kept verbatim).
    private collectVisibleCells(
        flowdata: CellMatrix,
        rowStart: number,
        rowEnd: number,
        colStart: number,
        colEnd: number,
        scrollWidth: number,
        scrollHeight: number,
    ): { cells: CellRenderItem[]; borderOffset: BorderOffsetMap } {
        const cells: CellRenderItem[] = [];
        const mergeCache: Record<string, number> = {};
        const borderOffset: BorderOffsetMap = {};

        for (let r = rowStart; r <= rowEnd; r += 1) {
            const startY = rowStartY(this.sheetCtx.visibledatarow, r, scrollHeight);
            const endY = rowEndY(this.sheetCtx.visibledatarow, r, scrollHeight);

            if (this.sheetCtx.config?.rowhidden?.[r] != null) {
                continue;
            }

            for (let c = colStart; c <= colEnd; c += 1) {
                const startX = colStartX(this.sheetCtx.visibledatacolumn, c, scrollWidth);
                const endX = colEndX(this.sheetCtx.visibledatacolumn, c, scrollWidth);

                if (this.sheetCtx.config?.colhidden?.[c] != null) {
                    continue;
                }

                let firstcolumnlen = this.sheetCtx.defaultcollen;
                if (this.sheetCtx.config?.columnlen?.[c]) {
                    firstcolumnlen = this.sheetCtx.config.columnlen[c];
                }

                const cell = flowdata?.[r]?.[c];
                if (cell?.mc) {
                    borderOffset[`${r}_${c}`] = { startY, startX, endY, endX };

                    if ('rs' in cell.mc) {
                        mergeCache[`r${r}c${c}`] = cells.length;
                    } else {
                        const key = `r${cell.mc.r}c${cell.mc.c}`;
                        const mergeMain = cells[mergeCache[key]];

                        if (mergeMain == null) {
                            mergeCache[key] = cells.length;
                            cells.push({ r, c, startX, startY, endY, endX, firstcolumnlen });
                        } else {
                            if (mergeMain.c === c) {
                                mergeMain.endY += endY - startY - 1;
                            }

                            if (mergeMain.r === r) {
                                mergeMain.endX += endX - startX;
                                mergeMain.firstcolumnlen += firstcolumnlen;
                            }
                        }

                        continue;
                    }
                }

                cells.push({ r, c, startY, startX, endY, endX, firstcolumnlen });
                borderOffset[`${r}_${c}`] = { startY, startX, endY, endX };
            }
        }

        return { cells, borderOffset };
    }

    // Render every collected cell. Merge members defer to the reprocess pass
    // and are returned (their anchor re-renders over the full span).
    private renderCells(pass: RenderPass, cells: CellRenderItem[]): CellRenderItem[] {
        const { flowdata, dynamicArrayCompute } = pass;
        const mergedCells: CellRenderItem[] = [];

        for (const item of cells) {
            const { r, c, startY, startX, endY, endX } = item;

            if (flowdata[r] == null) {
                continue;
            }

            if (flowdata[r][c] == null) {
                // Empty cell
                this.nullCellRender(pass, r, c, startY, startX, endY, endX);
            } else {
                const cell = flowdata[r][c];
                let value = null;

                if (cell?.mc) {
                    mergedCells.push(item);
                } else {
                    value = getRealCellValue(r, c, flowdata);
                }

                if (value == null || value.toString().length === 0) {
                    this.nullCellRender(pass, r, c, startY, startX, endY, endX);
                } else {
                    if (`${r}_${c}` in dynamicArrayCompute) {
                        value = dynamicArrayCompute[`${r}_${c}`].v;
                    }

                    this.cellRender(pass, r, c, startY, startX, endY, endX, value);
                }
            }
        }

        return mergedCells;
    }

    // Re-render each merge over its anchor cell's full span.
    private renderMergedCells(pass: RenderPass, mergedCells: CellRenderItem[]) {
        const { flowdata, dynamicArrayCompute, scrollWidth, scrollHeight } = pass;

        for (const item of mergedCells) {
            const cell = flowdata[item.r][item.c];
            if (!cell) continue;

            const mergeMaindata = cell.mc;
            if (!mergeMaindata) continue;

            let value = null;
            value = getRealCellValue(mergeMaindata.r, mergeMaindata.c, flowdata);

            const r = mergeMaindata.r;
            const c = mergeMaindata.c;

            const mainCell = flowdata[r][c];

            if (!mainCell?.mc?.rs || !mainCell.mc?.cs) {
                continue;
            }

            const startX = colStartX(this.sheetCtx.visibledatacolumn, c, scrollWidth);
            const startY = rowStartY(this.sheetCtx.visibledatarow, r, scrollHeight);
            const endY = rowEndY(this.sheetCtx.visibledatarow, r + mainCell.mc.rs - 1, scrollHeight);
            const endX = colEndX(this.sheetCtx.visibledatacolumn, c + mainCell.mc.cs - 1, scrollWidth);

            if (value == null || value.toString().length === 0) {
                this.nullCellRender(pass, r, c, startY, startX, endY, endX, true);
            } else {
                if (`${r}_${c}` in dynamicArrayCompute) {
                    value = dynamicArrayCompute[`${r}_${c}`].v;
                }
                this.cellRender(pass, r, c, startY, startX, endY, endX, value, true);
            }
        }
    }

    // Cell borders from config.borderInfo, drawn over the finished cells.
    private drawCellBorders(pass: RenderPass, borderOffset: BorderOffsetMap) {
        if ((this.sheetCtx.config?.borderInfo?.length ?? 0) === 0) {
            return;
        }

        const { renderCtx, rowStart, rowEnd, colStart, colEnd, offsetLeft: oL, offsetTop: oT } = pass;

        const renderBorder = (
            style: number | string,
            color: string,
            dir: string,
            moveX: number,
            moveY: number,
            toX: number,
            toY: number,
        ) => {
            renderCtx.save();
            setLineDash(renderCtx, style, dir, moveX, moveY, toX, toY);
            renderCtx.strokeStyle = color;
            renderCtx.stroke();
            renderCtx.closePath();
            renderCtx.restore();
        };

        const borderInfoCompute = getBorderInfoComputeRange(this.sheetCtx, rowStart, rowEnd, colStart, colEnd);

        for (const [x, bdInfo] of Object.entries(borderInfoCompute)) {
            const sepIdx = x.indexOf('_');
            const bdRow = Number(x.substring(0, sepIdx));
            const bdCol = Number(x.substring(sepIdx + 1));

            const bdOffset = borderOffset[x];
            if (!bdOffset) continue;

            const { startY, startX, endY, endX } = bdOffset;

            const leftX = startX - 2 + HALF_PIXEL + oL;
            const rightX = endX - 2 + HALF_PIXEL + oL;
            const topY = startY + oT;
            const bottomY = endY - 2 + HALF_PIXEL + oT;

            const overflowInfo = this.overflowColIn(pass.cellOverflowMap, bdRow, bdCol, colEnd);

            const notOverflowOrFirst = !overflowInfo.colIn || overflowInfo.stc === bdCol;

            if (bdInfo.s && notOverflowOrFirst) {
                const mergeMap = this.sheetCtx.config.merge;
                const mergeCell = mergeMap?.[x];
                let slashEndX = rightX;
                let slashEndY = bottomY;
                if (mergeCell) {
                    const mergeCellOffset = borderOffset[`${bdRow + mergeCell.rs - 1}_${bdCol + mergeCell.cs - 1}`];
                    slashEndX = mergeCellOffset.endX - 2 + HALF_PIXEL + oL;
                    slashEndY = mergeCellOffset.endY - 2 + HALF_PIXEL + oT;
                }
                renderBorder(bdInfo.s.style, bdInfo.s.color, 'v', leftX, topY, slashEndX, slashEndY);
            }

            if (bdInfo.l && notOverflowOrFirst) {
                renderBorder(bdInfo.l.style, bdInfo.l.color, 'v', leftX, topY - 1, leftX, bottomY);
            }

            if (bdInfo.r && (!overflowInfo.colIn || overflowInfo.colLast)) {
                renderBorder(bdInfo.r.style, bdInfo.r.color, 'v', rightX, topY - 1, rightX, bottomY);
            }

            if (bdInfo.t) {
                const tY = startY - 1 + HALF_PIXEL + oT;
                renderBorder(bdInfo.t.style, bdInfo.t.color, 'h', leftX, tY, rightX, tY);
            }

            if (bdInfo.b) {
                renderBorder(bdInfo.b.style, bdInfo.b.color, 'h', leftX, bottomY, rightX, bottomY);
            }
        }
    }

    public drawFreezeLine({ horizontalTop, verticalLeft }: { horizontalTop?: number; verticalLeft?: number }) {
        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);
        renderCtx.strokeStyle = '#ccc';
        renderCtx.lineWidth = 2;

        if (horizontalTop) {
            renderCtx.beginPath();
            renderCtx.moveTo(0, horizontalTop);
            renderCtx.lineTo(this.canvasElement.width, horizontalTop);
            renderCtx.stroke();
            renderCtx.closePath();
        }

        if (verticalLeft) {
            renderCtx.beginPath();
            renderCtx.moveTo(verticalLeft, 0);
            renderCtx.lineTo(verticalLeft, this.canvasElement.height);
            renderCtx.stroke();
            renderCtx.closePath();
        }

        renderCtx.restore();
    }

    // Autofilter UI: the filter-range border and the per-column buttons, drawn
    // inside every drawMain pass so freeze-region pinning and clipping match the
    // cells underneath. Geometry comes from getFilterButtonRects — the same
    // rects the mousedown hit-test uses. Colors resolve from the theme tokens
    // the HTML buttons used (border-primary / bg-background / bg-primary).
    private drawFilterUI(pass: RenderPass) {
        const { renderCtx, scrollWidth, scrollHeight, drawWidth, drawHeight, offsetLeft, offsetTop } = pass;
        const options = this.sheetCtx.filterOptions;
        if (options == null) return;

        const style = getComputedStyle(this.canvasElement);
        const primary = style.getPropertyValue('--primary').trim();
        const primaryForeground = style.getPropertyValue('--primary-foreground').trim();
        const background = style.getPropertyValue('--background').trim();
        const selectionHandle = style.getPropertyValue('--selection-handle').trim();
        const glyphs = getFilterGlyphs();

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(offsetLeft - 1, offsetTop - 1, drawWidth + 1, drawHeight + 1);
        renderCtx.clip();

        // Sheet coords map to the same -1-shifted canvas space the cells use.
        const toCanvasX = (x: number) => x - scrollWidth + offsetLeft - 1;
        const toCanvasY = (y: number) => y - scrollHeight + offsetTop - 1;

        // Range border (was the border-selection-handle overlay div)
        renderCtx.strokeStyle = selectionHandle;
        renderCtx.lineWidth = 1;
        renderCtx.strokeRect(
            toCanvasX(options.left) - 0.5,
            toCanvasY(options.top) - 0.5,
            options.width + 1,
            options.height + 1,
        );

        for (const rect of getFilterButtonRects(this.sheetCtx)) {
            if (
                rect.left + rect.width < scrollWidth ||
                rect.left > scrollWidth + drawWidth ||
                rect.top + rect.height < scrollHeight ||
                rect.top > scrollHeight + drawHeight
            ) {
                continue;
            }

            const bx = toCanvasX(rect.left);
            const by = toCanvasY(rect.top);
            const active = this.sheetCtx.filter[rect.col - options.startCol] != null;
            const hovered = this.sheetCtx.filterButtonHover === rect.col;
            const filled = active || hovered;

            renderCtx.beginPath();
            renderCtx.roundRect(bx + 0.5, by + 0.5, rect.width - 1, rect.height - 1, 2);
            renderCtx.fillStyle = filled ? primary : background;
            renderCtx.fill();
            renderCtx.strokeStyle = primary;
            renderCtx.lineWidth = 1;
            renderCtx.stroke();

            const glyphColor = filled ? primaryForeground : primary;
            if (active) {
                // 13×13 funnel, centered (the active-filter glyph)
                renderCtx.save();
                renderCtx.translate(bx + (rect.width - 13) / 2, by + (rect.height - 13) / 2);
                renderCtx.scale(13 / 24, 13 / 24);
                renderCtx.fillStyle = glyphColor;
                renderCtx.fill(glyphs.funnel);
                renderCtx.restore();
            } else {
                // 12×12 chevron-down, centered (lucide stroke conventions)
                renderCtx.save();
                renderCtx.translate(bx + (rect.width - 12) / 2, by + (rect.height - 12) / 2);
                renderCtx.scale(12 / 24, 12 / 24);
                renderCtx.strokeStyle = glyphColor;
                renderCtx.lineWidth = 2;
                renderCtx.lineCap = 'round';
                renderCtx.lineJoin = 'round';
                renderCtx.stroke(glyphs.chevron);
                renderCtx.restore();
            }
        }

        renderCtx.restore();
    }

    // Get overflow cells for the render range
    private getCellOverflowMap(
        canvas: CanvasRenderingContext2D,
        colStart: number,
        colEnd: number,
        rowStart: number,
        rowEnd: number,
    ) {
        const flowdata = getFlowdata(this.sheetCtx);
        const map: CellOverflowMap = {};
        if (!flowdata) {
            return map;
        }

        for (let r = rowStart; r <= rowEnd; r += 1) {
            if (flowdata[r] == null) {
                continue;
            }

            if (sharedCellOverflowMapCache[r]) {
                map[r] = sharedCellOverflowMapCache[r];
                continue;
            }

            let hasCellOver = false;

            // Only scan columns near the visible range. Text overflow from cells
            // far outside the viewport cannot reach the visible area. A buffer of
            // 50 columns on each side is generous for even very wide text.
            const scanStart = Math.max(0, colStart - 50);
            const scanEnd = Math.min(flowdata[r].length - 1, colEnd + 50);

            for (let c = scanStart; c <= scanEnd; c += 1) {
                const cell = flowdata[r][c];

                if (this.sheetCtx.config?.colhidden?.[c] != null) {
                    continue;
                }

                if (cell && (!isEmpty(cell.v) || isInlineStringCell(cell)) && cell.mc == null && cell.tb === '1') {
                    const horizonAlign = normalizedAttr(flowdata, r, c, 'ht');

                    const textMetricsObj = getCellTextInfo(cell, canvas, this.sheetCtx, {
                        r,
                        c,
                    });
                    const textMetrics = textMetricsObj?.textWidthAll ?? 0;

                    const startX = colStartX(this.sheetCtx.visibledatacolumn, c, 0);
                    const endX = colEndX(this.sheetCtx.visibledatacolumn, c, 0);

                    let stc = c;
                    let edc = c;

                    if (endX - startX < textMetrics) {
                        if (horizonAlign === '0') {
                            // Center aligned
                            const traceForward = this.traceOverflow(r, c, c - 1, 'forward', horizonAlign, textMetrics);
                            const traceBackward = this.traceOverflow(
                                r,
                                c,
                                c + 1,
                                'backward',
                                horizonAlign,
                                textMetrics,
                            );

                            if (traceForward.success) {
                                stc = traceForward.c;
                            } else {
                                stc = traceForward.c + 1;
                            }

                            if (traceBackward.success) {
                                edc = traceBackward.c;
                            } else {
                                edc = traceBackward.c - 1;
                            }
                        } else if (horizonAlign === '1') {
                            // Left aligned
                            const trace = this.traceOverflow(r, c, c + 1, 'backward', horizonAlign, textMetrics);
                            stc = c;

                            if (trace.success) {
                                edc = trace.c;
                            } else {
                                edc = trace.c - 1;
                            }
                        } else if (horizonAlign === '2') {
                            // Right aligned
                            const trace = this.traceOverflow(r, c, c - 1, 'forward', horizonAlign, textMetrics);
                            edc = c;

                            if (trace.success) {
                                stc = trace.c;
                            } else {
                                stc = trace.c + 1;
                            }
                        }
                    } else {
                        stc = c;
                        edc = c;
                    }

                    if ((stc <= colEnd || edc >= colStart) && stc < edc) {
                        const item = {
                            r,
                            stc,
                            edc,
                        };

                        const rowMap = map[r] ?? {};
                        rowMap[c] = item;
                        map[r] = rowMap;

                        hasCellOver = true;
                    }
                }
            }

            if (hasCellOver) {
                sharedCellOverflowMapCache[r] = map[r];
            }
        }

        return map;
    }

    // Empty cell rendering
    private nullCellRender(
        pass: RenderPass,
        r: number,
        c: number,
        startY: number,
        startX: number,
        endY: number,
        endX: number,
        isMerge = false,
    ) {
        const {
            renderCtx,
            cfCompute,
            offsetLeft,
            offsetTop,
            dynamicArrayCompute,
            cellOverflowMap,
            colEnd,
            flowdata,
            drawGridLines,
        } = pass;
        const checksCF = checkCF(r, c, cfCompute);

        // Background color
        let fillStyle = normalizedAttr(flowdata, r, c, 'bg');

        if (checksCF?.cellColor != null) {
            fillStyle = checksCF.cellColor;
        }

        if (!fillStyle) {
            renderCtx.fillStyle = '#FFFFFF';
        } else {
            renderCtx.fillStyle = fillStyle;
        }

        const cellsize = [
            startX + offsetLeft + BORDER_FIX[0],
            startY + offsetTop + BORDER_FIX[1],
            endX - startX + BORDER_FIX[2] - (isMerge ? 1 : 0),
            endY - startY + BORDER_FIX[3],
        ];

        // Before cell render (merged cells may re-render)
        if (
            this.sheetCtx.hooks.beforeRenderCell?.(
                flowdata[r][c],
                {
                    row: r,
                    column: c,
                    startX: cellsize[0],
                    startY: cellsize[1],
                    endX: cellsize[2] + cellsize[0],
                    endY: cellsize[3] + cellsize[1],
                },
                renderCtx,
            ) === false
        ) {
            return;
        }

        renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

        if (`${r}_${c}` in dynamicArrayCompute) {
            const value = dynamicArrayCompute[`${r}_${c}`].v;

            renderCtx.fillStyle = '#000000';
            // Text width and height
            const fontset = defaultFont(this.sheetCtx.defaultFontSize);
            renderCtx.font = fontset;

            // Horizontal align (default: left)
            const horizonAlignPos = startX + 4 + offsetLeft;

            // Vertical align (default: bottom)
            const verticalAlignPos = endY + offsetTop - 2;
            renderCtx.textBaseline = 'bottom';

            renderCtx.fillText(value == null ? '' : String(value), horizonAlignPos, verticalAlignPos);
        }

        // Comment indicator triangle
        if (flowdata?.[r]?.[c]?.commentCardIds?.length) {
            const commentInfo = this.sheetCtx.hooks.getCommentInfo?.(r, c);
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 12, startY + offsetTop);
            renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop);
            renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop + 11);
            renderCtx.fillStyle = commentInfo?.indicatorColor ?? commentInfo?.card.color ?? '#FC6666';
            renderCtx.fill();
            renderCtx.closePath();
        }

        // Check overflow cell relationship
        const overflowInfo = this.overflowColIn(cellOverflowMap, r, c, colEnd);

        // Last column of overflow range: render overflow cell content
        if (
            overflowInfo.colLast &&
            overflowInfo.rowIndex != null &&
            overflowInfo.colIndex != null &&
            overflowInfo.stc != null &&
            overflowInfo.edc != null
        ) {
            this.cellOverflowRender(
                pass,
                overflowInfo.rowIndex,
                overflowInfo.colIndex,
                overflowInfo.stc,
                overflowInfo.edc,
            );
        }

        // Overflow cell spans this cell, skip right border
        if (!overflowInfo.colIn || overflowInfo.colLast) {
            // Right border
            if (drawGridLines) {
                renderCtx.beginPath();
                renderCtx.moveTo(endX + offsetLeft - 2 + HALF_PIXEL, startY + offsetTop);
                renderCtx.lineTo(endX + offsetLeft - 2 + HALF_PIXEL, endY + offsetTop);
                renderCtx.lineWidth = 1;
                renderCtx.strokeStyle = defaultStyle.strokeStyle;
                renderCtx.stroke();
                renderCtx.closePath();
            }
        }

        // Bottom border
        if (drawGridLines) {
            renderCtx.beginPath();
            renderCtx.moveTo(startX + offsetLeft - 1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineTo(endX + offsetLeft - 1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.stroke();
            renderCtx.closePath();
        }

        // After cell render
        this.sheetCtx.hooks.afterRenderCell?.(
            flowdata[r][c],
            {
                row: r,
                column: c,
                startY: cellsize[1],
                startX: cellsize[0],
                endY: cellsize[3] + cellsize[1],
                endX: cellsize[2] + cellsize[0],
            },
            renderCtx,
        );
    }

    private cellRender(
        pass: RenderPass,
        r: number,
        c: number,
        startY: number,
        startX: number,
        endY: number,
        endX: number,
        value: string | number | boolean | null | undefined,
        isMerge = false,
    ) {
        const { renderCtx, cfCompute, offsetLeft, offsetTop, cellOverflowMap, colEnd, flowdata, drawGridLines } = pass;
        const cell = flowdata[r][c];
        const cellWidth = endX - startX - 2;
        const cellHeight = endY - startY - 2;
        const space_width = 2;
        const space_height = 2;

        const horizonAlign = Number(normalizedAttr(flowdata, r, c, 'ht'));
        const verticalAlign = Number(normalizedAttr(flowdata, r, c, 'vt'));

        const checksCF = checkCF(r, c, cfCompute);

        // Background color
        let fillStyle = normalizedAttr(flowdata, r, c, 'bg');
        if (checksCF?.cellColor != null) {
            fillStyle = checksCF.cellColor;
        }
        if (!fillStyle) {
            renderCtx.fillStyle = '#FFFFFF';
        } else {
            renderCtx.fillStyle = fillStyle;
        }

        const cellsize = [
            startX + offsetLeft + BORDER_FIX[0],
            startY + offsetTop + BORDER_FIX[1],
            endX - startX + BORDER_FIX[2] - (isMerge ? 1 : 0),
            endY - startY + BORDER_FIX[3],
        ];

        // Before cell render (merged cells may re-render)
        if (
            this.sheetCtx.hooks.beforeRenderCell?.(
                flowdata[r][c],
                {
                    row: r,
                    column: c,
                    startY: cellsize[1],
                    startX: cellsize[0],
                    endY: cellsize[3] + cellsize[1],
                    endX: cellsize[2] + cellsize[0],
                },
                renderCtx,
            ) === false
        ) {
            return;
        }

        renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

        const index = getSheetIndex(this.sheetCtx, this.sheetCtx.currentSheetId) as number;

        const { dataVerification } = this.sheetCtx.sheets[index];

        if (dataVerification?.[`${r}_${c}`] && !validateCellData(this.sheetCtx, dataVerification[`${r}_${c}`], value)) {
            // Data validation error indicator (red triangle top-left)
            renderCtx.beginPath();
            renderCtx.moveTo(startX + offsetLeft, startY + offsetTop);
            renderCtx.lineTo(startX + offsetLeft + 5, startY + offsetTop);
            renderCtx.lineTo(startX + offsetLeft, startY + offsetTop + 5);
            renderCtx.fillStyle = '#FC6666';
            renderCtx.fill();
            renderCtx.closePath();
        }

        // Comment indicator triangle
        if (cell?.commentCardIds?.length) {
            const commentInfo = this.sheetCtx.hooks.getCommentInfo?.(r, c);
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 12, startY + offsetTop);
            renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop);
            renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop + 11);
            renderCtx.fillStyle = commentInfo?.indicatorColor ?? commentInfo?.card.color ?? '#FC6666';
            renderCtx.fill();
            renderCtx.closePath();
        }

        // Forced-string indicator (green triangle top-left)
        if (cell?.qp === 1 && coercesToNumber(cell?.v)) {
            renderCtx.beginPath();
            renderCtx.moveTo(startX + offsetLeft + 5, startY + offsetTop);
            renderCtx.lineTo(startX + offsetLeft - 1, startY + offsetTop);
            renderCtx.lineTo(startX + offsetLeft - 1, startY + offsetTop + 6);
            renderCtx.fillStyle = '#487f1e';
            renderCtx.fill();
            renderCtx.closePath();
        }

        // Overflow cell handling
        let drawRightGridLine = true;
        const overflowInfo = this.overflowColIn(cellOverflowMap, r, c, colEnd);

        if (cell?.tb === '1' && overflowInfo.colIn) {
            // Last column of overflow range: render overflow cell content
            if (
                overflowInfo.colLast &&
                overflowInfo.rowIndex != null &&
                overflowInfo.colIndex != null &&
                overflowInfo.stc != null &&
                overflowInfo.edc != null
            ) {
                this.cellOverflowRender(
                    pass,
                    overflowInfo.rowIndex,
                    overflowInfo.colIndex,
                    overflowInfo.stc,
                    overflowInfo.edc,
                );
            } else {
                drawRightGridLine = false;
            }
        }
        // Data validation checkbox
        else if (dataVerification?.[`${r}_${c}`]?.type === 'checkbox') {
            const pos_x = startX + offsetLeft;
            const pos_y = startY + offsetTop + 1;

            renderCtx.save();
            renderCtx.beginPath();
            renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
            renderCtx.clip();

            const measureText = getMeasureText(value ?? '', renderCtx);
            const textMetrics = measureText.width + 14;
            const oneLineTextHeight = measureText.actualBoundingBoxDescent + measureText.actualBoundingBoxAscent;

            let horizonAlignPos = pos_x + space_width;
            if (horizonAlign === 0) {
                horizonAlignPos = pos_x + cellWidth / 2 - textMetrics / 2;
            } else if (horizonAlign === 2) {
                horizonAlignPos = pos_x + cellWidth - space_width - textMetrics;
            }

            const verticalCellHeight = cellHeight > oneLineTextHeight ? cellHeight : oneLineTextHeight;

            let verticalAlignPos_text = pos_y + verticalCellHeight - space_height;
            renderCtx.textBaseline = 'bottom';
            let verticalAlignPos_checkbox = verticalAlignPos_text - 13;

            if (verticalAlign === 0) {
                verticalAlignPos_text = pos_y + verticalCellHeight / 2;
                renderCtx.textBaseline = 'middle';
                verticalAlignPos_checkbox = verticalAlignPos_text - 6;
            } else if (verticalAlign === 1) {
                verticalAlignPos_text = pos_y + space_height;
                renderCtx.textBaseline = 'top';
                verticalAlignPos_checkbox = verticalAlignPos_text + 1;
            }

            // Checkbox
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = '#000';
            renderCtx.strokeRect(horizonAlignPos, verticalAlignPos_checkbox, 10, 10);

            if (dataVerification[`${r}_${c}`].checked) {
                renderCtx.beginPath();
                renderCtx.lineTo(horizonAlignPos + 1, verticalAlignPos_checkbox + 6);
                renderCtx.lineTo(horizonAlignPos + 4, verticalAlignPos_checkbox + 9);
                renderCtx.lineTo(horizonAlignPos + 9, verticalAlignPos_checkbox + 2);
                renderCtx.stroke();
                renderCtx.closePath();
            }

            // Text
            renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');
            renderCtx.fillText(value == null ? '' : String(value), horizonAlignPos + 14, verticalAlignPos_text);

            renderCtx.restore();
        } else {
            // Conditional formatting data bar
            if (checksCF?.dataBar?.valueLen && checksCF?.dataBar?.valueLen?.toString() !== 'NaN') {
                const x = startX + offsetLeft + space_width;
                const y = startY + offsetTop + space_height;
                const w = cellWidth - space_width * 2;
                const h = cellHeight - space_height * 2;

                const { valueType } = checksCF.dataBar;
                const { valueLen } = checksCF.dataBar;
                const { format } = checksCF.dataBar;

                if (valueType === 'minus') {
                    // Negative value
                    const { minusLen } = checksCF.dataBar;

                    if (format.length > 1) {
                        // Gradient
                        const my_gradient = renderCtx.createLinearGradient(
                            x + w * minusLen * (1 - valueLen),
                            y,
                            x + w * minusLen,
                            y,
                        );
                        my_gradient.addColorStop(0, '#ffffff');
                        my_gradient.addColorStop(1, '#ff0000');

                        renderCtx.fillStyle = my_gradient;
                    } else {
                        // Solid
                        renderCtx.fillStyle = '#ff0000';
                    }

                    renderCtx.fillRect(x + w * minusLen * (1 - valueLen), y, w * minusLen * valueLen, h);

                    renderCtx.beginPath();
                    renderCtx.moveTo(x + w * minusLen * (1 - valueLen), y);
                    renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y + h);
                    renderCtx.lineTo(x + w * minusLen, y + h);
                    renderCtx.lineTo(x + w * minusLen, y);
                    renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y);
                    renderCtx.lineWidth = 1;
                    renderCtx.strokeStyle = '#ff0000';
                    renderCtx.stroke();
                    renderCtx.closePath();
                } else if (valueType === 'plus') {
                    // Positive value
                    const { plusLen } = checksCF.dataBar;

                    if (plusLen === 1) {
                        if (format.length > 1) {
                            // Gradient
                            const my_gradient = renderCtx.createLinearGradient(x, y, x + w * valueLen, y);
                            my_gradient.addColorStop(0, format[0]);
                            my_gradient.addColorStop(1, format[1]);

                            renderCtx.fillStyle = my_gradient;
                        } else {
                            // Solid
                            [renderCtx.fillStyle] = format;
                        }

                        renderCtx.fillRect(x, y, w * valueLen, h);

                        renderCtx.beginPath();
                        renderCtx.moveTo(x, y);
                        renderCtx.lineTo(x, y + h);
                        renderCtx.lineTo(x + w * valueLen, y + h);
                        renderCtx.lineTo(x + w * valueLen, y);
                        renderCtx.lineTo(x, y);
                        renderCtx.lineWidth = 1;
                        [renderCtx.strokeStyle] = format;
                        renderCtx.stroke();
                        renderCtx.closePath();
                    } else {
                        const { minusLen } = checksCF.dataBar;

                        if (format.length > 1) {
                            // Gradient
                            const my_gradient = renderCtx.createLinearGradient(
                                x + w * minusLen,
                                y,
                                x + w * minusLen + w * plusLen * valueLen,
                                y,
                            );
                            my_gradient.addColorStop(0, format[0]);
                            my_gradient.addColorStop(1, format[1]);

                            renderCtx.fillStyle = my_gradient;
                        } else {
                            // Solid
                            [renderCtx.fillStyle] = format;
                        }

                        renderCtx.fillRect(x + w * minusLen, y, w * plusLen * valueLen, h);

                        renderCtx.beginPath();
                        renderCtx.moveTo(x + w * minusLen, y);
                        renderCtx.lineTo(x + w * minusLen, y + h);
                        renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y + h);
                        renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y);
                        renderCtx.lineTo(x + w * minusLen, y);
                        renderCtx.lineWidth = 1;
                        [renderCtx.strokeStyle] = format;
                        renderCtx.stroke();
                        renderCtx.closePath();
                    }
                }
            }

            const pos_x = startX + offsetLeft;
            const pos_y = startY + offsetTop + 1;

            renderCtx.save();
            renderCtx.beginPath();
            renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
            renderCtx.clip();

            const textInfo = cell
                ? getCellTextInfo(cell, renderCtx, this.sheetCtx, {
                      cellWidth,
                      cellHeight,
                      space_width,
                      space_height,
                      r,
                      c,
                  })
                : undefined;

            // Cell text color
            renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');

            if (checksCF?.textColor) {
                renderCtx.fillStyle = checksCF.textColor;
            }

            // Custom number format [Red]: set text color to red
            if ((cell?.ct?.fa?.indexOf('[Red]') ?? -1) > -1 && cell?.ct?.t === 'n' && (cell?.v as number) < 0) {
                renderCtx.fillStyle = '#ff0000';
            }

            this.cellTextRender(textInfo, renderCtx, {
                pos_x,
                pos_y,
            });

            renderCtx.restore();
        }

        if (drawRightGridLine && drawGridLines) {
            // Right border
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 2 + HALF_PIXEL, startY + offsetTop);
            renderCtx.lineTo(endX + offsetLeft - 2 + HALF_PIXEL, endY + offsetTop);
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.stroke();
            renderCtx.closePath();
        }

        // Bottom border
        if (drawGridLines) {
            renderCtx.beginPath();
            renderCtx.moveTo(startX + offsetLeft - 1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineTo(endX + offsetLeft - 1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.stroke();
            renderCtx.closePath();
        }

        // After cell render
        this.sheetCtx.hooks.afterRenderCell?.(
            flowdata[r]?.[c],
            {
                row: r,
                column: c,
                startX: cellsize[0],
                startY: cellsize[1],
                endX: cellsize[2] + cellsize[0],
                endY: cellsize[3] + cellsize[1],
            },
            renderCtx,
        );
    }

    // Overflow cell rendering
    private cellOverflowRender(pass: RenderPass, r: number, c: number, stc: number, edc: number) {
        const { renderCtx, scrollHeight, scrollWidth, offsetLeft, offsetTop, cfCompute, flowdata } = pass;
        // Overflow cell start/end row/column coordinates
        const startY = rowStartY(this.sheetCtx.visibledatarow, r, scrollHeight);
        const endY = rowEndY(this.sheetCtx.visibledatarow, r, scrollHeight);
        const startX = colStartX(this.sheetCtx.visibledatacolumn, stc, scrollWidth);
        const endX = colEndX(this.sheetCtx.visibledatacolumn, edc, scrollWidth);

        const cell = flowdata[r][c];
        const cellWidth = endX - startX - 2;
        const cellHeight = endY - startY - 2;
        const space_width = 2;
        const space_height = 2;

        const pos_x = startX + offsetLeft;
        const pos_y = startY + offsetTop + 1;

        const fontset = getFontSet(cell, this.sheetCtx.defaultFontSize);
        renderCtx.font = fontset;

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
        renderCtx.clip();

        const textInfo = cell
            ? getCellTextInfo(cell, renderCtx, this.sheetCtx, {
                  cellWidth,
                  cellHeight,
                  space_width,
                  space_height,
                  r,
                  c,
              })
            : undefined;

        const checksCF = checkCF(r, c, cfCompute);

        // Cell text color
        renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');

        if (checksCF?.textColor) {
            renderCtx.fillStyle = checksCF.textColor;
        }

        this.cellTextRender(textInfo, renderCtx, {
            pos_x,
            pos_y,
        });

        renderCtx.restore();
    }

    private traceOverflow(
        r: number,
        curC: number,
        traceC: number,
        traceDir: string,
        horizonAlign: string,
        textMetrics: number,
    ): { success: boolean; r: number; c: number } {
        const flowdata = getFlowdata(this.sheetCtx);
        if (!flowdata) return { success: false, r, c: traceC };

        // Trace terminates if column index is out of array bounds
        if (traceDir === 'forward' && traceC < 0) {
            return {
                success: false,
                r,
                c: traceC,
            };
        }

        if (traceDir === 'backward' && traceC > flowdata[r].length - 1) {
            return {
                success: false,
                r,
                c: traceC,
            };
        }

        // Trace terminates if cell is non-empty or merged
        const cell = flowdata[r][traceC];
        if (cell && (!isEmpty(cell.v) || cell.mc)) {
            return {
                success: false,
                r,
                c: traceC,
            };
        }

        let start_curC = colStartX(this.sheetCtx.visibledatacolumn, curC, 0);
        let end_curC = colEndX(this.sheetCtx.visibledatacolumn, curC, 0);

        const w = textMetrics - (end_curC - start_curC);

        if (horizonAlign === '0') {
            // Center align
            start_curC -= w / 2;
            end_curC += w / 2;
        } else if (horizonAlign === '1') {
            // Left align
            end_curC += w;
        } else if (horizonAlign === '2') {
            // Right align
            start_curC -= w;
        }

        const start_traceC = colStartX(this.sheetCtx.visibledatacolumn, traceC, 0);
        const end_traceC = colEndX(this.sheetCtx.visibledatacolumn, traceC, 0);

        if (traceDir === 'forward') {
            if (start_curC < start_traceC) {
                return this.traceOverflow(r, curC, traceC - 1, traceDir, horizonAlign, textMetrics);
            }
            if (start_curC < end_traceC) {
                return {
                    success: true,
                    r,
                    c: traceC,
                };
            }
            return {
                success: false,
                r,
                c: traceC,
            };
        }

        if (traceDir === 'backward') {
            if (end_curC > end_traceC) {
                return this.traceOverflow(r, curC, traceC + 1, traceDir, horizonAlign, textMetrics);
            }
            if (end_curC > start_traceC) {
                return {
                    success: true,
                    r,
                    c: traceC,
                };
            }
            return {
                success: false,
                r,
                c: traceC,
            };
        }
        return { success: false, r, c: traceC };
    }

    private overflowColIn(map: CellOverflowMap, r: number, c: number, colEnd: number) {
        let colIn = false; // Whether this cell is within an overflow cell's render range
        let colLast = false; // Whether this cell is the last column in an overflow cell's render range
        let rowIndex: number | undefined; // Overflow cell row index
        let colIndex: number | undefined; // Overflow cell column index
        let stc: number | undefined;
        let edc: number | undefined;

        if (map) {
            for (const rkey of Object.keys(map)) {
                const row = map[Number(rkey)];
                if (!row) continue;
                for (const ckey of Object.keys(row)) {
                    const mapItem = row[Number(ckey)];
                    const ri = Number(rkey);
                    const ci = Number(ckey);

                    if (ri === r && c >= mapItem.stc && c <= mapItem.edc) {
                        colIn = true;
                        rowIndex = ri;
                        colIndex = ci;
                        stc = mapItem.stc;
                        edc = mapItem.edc;

                        if (c === mapItem.edc || c === colEnd) {
                            colLast = true;
                            break;
                        }
                    }
                }
                if (colLast) break;
            }
        }

        return {
            colIn,
            colLast,
            rowIndex,
            colIndex,
            stc,
            edc,
        };
    }

    private cellTextRender(
        textInfo: CellTextInfo | null | undefined,
        ctx: CanvasRenderingContext2D,
        option: { pos_x: number; pos_y: number },
    ) {
        if (!textInfo) {
            return;
        }
        const { values, rotate, type, textLeftAll, textTopAll } = textInfo;
        const { pos_x, pos_y } = option;
        const rotated =
            rotate !== undefined &&
            rotate !== 0 &&
            type !== 'verticalWrap' &&
            textLeftAll !== undefined &&
            textTopAll !== undefined;
        if (rotated) {
            ctx.save();
            ctx.translate(pos_x + textLeftAll, pos_y + textTopAll);
            ctx.rotate((-rotate * Math.PI) / 180);
            ctx.translate(-(textLeftAll + pos_x), -(pos_y + textTopAll));
        }

        for (let i = 0; i < values.length; i += 1) {
            const word = values[i];
            const style = word.style;
            if (word.inline === true && isInlineStyle(style)) {
                ctx.font = style.fontset;
                ctx.fillStyle = style.fc;
            } else if (typeof style === 'string') {
                ctx.font = style;
            }

            const txt = isPlainObject(word.content)
                ? String((word.content as { m?: unknown }).m ?? '')
                : String(word.content);
            ctx.fillText(txt, pos_x + word.left, pos_y + word.top);

            if (word.cancelLine) {
                const c = word.cancelLine;
                ctx.beginPath();
                ctx.moveTo(Math.floor(pos_x + c.startX) + 0.5, Math.floor(pos_y + c.startY) + 0.5);
                ctx.lineTo(Math.floor(pos_x + c.endX) + 0.5, Math.floor(pos_y + c.endY) + 0.5);
                ctx.lineWidth = Math.floor(c.fs / 9);
                ctx.strokeStyle = ctx.fillStyle;
                ctx.stroke();
                ctx.closePath();
            }

            if (word.underLine) {
                const underLines = word.underLine;
                for (let a = 0; a < underLines.length; a += 1) {
                    const item = underLines[a];
                    ctx.beginPath();
                    ctx.moveTo(Math.floor(pos_x + item.startX) + 0.5, Math.floor(pos_y + item.startY));
                    ctx.lineTo(Math.floor(pos_x + item.endX) + 0.5, Math.floor(pos_y + item.endY) + 0.5);
                    ctx.lineWidth = Math.floor(item.fs / 9);
                    ctx.strokeStyle = ctx.fillStyle;
                    ctx.stroke();
                    ctx.closePath();
                }
            }
        }
        if (rotated) {
            ctx.restore();
        }
    }
}

function isInlineStyle(value: unknown): value is { fontset: string; fc: string } {
    return typeof value === 'object' && value !== null && 'fontset' in value && 'fc' in value;
}
