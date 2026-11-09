// A workbook as HTML: the export's one document, which the HTML download serves and WeasyPrint prints, and the
// preview's body of the first sheet. Each sheet renders through windowedSheet, so it walks only the window, under flat
// caps on cells and on images and charts. It runs in the transform process and reaches no Mount, so images arrive as
// URLs by media name.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { ptToPx } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import type {
    Cell,
    CellBorderSides,
    CellWithRowAndCol,
    MergeCell,
    Sheet,
    SheetFloatingItem,
} from '@workspace/lib/sheets';
import {
    borderSidesToCss,
    cellFontName,
    cellFontSize,
    mergeEdgeSides,
    parseCellKey,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_FONT_SIZE,
    sheetColumnsWidth,
    sheetRowsHeight,
} from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
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
} from '@workspace/sheet/engine';
import { cssColorToHex, isTransparentCssColor } from '../../document/colors';
import { FONT_STACK_SANS, SANS_FONT_NAME } from '../../document/font-stacks';
import type { HtmlExportMode, LossCounter } from '../../document/transform/protocol';
import { MAX_DECOMPRESSED_BYTES } from '../../ooxml/zip';
import { exportHtmlDocument } from '../html-document';
import { MAX_PDF_PAGE_PX } from '../weasyprint';
import { HORIZONTAL_ALIGN, isNumericRotation, sheetsResolver, VERTICAL_ALIGN } from './cell-style';
import type { FloatingObject, SheetBudget, WindowedSheet } from './window';
import { windowedSheet } from './window';

// Image sources by media name: data: URIs for an export, the prepared preview URLs for a preview.
type MediaUrls = Map<string, string>;

type ContentSize = { width: number; height: number };

// Each style's declarations and the class it is interned as, since the sanitizer CSS-parses every style attribute but
// passes class names as plain strings. The preview keeps inline styles, as its body embeds without a <head>.
type StyleRegistry = Map<string, string>;

export const PREVIEW_SHEET_BUDGET: SheetBudget = { maxRows: 200, maxCols: 50, maxCells: 10_000 };

// One a row of its window. The byte guard behind it catches a preview of that many full charts, with the truncated
// notice in its place.
export const MAX_PREVIEW_FLOATING = 200;

// The most cells, rows times columns, an export walks of all its sheets together, since a peer can write a merge or a
// border key at XFD1048576 and the sanitizer and WeasyPrint pay for every cell the walk writes.
export const MAX_EXPORT_CELLS = 250_000;

// The most images and charts an export draws of all its sheets together: as many pictures as an import keeps.
export const MAX_EXPORT_FLOATING = 1_000;

// What a sheet that draws costs a PDF at least, as it prints a page of its own: the cap holds 2,000 such sheets.
const PDF_PAGE_CELLS = 125;

// The default columns one PDF page holds. A cut sheet keeps at least that many, so its first page is never narrow.
const PAGE_COLUMNS = Math.floor(MAX_PDF_PAGE_PX / SHEET_DEFAULT_COL_WIDTH);

// Every td's defaults: inline in the preview, whose embedders strip the <head>, and the shared td{} rule in the export.
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

// Inter's line, as a multiple of the font size. A fallback font's can be taller, and grows a default row by a few
// pixels.
const LINE_HEIGHT = 1.2;

// Where the canvas places a cell's ink: CSS places a line by its font's ascent and descent, which in Inter put the ink
// 0.1em below the middle of the line and 0.17em below its top, so the margins lift it back.
const TEXT_PLACEMENT: Record<(typeof VERTICAL_ALIGN)[number], string> = {
    top: 'top:2px;margin-top:-0.17em',
    middle: 'top:50%;transform:translateY(-50%);margin-top:-0.1em',
    bottom: 'bottom:2px',
};

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

// The workbook as one document, whose PDF page fits its widest and tallest sheet as rendered. What the caps cut or left
// out is counted through `lost`.
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
    const { html, css, cut, leftOut, floatingLeftOut, size } = renderSheetsHtml(sheets, mediaUrls, mode);
    for (const sheet of cut) lost('sheets-cut', sheet);
    for (const sheet of leftOut) lost('sheets-left-out', sheet);
    for (const { kind, object } of floatingLeftOut)
        lost(kind === 'chart' ? 'charts-dropped' : 'images-dropped', object);
    const page = mode === 'pdf' ? pdfPageCss(size) : '@page { size: landscape; margin: 1.5cm; }';
    return exportHtmlDocument({
        title,
        cssFamilies: [SANS_FONT_NAME],
        css: `${SHEET_CSS_BASE}${page}${SHEET_CSS_PRINT}`,
        body: `<style>${css}</style>\n${html}`,
    });
}

