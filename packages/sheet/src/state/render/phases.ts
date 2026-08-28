// The drawMain cell phases: collect the visible cells, render them, then
// re-render merge anchors over their full span.

import { getSheetConfig } from '../context';
import { getRealCellValue } from '../modules/cell';
import { cellRender, nullCellRender } from './cells';
import { colEndX, colStartX, rowEndY, rowStartY } from './geometry';
import type { CellRenderItem, RenderPass } from './types';

// Walk the visible grid, recording a render item per drawable cell. Visible
// members of a merge accumulate the merge's on-screen extent onto its
// first-seen item (endY grows per spanned row, endX per spanned column —
// subtle inherited logic, kept verbatim).
export function collectVisibleCells(pass: RenderPass): CellRenderItem[] {
    const { sheetCtx, flowdata, rowStart, rowEnd, colStart, colEnd, scrollWidth, scrollHeight } = pass;
    const cells: CellRenderItem[] = [];
    const mergeCache: Record<string, number> = {};
    const cfg = getSheetConfig(sheetCtx);

    for (let r = rowStart; r <= rowEnd; r += 1) {
        const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
        const endY = rowEndY(sheetCtx.visibledatarow, r, scrollHeight);

        if (cfg?.rowhidden?.[r] != null) {
            continue;
        }

        for (let c = colStart; c <= colEnd; c += 1) {
            const startX = colStartX(sheetCtx.visibledatacolumn, c, scrollWidth);
            const endX = colEndX(sheetCtx.visibledatacolumn, c, scrollWidth);

            if (cfg?.colhidden?.[c] != null) {
                continue;
            }

            const cell = flowdata?.[r]?.[c];
            if (cell?.mc) {
                if ('rs' in cell.mc) {
                    mergeCache[`r${r}c${c}`] = cells.length;
                } else {
                    const key = `r${cell.mc.r}c${cell.mc.c}`;
                    const mergeMain = cells[mergeCache[key]];

                    if (mergeMain == null) {
                        mergeCache[key] = cells.length;
                        cells.push({ r, c, startX, startY, endY, endX });
                    } else {
                        if (mergeMain.c === c) {
                            mergeMain.endY += endY - startY - 1;
                        }

                        if (mergeMain.r === r) {
                            mergeMain.endX += endX - startX;
                        }
                    }

                    continue;
                }
            }

            cells.push({ r, c, startY, startX, endY, endX });
        }
    }

    return cells;
}

// Render every collected cell. Merge members defer to the reprocess pass
// and are returned (their anchor re-renders over the full span).
export function renderCells(pass: RenderPass, cells: CellRenderItem[]): CellRenderItem[] {
    const { flowdata } = pass;
    const mergedCells: CellRenderItem[] = [];

    for (const item of cells) {
        const { r, c, startY, startX, endY, endX } = item;

        if (flowdata[r] == null) {
            continue;
        }

        if (flowdata[r][c] == null) {
            // Empty cell
            nullCellRender(pass, r, c, startY, startX, endY, endX);
        } else {
            const cell = flowdata[r][c];
            let value = null;

            if (cell?.mc) {
                mergedCells.push(item);
            } else {
                value = getRealCellValue(r, c, flowdata);
            }

            if (value == null || value.toString().length === 0) {
                nullCellRender(pass, r, c, startY, startX, endY, endX);
            } else {
                cellRender(pass, r, c, startY, startX, endY, endX, value);
            }
        }
    }

    return mergedCells;
}

// Re-render each merge over its anchor cell's full span.
export function renderMergedCells(pass: RenderPass, mergedCells: CellRenderItem[]) {
    const { sheetCtx, flowdata, scrollWidth, scrollHeight } = pass;

    for (const item of mergedCells) {
        const cell = flowdata[item.r][item.c];
        if (!cell) continue;

        const mergeMaindata = cell.mc;
        if (!mergeMaindata) continue;

        const value = getRealCellValue(mergeMaindata.r, mergeMaindata.c, flowdata);

        const r = mergeMaindata.r;
        const c = mergeMaindata.c;

        const mainCell = flowdata[r][c];

        if (!mainCell?.mc?.rs || !mainCell.mc?.cs) {
            continue;
        }

        const startX = colStartX(sheetCtx.visibledatacolumn, c, scrollWidth);
        const startY = rowStartY(sheetCtx.visibledatarow, r, scrollHeight);
        const endY = rowEndY(sheetCtx.visibledatarow, r + mainCell.mc.rs - 1, scrollHeight);
        const endX = colEndX(sheetCtx.visibledatacolumn, c + mainCell.mc.cs - 1, scrollWidth);

        if (value == null || value.toString().length === 0) {
            nullCellRender(pass, r, c, startY, startX, endY, endX, true);
        } else {
            cellRender(pass, r, c, startY, startX, endY, endX, value, true);
        }
    }
}
