// Canvas renderer facade. The actual drawing lives in state/render/: drawMain
// orchestrates the per-pass phases (collect cells -> render cells -> reprocess
// merges -> borders -> edge clear -> filter UI); freeze regions invoke it once
// per region with their own offsets.

import { type Context, getFlowdata } from './context';
import { getComputeMap } from './modules/conditionFormat';
import { defaultFont } from './modules/text';
import { drawCellBorders } from './render/borders';
import { drawFilterUI } from './render/filter-ui';
import { mainVisibleRange } from './render/geometry';
import { drawColumnHeader, drawRowHeader } from './render/headers';
import { computeCellOverflowMap, holdRenderCaches, scheduleRenderCacheClear } from './render/overflow';
import { collectVisibleCells, renderCells, renderMergedCells } from './render/phases';
import type { RenderPass } from './render/types';
import { defaultStyle } from './render/types';

export class Canvas {
    private canvasElement: HTMLCanvasElement;

    private sheetCtx: Context;

    constructor(canvasElement: HTMLCanvasElement, ctx: Context) {
        this.canvasElement = canvasElement;
        this.sheetCtx = ctx;
    }

    public drawRowHeader(scrollHeight: number, drawHeight?: number, offsetTop?: number) {
        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;
        drawRowHeader(this.sheetCtx, renderCtx, scrollHeight, drawHeight, offsetTop);
    }

    public drawColumnHeader(scrollWidth: number, drawWidth?: number, offsetLeft?: number) {
        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;
        drawColumnHeader(this.sheetCtx, renderCtx, scrollWidth, drawWidth, offsetLeft);
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

        holdRenderCaches();

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
            // Overflow cell configuration for render area
            cellOverflowMap: computeCellOverflowMap(this.sheetCtx, renderCtx, colStart, colEnd, rowStart, rowEnd),
            drawGridLines: !this.sheetCtx.currentSheetIsPivot && this.sheetCtx.showGridLines,
        };

        this.sheetCtx.hooks.beforeRenderCellArea?.(flowdata, renderCtx);

        const { cells, borderOffset } = collectVisibleCells(pass);
        const mergedCells = renderCells(pass, cells);
        renderMergedCells(pass, mergedCells);
        drawCellBorders(pass, borderOffset);

        // Clear right gray area when last column is rendered to prevent overflow
        if (colEnd === this.sheetCtx.visibledatacolumn.length - 1) {
            renderCtx.clearRect(
                lastColRight - scrollWidth + offsetLeft - 1,
                offsetTop - 1,
                this.sheetCtx.ch_width - this.sheetCtx.visibledatacolumn[colEnd],
                lastRowBottom - scrollHeight,
            );
        }

        drawFilterUI(pass);

        renderCtx.restore();

        scheduleRenderCacheClear();
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
}
