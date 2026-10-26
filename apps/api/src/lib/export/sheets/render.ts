// A workbook as HTML: the export's one document, which the HTML download serves and WeasyPrint prints, and the
// preview's body of the first sheet, cut to a budget. Each cell is a table cell drawn as the canvas draws it, with the
// images and charts floating over the grid where the editor floats them. Runs in the transform process, so it reaches
// no Mount: images arrive as URLs by media name.

import { escapeHtml } from '@workspace/lib/html';
import type {
    Cell,
    CellBorderSides,
    CellWithRowAndCol,
    ConditionalFormatRule,
    MergeCell,
    Sheet,
    SheetConfig,
} from '@workspace/lib/sheets';
import {
    borderInfoExtent,
    borderSidesToCss,
    cellFontName,
    floatingItems,
    mergedBorderSides,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_FONT_SIZE,
    sheetColumnsWidth,
    sheetFloatingBox,
    sheetRowsHeight,
} from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { getElementBounds } from '@workspace/lib/vector';
import type { CellFormatStyle, CellResolver, ComputeMap, DataBar } from '@workspace/sheet/engine';
import {
    booleanDisplay,
    cellWrapsText,
    createCfFormulaEvaluator,
    evaluateConditionalFormat,
    FormulaEngine,
    generalAlign,
    renderSheetChartSvg,
    richText,
    withCfRanges,
} from '@workspace/sheet/engine';
import { cssColorToHex, isTransparentCssColor } from '../../document/colors';
import { FONT_STACK_SANS } from '../../document/font-stacks';
import type { HtmlExportMode, LossCounter } from '../../document/transform/protocol';
import { cellFontSize } from '../../ooxml/spreadsheetml';
import { exportHtmlDocument } from '../html-document';
import { MAX_PDF_PAGE_PX } from '../weasyprint';
import { HORIZONTAL_ALIGN, isNumericRotation, sheetsResolver, VERTICAL_ALIGN } from './cell-style';

// Image sources by media name: data: URIs for an export, the prepared preview URLs for a preview.
type MediaUrls = Map<string, string>;

type ContentSize = { width: number; height: number };

// The export interns every cell's style into a class declared in one <style> element. A workbook repeats a few hundred
// styles over hundreds of thousands of cells, and the sanitizer CSS-parses every style attribute but passes class
// names and style text as plain strings. A key is the exact declarations the inline path would write. The preview
// keeps inline styles, because its body embeds without a <head>.
type StyleRegistry = Map<string, string>;

// A window renders from the top-left of the used range. maxCells is a bound of its own, so tuning the rows or the
// columns can never remove it.
type SheetBudget = { maxRows: number; maxCols: number; maxCells: number };
export const PREVIEW_SHEET_BUDGET: SheetBudget = { maxRows: 200, maxCols: 50, maxCells: 10_000 };

// The most cells, rows times columns, an export walks of all its sheets together. A peer can write a merge or a border
// key at XFD1048576 on as many sheets as it likes, and the sanitizer and WeasyPrint pay for every cell the walk writes.
// A row whose every column is hidden still costs one.
export const MAX_EXPORT_CELLS = 250_000;

// The default columns one PDF page holds. A cut sheet keeps at least that many, so its first page is never narrow.
const PAGE_COLUMNS = Math.floor(MAX_PDF_PAGE_PX / SHEET_DEFAULT_COL_WIDTH);

// Every td's defaults: inline in the preview, whose embedders strip the <head>, and the shared td{} rule in the export.
// There is no vertical-align here, because buildCellStyle always writes one.
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

// The workbook as one document. The screen's prints landscape. The PDF's page fits its widest and tallest sheet as
// rendered, so WeasyPrint never clips a wide grid. A sheet cut to MAX_EXPORT_CELLS, or left out for it, is counted.
export function sheetsHtmlDocument({
    title,
    sheets,
    mediaUrls,
    mode,
    lost,
}: {
    title: string;
    sheets: Sheet[];
    mediaUrls: MediaUrls;
    mode: HtmlExportMode;
    lost: LossCounter['lost'];
}): string {
    const { html, css, cut, leftOut, size } = renderSheetsHtml(sheets, mediaUrls);
    for (const sheet of cut) lost('sheets-cut', sheet);
    for (const sheet of leftOut) lost('sheets-left-out', sheet);
    const page = mode === 'pdf' ? pdfPageCss(size) : '@page { size: landscape; margin: 1.5cm; }';
    return exportHtmlDocument({
        title,
        css: `${SHEET_CSS_BASE}${page}${SHEET_CSS_PRINT}`,
        body: `<style>${css}</style>\n${html}`,
    });
}

