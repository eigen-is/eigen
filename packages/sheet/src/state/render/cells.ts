// Draws one cell on the grid canvas: its background, its corner marks, such as a comment's, a tick box or a list
// chevron, a data bar, its text and its grid lines. The grid's paint phases call cellRender for a cell with a value
// and nullCellRender for one without, once per visible cell. The text layout is getCellTextInfo's.

import { commentIndicatorColor, INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
import { isForcedStringNumber, normalizedAttr } from '../modules/cell';
import { cellIndicatorRect } from '../modules/cell-glyph';
import { checkCF } from '../modules/condition-format';
import type { CellGlyphRect } from '../modules/data-validation';
import {
    cellPassesRule,
    cellTextBox,
    checkboxAlign,
    checkboxRect,
    dropdownChevronRect,
    isCheckboxChecked,
} from '../modules/data-validation';
import { getCellTextInfo } from '../modules/text';
import type { Rect } from '../types';
import { cellOverflowRender, cellTextRender } from './cell-text';
import { drawDataBar } from './data-bar';
import { BORDER_FIX, HALF_PIXEL } from './geometry';
import { overflowColIn } from './overflow';
import type { RenderPass } from './types';

// Gray rather than black, the way Google draws the box, and fixed, as the grid is paper and doesn't re-theme.
const CHECKBOX_STROKE = '#5f6368';

const FORCED_STRING_INDICATOR_COLOR = '#487f1e';

// A right-angled triangle filling half of its cellIndicatorRect, anchored on the cell corner: one leg along the top
// edge, one down the side.
export function drawCellIndicator(
    renderCtx: CanvasRenderingContext2D,
    corner: 'left' | 'right',
    rect: CellGlyphRect,
    color: string,
) {
    const x = corner === 'left' ? rect.x : rect.x + rect.size;
    renderCtx.beginPath();
    renderCtx.moveTo(x, rect.y);
    renderCtx.lineTo(corner === 'left' ? x + rect.size : x - rect.size, rect.y);
    renderCtx.lineTo(x, rect.y + rect.size);
    renderCtx.fillStyle = color;
    renderCtx.fill();
    renderCtx.closePath();
}

function drawCommentIndicator(pass: RenderPass, cardId: string, startY: number, endX: number) {
    const { renderCtx, sheetCtx, offsetLeft, offsetTop } = pass;
    const color = commentIndicatorColor(sheetCtx.commentCards?.[cardId]?.color);
    drawCellIndicator(renderCtx, 'right', cellIndicatorRect('right', 0, startY + offsetTop, endX + offsetLeft), color);
}

function drawTickBox(renderCtx: CanvasRenderingContext2D, rect: CellGlyphRect, checked: boolean) {
    renderCtx.lineWidth = 1;
    renderCtx.strokeStyle = CHECKBOX_STROKE;
    renderCtx.strokeRect(rect.x + HALF_PIXEL, rect.y + HALF_PIXEL, rect.size, rect.size);
    if (!checked) return;

    renderCtx.beginPath();
    renderCtx.moveTo(rect.x + 2, rect.y + rect.size / 2);
    renderCtx.lineTo(rect.x + rect.size / 2 - 1, rect.y + rect.size - 3);
    renderCtx.lineTo(rect.x + rect.size - 2, rect.y + 2);
    renderCtx.stroke();
    renderCtx.closePath();
}

// The list chevron takes the cell's own text color at low alpha, as a fixed gray would vanish into a dark fill.
const DROPDOWN_CHEVRON_ALPHA = 0.55;

function renderDropdownChevron(pass: RenderPass, r: number, c: number, box: Rect) {
    const { renderCtx, flowdata } = pass;
    const rect = dropdownChevronRect(box);
    if (!rect) return;

    renderCtx.save();
    renderCtx.globalAlpha = DROPDOWN_CHEVRON_ALPHA;
    // An empty cell has no fc of its own; black is what its text would take.
    renderCtx.strokeStyle = normalizedAttr(flowdata, r, c, 'fc') ?? '#000000';
    renderCtx.lineWidth = 1.5;
    renderCtx.lineCap = 'round';
    renderCtx.lineJoin = 'round';
    renderCtx.beginPath();
    // Lucide chevron-down proportions inside the box: full width, middle fifth.
    renderCtx.moveTo(rect.x + 1, rect.y + rect.size * 0.3);
    renderCtx.lineTo(rect.x + rect.size / 2, rect.y + rect.size * 0.7);
    renderCtx.lineTo(rect.x + rect.size - 1, rect.y + rect.size * 0.3);
    renderCtx.stroke();
    renderCtx.restore();
}

// A cell adds its grid lines to the pass's grid path, which drawMain strokes once. Spilled text hides the
// right line. Both lines lie on the cell's own last pixel. The right line stops one pixel above the next
// row, so it leaves no stub where the cell below draws no right line.
function addGridLines(
    pass: RenderPass,
    startY: number,
    startX: number,
    endY: number,
    endX: number,
    rightLine: boolean,
) {
    const { gridLines, offsetLeft, offsetTop } = pass;
    if (rightLine) {
        const x = endX + offsetLeft - 2 + HALF_PIXEL;
        gridLines.moveTo(x, startY + offsetTop);
        gridLines.lineTo(x, endY + offsetTop - 1);
    }
    const y = endY + offsetTop - 2 + HALF_PIXEL;
    gridLines.moveTo(startX + offsetLeft - 1, y);
    gridLines.lineTo(endX + offsetLeft - 1, y);
}

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
    const {
        renderCtx,
        cfCompute,
        offsetLeft,
        offsetTop,
        validationAt,
        cellOverflowMap,
        colEnd,
        flowdata,
        drawGridLines,
    } = pass;
    const rule = validationAt(r, c);
    const checksCF = checkCF(r, c, cfCompute);

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

    renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

    const cardId = flowdata?.[r]?.[c]?.commentCardIds?.[0];
    if (cardId) drawCommentIndicator(pass, cardId, startY, endX);

    if (rule) {
        const box = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
        // An empty cell in a tick-box range shows an unchecked box, so the range reads as one column.
        if (rule.type === 'checkbox') {
            const verticalAlign = Number(normalizedAttr(flowdata, r, c, 'vt'));
            drawTickBox(renderCtx, checkboxRect(box, checkboxAlign(flowdata?.[r]?.[c]), verticalAlign), false);
        } else if (rule.type === 'dropdown') {
            renderDropdownChevron(pass, r, c, box);
        }
    }

    const overflowInfo = overflowColIn(cellOverflowMap, r, c, colEnd);

    if (
        overflowInfo.colLast &&
        overflowInfo.rowIndex != null &&
        overflowInfo.colIndex != null &&
        overflowInfo.stc != null &&
        overflowInfo.edc != null
    ) {
        cellOverflowRender(pass, overflowInfo.rowIndex, overflowInfo.colIndex, overflowInfo.stc, overflowInfo.edc);
    }

    // Text spilling across this cell hides its right grid line.
    if (drawGridLines) {
        addGridLines(pass, startY, startX, endY, endX, !overflowInfo.colIn || overflowInfo.colLast);
    }
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
        validationAt,
        cellOverflowMap,
        colEnd,
        flowdata,
        drawGridLines,
    } = pass;
    const cell = flowdata[r][c];
    const rule = validationAt(r, c);
    const box = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
    const { width: cellWidth, height: cellHeight } = box;
    const space_width = 2;
    const space_height = 2;

    const verticalAlign = Number(normalizedAttr(flowdata, r, c, 'vt'));

    const checksCF = checkCF(r, c, cfCompute);

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

    renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

    const invalid = rule != null && !cellPassesRule(sheetCtx, rule, cell);
    if (invalid) {
        drawCellIndicator(
            renderCtx,
            'left',
            cellIndicatorRect('left', startX + offsetLeft, startY + offsetTop, 0),
            INDICATOR_RED,
        );
    }

    const cardId = cell?.commentCardIds?.[0];
    if (cardId) drawCommentIndicator(pass, cardId, startY, endX);

    if (isForcedStringNumber(cell)) {
        drawCellIndicator(
            renderCtx,
            'left',
            cellIndicatorRect('left', startX + offsetLeft, startY + offsetTop, 0),
            FORCED_STRING_INDICATOR_COLOR,
        );
    }

    let drawRightGridLine = true;
    const overflowInfo = overflowColIn(cellOverflowMap, r, c, colEnd);

    // Only a spilling source has a value inside its own span.
    if (overflowInfo.colIn) {
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
    // A tick box stands in for a value its rule names. Any other value fails the rule and is painted as text.
    else if (rule?.type === 'checkbox' && !invalid) {
        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(box.left, box.top, box.width, box.height);
        renderCtx.clip();
        drawTickBox(renderCtx, checkboxRect(box, checkboxAlign(cell), verticalAlign), isCheckboxChecked(rule, value));
        renderCtx.restore();
    } else {
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

        const pos_x = box.left;
        const pos_y = box.top;

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

        renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');

        if (checksCF?.textColor) {
            renderCtx.fillStyle = checksCF.textColor;
        }

        // A [Red] number format colors a negative number.
        if ((cell?.ct?.fa?.indexOf('[Red]') ?? -1) > -1 && cell?.ct?.t === 'n' && (cell?.v as number) < 0) {
            renderCtx.fillStyle = '#ff0000';
        }

        cellTextRender(textInfo, renderCtx, { pos_x, pos_y, origin: pass.origin });

        renderCtx.restore();
    }

    if (rule?.type === 'dropdown') {
        renderDropdownChevron(pass, r, c, box);
    }

    if (drawGridLines) {
        addGridLines(pass, startY, startX, endY, endX, drawRightGridLine);
    }
}
