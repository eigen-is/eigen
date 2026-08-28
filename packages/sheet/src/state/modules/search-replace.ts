import { applyPreserveCase, buildSearchRegex } from '@workspace/lib/doc-search';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { sortBy } from 'es-toolkit/compat';
import { valueShowEs } from '../../engine/format';
import { type Context, getFlowdata, updateContextWithSheetConfig, updateContextWithSheetData } from '../context';
import type { SearchHighlight, SearchResult } from '../types';
import { getSheetIndex, indexToColumnChar } from '../utils';
import { setCellValue as setCellValueInternal } from './cell';
import { delFunctionGroup, execFunctionGroup, groupValuesRefresh } from './formula-exec';
import { checkCellIsLocked } from './protection';
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
                    cellPosition: `${indexToColumnChar(c)}${r + 1}`,
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
        updateContextWithSheetConfig(ctx);
        updateContextWithSheetData(ctx, flowdata);
    }
    ctx.selections = normalizeSelection(ctx, [{ row: [cell.r, cell.r], column: [cell.c, cell.c] }]);
    ctx.searchActive = cell;
    centerCellInView(ctx, cell.r, cell.c);
}

// Rewrite every occurrence of the query inside one cell via the recalc path. Returns true iff the
// cell was rewritten. A formula cell (its COMPUTED value matched — the Excel/Google convention is not
// to rewrite inside formula results), a per-cell-locked cell, or a value that no longer matches (a
// stale id under collab) all no-op and return false, so they're excluded from the replaced count.
function replaceInCell(
    ctx: Context,
    cell: SearchHighlight,
    regex: RegExp,
    replacement: string,
    preserveCase: boolean,
): boolean {
    const flowdata = getFlowdata(ctx, cell.sheetId);
    if (!flowdata) return false;
    const cellData = flowdata[cell.r]?.[cell.c];
    if (cellData == null || cellData.f != null) return false;
    if (checkCellIsLocked(ctx, cell.r, cell.c, cell.sheetId)) return false;

    const oldText = cellText(cell.r, cell.c, flowdata);
    regex.lastIndex = 0;
    // Function-form replacement suppresses $1/$& expansion — literal, one semantic across surfaces.
    const newText = oldText.replace(regex, (m) => (preserveCase ? applyPreserveCase(m, replacement) : replacement));
    if (newText === oldText) return false;

    // Recalc path (mirrors updateCell's plain-value branch), cross-tab safe via sheetId + flowdata:
    // clear the cell's formula group, run the group so dependents recompute, then write the value.
    delFunctionGroup(ctx, cell.r, cell.c, cell.sheetId);
    execFunctionGroup(ctx, cell.r, cell.c, newText, cell.sheetId, flowdata);
    setCellValueInternal(ctx, cell.r, cell.c, flowdata, newText);
    return true;
}

// Rewrite the one targeted cell (every occurrence within it — the cell is the atomic unit), then
// materialise any recomputed dependents. Returns whether it changed anything.
export function replaceSearchMatch(
    ctx: Context,
    cell: SearchHighlight,
    query: string,
    replacement: string,
    opts: DocSearchOptions,
    preserveCase: boolean,
): boolean {
    const regex = buildSearchRegex(query, opts);
    if (regex == null) return false;
    const changed = replaceInCell(ctx, cell, regex, replacement, preserveCase);
    if (changed) groupValuesRefresh(ctx);
    return changed;
}

// Replace across every matching cell in one pass (one setContext recipe = one undo when driven from
// the Workbook API), skipping formula/locked cells. Returns the count of cells actually rewritten.
export function replaceAllMatches(
    ctx: Context,
    query: string,
    replacement: string,
    opts: DocSearchOptions,
    preserveCase: boolean,
): number {
    const regex = buildSearchRegex(query, opts);
    if (regex == null) return 0;
    let replaced = 0;
    for (const m of collectMatches(ctx, query, opts)) {
        if (replaceInCell(ctx, { sheetId: m.sheetId, r: m.r, c: m.c }, regex, replacement, preserveCase)) {
            replaced += 1;
        }
    }
    if (replaced > 0) groupValuesRefresh(ctx);
    return replaced;
}
