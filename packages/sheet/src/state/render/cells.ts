// nullCellRender/cellRender draw a single cell: background, indicators,
// checkbox, data bar, text and grid lines. Text layout itself lives in
// modules/text.ts.

import { normalizedAttr } from '../modules/cell';
import { checkCF } from '../modules/conditionFormat';
import { validateCellData } from '../modules/dataVerification';
import { getCellTextInfo, getMeasureText } from '../modules/text';
import { cellOverflowRender, cellTextRender } from './cell-text';
import { drawDataBar } from './data-bar';
import { BORDER_FIX, HALF_PIXEL } from './geometry';
import { overflowColIn } from './overflow';
import type { RenderPass } from './types';
import { defaultStyle } from './types';

// Unlike the engine's stricter isRealNum, this accepts anything Number() can
// coerce (null, '', booleans); it only gates the forced-string indicator.
function coercesToNumber(val: unknown) {
    return !Number.isNaN(Number(val));
}

// The right/bottom cell grid lines all share the same 1px default-color stroke.
function strokeGridLine(renderCtx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
    renderCtx.beginPath();
    renderCtx.moveTo(x1, y1);
    renderCtx.lineTo(x2, y2);
    renderCtx.lineWidth = 1;
    renderCtx.strokeStyle = defaultStyle.strokeStyle;
    renderCtx.stroke();
    renderCtx.closePath();
}

// Empty cell rendering
export function nullCellRender(
    pass: RenderPass,
    r: number,
    c: number,
    startY: number,
    startX: number,
    endY: number,
    endX: number,
    isMerge = false,
) {
    const { sheetCtx, renderCtx, cfCompute, offsetLeft, offsetTop, cellOverflowMap, colEnd, flowdata, drawGridLines } =
        pass;
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
        sheetCtx.hooks.beforeRenderCell?.(
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

    // Comment indicator triangle
    if (flowdata?.[r]?.[c]?.commentCardIds?.length) {
        const commentInfo = sheetCtx.hooks.getCommentInfo?.(r, c);
        renderCtx.beginPath();
        renderCtx.moveTo(endX + offsetLeft - 12, startY + offsetTop);
        renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop);
        renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop + 11);
        renderCtx.fillStyle = commentInfo?.indicatorColor ?? commentInfo?.card.color ?? '#FC6666';
        renderCtx.fill();
        renderCtx.closePath();
    }

    // Check overflow cell relationship
    const overflowInfo = overflowColIn(cellOverflowMap, r, c, colEnd);

    // Last column of overflow range: render overflow cell content
    if (
        overflowInfo.colLast &&
        overflowInfo.rowIndex != null &&
        overflowInfo.colIndex != null &&
        overflowInfo.stc != null &&
        overflowInfo.edc != null
    ) {
        cellOverflowRender(pass, overflowInfo.rowIndex, overflowInfo.colIndex, overflowInfo.stc, overflowInfo.edc);
    }

    // Overflow cell spans this cell, skip right border
    if (!overflowInfo.colIn || overflowInfo.colLast) {
        // Right border
        if (drawGridLines) {
            strokeGridLine(
                renderCtx,
                endX + offsetLeft - 2 + HALF_PIXEL,
                startY + offsetTop,
                endX + offsetLeft - 2 + HALF_PIXEL,
                endY + offsetTop,
            );
        }
    }

    // Bottom border
    if (drawGridLines) {
        strokeGridLine(
            renderCtx,
            startX + offsetLeft - 1,
            endY + offsetTop - 2 + HALF_PIXEL,
            endX + offsetLeft - 1,
            endY + offsetTop - 2 + HALF_PIXEL,
        );
    }

    // After cell render
    sheetCtx.hooks.afterRenderCell?.(
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

export function cellRender(
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
    const {
        sheetCtx,
        renderCtx,
        cfCompute,
        offsetLeft,
        offsetTop,
        dataVerification,
        cellOverflowMap,
        colEnd,
        flowdata,
        drawGridLines,
    } = pass;
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
        sheetCtx.hooks.beforeRenderCell?.(
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

    if (dataVerification?.[`${r}_${c}`] && !validateCellData(sheetCtx, dataVerification[`${r}_${c}`], value)) {
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
        const commentInfo = sheetCtx.hooks.getCommentInfo?.(r, c);
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
    const overflowInfo = overflowColIn(cellOverflowMap, r, c, colEnd);

    if (cell?.tb === '1' && overflowInfo.colIn) {
        // Last column of overflow range: render overflow cell content
        if (
            overflowInfo.colLast &&
            overflowInfo.rowIndex != null &&
            overflowInfo.colIndex != null &&
            overflowInfo.stc != null &&
            overflowInfo.edc != null
        ) {
            cellOverflowRender(pass, overflowInfo.rowIndex, overflowInfo.colIndex, overflowInfo.stc, overflowInfo.edc);
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
            drawDataBar(
                renderCtx,
                checksCF.dataBar,
                startX + offsetLeft + space_width,
                startY + offsetTop + space_height,
                cellWidth - space_width * 2,
                cellHeight - space_height * 2,
            );
        }

        const pos_x = startX + offsetLeft;
        const pos_y = startY + offsetTop + 1;

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
        renderCtx.clip();

        const textInfo = cell
            ? getCellTextInfo(cell, renderCtx, sheetCtx, {
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

        cellTextRender(textInfo, renderCtx, {
            pos_x,
            pos_y,
        });

        renderCtx.restore();
    }

    if (drawRightGridLine && drawGridLines) {
        // Right border
        strokeGridLine(
            renderCtx,
            endX + offsetLeft - 2 + HALF_PIXEL,
            startY + offsetTop,
            endX + offsetLeft - 2 + HALF_PIXEL,
            endY + offsetTop,
        );
    }

    // Bottom border
    if (drawGridLines) {
        strokeGridLine(
            renderCtx,
            startX + offsetLeft - 1,
            endY + offsetTop - 2 + HALF_PIXEL,
            endX + offsetLeft - 1,
            endY + offsetTop - 2 + HALF_PIXEL,
        );
    }

    // After cell render
    sheetCtx.hooks.afterRenderCell?.(
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
