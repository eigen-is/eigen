// Paints the text of one cell on the grid canvas, with its strikethrough and underlines, from a layout getCellTextInfo
// worked out before: nothing here measures or wraps. The cell painter calls it for each cell. cellOverflowRender paints
// the text of a cell that spills into its empty neighbors, clipped to the cells it spills over.

import { normalizedAttr } from '../modules/cell';
import { checkCF } from '../modules/condition-format';
import { cellTextBox } from '../modules/data-validation';
import type { CellTextInfo } from '../modules/text';
import { getCellTextInfo, getFontSet } from '../modules/text';
import { colEndX, colStartX, rowEndY, rowStartY } from './geometry';
import type { RenderPass } from './types';

// `origin` is where the sheet's top-left corner falls on the canvas. The strikethrough and underline snap to
// the sheet's pixel grid, not the canvas's, so they move with the text when a scroll moves by half a pixel.
export function cellTextRender(
    textInfo: CellTextInfo | null | undefined,
    ctx: CanvasRenderingContext2D,
    option: { pos_x: number; pos_y: number; origin: { x: number; y: number } },
) {
    if (!textInfo) {
        return;
    }
    const { values, rotate, type, textLeftAll, textTopAll } = textInfo;
    const { pos_x, pos_y, origin } = option;
    const snapX = (x: number) => Math.floor(x - origin.x) + origin.x;
    const snapY = (y: number) => Math.floor(y - origin.y) + origin.y;
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

    for (const word of values) {
        const { style } = word;
        if (typeof style === 'string') {
            ctx.font = style;
        } else if (word.inline === true) {
            ctx.font = style.fontset;
            ctx.fillStyle = style.fc;
        }

        ctx.fillText(word.content, pos_x + word.left, pos_y + word.top);

        for (const line of [word.cancelLine ?? [], word.underLine ?? []].flat()) {
            ctx.beginPath();
            ctx.moveTo(snapX(pos_x + line.startX) + 0.5, snapY(pos_y + line.startY) + 0.5);
            ctx.lineTo(snapX(pos_x + line.endX) + 0.5, snapY(pos_y + line.endY) + 0.5);
            ctx.lineWidth = Math.floor(line.fs / 9);
            ctx.strokeStyle = ctx.fillStyle;
            ctx.stroke();
            ctx.closePath();
        }
    }
    if (rotated) {
        ctx.restore();
    }
}

// `startColumn` and `endColumn` are the first and last columns the text spills over.
export function cellOverflowRender(pass: RenderPass, r: number, c: number, startColumn: number, endColumn: number) {
    const { sheetCtx, renderCtx, scrollHeight, scrollWidth, offsetLeft, offsetTop, cfCompute, flowdata } = pass;
    const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
    const endY = rowEndY(sheetCtx.visibledatarow, r, scrollHeight);
    const startX = colStartX(sheetCtx.visibledatacolumn, startColumn, scrollWidth);
    const endX = colEndX(sheetCtx.visibledatacolumn, endColumn, scrollWidth);

    const cell = flowdata[r][c];
    // The text box of a single cell, stretched over the whole spill, so the text stays off the grid lines.
    const {
        left: pos_x,
        top: pos_y,
        width: cellWidth,
        height: cellHeight,
    } = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
    const space_width = 2;
    const space_height = 2;

    renderCtx.font = getFontSet(cell);

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
    renderCtx.clip();

    const textInfo = cell
        ? getCellTextInfo(cell, renderCtx, {
              cellWidth,
              cellHeight,
              space_width,
              space_height,
              r,
              c,
          })
        : undefined;

    const checksCF = checkCF(r, c, cfCompute);

    renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');

    if (checksCF?.textColor) {
        renderCtx.fillStyle = checksCF.textColor;
    }

    cellTextRender(textInfo, renderCtx, { pos_x, pos_y, origin: pass.origin });

    renderCtx.restore();
}
