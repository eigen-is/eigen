// Row and column header strips: white cell backgrounds, sequence labels, and
// the separator lines (hidden rows/columns get a doubled separator).

import { type Context, getSheetConfig } from '../context';
import { defaultFont, getMeasureText } from '../modules/text';
import { indexToColumnChar } from '../utils';
import { colEndX, colStartX, HALF_PIXEL, headerVisibleRange, rowEndY, rowStartY } from './geometry';
import { defaultStyle } from './types';

export function drawRowHeader(
    sheetCtx: Context,
    renderCtx: CanvasRenderingContext2D,
    scrollHeight: number,
    drawHeight?: number,
    offsetTop?: number,
) {
    drawHeight ??= sheetCtx.tableContentSize[1];
    offsetTop ??= sheetCtx.columnHeaderHeight;

    renderCtx.save();
    renderCtx.scale(sheetCtx.devicePixelRatio, sheetCtx.devicePixelRatio);

    renderCtx.clearRect(0, offsetTop, sheetCtx.rowHeaderWidth - 1, drawHeight);

    renderCtx.font = defaultFont(sheetCtx.defaultFontSize);
    renderCtx.textBaseline = defaultStyle.textBaseline;
    renderCtx.fillStyle = defaultStyle.fillStyle;

    const { start: rowStart, end: rowEnd } = headerVisibleRange(sheetCtx.visibledatarow, scrollHeight, drawHeight);

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(0, offsetTop - 1, sheetCtx.rowHeaderWidth - 1, drawHeight - 2);
    renderCtx.clip();

    const rowhidden = getSheetConfig(sheetCtx)?.rowhidden;
    let prevEndY: number | undefined;
    for (let r = rowStart; r <= rowEnd; r += 1) {
        const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
        const endY = rowEndY(sheetCtx.visibledatarow, r, scrollHeight);

        const firstOffset = rowStart === r ? -2 : 0;
        const lastOffset = rowEnd === r ? -2 : 0;
        // Triggered before row header cell render; return false to skip
        if (
            sheetCtx.hooks.beforeRenderRowHeaderCell?.(
                `${r + 1}`,
                r,
                startY + offsetTop + firstOffset,
                sheetCtx.rowHeaderWidth - 1,
                endY - startY + 1 + lastOffset - firstOffset,
                renderCtx,
            ) === false
        ) {
            continue;
        }

        if (rowhidden?.[r] == null) {
            renderCtx.fillStyle = '#ffffff';
            renderCtx.fillRect(
                0,
                startY + offsetTop + firstOffset,
                sheetCtx.rowHeaderWidth - 1,
                endY - startY + 1 + lastOffset - firstOffset,
            );
            renderCtx.fillStyle = '#000000';

            // Row header sequence number
            const textMetrics = getMeasureText(r + 1, renderCtx);

            const horizonAlignPos = (sheetCtx.rowHeaderWidth - textMetrics.width) / 2;
            const verticalAlignPos = startY + (endY - startY) / 2 + offsetTop;

            renderCtx.fillText(`${r + 1}`, horizonAlignPos, verticalAlignPos);
        }

        // Row header right edge
        renderCtx.beginPath();
        renderCtx.moveTo(sheetCtx.rowHeaderWidth - 2 + HALF_PIXEL, startY + offsetTop - 2);
        renderCtx.lineTo(sheetCtx.rowHeaderWidth - 2 + HALF_PIXEL, endY + offsetTop - 2);
        renderCtx.lineWidth = 1;

        renderCtx.strokeStyle = defaultStyle.strokeStyle;
        renderCtx.stroke();
        renderCtx.closePath();

        // Row header horizontal line
        if (rowhidden && rowhidden[r] == null && rowhidden[r + 1] != null) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, endY + offsetTop - 4 + HALF_PIXEL);
            renderCtx.lineTo(sheetCtx.rowHeaderWidth - 1, endY + offsetTop - 4 + HALF_PIXEL);
            renderCtx.closePath();
            renderCtx.stroke();
        } else if (rowhidden == null || rowhidden[r] == null) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineTo(sheetCtx.rowHeaderWidth - 1, endY + offsetTop - 2 + HALF_PIXEL);

            renderCtx.closePath();
            renderCtx.stroke();
        }

        if (rowhidden?.[r - 1] != null && prevEndY !== undefined) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, prevEndY + offsetTop + HALF_PIXEL);
            renderCtx.lineTo(sheetCtx.rowHeaderWidth - 1, prevEndY + offsetTop + HALF_PIXEL);
            renderCtx.closePath();
            renderCtx.stroke();
        }

        prevEndY = endY;

        sheetCtx.hooks.afterRenderRowHeaderCell?.(
            `${r + 1}`,
            r,
            startY + offsetTop + firstOffset,
            sheetCtx.rowHeaderWidth - 1,
            endY - startY + 1 + lastOffset - firstOffset,
            renderCtx,
        );
    }

    renderCtx.restore(); // header clip
    renderCtx.restore(); // device-pixel-ratio scale
}

