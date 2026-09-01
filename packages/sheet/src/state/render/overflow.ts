// Text-overflow geometry: which cells spill their text across adjacent empty
// columns (cell.tb === '1'), and the per-row cache shared across passes.

import { isEmpty } from 'es-toolkit/compat';
import { type Context, getFlowdata, getSheetConfig } from '../context';
import { normalizedAttr } from '../modules/cell';
import { isInlineStringCell } from '../modules/inline-string';
import { getCellTextInfo } from '../modules/text';
import { colEndX, colStartX } from './geometry';
import type { CellOverflowMap } from './types';

// Module-level cache that persists across Canvas instances.
// Previously this lived on the Canvas class and was reset to {} on every
// new Canvas(), making it completely useless. The drawMain facade holds it
// open while drawing and clears it after 100ms of idle time.
let cellOverflowMapCache: CellOverflowMap = {};

export function clearCellOverflowCache() {
    cellOverflowMapCache = {};
}

// Get overflow cells for the render range
export function computeCellOverflowMap(
    sheetCtx: Context,
    canvas: CanvasRenderingContext2D,
    colStart: number,
    colEnd: number,
    rowStart: number,
    rowEnd: number,
): CellOverflowMap {
    const flowdata = getFlowdata(sheetCtx);
    const map: CellOverflowMap = {};
    if (!flowdata) {
        return map;
    }
    const colhidden = getSheetConfig(sheetCtx)?.colhidden;

    for (let r = rowStart; r <= rowEnd; r += 1) {
        if (flowdata[r] == null) {
            continue;
        }

        if (cellOverflowMapCache[r]) {
            map[r] = cellOverflowMapCache[r];
            continue;
        }

        let hasCellOver = false;

        // Only scan columns near the visible range. Text overflow from cells
        // far outside the viewport cannot reach the visible area. A buffer of
        // 50 columns on each side is generous for even very wide text.
        const scanStart = Math.max(0, colStart - 50);
        const scanEnd = Math.min(flowdata[r].length - 1, colEnd + 50);

        for (let c = scanStart; c <= scanEnd; c += 1) {
            const cell = flowdata[r][c];

            if (colhidden?.[c] != null) {
                continue;
            }

            if (cell && (!isEmpty(cell.v) || isInlineStringCell(cell)) && cell.mc == null && cell.tb === '1') {
                const horizonAlign = normalizedAttr(flowdata, r, c, 'ht');

                const textMetricsObj = getCellTextInfo(cell, canvas, sheetCtx, {
                    r,
                    c,
                });
                const textMetrics = textMetricsObj?.textWidthAll ?? 0;

                const startX = colStartX(sheetCtx.visibledatacolumn, c, 0);
                const endX = colEndX(sheetCtx.visibledatacolumn, c, 0);

                let stc = c;
                let edc = c;

                if (endX - startX < textMetrics) {
                    if (horizonAlign === '0') {
                        // Center aligned
                        const traceForward = traceOverflow(sheetCtx, r, c, c - 1, 'forward', horizonAlign, textMetrics);
                        const traceBackward = traceOverflow(
                            sheetCtx,
                            r,
                            c,
                            c + 1,
                            'backward',
                            horizonAlign,
                            textMetrics,
                        );

                        if (traceForward.success) {
                            stc = traceForward.c;
                        } else {
                            stc = traceForward.c + 1;
                        }

                        if (traceBackward.success) {
                            edc = traceBackward.c;
                        } else {
                            edc = traceBackward.c - 1;
                        }
                    } else if (horizonAlign === '1') {
                        // Left aligned
                        const trace = traceOverflow(sheetCtx, r, c, c + 1, 'backward', horizonAlign, textMetrics);
                        stc = c;

                        if (trace.success) {
                            edc = trace.c;
                        } else {
                            edc = trace.c - 1;
                        }
                    } else if (horizonAlign === '2') {
                        // Right aligned
                        const trace = traceOverflow(sheetCtx, r, c, c - 1, 'forward', horizonAlign, textMetrics);
                        edc = c;

                        if (trace.success) {
                            stc = trace.c;
                        } else {
                            stc = trace.c + 1;
                        }
                    }
                } else {
                    stc = c;
                    edc = c;
                }

                if ((stc <= colEnd || edc >= colStart) && stc < edc) {
                    const item = {
                        r,
                        stc,
                        edc,
                    };

                    const rowMap = map[r] ?? {};
                    rowMap[c] = item;
                    map[r] = rowMap;

                    hasCellOver = true;
                }
            }
        }

        if (hasCellOver) {
            cellOverflowMapCache[r] = map[r];
        }
    }

    return map;
}

