// Row and column header strips: header backgrounds, sequence labels, and
// the separator lines (hidden rows/columns get a doubled separator).

import { columnIndexToLabel, SHEET_COLUMN_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import { defaultFont, getMeasureText } from '../modules/text';
import { canvasColors } from './colors';
import { colEndX, colStartX, HALF_PIXEL, headerVisibleRange, rowEndY, rowStartY } from './geometry';

export function drawRowHeader(
    sheetCtx: Context,
    renderCtx: CanvasRenderingContext2D,
    scrollHeight: number,
    drawHeight: number,
    offsetTop: number,
) {
    renderCtx.save();
    renderCtx.scale(sheetCtx.devicePixelRatio, sheetCtx.devicePixelRatio);

    renderCtx.clearRect(0, offsetTop, SHEET_ROW_HEADER_WIDTH - 1, drawHeight);

    const colors = canvasColors(renderCtx.canvas);
    const font = defaultFont();
    renderCtx.font = font;
    renderCtx.textBaseline = 'middle';

    const { start: rowStart, end: rowEnd } = headerVisibleRange(sheetCtx.visibledatarow, scrollHeight, drawHeight);

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(0, offsetTop - 1, SHEET_ROW_HEADER_WIDTH - 1, drawHeight - 2);
    renderCtx.clip();

    const rowhidden = getSheetConfig(sheetCtx)?.rowhidden;
    let prevEndY: number | undefined;
    for (let r = rowStart; r <= rowEnd; r += 1) {
        const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
        const endY = rowEndY(sheetCtx.visibledatarow, r, scrollHeight);

        const firstOffset = rowStart === r ? -2 : 0;
        const lastOffset = rowEnd === r ? -2 : 0;
        if (rowhidden?.[r] == null) {
            renderCtx.fillStyle = colors.headerBackground;
            renderCtx.fillRect(
                0,
                startY + offsetTop + firstOffset,
                SHEET_ROW_HEADER_WIDTH - 1,
                endY - startY + 1 + lastOffset - firstOffset,
            );
            renderCtx.fillStyle = colors.headerText;

            // Row header sequence number
            const textMetrics = getMeasureText(r + 1, renderCtx, font);

            const horizonAlignPos = (SHEET_ROW_HEADER_WIDTH - textMetrics.width) / 2;
            const verticalAlignPos = startY + (endY - startY) / 2 + offsetTop;

            renderCtx.fillText(`${r + 1}`, horizonAlignPos, verticalAlignPos);
        }

        // Row header right edge
        renderCtx.beginPath();
        renderCtx.moveTo(SHEET_ROW_HEADER_WIDTH - 2 + HALF_PIXEL, startY + offsetTop - 2);
        renderCtx.lineTo(SHEET_ROW_HEADER_WIDTH - 2 + HALF_PIXEL, endY + offsetTop - 2);
        renderCtx.lineWidth = 1;

        renderCtx.strokeStyle = colors.gridLine;
        renderCtx.stroke();
        renderCtx.closePath();

        // Row header horizontal line
        if (rowhidden && rowhidden[r] == null && rowhidden[r + 1] != null) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, endY + offsetTop - 4 + HALF_PIXEL);
            renderCtx.lineTo(SHEET_ROW_HEADER_WIDTH - 1, endY + offsetTop - 4 + HALF_PIXEL);
            renderCtx.closePath();
            renderCtx.stroke();
        } else if (rowhidden == null || rowhidden[r] == null) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, endY + offsetTop - 2 + HALF_PIXEL);
            renderCtx.lineTo(SHEET_ROW_HEADER_WIDTH - 1, endY + offsetTop - 2 + HALF_PIXEL);

            renderCtx.closePath();
            renderCtx.stroke();
        }

        if (rowhidden?.[r - 1] != null && prevEndY !== undefined) {
            renderCtx.beginPath();
            renderCtx.moveTo(-1, prevEndY + offsetTop + HALF_PIXEL);
            renderCtx.lineTo(SHEET_ROW_HEADER_WIDTH - 1, prevEndY + offsetTop + HALF_PIXEL);
            renderCtx.closePath();
            renderCtx.stroke();
        }

        prevEndY = endY;
    }

    renderCtx.restore(); // header clip
    renderCtx.restore(); // device-pixel-ratio scale
}

