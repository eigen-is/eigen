// Cell borders from config.borderInfo, drawn over the finished cells.

import { getSheetConfig } from '../context';
import { BORDER_STYLE_NAMES, getBorderInfoCompute } from '../modules/border';
import { colEndX, colStartX, HALF_PIXEL, rowEndY, rowStartY } from './geometry';
import { overflowColIn } from './overflow';
import type { RenderPass } from './types';

function setLineDash(
    canvasborder: CanvasRenderingContext2D,
    type: number,
    hv: string,
    moveX: number,
    moveY: number,
    toX: number,
    toY: number,
) {
    const typeName = BORDER_STYLE_NAMES[type.toString()] ?? '';

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

export function drawCellBorders(pass: RenderPass) {
    const { sheetCtx } = pass;
    const cfg = getSheetConfig(sheetCtx);

    const {
        renderCtx,
        rowStart,
        rowEnd,
        colStart,
        colEnd,
        scrollWidth,
        scrollHeight,
        offsetLeft: oL,
        offsetTop: oT,
    } = pass;

    const renderBorder = (
        style: number,
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

    const borderInfoCompute = getBorderInfoCompute(sheetCtx, sheetCtx.currentSheetId, [
        rowStart,
        rowEnd,
        colStart,
        colEnd,
    ]);

    for (const [x, bdInfo] of Object.entries(borderInfoCompute)) {
        const sepIdx = x.indexOf('_');
        const bdRow = Number(x.substring(0, sepIdx));
        const bdCol = Number(x.substring(sepIdx + 1));
        if (cfg?.rowhidden?.[bdRow] != null || cfg?.colhidden?.[bdCol] != null) continue;

        const startY = rowStartY(sheetCtx.visibledatarow, bdRow, scrollHeight);
        const startX = colStartX(sheetCtx.visibledatacolumn, bdCol, scrollWidth);
        const endY = rowEndY(sheetCtx.visibledatarow, bdRow, scrollHeight);
        const endX = colEndX(sheetCtx.visibledatacolumn, bdCol, scrollWidth);

        const leftX = startX - 2 + HALF_PIXEL + oL;
        const rightX = endX - 2 + HALF_PIXEL + oL;
        const topY = startY + oT;
        const bottomY = endY - 2 + HALF_PIXEL + oT;

        const overflowInfo = overflowColIn(pass.cellOverflowMap, bdRow, bdCol, colEnd);

        const notOverflowOrFirst = !overflowInfo.colIn || overflowInfo.stc === bdCol;

        if (bdInfo.s && notOverflowOrFirst) {
            const mergeMap = cfg?.merge;
            const mergeCell = mergeMap?.[x];
            let slashEndX = rightX;
            let slashEndY = bottomY;
            if (mergeCell) {
                slashEndX =
                    colEndX(sheetCtx.visibledatacolumn, bdCol + mergeCell.cs - 1, scrollWidth) - 2 + HALF_PIXEL + oL;
                slashEndY =
                    rowEndY(sheetCtx.visibledatarow, bdRow + mergeCell.rs - 1, scrollHeight) - 2 + HALF_PIXEL + oT;
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
