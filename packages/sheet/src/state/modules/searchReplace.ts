import { buildSearchRegex } from '@workspace/lib/doc-search';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { sortBy } from 'es-toolkit/compat';
import { valueShowEs } from '../../engine/format';
import { type Context, getFlowdata, updateContextWithSheetData } from '../context';
import type { SearchHighlight, SearchResult } from '../types';
import { chatatABC, getSheetIndex } from '../utils';
import { normalizeSelection } from './selection';
import { changeSheet } from './sheet';

function cellText(r: number, c: number, flowdata: NonNullable<ReturnType<typeof getFlowdata>>): string {
    const shown = valueShowEs(r, c, flowdata);
    if (shown == null || shown === '') return '';
    return String(shown);
}

function matches(value: string, regex: RegExp): boolean {
    regex.lastIndex = 0; // buildSearchRegex is global — reset before each membership test
    return regex.test(value);
}

// PURE: scan every non-hidden sheet (display order, row-major) for cells whose shown value
// matches. No ctx mutation — this drives the side-effect-free contract search(); highlight and
// reveal are the side-effecting calls. Match unit = cell (the Excel/Sheets convention).
export function collectMatches(ctx: Context, query: string, opts: DocSearchOptions): SearchResult[] {
    const regex = buildSearchRegex(query, opts);
    if (regex == null) return [];

    const out: SearchResult[] = [];
    const ordered = sortBy(
        ctx.sheets.filter((s) => s.hide !== 1),
        (s) => s.order,
    );
    for (const sheet of ordered) {
        const sheetId = sheet.id;
        if (sheetId == null) continue;
        const flowdata = getFlowdata(ctx, sheetId);
        if (!flowdata) continue;
        for (let r = 0; r < flowdata.length; r += 1) {
            const row = flowdata[r];
            for (let c = 0; c < row.length; c += 1) {
                if (row[c] == null) continue;
                const value = cellText(r, c, flowdata);
                if (value === '' || !matches(value, regex)) continue;
                out.push({
                    r,
                    c,
                    sheetId,
                    sheetName: sheet.name ?? '',
                    cellPosition: `${chatatABC(c)}${r + 1}`,
                    value,
                });
            }
        }
    }
    return out;
}

export function setSearchHighlights(ctx: Context, cells: SearchHighlight[]) {
    ctx.searchHighlights = cells;
    if (cells.length === 0) ctx.searchActive = null;
}

// Centre the match in the viewport (amendment 11) so the floating find bar can't cover it. The
// native scroll surface clamps the request, so out-of-range coordinates from a stale id no-op
// instead of throwing (contract rule 2).
function centerCellInView(ctx: Context, r: number, c: number) {
    const rowBottom = ctx.visibledatarow[r];
    const colRight = ctx.visibledatacolumn[c];
    if (rowBottom == null || colRight == null) return;
    const rowTop = r - 1 < 0 ? 0 : ctx.visibledatarow[r - 1];
    const colLeft = c - 1 < 0 ? 0 : ctx.visibledatacolumn[c - 1];
    ctx.scrollRequest = {
        top: Math.max(0, (rowTop + rowBottom) / 2 - ctx.cellmainHeight / 2),
        left: Math.max(0, (colLeft + colRight) / 2 - ctx.cellmainWidth / 2),
    };
}

// Cross-tab reveal: switch sheets, refresh geometry, select + scroll — one recipe. SheetOverlay's
// effects flush BEFORE the Workbook/Sheet geometry effects, so a post-render scroll would read the
// OLD sheet's visibledatarow/config; refreshing here makes centerCellInView see the target sheet's
// geometry, and the overlay's scrollRequest apply effect performs the DOM scroll.
export function revealSearchMatch(ctx: Context, cell: SearchHighlight) {
    if (cell.sheetId !== ctx.currentSheetId) {
        changeSheet(ctx, cell.sheetId);
        if (ctx.currentSheetId !== cell.sheetId) return; // switch vetoed/invalid
        const idx = getSheetIndex(ctx, cell.sheetId);
        const flowdata = getFlowdata(ctx, cell.sheetId);
        if (idx == null || flowdata == null) return;
        ctx.config = ctx.sheets[idx].config ?? {};
        updateContextWithSheetData(ctx, flowdata);
    }
    ctx.selections = normalizeSelection(ctx, [{ row: [cell.r, cell.r], column: [cell.c, cell.c] }]);
    ctx.searchActive = cell;
    centerCellInView(ctx, cell.r, cell.c);
}