function traceOverflow(
    sheetCtx: Context,
    r: number,
    curC: number,
    traceC: number,
    traceDir: string,
    horizonAlign: string,
    textMetrics: number,
): { success: boolean; r: number; c: number } {
    const flowdata = getFlowdata(sheetCtx);
    if (!flowdata) return { success: false, r, c: traceC };

    // Trace terminates if column index is out of array bounds
    if (traceDir === 'forward' && traceC < 0) {
        return {
            success: false,
            r,
            c: traceC,
        };
    }

    if (traceDir === 'backward' && traceC > flowdata[r].length - 1) {
        return {
            success: false,
            r,
            c: traceC,
        };
    }

    // Trace terminates if cell is non-empty or merged
    const cell = flowdata[r][traceC];
    if (cell && (!isEmpty(cell.v) || cell.mc)) {
        return {
            success: false,
            r,
            c: traceC,
        };
    }

    let start_curC = colStartX(sheetCtx.visibledatacolumn, curC, 0);
    let end_curC = colEndX(sheetCtx.visibledatacolumn, curC, 0);

    const w = textMetrics - (end_curC - start_curC);

    if (horizonAlign === '0') {
        // Center align
        start_curC -= w / 2;
        end_curC += w / 2;
    } else if (horizonAlign === '1') {
        // Left align
        end_curC += w;
    } else if (horizonAlign === '2') {
        // Right align
        start_curC -= w;
    }

    const start_traceC = colStartX(sheetCtx.visibledatacolumn, traceC, 0);
    const end_traceC = colEndX(sheetCtx.visibledatacolumn, traceC, 0);

    if (traceDir === 'forward') {
        if (start_curC < start_traceC) {
            return traceOverflow(sheetCtx, r, curC, traceC - 1, traceDir, horizonAlign, textMetrics);
        }
        if (start_curC < end_traceC) {
            return {
                success: true,
                r,
                c: traceC,
            };
        }
        return {
            success: false,
            r,
            c: traceC,
        };
    }

    if (traceDir === 'backward') {
        if (end_curC > end_traceC) {
            return traceOverflow(sheetCtx, r, curC, traceC + 1, traceDir, horizonAlign, textMetrics);
        }
        if (end_curC > start_traceC) {
            return {
                success: true,
                r,
                c: traceC,
            };
        }
        return {
            success: false,
            r,
            c: traceC,
        };
    }
    return { success: false, r, c: traceC };
}

export function overflowColIn(map: CellOverflowMap, r: number, c: number, colEnd: number) {
    let colIn = false; // Whether this cell is within an overflow cell's render range
    let colLast = false; // Whether this cell is the last column in an overflow cell's render range
    let rowIndex: number | undefined; // Overflow cell row index
    let colIndex: number | undefined; // Overflow cell column index
    let stc: number | undefined;
    let edc: number | undefined;

    if (map) {
        for (const rkey of Object.keys(map)) {
            const row = map[Number(rkey)];
            if (!row) continue;
            for (const ckey of Object.keys(row)) {
                const mapItem = row[Number(ckey)];
                const ri = Number(rkey);
                const ci = Number(ckey);

                if (ri === r && c >= mapItem.stc && c <= mapItem.edc) {
                    colIn = true;
                    rowIndex = ri;
                    colIndex = ci;
                    stc = mapItem.stc;
                    edc = mapItem.edc;

                    if (c === mapItem.edc || c === colEnd) {
                        colLast = true;
                        break;
                    }
                }
            }
            if (colLast) break;
        }
    }

    return {
        colIn,
        colLast,
        rowIndex,
        colIndex,
        stc,
        edc,
    };
}