export function drawColumnHeader(
    sheetCtx: Context,
    renderCtx: CanvasRenderingContext2D,
    scrollWidth: number,
    drawWidth: number,
    offsetLeft: number,
) {
    renderCtx.save();
    renderCtx.scale(sheetCtx.devicePixelRatio, sheetCtx.devicePixelRatio);
    renderCtx.clearRect(offsetLeft, 0, drawWidth, SHEET_COLUMN_HEADER_HEIGHT - 1);

    const colors = canvasColors(renderCtx.canvas);
    const font = defaultFont();
    renderCtx.font = font;
    renderCtx.textBaseline = 'middle';

    const { start: colStart, end: colEnd } = headerVisibleRange(sheetCtx.visibledatacolumn, scrollWidth, drawWidth);

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(offsetLeft - 1, 0, drawWidth, SHEET_COLUMN_HEADER_HEIGHT - 1);
    renderCtx.clip();

    const colhidden = getSheetConfig(sheetCtx)?.colhidden;
    let prevEndX: number | undefined;
    for (let c = colStart; c <= colEnd; c += 1) {
        const startX = colStartX(sheetCtx.visibledatacolumn, c, scrollWidth);
        const endX = colEndX(sheetCtx.visibledatacolumn, c, scrollWidth);

        const columnLabel = columnIndexToLabel(c);
        if (colhidden?.[c] == null) {
            renderCtx.fillStyle = colors.headerBackground;
            renderCtx.fillRect(startX + offsetLeft - 1, 0, endX - startX, SHEET_COLUMN_HEADER_HEIGHT - 1);
            renderCtx.fillStyle = colors.headerText;

            // Column header sequence number
            const textMetrics = getMeasureText(columnLabel, renderCtx, font);

            // Rounded on the sheet, not the canvas, so the letter moves with its column when a scroll moves
            // by half a pixel.
            const sheetLeft = startX + scrollWidth + (endX - startX) / 2 - textMetrics.width / 2;
            const horizonAlignPos = Math.round(sheetLeft) - scrollWidth + offsetLeft;
            const verticalAlignPos = Math.round(SHEET_COLUMN_HEADER_HEIGHT / 2);

            renderCtx.fillText(columnLabel, horizonAlignPos, verticalAlignPos);
        }

        // Column header vertical line
        if (colhidden && colhidden[c] != null && colhidden[c + 1] != null) {
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 4 + HALF_PIXEL, 0);
            renderCtx.lineTo(endX + offsetLeft - 4 + HALF_PIXEL, SHEET_COLUMN_HEADER_HEIGHT - 2);
            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = colors.gridLine;
            renderCtx.closePath();
            renderCtx.stroke();
        } else if (colhidden == null || colhidden[c] == null) {
            renderCtx.beginPath();
            renderCtx.moveTo(endX + offsetLeft - 2 + HALF_PIXEL, 0);
            renderCtx.lineTo(endX + offsetLeft - 2 + HALF_PIXEL, SHEET_COLUMN_HEADER_HEIGHT - 2);

            renderCtx.lineWidth = 1;
            renderCtx.strokeStyle = colors.gridLine;
            renderCtx.closePath();
            renderCtx.stroke();
        }

        if (colhidden?.[c - 1] != null && prevEndX !== undefined) {
            renderCtx.beginPath();
            renderCtx.moveTo(prevEndX + offsetLeft + HALF_PIXEL, 0);
            renderCtx.lineTo(prevEndX + offsetLeft + HALF_PIXEL, SHEET_COLUMN_HEADER_HEIGHT - 2);
            renderCtx.closePath();
            renderCtx.stroke();
        }

        // Column header bottom edge
        renderCtx.beginPath();
        renderCtx.moveTo(startX + offsetLeft - 1, SHEET_COLUMN_HEADER_HEIGHT - 2 + HALF_PIXEL);
        renderCtx.lineTo(endX + offsetLeft - 1, SHEET_COLUMN_HEADER_HEIGHT - 2 + HALF_PIXEL);
        renderCtx.stroke();
        renderCtx.closePath();

        prevEndX = endX;
    }

    renderCtx.restore(); // header clip
    renderCtx.restore(); // device-pixel-ratio scale
}