// A preview is a glance, so it renders only the first shown sheet, cut to the budget. `truncated` is true when rows,
// columns, cells or other sheets were left out, and the caller then adds the shared marker. The resolver spans every
// sheet, so a rule's formula can read another sheet.
export function renderSheetsPreviewHtml(sheets: Sheet[], mediaUrls: MediaUrls): { html: string; truncated: boolean } {
    const shown = shownSheets(sheets);
    if (shown.length === 0) return { html: '', truncated: false };
    const first = renderSheet(shown[0], new FormulaEngine(), sheetsResolver(sheets), {
        budget: PREVIEW_SHEET_BUDGET,
        mediaUrls,
    });
    if (!first) return { html: '', truncated: true };
    return { html: `<div class="sheet">\n${first.html}\n</div>`, truncated: first.truncated || shown.length > 1 };
}

// One engine and one resolver serve every sheet, so a rule's formula such as `=Sheet2!A1>10` reads the other sheet.
// The resolver reads the stored values: only a rule's own formula is evaluated. The sheets spend one MAX_EXPORT_CELLS
// in tab order, so a sheet gets the cells the ones before it left. `cut` holds the sheets cut to it, `leftOut` the
// sheets it left no row of, and `size` is the widest and tallest sheet as rendered.
export function renderSheetsHtml(
    sheets: Sheet[],
    mediaUrls: MediaUrls,
): { html: string; css: string; cut: Sheet[]; leftOut: Sheet[]; size: ContentSize } {
    const engine = new FormulaEngine();
    const resolver = sheetsResolver(sheets);
    const styles: StyleRegistry = new Map();
    const cut: Sheet[] = [];
    const leftOut: Sheet[] = [];
    const size = { width: 0, height: 0 };
    const bodies: string[] = [];
    let cellsLeft = MAX_EXPORT_CELLS;
    for (const sheet of shownSheets(sheets)) {
        const rendered = renderSheet(sheet, engine, resolver, { cellsLeft, styles, mediaUrls });
        if (!rendered) {
            leftOut.push(sheet);
            continue;
        }
        cellsLeft -= rendered.cells;
        if (rendered.truncated) cut.push(sheet);
        size.width = Math.max(size.width, rendered.size.width);
        size.height = Math.max(size.height, rendered.size.height);
        bodies.push(rendered.html);
    }
    // Each sheet but the last ends its page. The .sheet div already has a class, so its page break is a second class.
    const html = bodies
        .map((body, i) => {
            const divClass =
                i === bodies.length - 1 ? 'sheet' : `sheet ${internStyle(styles, 'page-break-after:always')}`;
            return `<div class="${divClass}">\n${body}\n</div>`;
        })
        .join('\n');
    return { html, css: serializeStyleRules(styles), cut, leftOut, size };
}

// The sheets the tabs show, as Excel prints them. The resolver still spans every sheet, the hidden ones too.
function shownSheets(sheets: Sheet[]): Sheet[] {
    return sheets.filter((sheet) => sheet.hide !== 1);
}

function pdfPageCss({ width, height }: ContentSize): string {
    const side = (content: number) => Math.min(content + 2 * PAGE_MARGIN + PAGE_SLACK, MAX_PDF_PAGE_PX);
    return `@page { size: ${side(width)}px ${side(height)}px; margin: ${PAGE_MARGIN}px; }`;
}

// The far corner of a sheet's images and charts as they turn, in the table's space, as the overlay places them.
function floatingExtent(sheet: Sheet, offset: { left: number; top: number }): { width: number; height: number } {
    let width = 0;
    let height = 0;
    for (const { bounds } of floatingObjects(sheet)) {
        width = Math.max(width, bounds.maxX - offset.left);
        height = Math.max(height, bounds.maxY - offset.top);
    }
    return { width, height };
}