export function drawColumnHeader(
    sheetCtx: Context,
    renderCtx: CanvasRenderingContext2D,
    scrollWidth: number,
    drawWidth?: number,
    offsetLeft?: number,
) {
    drawWidth ??= sheetCtx.tableContentSize[0];
    offsetLeft ??= sheetCtx.rowHeaderWidth;

    renderCtx.save();
    renderCtx.scale(sheetCtx.devicePixelRatio, sheetCtx.devicePixelRatio);
    renderCtx.clearRect(offsetLeft, 0, drawWidth, sheetCtx.columnHeaderHeight - 1);

    renderCtx.font = defaultFont(sheetCtx.defaultFontSize);
    renderCtx.textBaseline = defaultStyle.textBaseline;
    renderCtx.fillStyle = defaultStyle.fillStyle;

    const { start: colStart, end: colEnd } = headerVisibleRange(sheetCtx.visibledatacolumn, scrollWidth, drawWidth);

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(offsetLeft - 1, 0, drawWidth, sheetCtx.columnHeaderHeight - 1);
    renderCtx.clip();

    const colhidden = getSheetConfig(sheetCtx)?.colhidden;
    let prevEndX: number | undefined;
    for (let c = colStart; c <= colEnd; c += 1) {
        const startX = colStartX(sheetCtx.visibledatacolumn, c, scrollWidth);
        const endX = colEndX(sheetCtx.visibledatacolumn, c, scrollWidth);

        const columnLabel = indexToColumnChar(c);
        // Triggered before column header cell render; return false to skip
        if (
            sheetCtx.hooks.beforeRenderColumnHeaderCell?.(
                columnLabel,
                c,
                startX + offsetLeft - 1,
                endX - startX,
                sheetCtx.columnHeaderHeight - 1,
                renderCtx,
            ) === false
        ) {
            continue;
        }

        if (colhidden?.[c] == null) {
            renderCtx.fillStyle = '#ffffff';
            renderCtx.fillRect(startX + offsetLeft - 1, 0, endX - startX, sheetCtx.columnHeaderHeight - 1);
            renderCtx.fillStyle = '#000000';

            // Column header sequence number
            const textMetrics = getMeasureText(columnLabel, renderCtx);

            const horizonAlignPos = Math.round(startX + (endX - startX) / 2 + offsetLeft - textMetrics.width / 2);
            const verticalAlignPos = Math.round(sheetCtx.columnHeaderHeight / 2);

            renderCtx.fillText(columnLabel, horizonAlignPos, verticalAlignPos);
        }

        // Column header vertical line
        if (colhidden && colhidden[c] != null && colhidden[c + 1] != null) {
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 4 + HALF_PIXEL, 0);
            renderCtx.lineTo(endX + offsetLeft - 4 + HALF_PIXEL, sheetCtx.columnHeaderHeight - 2);
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.closePath();
            renderCtx.stroke();
        } else if (colhidden == null || colhidden[c] == null) {
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 2 + HALF_PIXEL, 0);
            renderCtx.lineTo(endX + offsetLeft - 2 + HALF_PIXEL, sheetCtx.columnHeaderHeight - 2);

            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = defaultStyle.strokeStyle;
            renderCtx.closePath();
            renderCtx.stroke();
        }

        if (colhidden?.[c - 1] != null && prevEndX !== undefined) {
            renderCtx.beginPath();
            renderCtx.moveTo(prevEndX + offsetLeft + HALF_PIXEL, 0);
            renderCtx.lineTo(prevEndX + offsetLeft + HALF_PIXEL, sheetCtx.columnHeaderHeight - 2);
            renderCtx.closePath();
            renderCtx.stroke();
        }

        // Column header bottom edge
        renderCtx.beginPath();
        renderCtx.moveTo(startX + offsetLeft - 1, sheetCtx.columnHeaderHeight - 2 + HALF_PIXEL);
        renderCtx.lineTo(endX + offsetLeft - 1, sheetCtx.columnHeaderHeight - 2 + HALF_PIXEL);
        renderCtx.stroke();
        renderCtx.closePath();

        prevEndX = endX;

        sheetCtx.hooks.afterRenderColumnHeaderCell?.(
            columnLabel,
            c,
            startX + offsetLeft - 1,
            endX - startX,
            sheetCtx.columnHeaderHeight - 1,
            renderCtx,
        );
    }

    renderCtx.restore(); // header clip
    renderCtx.restore(); // device-pixel-ratio scale
}