// The first shown sheet, its overlay clipped to the budget's box, since an image parked outside would stretch the body
// and shrink the thumbnail scaled from it. On `truncated` the caller adds the shared marker.
export function renderSheetsPreviewHtml(sheets: Sheet[], mediaUrls: MediaUrls): { html: string; truncated: boolean } {
    const shown = shownSheets(sheets);
    if (shown.length === 0) return { html: '', truncated: false };
    const windowed = windowedSheet(shown[0], () => PREVIEW_SHEET_BUDGET);
    if (!windowed) return { html: '', truncated: true };
    const { sheet, range, offset, budgetEnd } = windowed;
    const [firstRow, , firstCol] = range ?? [0, 0, 0, 0];
    const clip = {
        width: sheetColumnsWidth(sheet, firstCol, budgetEnd.col),
        height: sheetRowsHeight(sheet, firstRow, budgetEnd.row),
    };
    const inClip = windowed.floating.filter(
        ({ bounds }) =>
            bounds.minX - offset.left < clip.width &&
            bounds.minY - offset.top < clip.height &&
            bounds.maxX > offset.left &&
            bounds.maxY > offset.top,
    );
    const floating = inClip.slice(0, MAX_PREVIEW_FLOATING);
    const first = renderSheet({ ...windowed, floating }, new FormulaEngine(), sheetsResolver(sheets), {
        clip,
        mediaUrls,
    });
    const leftOut = floating.length < windowed.floating.length;
    const truncated = windowed.truncated || leftOut || shown.length > 1;
    return { html: `<div class="sheet">\n${first.html}\n</div>`, truncated };
}

// One engine and one resolver serve every sheet, so a rule's `=Sheet2!A1>10` reads the other sheet. The sheets spend
// the caps in tab order, so each gets what the ones before it left.
export function renderSheetsHtml(
    sheets: Sheet[],
    mediaUrls: MediaUrls,
    mode: HtmlExportMode,
): {
    html: string;
    css: string;
    cut: Sheet[];
    leftOut: Sheet[];
    floatingLeftOut: SheetFloatingItem[];
    size: ContentSize;
} {
    const engine = new FormulaEngine();
    const resolver = sheetsResolver(sheets);
    const styles: StyleRegistry = new Map();
    const cut: Sheet[] = [];
    const leftOut: Sheet[] = [];
    const floatingLeftOut: SheetFloatingItem[] = [];
    const size = { width: 0, height: 0 };
    const bodies: string[] = [];
    const floatingLeft = { objects: MAX_EXPORT_FLOATING, imageBytes: MAX_DECOMPRESSED_BYTES };
    let cellsLeft = MAX_EXPORT_CELLS;
    for (const sheet of shownSheets(sheets)) {
        const windowed = windowedSheet(sheet, (rows, cols) => exportWindow(mode, cellsLeft, rows, cols));
        if (!windowed) {
            leftOut.push(sheet);
            continue;
        }
        // A sheet with shown cells, images or charts prints a page of its own. A blank one takes no page, and nor does
        // one whose every row or every column is hidden.
        const draws = (windowed.rows.length > 0 && windowed.cols.length > 0) || windowed.floating.length > 0;
        const cells = Math.max(windowed.cells, draws && mode === 'pdf' ? PDF_PAGE_CELLS : 0);
        if (cells > cellsLeft) {
            leftOut.push(sheet);
            continue;
        }
        cellsLeft -= cells;
        if (windowed.truncated) cut.push(sheet);
        if (!draws) continue;
        const floating = capFloating(windowed.floating, mediaUrls, floatingLeft);
        floatingLeftOut.push(...floating.leftOut);
        const rendered = renderSheet({ ...windowed, floating: floating.kept }, engine, resolver, { styles, mediaUrls });
        size.width = Math.max(size.width, rendered.size.width);
        size.height = Math.max(size.height, rendered.size.height);
        // Images whose media resolves to nothing draw nothing.
        if (rendered.html) bodies.push(rendered.html);
    }
    // Each sheet but the last ends its page. The .sheet div already has a class, so its page break is a second class.
    const html = bodies
        .map((body, i) => {
            const divClass =
                i === bodies.length - 1 ? 'sheet' : `sheet ${internStyle(styles, 'page-break-after:always')}`;
            return `<div class="${divClass}">\n${body}\n</div>`;
        })
        .join('\n');
    return { html, css: serializeStyleRules(styles), cut, leftOut, floatingLeftOut, size };
}