// The sheet's table and overlay, for the caller to wrap in its .sheet div. With `styles` this is the export, with
// interned classes, in a window of `cellsLeft`, and null when those cells hold none of its rows. Without it this is the
// preview, inline-styled, in its budget. `cells` is what the window cost, and `size` the table and its overlay as
// rendered: the overlay draws at the stored grid coordinate, so an image or chart parked past the used range is still
// on the page.
function renderSheet(
    sheet: Sheet,
    engine: FormulaEngine,
    resolver: CellResolver,
    {
        budget,
        cellsLeft = 0,
        styles,
        mediaUrls,
    }: { budget?: SheetBudget; cellsLeft?: number; styles?: StyleRegistry; mediaUrls: MediaUrls },
): { html: string; truncated: boolean; cells: number; size: ContentSize } | null {
    const forStylesheet = styles !== undefined;
    const config = sheet.config ?? {};
    const showGrid = sheet.showGridLines !== false && sheet.showGridLines !== 0;
    const overlay = { budget, styles, mediaUrls, resolver };

    const { minRow, minCol, maxRow, maxCol } = getRenderBounds(sheet, config);
    if (maxRow < 0 || maxCol < 0) {
        // An image or chart on an otherwise blank sheet is all there is to render.
        return {
            html: withFloatingOverlay(sheet, '', 0, 0, 0, overlay),
            truncated: false,
            cells: 0,
            size: floatingExtent(sheet, { left: 0, top: 0 }),
        };
    }

    // The window comes first, so all that follows costs what is rendered, not what the sheet declares: a merge or a
    // rule's range can name millions of cells.
    const shownRows = shownCount(minRow, maxRow, config.rowhidden);
    const { maxRows, maxCols, maxCells } =
        budget ?? exportWindow(cellsLeft, shownRows, shownCount(minCol, maxCol, config.colhidden));
    if (maxRows === 0 && shownRows > 0) return null;
    let truncated = false;
    const renderCols: number[] = [];
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c] != null) continue;
        if (renderCols.length >= maxCols) {
            truncated = true;
            break;
        }
        renderCols.push(c);
    }

    const renderRows: number[] = [];
    const rowCells = Math.max(1, renderCols.length);
    let cellCount = 0;
    for (let r = minRow; r <= maxRow; r++) {
        if (config.rowhidden?.[r] != null) continue;
        if (renderRows.length >= maxRows || cellCount + rowCells > maxCells) {
            truncated = true;
            break;
        }
        cellCount += rowCells;
        renderRows.push(r);
    }
    const lastRow = renderRows.at(-1) ?? -1;
    const lastCol = renderCols.at(-1) ?? -1;
    // Only a window that leaves cells out clips what reaches past it: the preview's, or an export cut to the cap.
    const clipped = budget !== undefined || truncated;

    // A merge's outer borders sit on its first cell, the only one rendered for it.
    const borderMap = mergedBorderSides(config.borderInfo, config.merge, [minRow, lastRow, minCol, lastCol]);

    // The rules need the dense `data` matrix, and a sheet without it draws none, as the canvas does.
    const rules =
        clipped && sheet.conditionalFormatRules
            ? clipRulesToWindow(sheet.conditionalFormatRules, minRow, lastRow, minCol, lastCol)
            : sheet.conditionalFormatRules;
    const cfMap: ComputeMap | null =
        rules && sheet.data
            ? evaluateConditionalFormat(rules, sheet.data, {
                  evaluateFormula: createCfFormulaEvaluator(engine, resolver, sheet.id ?? sheet.name),
              })
            : null;

    // Each rendered row tests the merges that cover it, which a sweep down the merges by their first row keeps. A set
    // of every covered cell would be an allocation bomb, as one merge can span a million rows.
    const merges = config.merge ? Object.values(config.merge).sort((a, b) => a.r - b.r) : [];
    const mergeAnchors = new Map<string, MergeCell>();
    for (const m of merges) mergeAnchors.set(`${m.r},${m.c}`, m);
    let rowMerges: MergeCell[] = [];
    let nextMerge = 0;

    const cellMap = new Map<string, CellWithRowAndCol>();
    if (sheet.celldata) {
        for (const cd of sheet.celldata) {
            cellMap.set(`${cd.r},${cd.c}`, cd);
        }
    }

    const cols: string[] = [];
    let tableWidth = 0;
    for (const c of renderCols) {
        const w = sheetColumnsWidth(sheet, c, c);
        tableWidth += w;
        cols.push(`<col ${styleAttr(styles, `width:${w}px`)}>`);
    }
    const colgroup = `<colgroup>${cols.join('')}</colgroup>`;

    const rows: string[] = [];
    let tableHeight = 0;
    for (const r of renderRows) {
        const h = sheetRowsHeight(sheet, r, r);
        tableHeight += h;
        const cells: string[] = [];
        rowMerges = rowMerges.filter((m) => r < m.r + m.rs);
        for (; nextMerge < merges.length && merges[nextMerge].r <= r; nextMerge++) {
            if (r < merges[nextMerge].r + merges[nextMerge].rs) rowMerges.push(merges[nextMerge]);
        }

        for (const c of renderCols) {
            const key = `${r},${c}`;

            if (rowMerges.some((m) => c >= m.c && c < m.c + m.cs && (m.r !== r || m.c !== c))) continue;

            const cd = cellMap.get(key);
            const v = cd?.v ?? null;
            const merge = mergeAnchors.get(key);
            const cfStyle = cfMap ? cfMap[`${r}_${c}`] : undefined;

            const attrs: string[] = [];
            if (merge) {
                // A span past the window would claim table cells the window never wrote.
                const cs = clipped ? Math.min(merge.cs, lastCol - c + 1) : merge.cs;
                const rs = clipped ? Math.min(merge.rs, lastRow - r + 1) : merge.rs;
                if (cs !== merge.cs || rs !== merge.rs) truncated = true;
                if (cs > 1) attrs.push(`colspan="${cs}"`);
                if (rs > 1) attrs.push(`rowspan="${rs}"`);
            }

            const cellStyle = buildCellStyle(v, borderMap[`${r}_${c}`], showGrid, cfStyle, forStylesheet);
            if (forStylesheet) {
                // The shared td{} rule holds the base declarations, so an unstyled cell needs no class.
                if (cellStyle) attrs.push(styleAttr(styles, cellStyle));
            } else {
                attrs.push(`style="${cellStyle ? `${BASE_TD_STYLE};${cellStyle}` : BASE_TD_STYLE}"`);
            }

            // A web link passes the editor's scheme gate. A link into the workbook means nothing in a standalone
            // document, so it stays plain text.
            const link = sheet.hyperlink?.[`${r}_${c}`];
            const href = link?.linkType === 'webpage' ? resolveWebLink(link.linkAddress) : null;
            let display = getCellDisplay(v);
            if (href != null) {
                display = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${display}</a>`;
            }
            const dataBarLayer = cfStyle?.dataBar ? renderDataBar(cfStyle.dataBar, display, styles) : null;
            const inner = wrapForRotation(v, dataBarLayer ?? display, styles);
            const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            cells.push(`<td${attrStr}>${inner}</td>`);
        }

        rows.push(`<tr ${styleAttr(styles, `height:${h}px`)}>${cells.join('')}</tr>`);
    }

    const q = fontQuote(forStylesheet);
    const tableStyle = `border-collapse:collapse;table-layout:fixed;font-family:${FONT_STACK_SANS.replaceAll('"', q)};font-size:${SHEET_DEFAULT_FONT_SIZE}pt;color:#1a1a2e;background:#fff;width:${tableWidth}px`;
    const table = `<table ${styleAttr(styles, tableStyle)}>${colgroup}<tbody>${rows.join('')}</tbody></table>`;
    const html = withFloatingOverlay(sheet, table, tableWidth, minRow, minCol, overlay);
    const extent = floatingExtent(sheet, gridOffset(sheet, minRow, minCol));
    const size = { width: Math.max(tableWidth, extent.width), height: Math.max(tableHeight, extent.height) };
    return { html, truncated, cells: cellCount, size };
}

// The export's window keeps the columns from the left up to one PDF page wide, and more of them while every row still
// fits. Then it keeps the rows that fit the cells left.
function exportWindow(cellsLeft: number, rows: number, cols: number): SheetBudget {
    const pageCols = Math.min(cols, PAGE_COLUMNS);
    const maxCols = Math.min(cols, Math.max(pageCols, Math.floor(cellsLeft / rows)));
    return { maxRows: Math.min(rows, Math.floor(cellsLeft / Math.max(1, maxCols))), maxCols, maxCells: cellsLeft };
}

// The table inside a box that reaches the farthest image or chart, so what follows in the flow, the next sheet or the
// preview's marker, starts below them. The preview clips the overlay to its window: an image parked outside it would
// stretch the body and shrink the thumbnail scaled from it. A sheet with no images or charts writes the bare table.
function withFloatingOverlay(
    sheet: Sheet,
    table: string,
    tableWidth: number,
    minRow: number,
    minCol: number,
    {
        budget,
        styles,
        mediaUrls,
        resolver,
    }: { budget?: SheetBudget; styles?: StyleRegistry; mediaUrls: MediaUrls; resolver: CellResolver },
): string {
    const offset = gridOffset(sheet, minRow, minCol);
    const clip = budget && {
        width: sheetColumnsWidth(sheet, minCol, minCol + budget.maxCols - 1),
        height: sheetRowsHeight(sheet, minRow, minRow + budget.maxRows - 1),
    };
    const overlay = renderFloatingObjects(sheet, mediaUrls, resolver, offset, styles, clip);
    if (!overlay) return table;
    const extent = floatingExtent(sheet, offset);
    const width = Math.max(tableWidth, clip ? Math.min(extent.width, clip.width) : extent.width);
    const height = clip ? Math.min(extent.height, clip.height) : extent.height;
    const box = `position:relative;width:${width}px;min-height:${height}px${clip ? ';overflow:hidden' : ''}`;
    return `<div ${styleAttr(styles, box)}>${table}${overlay}</div>`;
}

// A rule may name the whole sheet while the preview renders a small window, and the evaluator visits every cell of
// every range, running a formula rule's engine once per cell. Clipping keeps that work to what is rendered. A rule
// that misses the window drops out.
function clipRulesToWindow(
    rules: ConditionalFormatRule[],
    firstRow: number,
    lastRow: number,
    firstCol: number,
    lastCol: number,
): ConditionalFormatRule[] {
    const clipped: ConditionalFormatRule[] = [];
    for (const rule of rules) {
        const cellrange = rule.cellrange
            .map((range) => ({
                row: [Math.max(range.row[0], firstRow), Math.min(range.row[1], lastRow)],
                column: [Math.max(range.column[0], firstCol), Math.min(range.column[1], lastCol)],
            }))
            .filter((range) => range.row[0] <= range.row[1] && range.column[0] <= range.column[1]);
        if (cellrange.length > 0) clipped.push(withCfRanges(rule, cellrange));
    }
    return clipped;
}

// How many of the rows or columns from first to last show. A hidden one has a key in `rowhidden` or `colhidden`.
function shownCount(first: number, last: number, hidden: Record<string, number> | undefined): number {
    let count = 0;
    for (let i = first; i <= last; i++) {
        if (hidden?.[i] == null) count++;
    }
    return count;
}

// Images and charts are stored in grid pixels from A1, while the overlay places them against the window's first cell.
// One anchored above or left of the used range would take a negative offset and fall off the page, so the window
// starts at the row and column the earliest one, as it turns, starts in.
function getRenderBounds(
    sheet: Sheet,
    config: SheetConfig,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
    const bounds = getGridBounds(sheet, config.borderInfo ?? {});
    const floating = floatingObjects(sheet);
    if (floating.length === 0 || bounds.maxRow < 0) return bounds;

    let x = Number.MAX_SAFE_INTEGER;
    let y = Number.MAX_SAFE_INTEGER;
    for (const { bounds: turned } of floating) {
        x = Math.min(x, turned.minX);
        y = Math.min(y, turned.minY);
    }

    let minCol = 0;
    let left = 0;
    while (minCol < bounds.minCol && left + sheetColumnsWidth(sheet, minCol, minCol) <= x) {
        left += sheetColumnsWidth(sheet, minCol, minCol);
        minCol++;
    }
    let minRow = 0;
    let top = 0;
    while (minRow < bounds.minRow && top + sheetRowsHeight(sheet, minRow, minRow) <= y) {
        top += sheetRowsHeight(sheet, minRow, minRow);
        minRow++;
    }
    return { ...bounds, minRow, minCol };
}

function getGridBounds(
    sheet: Sheet,
    borderInfo: Record<string, CellBorderSides>,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
    let minRow = Number.MAX_SAFE_INTEGER;
    let minCol = Number.MAX_SAFE_INTEGER;
    let maxRow = -1;
    let maxCol = -1;

    if (sheet.celldata) {
        for (const { r, c, v } of sheet.celldata) {
            if (!hasVisibleContent(v)) continue;
            if (r < minRow) minRow = r;
            if (c < minCol) minCol = c;
            if (r > maxRow) maxRow = r;
            if (c > maxCol) maxCol = c;
        }
    }

    // The raw border keys: folding onto a merge's first cell only ever drops keys.
    const be = borderInfoExtent(borderInfo);
    if (be.minRow < minRow) minRow = be.minRow;
    if (be.minCol < minCol) minCol = be.minCol;
    if (be.maxRow > maxRow) maxRow = be.maxRow;
    if (be.maxCol > maxCol) maxCol = be.maxCol;

    if (sheet.config?.merge) {
        for (const m of Object.values(sheet.config.merge)) {
            if (m.r < minRow) minRow = m.r;
            if (m.c < minCol) minCol = m.c;
            const endRow = m.r + m.rs - 1;
            const endCol = m.c + m.cs - 1;
            if (endRow > maxRow) maxRow = endRow;
            if (endCol > maxCol) maxCol = endCol;
        }
    }

    // A key past Excel's grid draws nothing there, and every walk over the span would run as far as it says.
    maxRow = Math.min(maxRow, REFERENCE_ROW_COUNT - 1);
    maxCol = Math.min(maxCol, REFERENCE_COLUMN_COUNT - 1);
    if (maxRow < 0 || minRow > maxRow || minCol > maxCol) return { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 };
    return { minRow, minCol, maxRow, maxCol };
}

function hasVisibleContent(v: Cell | null): boolean {
    if (!v) return false;
    if (v.v != null || v.m != null || richText(v) !== undefined) return true;
    if (v.bg || v.fc) return true;
    if (v.bl === 1 || v.it === 1 || v.un === 1 || v.cl === 1) return true;
    if (v.mc && 'rs' in v.mc) return true; // merge anchor
    return false;
}

// The rows and columns the window skips, in grid pixels from A1, which the overlay subtracts from each stored box.
function gridOffset(sheet: Sheet, minRow: number, minCol: number): { left: number; top: number } {
    return { left: sheetColumnsWidth(sheet, 0, minCol - 1), top: sheetRowsHeight(sheet, 0, minRow - 1) };
}

// Every image and chart in their one paint order, each with its box clamped as the editor's writers store it
// (sheetFloatingBox), which also turns a string a peer stored into its number, and the box it covers as it turns,
// which the page size, the window's origin and the preview's clip count. One turned past A1 tucks under the
// editor's headers, but a page has none, so it moves right or down until it starts on the page.
function floatingObjects(sheet: Sheet) {
    return floatingItems(sheet).map((item) => {
        const stored = sheetFloatingBox(item.object);
        const turned = getElementBounds(stored);
        const box = { ...stored, x: stored.x - Math.min(0, turned.minX), y: stored.y - Math.min(0, turned.minY) };
        return { item, box, bounds: getElementBounds(box) };
    });
}

function buildCellStyle(
    v: Cell | null,
    borders: CellBorderSides | undefined,
    showGrid: boolean,
    cfStyle: CellFormatStyle | undefined,
    forStylesheet: boolean,
): string {
    const parts: string[] = [];

    const rotated = isNumericRotation(v);

    if (v) {
        const family = cellFontName(v.ff);
        // In stylesheet text entities stay literal, so escapeHtml there would draw "Bell MT & Co" as "Bell MT &amp;
        // Co". The quotes are all that could end the quoted name early, and the stylesheet seam strips the rest.
        if (family) {
            const name = forStylesheet ? family.replace(/["'\\]/g, '') : escapeHtml(family);
            const q = fontQuote(forStylesheet);
            parts.push(`font-family:${q}${name}${q},sans-serif`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (typeof v.fs === 'number') parts.push(`font-size:${cellFontSize(v.fs)}pt`);
        // A rule's colors win over the cell's own, as on the canvas.
        const textColor = cssColor(cfStyle?.textColor || v.fc);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle?.cellColor || v.bg);
        if (cellColor) parts.push(`background:${cellColor}`);
        // A rotated cell's span is placed absolutely (wrapForRotation), so no alignment acts on it. Any other cell
        // writes its own text-align, else Excel's General one as the canvas draws it, where left, the td's own, writes
        // none. Its vertical-align defaults to middle.
        if (!rotated) {
            const general = generalAlign(v);
            const ht = v.ht != null && v.ht in HORIZONTAL_ALIGN ? v.ht : general === '1' ? undefined : Number(general);
            if (ht !== undefined) parts.push(`text-align:${HORIZONTAL_ALIGN[ht]}`);
            const valign = v.vt != null && v.vt in VERTICAL_ALIGN ? VERTICAL_ALIGN[v.vt] : 'middle';
            parts.push(`vertical-align:${valign}`);
        }
        if (cellWrapsText(v)) parts.push('white-space:pre-wrap;word-wrap:break-word');
        if (v.un === 1 && v.cl === 1) {
            parts.push('text-decoration:underline line-through');
        } else if (v.un === 1) {
            parts.push('text-decoration:underline');
        } else if (v.cl === 1) {
            parts.push('text-decoration:line-through');
        }
    } else if (cfStyle) {
        // Some rules color an empty cell too: only the rule's colors apply.
        const textColor = cssColor(cfStyle.textColor);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle.cellColor);
        if (cellColor) parts.push(`background:${cellColor}`);
    }

    if (borders) {
        // CSS has no diagonal border, so the slash side `s` is not rendered.
        parts.push(...borderSidesToCss(borders, (color) => cssColor(color) ?? 'transparent'));
    } else if (showGrid) {
        parts.push('border:1px solid #d4d4d4');
    }

    // Both the data bar's layer and a rotated span are placed absolutely inside the cell.
    if (rotated || cfStyle?.dataBar) {
        parts.push('position:relative');
    }

    return parts.join(';');
}

// Cell, border and rule colors are schemaless values a collaborator sets, so only a string the color parser reads
// reaches the CSS: `red;position:fixed;inset:0` would add declarations of its own to the export and the drive hero.
// A bare keyword (a named color) can't add a declaration, so it passes as CSS reads it.
function cssColor(color: unknown): string | undefined {
    if (typeof color !== 'string' || !color) return undefined;
    return cssColorToHex(color) !== undefined || isTransparentCssColor(color) || /^[a-z]+$/i.test(color)
        ? color
        : undefined;
}

// A font name's quote is a real `"` in stylesheet text and `&quot;` in a style attribute, where a `"` would end the
// attribute and drop every later declaration.
function fontQuote(forStylesheet: boolean): string {
    return forStylesheet ? '"' : '&quot;';
}

function getCellDisplay(v: Cell | null): string {
    if (!v) return '';
    const rich = richText(v);
    if (rich !== undefined) return escapeHtml(rich);
    if (v.m != null) return escapeHtml(String(v.m));
    if (v.v == null) return '';
    if (typeof v.v === 'boolean') return booleanDisplay(v.v);
    return escapeHtml(String(v.v));
}

// The cell's content turned as the canvas turns it. The span is pinned to the corner the text turns around: left and
// bottom for a positive rt, which turns up, and left and top for a negative one. CSS turns clockwise and rt
// anticlockwise, as Excel does, so the angle is negated. Turned around a corner, the text would swing past the cell's
// left edge and be clipped, so the span shifts right by sin(rt) em after it turns, as the canvas shifts its pivot by
// the text's height. A 'vertical' rt stacks the characters with writing-mode instead.
function wrapForRotation(v: Cell | null, inner: string, styles?: StyleRegistry): string {
    if (!v || v.rt == null) return inner;
    if (v.rt === 'vertical') {
        return `<span ${styleAttr(styles, 'writing-mode:vertical-rl;text-orientation:upright')}>${inner}</span>`;
    }
    if (isNumericRotation(v)) {
        const { rt } = v;
        const cssAngle = -rt;
        const yPin = rt > 0 ? 'bottom:0' : 'top:0';
        const origin = rt > 0 ? 'left bottom' : 'left top';
        const overhangEm = Math.abs(Math.sin((rt * Math.PI) / 180)).toFixed(3);
        const decl =
            `position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)`;
        return `<span ${styleAttr(styles, decl)}>${inner}</span>`;
    }
    return inner;
}

// The data bar as the canvas paints it: a negative value fills the half left of the zero line, a positive one the half
// right of it. The canvas paints a negative bar red whatever the rule's color, so the export does too.
function renderDataBar(bar: DataBar, display: string, styles?: StyleRegistry): string {
    const from = cssColor(bar.format[0]) ?? 'transparent';
    const to = cssColor(bar.format[1]) ?? 'transparent';
    let left: number;
    let width: number;
    let fill: string;
    if (bar.valueType === 'minus') {
        left = bar.minusLen * (1 - bar.valueLen) * 100;
        width = bar.minusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? 'linear-gradient(to right, #ffffff, #ff0000)' : '#ff0000';
    } else if (bar.plusLen === 1) {
        left = 0;
        width = bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    } else {
        // A positive value in a range with negatives starts at the zero line.
        left = bar.minusLen * 100;
        width = bar.plusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    }

    const barStyle = `position:absolute;top:0;left:${left}%;width:${width}%;height:100%;background:${fill};z-index:0`;
    return `<div ${styleAttr(styles, barStyle)}></div><span ${styleAttr(styles, 'position:relative;z-index:1')}>${display}</span>`;
}

// Images and charts at their stored boxes, rotated about their centers, in the order the editor stacks them. An image
// whose name resolves to nothing renders nothing: a `pending:` name from an upload that never settled, or a media
// file deleted under the reference. A chart draws as the painter's inline SVG on white like the editor's chart box,
// so the gridlines stop at it, its ranges read from the materialized sheets.
function renderFloatingObjects(
    sheet: Sheet,
    mediaUrls: MediaUrls,
    resolver: CellResolver,
    offset: { left: number; top: number },
    styles?: StyleRegistry,
    clip?: { width: number; height: number },
): string {
    const parts: string[] = [];
    for (const { item, box, bounds } of floatingObjects(sheet)) {
        const [minX, minY] = [bounds.minX - offset.left, bounds.minY - offset.top];
        const [maxX, maxY] = [bounds.maxX - offset.left, bounds.maxY - offset.top];
        if (clip && (minX >= clip.width || minY >= clip.height || maxX <= 0 || maxY <= 0)) continue;
        const rotate = box.angle ? `;transform:rotate(${box.angle}deg);transform-origin:center center` : '';
        const place = (extra = '') =>
            styleAttr(
                styles,
                `position:absolute;left:${box.x - offset.left}px;top:${box.y - offset.top}px;width:${box.width}px;height:${box.height}px${extra}${rotate}`,
            );
        if (item.kind === 'image') {
            const src = mediaUrls.get(item.object.mediaName);
            if (src !== undefined) parts.push(`<img ${place()} src="${escapeHtml(src)}" alt="">`);
        } else {
            const svg = renderSheetChartSvg({ ...item.object, width: box.width, height: box.height }, resolver);
            parts.push(`<div ${place(';background:#fff')}>${svg}</div>`);
        }
    }
    return parts.join('');
}

function styleAttr(styles: StyleRegistry | undefined, declarations: string): string {
    return styles ? `class="${internStyle(styles, declarations)}"` : `style="${declarations}"`;
}

function internStyle(styles: StyleRegistry, declarations: string): string {
    let cls = styles.get(declarations);
    if (cls === undefined) {
        cls = `s${styles.size}`;
        styles.set(declarations, cls);
    }
    return cls;
}

// A cell's values are schemaless strings, and in a stylesheet they sit in CSS text, where other characters are
// structural and no HTML entity is decoded. Every declaration passes here, so the whole class is closed at one seam.
// `<` and `>` end the <style> element, and the sanitizer keeps what follows. `{` and `}` open and close a rule. `\`
// starts a CSS escape, which could spell `url(` past the sanitizer's scan. `/*` opens a comment that swallows every
// later rule. None of them is in a real declaration.
const CSS_TEXT_STRUCTURAL = /[<>{}\\]|\/\*|\*\//g;

function serializeStyleRules(styles: StyleRegistry): string {
    const rules = [`td{${BASE_TD_STYLE}}`];
    for (const [declarations, cls] of styles) {
        rules.push(`.${cls}{${declarations.replace(CSS_TEXT_STRUCTURAL, '')}}`);
    }
    return rules.join('\n');
}

const SHEET_CSS_BASE = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: ${FONT_STACK_SANS};
    font-size: 11px;
    color: #1a1a2e;
    background: #fff;
    margin: 0;
    padding: 2rem;
}

.sheet {
    margin-bottom: 2rem;
}
`;

const SHEET_CSS_PRINT = `
@media print {
    body { padding: 0; background: #fff; }
    .sheet { margin-bottom: 0; }
}
`;
