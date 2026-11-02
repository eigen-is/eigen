// Canvas renderer facade. The drawing itself lives in the render passes: drawMain
// runs them over one rect of one pane (collect cells -> render cells -> reprocess
// merges -> grid lines -> borders -> edge clear -> filter UI), and each pane or
// part of one is its own call with its own offsets.

import type { Context } from './context';
import { getFlowdata } from './context';
import { getComputeMap } from './modules/condition-format';
import { validationLookup } from './modules/data-verification';
import { clearMeasureTextCache, defaultFont } from './modules/text';
import { drawCellBorders } from './render/borders';
import { canvasColors } from './render/colors';
import { drawFilterUI } from './render/filter-ui';
import { mainVisibleRange } from './render/geometry';
import { drawColumnHeader, drawRowHeader } from './render/headers';
import { computeCellOverflowMap } from './render/overflow';
import { collectVisibleCells, renderCells, renderMergedCells } from './render/phases';
import type { RenderPass } from './render/types';
import { getSheetIndex } from './utils';

// The measured-text cache survives the multi-pass draw bursts; 100ms without a
// drawMain call invalidates it.
let renderCacheClearTimeout: ReturnType<typeof setTimeout> | undefined;

export class Canvas {
    private canvasElement: HTMLCanvasElement;

    private sheetCtx: Context;

    public constructor(canvasElement: HTMLCanvasElement, ctx: Context) {
        this.canvasElement = canvasElement;
        this.sheetCtx = ctx;
    }

    public drawRowHeader(scrollHeight: number, drawHeight: number, offsetTop: number) {
        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;
        drawRowHeader(this.sheetCtx, renderCtx, scrollHeight, drawHeight, offsetTop);
    }

    public drawColumnHeader(scrollWidth: number, drawWidth: number, offsetLeft: number) {
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
    }: {
        scrollWidth: number;
        scrollHeight: number;
        drawWidth: number;
        drawHeight: number;
        offsetLeft: number;
        offsetTop: number;
    }) {
        const flowdata = getFlowdata(this.sheetCtx);
        if (flowdata == null) {
            return;
        }

        clearTimeout(renderCacheClearTimeout);

        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);

        // Table render area: start/end row/column indices
        const { start: rowStart, end: rowEnd } = mainVisibleRange(
            this.sheetCtx.visibledatarow,
            scrollHeight,
            drawHeight,
        );
        const { start: colStart, end: colEnd } = mainVisibleRange(
            this.sheetCtx.visibledatacolumn,
            scrollWidth,
            drawWidth,
        );

        // Table render area: start/end coordinates
        const lastRowBottom = this.sheetCtx.visibledatarow[rowEnd];
        const lastColRight = this.sheetCtx.visibledatacolumn[colEnd];

        // Initialize table canvas area
        renderCtx.fillStyle = '#ffffff';
        renderCtx.fillRect(offsetLeft - 1, offsetTop - 1, lastColRight - scrollWidth, lastRowBottom - scrollHeight);
        renderCtx.font = defaultFont();
        renderCtx.fillStyle = canvasColors(this.canvasElement).cellText;

        const sheetIndex = getSheetIndex(this.sheetCtx, this.sheetCtx.currentSheetId);
        const validationAt = validationLookup(
            sheetIndex == null ? undefined : this.sheetCtx.sheets[sheetIndex].dataValidations,
            { row: [rowStart, rowEnd], column: [colStart, colEnd] },
        );

        const pass: RenderPass = {
            sheetCtx: this.sheetCtx,
            renderCtx,
            offsetLeft,
            offsetTop,
            scrollWidth,
            scrollHeight,
            origin: { x: offsetLeft - scrollWidth, y: offsetTop - scrollHeight },
            drawWidth,
            drawHeight,
            rowStart,
            rowEnd,
            colStart,
            colEnd,
            flowdata,
            cfCompute: getComputeMap(this.sheetCtx),
            validationAt,
            cellOverflowMap: computeCellOverflowMap(
                this.sheetCtx,
                renderCtx,
                validationAt,
                colStart,
                colEnd,
                rowStart,
                rowEnd,
            ),
            drawGridLines: !this.sheetCtx.currentSheetIsPivot && this.sheetCtx.showGridLines,
            gridLines: new Path2D(),
        };

        const cells = collectVisibleCells(pass);
        const mergedCells = renderCells(pass, cells);
        renderMergedCells(pass, mergedCells);
        renderCtx.lineWidth = 1;
        renderCtx.strokeStyle = canvasColors(this.canvasElement).gridLine;
        renderCtx.stroke(pass.gridLines);
        drawCellBorders(pass);

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

        renderCacheClearTimeout = setTimeout(() => {
            clearMeasureTextCache();
        }, 100);
    }

    public drawFreezeLine({ horizontalTop, verticalLeft }: { horizontalTop?: number; verticalLeft?: number }) {
        const renderCtx = this.canvasElement.getContext('2d');
        if (!renderCtx) return;

        renderCtx.save();
        renderCtx.scale(this.sheetCtx.devicePixelRatio, this.sheetCtx.devicePixelRatio);
        renderCtx.strokeStyle = canvasColors(this.canvasElement).freezeLine;
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
