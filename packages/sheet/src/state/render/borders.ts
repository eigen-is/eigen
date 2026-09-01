// Cell borders from config.borderInfo, drawn over the finished cells.

import { BORDER_STYLES, parseCellKey } from '@workspace/lib/sheets';
import { getSheetConfig } from '../context';
import { getBorderInfoCompute } from '../modules/border';
import { colEndX, colStartX, HALF_PIXEL, rowEndY, rowStartY } from './geometry';
import { overflowColIn } from './overflow';
import type { RenderPass } from './types';

// Dash pattern + line width per border-style ordinal, computed once from the shared vocabulary
// (BORDER_STYLES) instead of re-matching capitalized style-name substrings every frame. `medium`
// styles nudge the stroke half a pixel across its own axis; the mapping reproduces the old cascade.
const BORDER_DASH: Record<number, { dash: number[]; lineWidth: number; medium: boolean }> = (() => {
    const table: Record<number, { dash: number[]; lineWidth: number; medium: boolean }> = {};
    for (const [ord, { name }] of Object.entries(BORDER_STYLES)) {
        const n = name[0].toUpperCase() + name.slice(1);
        let dash = [0];
        if (n === 'Hair') dash = [1, 2];
        else if (n.includes('DashDotDot')) dash = [2, 2, 5, 2, 2];
        else if (n.includes('DashDot')) dash = [2, 5, 2];
        else if (n.includes('Dotted')) dash = [2];
        else if (n.includes('Dashed')) dash = [3];
        const medium = n.includes('Medium');
        let lineWidth = 1;
        if (medium) lineWidth = 2;
        else if (n === 'Thick') lineWidth = 3;
        table[Number(ord)] = { dash, lineWidth, medium };
    }
    return table;
})();

function setLineDash(
    canvasborder: CanvasRenderingContext2D,
    type: number,
    hv: string,
    moveX: number,
    moveY: number,
    toX: number,
    toY: number,
) {
    const { dash, lineWidth, medium } = BORDER_DASH[type] ?? { dash: [0], lineWidth: 1, medium: false };
    canvasborder.setLineDash(dash);
    canvasborder.beginPath();

    if (medium) {
        if (hv === 'h') {
            canvasborder.moveTo(moveX, moveY - 0.5);
            canvasborder.lineTo(toX, toY - 0.5);
        } else {
            canvasborder.moveTo(moveX - 0.5, moveY);
            canvasborder.lineTo(toX - 0.5, toY);
        }
    } else {
        canvasborder.moveTo(moveX, moveY);
        canvasborder.lineTo(toX, toY);
    }
    canvasborder.lineWidth = lineWidth;
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
        const [bdRow, bdCol] = parseCellKey(x);
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