// The sheets the tabs show, as Excel prints them. The resolver still spans every sheet, the hidden ones too.
function shownSheets(sheets: Sheet[]): Sheet[] {
    return sheets.filter((sheet) => sheet.hide !== 1);
}

function pdfPageCss({ width, height }: ContentSize): string {
    const side = (content: number) => Math.min(content + 2 * PAGE_MARGIN + PAGE_SLACK, MAX_PDF_PAGE_PX);
    return `@page { size: ${side(width)}px ${side(height)}px; margin: ${PAGE_MARGIN}px; }`;
}

// Every <img> repeats its whole source and the finished document crosses the API's heap, so the bytes the tags write
// are held to the cap the media prep holds each file to once. One whose media resolves to nothing draws nothing and is
// free.
function capFloating(
    floating: FloatingObject[],
    mediaUrls: MediaUrls,
    left: { objects: number; imageBytes: number },
): { kept: FloatingObject[]; leftOut: SheetFloatingItem[] } {
    const kept: FloatingObject[] = [];
    const leftOut: SheetFloatingItem[] = [];
    for (const object of floating) {
        const { item } = object;
        const src = item.kind === 'image' ? mediaUrls.get(item.object.mediaName) : undefined;
        if (item.kind === 'image' && src === undefined) {
            kept.push(object);
            continue;
        }
        const bytes = src?.length ?? 0;
        if (left.objects === 0 || bytes > left.imageBytes) {
            leftOut.push(item);
            continue;
        }
        left.objects -= 1;
        left.imageBytes -= bytes;
        kept.push(object);
    }
    return { kept, leftOut };
}

// The far corner of a sheet's images and charts as they turn, in the table's space, as the overlay places them.
function floatingExtent(floating: FloatingObject[], offset: { left: number; top: number }): ContentSize {
    let width = 0;
    let height = 0;
    for (const { bounds } of floating) {
        width = Math.max(width, bounds.maxX - offset.left);
        height = Math.max(height, bounds.maxY - offset.top);
    }
    return { width, height };
}

