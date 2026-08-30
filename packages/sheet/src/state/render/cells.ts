// nullCellRender/cellRender draw a single cell: background, indicators,
// checkbox, data bar, text and grid lines. Text layout itself lives in
// modules/text.ts.

import { normalizedAttr } from '../modules/cell';
import { cellIndicatorRect } from '../modules/cell-glyph';
import { checkCF } from '../modules/condition-format';
import {
    type CellGlyphRect,
    CHECKBOX_LABEL_GAP,
    cellTextBox,
    checkboxRect,
    dropdownChevronRect,
    isCheckboxChecked,
    showsCheckboxLabel,
    validateCellData,
} from '../modules/data-verification';
import { getCellTextInfo } from '../modules/text';
import type { Rect } from '../types';
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

// Data-verification tick box. Hardcoded light like every other canvas color —
// the workbook surface is pinned light via `.eigen-paper` (RENDERING.md
// § Theming) — and grey rather than black, the way Google draws the box.
const CHECKBOX_STROKE = '#5f6368';

// One red for both attention marks: the invalid-value triangle, and the comment
// triangle's fallback when its card carries no colour of its own.
const INDICATOR_RED = '#FC6666';
const FORCED_STRING_INDICATOR_COLOR = '#487f1e';

// A right-angled triangle filling half of its cellIndicatorRect, anchored on
// the cell corner: one leg along the top edge, one down the side.
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

// Drawn identically by both render paths — most commented cells in a workbook
// hold a value, plenty do not.
function drawCommentIndicator(pass: RenderPass, r: number, c: number, startY: number, endX: number) {
    const { renderCtx, sheetCtx, offsetLeft, offsetTop } = pass;
    const commentInfo = sheetCtx.hooks.getCommentInfo?.(r, c);
    const color = commentInfo?.indicatorColor ?? commentInfo?.card.color ?? INDICATOR_RED;
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

// Data-validation list chevron, painted on every cell a list rule covers —
// empty ones included, which is where it earns its keep: a blank validated cell
// is otherwise indistinguishable from a blank free-text one. It overlays the
// cell text rather than reserving width, the way Google's does, and takes the
// cell's OWN text colour at low alpha instead of a flat grey: validated cells
// sit on dark fills a fixed grey would vanish into.
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
    // A sheet with no rules at all short-circuits here, key never built.
    const rule = dataVerification?.[`${r}_${c}`];
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
        drawCommentIndicator(pass, r, c, startY, endX);
    }

    if (rule) {
        const box = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
        // An empty cell inside a tick-box range still shows an unchecked box, so the
        // range reads as one uniform column.
        if (rule.type === 'checkbox') {
            const horizonAlign = Number(normalizedAttr(flowdata, r, c, 'ht'));
            const verticalAlign = Number(normalizedAttr(flowdata, r, c, 'vt'));
            drawTickBox(renderCtx, checkboxRect(box, horizonAlign, verticalAlign), false);
        } else if (rule.type === 'dropdown') {
            renderDropdownChevron(pass, r, c, box);
        }
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
    const rule = dataVerification?.[`${r}_${c}`];
    const box = cellTextBox(startX + offsetLeft, startY + offsetTop, endX + offsetLeft, endY + offsetTop);
    const { width: cellWidth, height: cellHeight } = box;
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

    // Invalid-value indicator (red triangle top-left)
    if (rule && !validateCellData(sheetCtx, rule, value)) {
        drawCellIndicator(
            renderCtx,
            'left',
            cellIndicatorRect('left', startX + offsetLeft, startY + offsetTop, 0),
            INDICATOR_RED,
        );
    }

    // Comment indicator triangle
    if (cell?.commentCardIds?.length) {
        drawCommentIndicator(pass, r, c, startY, endX);
    }

    // Forced-string indicator (green triangle top-left)
    if (cell?.qp === 1 && coercesToNumber(cell?.v)) {
        drawCellIndicator(
            renderCtx,
            'left',
            cellIndicatorRect('left', startX + offsetLeft, startY + offsetTop, 0),
            FORCED_STRING_INDICATOR_COLOR,
        );
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
    // Data validation tick box
    else if (rule?.type === 'checkbox') {
        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(box.left, box.top, box.width, box.height);
        renderCtx.clip();

        const rect = checkboxRect(box, horizonAlign, verticalAlign);
        drawTickBox(renderCtx, rect, isCheckboxChecked(rule, value));

        if (showsCheckboxLabel(rule, value)) {
            renderCtx.textBaseline = 'middle';
            renderCtx.fillStyle = normalizedAttr(flowdata, r, c, 'fc');
            renderCtx.fillText(String(value ?? ''), rect.x + rect.size + CHECKBOX_LABEL_GAP, rect.y + rect.size / 2);
        }

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

        const pos_x = box.left;
        const pos_y = box.top;

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

    if (rule?.type === 'dropdown') {
        renderDropdownChevron(pass, r, c, box);
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
