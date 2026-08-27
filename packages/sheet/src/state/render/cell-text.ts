// Paints the laid-out text of one cell (modules/text.ts computes the layout;
// nothing here measures or wraps), plus the overflow-span variant that draws a
// source cell's text clipped to its full spill range.

import { isPlainObject } from 'es-toolkit/compat';
import { normalizedAttr } from '../modules/cell';
import { checkCF } from '../modules/condition-format';
import { cellTextBox } from '../modules/data-verification';
import type { CellTextInfo } from '../modules/text';
import { getCellTextInfo, getFontSet } from '../modules/text';
import { colEndX, colStartX, rowEndY, rowStartY } from './geometry';
import type { RenderPass } from './types';

function isInlineStyle(value: unknown): value is { fontset: string; fc: string } {
    return typeof value === 'object' && value !== null && 'fontset' in value && 'fc' in value;
}

export function cellTextRender(
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

// Overflow cell rendering
export function cellOverflowRender(pass: RenderPass, r: number, c: number, stc: number, edc: number) {
    const { sheetCtx, renderCtx, scrollHeight, scrollWidth, offsetLeft, offsetTop, cfCompute, flowdata } = pass;
    // Overflow cell start/end row/column coordinates
    const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
    const endY = rowEndY(sheetCtx.visibledatarow, r, scrollHeight);
    const startX = colStartX(sheetCtx.visibledatacolumn, stc, scrollWidth);
    const endX = colEndX(sheetCtx.visibledatacolumn, edc, scrollWidth);

    const cell = flowdata[r][c];
    // The same box the painter and the hit test build for a single cell, over the
    // full spill range: the 1px top inset and the 2px the width and height give up
    // are the grid lines the text must not run over.
    const {
        left: pos_x,
        top: pos_y,
        width: cellWidth,
        height: cellHeight,
    } = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
    const space_width = 2;
    const space_height = 2;

    renderCtx.font = getFontSet(cell, sheetCtx.defaultFontSize);

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

    const checksCF = checkCF(r, c, cfCompute);

    // Cell text color
    renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');

    if (checksCF?.textColor) {
        renderCtx.fillStyle = checksCF.textColor;
    }

    cellTextRender(textInfo, renderCtx, {
        pos_x,
        pos_y,
    });

    renderCtx.restore();
}