// The sheet's table and overlay, for the caller to wrap in its .sheet div. With `styles` it is the export, with
// interned classes, and without it the preview, inline-styled, whose `clip` box also clips the overlay.
function renderSheet(
    { sheet, rows, cols, range, offset, floating }: WindowedSheet,
    engine: FormulaEngine,
    resolver: CellResolver,
    { clip, styles, mediaUrls }: { clip?: ContentSize; styles?: StyleRegistry; mediaUrls: MediaUrls },
): { html: string; size: ContentSize } {
    const forStylesheet = styles !== undefined;
    const config = sheet.config ?? {};
    const showGrid = sheet.showGridLines !== false && sheet.showGridLines !== 0;
    const extent = floatingExtent(floating, offset);
    const overlay = { floating, extent, styles, mediaUrls, resolver };
    if (!range) {
        // An image or chart on an otherwise blank sheet is all there is to render.
        return { html: withFloatingOverlay('', 0, offset, clip, overlay), size: extent };
    }

    // Each merge is one td on its first rendered cell, spanning the rendered tracks it covers, so a hidden track inside
    // it adds no span and the table matches its colgroup.
    const width = cols.length;
    const merges = Object.values(config.merge ?? {});
    const spans: MergeCell[] = [];
    // The merge each rendered cell lies in, by its index in `merges`, else -1.
    const mergeAt = new Int32Array(rows.length * width).fill(-1);
    for (const [k, anchor] of merges.entries()) {
        const r0 = firstAtOrAfter(rows, anchor.r);
        const r1 = firstAtOrAfter(rows, anchor.r + anchor.rs) - 1;
        const c0 = firstAtOrAfter(cols, anchor.c);
        const c1 = firstAtOrAfter(cols, anchor.c + anchor.cs) - 1;
        spans.push({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
        for (let i = r0; i <= r1; i++) mergeAt.fill(k, i * width + c0, i * width + c1 + 1);
    }
    // The merge a stored cell lies in, else -1. A merge that renders has a shown row next to each of its hidden ones,
    // before or after it, and the same for its columns, so the rendered cells nearest the stored one find it.
    const mergeOf = (r: number, c: number): number => {
        const i = firstAtOrAfter(rows, r);
        const j = firstAtOrAfter(cols, c);
        for (const near of [i, i - 1]) {
            for (const nearCol of [j, j - 1]) {
                if (near < 0 || near >= rows.length || nearCol < 0 || nearCol >= width) continue;
                const k = mergeAt[near * width + nearCol];
                const m = merges[k];
                if (k >= 0 && r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) return k;
            }
        }
        return -1;
    };
    // A merge's outer borders fold from the stored keys in reading order, as the editor folds them, onto the first
    // rendered cell, so a side stored on a hidden edge track still draws.
    const rowAt = new Map(rows.map((r, i) => [r, i]));
    const colAt = new Map(cols.map((c, j) => [c, j]));
    const borderMap: Record<string, CellBorderSides> = {};
    const inMerges: { sides: CellBorderSides; r: number; c: number; k: number }[] = [];
    for (const key in config.borderInfo) {
        const [r, c] = parseCellKey(key);
        const k = mergeOf(r, c);
        if (k >= 0) {
            inMerges.push({ sides: config.borderInfo[key], r, c, k });
            continue;
        }
        const i = rowAt.get(r);
        const j = colAt.get(c);
        if (i !== undefined && j !== undefined) borderMap[`${i}_${j}`] = config.borderInfo[key];
    }
    inMerges.sort((a, b) => a.r - b.r || a.c - b.c);
    for (const { sides, r, c, k } of inMerges) {
        const edge = mergeEdgeSides(sides, merges[k], r, c);
        if (edge) Object.assign((borderMap[`${spans[k].r}_${spans[k].c}`] ??= {}), edge);
    }

    // The rules need the dense `data` matrix, and a sheet without it draws none, as the canvas does.
    const rules = sheet.conditionalFormatRules;
    const cfMap: ComputeMap | null =
        rules && sheet.data
            ? evaluateConditionalFormat(rules, sheet.data, {
                  evaluateFormula: createCfFormulaEvaluator(engine, resolver, sheet.id),
              })
            : null;

    const cellMap = new Map<string, CellWithRowAndCol>();
    for (const cd of sheet.celldata ?? []) cellMap.set(`${cd.r},${cd.c}`, cd);

    const colTags: string[] = [];
    let tableWidth = 0;
    for (const c of cols) {
        const w = sheetColumnsWidth(sheet, c, c);
        tableWidth += w;
        colTags.push(`<col ${styleAttr(styles, `width:${w}px`)}>`);
    }
    const colgroup = `<colgroup>${colTags.join('')}</colgroup>`;

    const heights = rows.map((r) => sheetRowsHeight(sheet, r, r));
    const rowTags: string[] = [];
    let tableHeight = 0;
    for (let i = 0; i < rows.length; i++) {
        const h = heights[i];
        tableHeight += h;
        const cells: string[] = [];
        for (let j = 0; j < width; j++) {
            const k = mergeAt[i * width + j];
            const span = k >= 0 ? spans[k] : undefined;
            if (span && (span.r !== i || span.c !== j)) continue;
            // A merge draws its first cell, even when that cell's row or column is hidden.
            const [r, c] = k >= 0 ? [merges[k].r, merges[k].c] : [rows[i], cols[j]];
            const v = cellMap.get(`${r},${c}`)?.v ?? null;
            const cfStyle = cfMap ? cfMap[`${r}_${c}`] : undefined;

            const attrs: string[] = [];
            if (span && span.cs > 1) attrs.push(`colspan="${span.cs}"`);
            if (span && span.rs > 1) attrs.push(`rowspan="${span.rs}"`);

            const cellHeight = span ? heights.slice(i, i + span.rs).reduce((sum, rowHeight) => sum + rowHeight) : h;
            const clipped = canPassRows(v, cellHeight);
            const cellStyle = buildCellStyle(v, borderMap[`${i}_${j}`], showGrid, cfStyle, forStylesheet, clipped);
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
            // Content that can pass the cell's rows is clipped to them, under the data bar's layer, which spans the
            // whole cell.
            const dataBar = cfStyle?.dataBar;
            let inner: string;
            if (clipped) {
                const content = clipToRows(
                    wrapForRotation(v, display, styles),
                    cellHeight,
                    cellVerticalAlign(v),
                    styles,
                );
                inner = dataBar ? renderDataBar(dataBar, content, styles) : content;
            } else {
                inner = wrapForRotation(v, dataBar ? renderDataBar(dataBar, display, styles) : display, styles);
            }
            const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            cells.push(`<td${attrStr}>${inner}</td>`);
        }

        rowTags.push(`<tr ${styleAttr(styles, `height:${h}px`)}>${cells.join('')}</tr>`);
    }

    const tableStyle = `border-collapse:collapse;table-layout:fixed;font-family:${FONT_STACK_SANS};font-size:${SHEET_DEFAULT_FONT_SIZE}pt;color:#1a1a2e;background:#fff;width:${tableWidth}px`;
    const table = `<table ${styleAttr(styles, tableStyle)}>${colgroup}<tbody>${rowTags.join('')}</tbody></table>`;
    const html = withFloatingOverlay(table, tableWidth, offset, clip, overlay);
    return { html, size: { width: Math.max(tableWidth, extent.width), height: Math.max(tableHeight, extent.height) } };
}

// Whether a cell's content can grow its rows past their stored height, where the editor clips it. A turned span is
// placed absolutely and grows none, and a clip doubles what a cell costs WeasyPrint, so most cells stay plain.
function canPassRows(v: Cell | null, height: number): boolean {
    if (!v || isNumericRotation(v)) return false;
    return cellWrapsText(v) || v.rt === 'vertical' || ptToPx(cellFontSize(v.fs)) * LINE_HEIGHT + 1 > height;
}

// An inline-block as tall as the rows less their gridline, as WeasyPrint pages through a block's content past its
// height but not an inline-block's. The text inside is placed absolutely, so centered text spills past both edges as
// the editor's.
function clipToRows(
    content: string,
    height: number,
    valign: (typeof VERTICAL_ALIGN)[number],
    styles?: StyleRegistry,
): string {
    if (!content) return content;
    const clip =
        'display:inline-block;width:100%;vertical-align:top;position:relative;overflow:hidden;' +
        `text-decoration:inherit;height:${Math.max(0, height - 1)}px;margin:-1px 0`;
    const text = `position:absolute;left:0;right:0;line-height:1.1;text-decoration:inherit;${TEXT_PLACEMENT[valign]}`;
    return `<div ${styleAttr(styles, clip)}><div ${styleAttr(styles, text)}>${content}</div></div>`;
}

// The position of the first track in `tracks`, ascending, at or after `track`: tracks.length when there is none.
function firstAtOrAfter(tracks: number[], track: number): number {
    let low = 0;
    let high = tracks.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (tracks[mid] < track) low = mid + 1;
        else high = mid;
    }
    return low;
}

// The columns from the left up to one PDF page wide, the HTML download keeping more while every row still fits, then
// the rows that fit the cells left.
function exportWindow(mode: HtmlExportMode, cellsLeft: number, rows: number, cols: number): SheetBudget {
    const pageCols = Math.min(cols, PAGE_COLUMNS);
    const maxCols =
        mode === 'pdf' ? pageCols : Math.min(cols, Math.max(pageCols, Math.floor(cellsLeft / Math.max(1, rows))));
    return { maxRows: Math.min(rows, Math.floor(cellsLeft / Math.max(1, maxCols))), maxCols, maxCells: cellsLeft };
}

// The table inside a box that reaches the farthest image or chart, so what follows in the flow starts below them.
function withFloatingOverlay(
    table: string,
    tableWidth: number,
    offset: { left: number; top: number },
    clip: ContentSize | undefined,
    {
        floating,
        extent,
        styles,
        mediaUrls,
        resolver,
    }: {
        floating: FloatingObject[];
        extent: ContentSize;
        styles?: StyleRegistry;
        mediaUrls: MediaUrls;
        resolver: CellResolver;
    },
): string {
    const overlay = renderFloatingObjects(floating, mediaUrls, resolver, offset, styles);
    if (!overlay) return table;
    const width = Math.max(tableWidth, clip ? Math.min(extent.width, clip.width) : extent.width);
    const height = clip ? Math.min(extent.height, clip.height) : extent.height;
    const box = `position:relative;width:${width}px;min-height:${height}px${clip ? ';overflow:hidden' : ''}`;
    return `<div ${styleAttr(styles, box)}>${table}${overlay}</div>`;
}

function buildCellStyle(
    v: Cell | null,
    borders: CellBorderSides | undefined,
    showGrid: boolean,
    cfStyle: CellFormatStyle | undefined,
    forStylesheet: boolean,
    clipped: boolean,
): string {
    const parts: string[] = [];

    const rotated = isNumericRotation(v);

    if (v) {
        const family = cellFontName(v.ff);
        // Stylesheet text decodes no entities, so escapeHtml there would draw "Bell MT & Co" as "Bell MT &amp; Co".
        if (family) {
            const stack = getFontFamily(family);
            parts.push(`font-family:${forStylesheet ? stack : escapeHtml(stack)}`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (v.fs !== undefined) parts.push(`font-size:${cellFontSize(v.fs)}pt`);
        // A rule's colors win over the cell's own, as on the canvas.
        const textColor = cssColor(cfStyle?.textColor || v.fc);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle?.cellColor || v.bg);
        if (cellColor) parts.push(`background:${cellColor}`);
        // A rotated cell's span is placed absolutely, so no alignment acts on it. Any other writes its own or Excel's
        // General, except what the td and the table body already say: left and middle.
        if (!rotated) {
            const general = generalAlign(v);
            const ht = v.ht != null && v.ht in HORIZONTAL_ALIGN ? v.ht : general === '1' ? undefined : Number(general);
            if (ht !== undefined) parts.push(`text-align:${HORIZONTAL_ALIGN[ht]}`);
            const valign = cellVerticalAlign(v);
            if (clipped) parts.push('line-height:0');
            else if (valign !== 'middle') parts.push(`vertical-align:${valign}`);
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

function cellVerticalAlign(v: Cell | null): (typeof VERTICAL_ALIGN)[number] {
    return v?.vt != null && v.vt in VERTICAL_ALIGN ? VERTICAL_ALIGN[v.vt] : 'middle';
}

// Only a string the color parser reads reaches the CSS, since a collaborator's `red;position:fixed;inset:0` would add
// declarations of its own. A bare keyword can't add one, so it passes as CSS reads it.
function cssColor(color: unknown): string | undefined {
    if (typeof color !== 'string' || !color) return undefined;
    return cssColorToHex(color) !== undefined || isTransparentCssColor(color) || /^[a-z]+$/i.test(color)
        ? color
        : undefined;
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

// The content turned as the canvas turns it, pinned to the corner it turns around and shifted right by sin(rt) em so it
// doesn't swing past the cell's left edge. CSS turns clockwise and rt anticlockwise, so the angle is negated.
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
            `position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;text-decoration:inherit;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)`;
        return `<span ${styleAttr(styles, decl)}>${inner}</span>`;
    }
    return inner;
}

// The data bar as the canvas paints it: a negative value left of the zero line, always red, a positive one right of it.
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
    const textStyle = 'position:relative;z-index:1;text-decoration:inherit';
    return `<div ${styleAttr(styles, barStyle)}></div><span ${styleAttr(styles, textStyle)}>${display}</span>`;
}

// Images and charts at their stored boxes, rotated about their centers, in the editor's stacking order. An image whose
// name resolves to nothing, such as a deleted file, renders nothing.
function renderFloatingObjects(
    floating: FloatingObject[],
    mediaUrls: MediaUrls,
    resolver: CellResolver,
    offset: { left: number; top: number },
    styles?: StyleRegistry,
): string {
    const parts: string[] = [];
    for (const { item, box } of floating) {
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

// What is structural in CSS text and in no real declaration: `<` and `>` end the element, `{` and `}` open a rule, `\`
// spells `url(` past the sanitizer's scan, and `/*` swallows later rules. Every declaration passes here.
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
