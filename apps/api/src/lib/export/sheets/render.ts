// A workbook as HTML: the export's one document, which the HTML download serves and WeasyPrint prints, and the
// preview's body of the first sheet, cut to a budget. Each sheet renders through windowedSheet, so it walks only the
// window. Each cell is a table cell drawn as the canvas draws it, with the images and charts floating over the grid
// where the editor floats them. Runs in the transform process, so it reaches no Mount: images arrive as URLs by media
// name.

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
    sheetChartPoints,
} from '@workspace/sheet/engine';
import { cssColorToHex, isTransparentCssColor } from '../../document/colors';
import { FONT_STACK_SANS } from '../../document/font-stacks';
import type { HtmlExportMode, LossCounter } from '../../document/transform/protocol';
import { exportHtmlDocument } from '../html-document';
import { MAX_PDF_PAGE_PX } from '../weasyprint';
import { HORIZONTAL_ALIGN, isNumericRotation, sheetsResolver, VERTICAL_ALIGN } from './cell-style';
import type { FloatingObject, SheetBudget, WindowedSheet } from './window';
import { windowedSheet } from './window';

// Image sources by media name: data: URIs for an export, the prepared preview URLs for a preview.
type MediaUrls = Map<string, string>;

// The pixels each raster decodes to, by media name, read from its header when the export loads its media.
export type MediaPixels = Map<string, number>;

type ContentSize = { width: number; height: number };

// The export interns every cell's style into a class declared in one <style> element. A workbook repeats a few hundred
// styles over hundreds of thousands of cells, and the sanitizer CSS-parses every style attribute but passes class
// names and style text as plain strings. A key is the exact declarations the inline path would write. The preview
// keeps inline styles, because its body embeds without a <head>.
type StyleRegistry = Map<string, string>;

export const PREVIEW_SHEET_BUDGET: SheetBudget = { maxRows: 200, maxCols: 50, maxCells: 10_000 };

// The cells the preview's images and charts spend, apart from the window's, so a window that spends all of its own
// still draws its first charts. As many as the window holds draws four charts of 2,000 points, about 1 MB of SVG. A
// full window of plain cells and its charts then stay under the preview's 8 MB byte guard.
export const PREVIEW_FLOATING_CELLS = 10_000;

// The most cells, rows times columns, an export walks of all its sheets together. A peer can write a merge or a border
// key at XFD1048576 on as many sheets as it likes, and the sanitizer and WeasyPrint pay for every cell the walk writes.
// A row whose every column is hidden still costs one, and a sheet whose every row is hidden costs its columns once.
export const MAX_EXPORT_CELLS = 250_000;

// The cells each page a PDF prints costs, since WeasyPrint pays for pages as well as cells: the cap then holds 2,000
// pages. One-cell sheets, a page each, printed in 6.4 s for 1,000, 18.8 s for 2,000 and 47.9 s for 3,000, and 4,000
// reached WeasyPrint's 60 s timeout. A sheet of 4,000 rows each a page tall reached it too.
const PDF_PAGE_CELLS = 125;

// What a chart costs the cap besides its points: its axes, title and legend cost the render about what 500 cells do.
// 1,000 one-point charts drew in 0.65 s, where 250,000 cells draw in 0.33 s. A chart draws at most MAX_CHART_POINTS.
const CHART_CELLS = 500;

// The bytes of HTML a cell with a value writes: a grid of numbers or of short text writes about 50 a cell. An image's
// tag writes its whole source, a data: URI in an export, so it costs its tag and source at this rate. So the cap holds
// about 12 MB of pictures in place of cells, however many images repeat one large picture.
const CELL_BYTES = 50;

// The bytes an image writes around its source: its tag, and its own style rule for where it sits. Tiny pictures
// cost little by their sources alone, but each still writes these bytes.
const IMAGE_TAG_BYTES = 200;

// The decoded pixels that cost a cell. An export's rasters reach WeasyPrint as their screen previews, WebPs of at most
// 2560 px a side, and it decodes each whole and writes its pixels into the PDF, so many distinct pictures cost it far
// more than their bytes say. Distinct 2560 by 1440 previews of real photos took it 0.58 s of CPU each, 60 in 35 s, and
// flat colour 0.06 s. At 800 pixels a cell such a photo costs 4,608 cells beside the 3,075 of its 115 KB, so the cap
// holds 32, which take about the 19 s its 2,000 pages take. WeasyPrint decodes a picture once however many tags show
// it, so its pixels are charged once.
const PIXELS_PER_CELL = 800;

// The default columns one PDF page holds. A cut sheet keeps at least that many, so its first page is never narrow.
const PAGE_COLUMNS = Math.floor(MAX_PDF_PAGE_PX / SHEET_DEFAULT_COL_WIDTH);

// Every td's defaults: inline in the preview, whose embedders strip the <head>, and the shared td{} rule in the export.
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

// A line of text in Inter is about 1.2 times its font size. With its padding and gridline, such a line that fits its
// rows with a pixel to spare grows them by two pixels at most, as a thick border does. A character Inter lacks takes a
// fallback font's line, which can be taller. Noto Sans CJK's is 1.45 times, so a plain 10 to 11.5 pt line grows a
// default row by 2 to 5 pixels, and a sheet of such rows prints up to a quarter more pages than printedPages charged.
// That stays bounded, because a larger font is clipped.
const LINE_HEIGHT = 1.2;

// Where a cell's text sits in its rows, as the canvas places the text's ink: in the middle, or 2 px from the top or
// the bottom. CSS places a line by its font's ascent and descent instead. In Inter those put the ink 0.1em below the
// middle of the line and 0.17em below its top, so the margins lift it back.
const TEXT_PLACEMENT: Record<(typeof VERTICAL_ALIGN)[number], string> = {
    top: 'top:2px;margin-top:-0.17em',
    middle: 'top:50%;transform:translateY(-50%);margin-top:-0.1em',
    bottom: 'bottom:2px',
};

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

// The height a page prints a sheet on once a sheet is as tall as the largest page. A shorter sheet fits one page.
const PAGE_CONTENT_HEIGHT = MAX_PDF_PAGE_PX - 2 * PAGE_MARGIN;

// The workbook as one document. The screen's prints landscape. The PDF's page fits its widest and tallest sheet as
// rendered, so WeasyPrint never clips a wide grid. A sheet cut to MAX_EXPORT_CELLS, or a sheet or chart left out for
// it, is counted, and so is an image or chart left out. Only the PDF charges a sheet its pages.
export function sheetsHtmlDocument({
    title,
    sheets,
    mediaUrls,
    mediaPixels,
    mode,
    lost,
}: {
    title: string;
    sheets: Sheet[];
    mediaUrls: MediaUrls;
    mediaPixels: MediaPixels;
    mode: HtmlExportMode;
    lost: LossCounter['lost'];
}): string {
    const { html, css, cut, leftOut, floatingLeftOut, size } = renderSheetsHtml(sheets, mediaUrls, mode, mediaPixels);
    for (const sheet of cut) lost('sheets-cut', sheet);
    for (const sheet of leftOut) lost('sheets-left-out', sheet);
    for (const { kind, object } of floatingLeftOut)
        lost(kind === 'chart' ? 'charts-dropped' : 'images-dropped', object);
    const page = mode === 'pdf' ? pdfPageCss(size) : '@page { size: landscape; margin: 1.5cm; }';
    return exportHtmlDocument({
        title,
        css: `${SHEET_CSS_BASE}${page}${SHEET_CSS_PRINT}`,
        body: `<style>${css}</style>\n${html}`,
    });
}

// A preview is a glance, so it renders only the first shown sheet, cut to the budget. It clips the overlay to the
// budget's box, since an image parked outside it would stretch the body and shrink the thumbnail scaled from it. The
// images and charts inside the box spend PREVIEW_FLOATING_CELLS, so a crowded preview draws the ones that fit instead
// of a body the byte guard throws away. `truncated` is true when rows, columns, cells, images, charts or other sheets
// were left out, and the caller then adds the shared marker. The resolver spans every sheet, so a rule's formula can
// read another sheet.
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
    // The browser draws the preview, so its pictures cost no decoded pixels: WeasyPrint never sees them.
    const floating = chargeFloating(inClip, mediaUrls, PREVIEW_FLOATING_CELLS, new Map());
    const first = renderSheet({ ...windowed, floating: floating.kept }, new FormulaEngine(), sheetsResolver(sheets), {
        clip,
        mediaUrls,
    });
    const leftOut = floating.leftOut.length > 0 || inClip.length < windowed.floating.length;
    const truncated = windowed.truncated || leftOut || shown.length > 1;
    return { html: `<div class="sheet">\n${first.html}\n</div>`, truncated };
}

// One engine and one resolver serve every sheet, so a rule's formula such as `=Sheet2!A1>10` reads the other sheet.
// The resolver reads the stored values: only a rule's own formula is evaluated. The sheets spend one MAX_EXPORT_CELLS
// in tab order, so a sheet gets the cells the ones before it left, and in a PDF one that draws costs at least a page.
// A sheet's images and charts spend what its cells left, and a picture's pixels are charged on the first tag drawn.
// `cut` holds the sheets cut to the cap, `leftOut` the sheets it left no row or page of, `floatingLeftOut` the images
// and charts it left no room for, and `size` is the widest and tallest sheet as rendered.
export function renderSheetsHtml(
    sheets: Sheet[],
    mediaUrls: MediaUrls,
    mode: HtmlExportMode,
    mediaPixels: MediaPixels,
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
    const unpaidPixels = new Map(mediaPixels);
    let cellsLeft = MAX_EXPORT_CELLS;
    for (const sheet of shownSheets(sheets)) {
        const budget = (rows: number, cols: number) => exportWindow(mode, cellsLeft, rows, cols);
        let windowed = windowedSheet(sheet, budget);
        // A sheet with shown cells, images or charts prints a page of its own. A blank one takes no page, and nor does
        // one whose every row or every column is hidden.
        const draws =
            windowed !== null &&
            ((windowed.rows.length > 0 && windowed.cols.length > 0) || windowed.floating.length > 0);
        let pages = 0;
        if (windowed && draws && mode === 'pdf') {
            const printed = printedPages(windowed, Math.floor(cellsLeft / PDF_PAGE_CELLS));
            pages = printed.pages;
            if (printed.rows < windowed.rows.length) {
                const kept = printed.rows;
                windowed =
                    kept > 0 ? windowedSheet(sheet, (rows, cols) => ({ ...budget(rows, cols), maxRows: kept })) : null;
            }
        }
        if (!windowed) {
            leftOut.push(sheet);
            continue;
        }
        const cells = Math.max(windowed.cells, pages * PDF_PAGE_CELLS);
        if (cells > cellsLeft) {
            leftOut.push(sheet);
            continue;
        }
        cellsLeft -= cells;
        if (windowed.truncated) cut.push(sheet);
        if (!draws) continue;
        const floating = chargeFloating(windowed.floating, mediaUrls, cellsLeft, unpaidPixels);
        cellsLeft -= floating.cells;
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

// The pages the PDF prints a sheet on, and how many of its rows the first `most` pages hold. Each row prints about its
// stored height, since content that could grow it is clipped (canPassRows), and a plain line or a border thicker than
// a pixel adds a few pixels at most (LINE_HEIGHT). A row that doesn't fit what is left of a page starts the next one, as WeasyPrint
// breaks a table between rows, so rows taller than half a page print a page each. The overlay's box stretches the
// sheet to its farthest image or chart. A sheet whose overlay alone takes more than `most` pages has no row to keep.
function printedPages({ sheet, rows, offset, floating }: WindowedSheet, most: number): { pages: number; rows: number } {
    const overlay = Math.ceil(floatingExtent(floating, offset).height / PAGE_CONTENT_HEIGHT);
    if (overlay > most) return { pages: overlay, rows: 0 };
    let pages = 1;
    let filled = 0;
    for (const [i, r] of rows.entries()) {
        const height = sheetRowsHeight(sheet, r, r);
        if (filled > 0 && filled + height > PAGE_CONTENT_HEIGHT) {
            if (pages === most) return { pages, rows: i };
            pages++;
            filled = 0;
        }
        filled += height;
    }
    return { pages: Math.max(pages, overlay), rows: rows.length };
}

// The images and charts that fit `cellsLeft`, in paint order, and the ones left out. A chart costs CHART_CELLS and
// the points it draws. An image costs the bytes of its tag and source at CELL_BYTES a cell, since every tag repeats
// the whole source. The first image drawn of a picture also costs the pixels `unpaidPixels` holds for it, which are
// then paid. One whose media resolves to nothing draws nothing and costs nothing.
function chargeFloating(
    floating: FloatingObject[],
    mediaUrls: MediaUrls,
    cellsLeft: number,
    unpaidPixels: MediaPixels,
): { kept: FloatingObject[]; cells: number; leftOut: SheetFloatingItem[] } {
    const kept: FloatingObject[] = [];
    const leftOut: SheetFloatingItem[] = [];
    let cells = 0;
    for (const object of floating) {
        const { item } = object;
        const src = item.kind === 'image' ? mediaUrls.get(item.object.mediaName) : undefined;
        let cost = 0;
        if (item.kind === 'chart') cost = CHART_CELLS + sheetChartPoints(item.object);
        else if (src !== undefined) {
            const pixels = unpaidPixels.get(item.object.mediaName) ?? 0;
            cost = Math.ceil((IMAGE_TAG_BYTES + src.length) / CELL_BYTES) + Math.ceil(pixels / PIXELS_PER_CELL);
        }
        if (cells + cost > cellsLeft) {
            leftOut.push(item);
            continue;
        }
        cells += cost;
        kept.push(object);
        if (item.kind === 'image') unpaidPixels.delete(item.object.mediaName);
    }
    return { kept, cells, leftOut };
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

// The sheet's table and overlay, for the caller to wrap in its .sheet div. With `styles` this is the export, with
// interned classes. Without it this is the preview, inline-styled, whose `clip` box also clips the overlay. `size` is
// the table and its overlay as rendered: the overlay draws at the stored grid coordinate, so an image or chart parked
// past the used range is still on the page.
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

    // Each merge is one td on the first rendered cell it covers, spanning the rendered rows and columns it covers, so
    // a hidden row or column inside it adds no span and the table matches its colgroup.
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
    // A merge's outer borders sit on its first rendered cell, the only one drawn for it. They fold from the stored
    // keys in reading order, as the editor folds them, so a side stored on a hidden edge row or column still draws.
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
                  evaluateFormula: createCfFormulaEvaluator(engine, resolver, sheet.id ?? sheet.name),
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

    const q = fontQuote(forStylesheet);
    const tableStyle = `border-collapse:collapse;table-layout:fixed;font-family:${FONT_STACK_SANS.replaceAll('"', q)};font-size:${SHEET_DEFAULT_FONT_SIZE}pt;color:#1a1a2e;background:#fff;width:${tableWidth}px`;
    const table = `<table ${styleAttr(styles, tableStyle)}>${colgroup}<tbody>${rowTags.join('')}</tbody></table>`;
    const html = withFloatingOverlay(table, tableWidth, offset, clip, overlay);
    return { html, size: { width: Math.max(tableWidth, extent.width), height: Math.max(tableHeight, extent.height) } };
}

// Whether a cell's content can grow its rows past their stored height: wrapped or stacked text, or a line taller than
// the rows. A table row grows to fit its content, but the editor clips a cell's text to its rows. So such content is
// clipped (clipToRows), and every row prints about its stored height. A turned span is placed absolutely and grows no
// row, and a clip would cut it off. Most cells hold one short line and stay plain, since a clip doubles what a cell
// costs WeasyPrint.
function canPassRows(v: Cell | null, height: number): boolean {
    if (!v || isNumericRotation(v)) return false;
    return cellWrapsText(v) || v.rt === 'vertical' || ptToPx(cellFontSize(v.fs)) * LINE_HEIGHT + 1 > height;
}

// The content sits in an inline-block as tall as the rows less their gridline, the box the editor clips to. Its
// margins give back the td's padding. WeasyPrint pages through a block's content past its height, but not through an
// inline-block's. The text inside is placed absolutely, so centered text spills past both edges as the editor's does.
// It sits where the canvas puts the ink, and its line pitch is the editor's, which spaces wrapped lines at 1.5 times
// their ascent. The td of a clipped cell sets its line-height to 0, so a large font adds no line around the block. A
// text decoration doesn't reach into an inline-block or an absolute box, so both take the td's own.
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

// The export's window keeps the columns from the left up to one PDF page wide. The HTML download keeps more of them
// while every row still fits, a sheet whose every row is hidden as one row, where the PDF's page would cut them off.
// Then it keeps the rows that fit the cells left.
function exportWindow(mode: HtmlExportMode, cellsLeft: number, rows: number, cols: number): SheetBudget {
    const pageCols = Math.min(cols, PAGE_COLUMNS);
    const maxCols =
        mode === 'pdf' ? pageCols : Math.min(cols, Math.max(pageCols, Math.floor(cellsLeft / Math.max(1, rows))));
    return { maxRows: Math.min(rows, Math.floor(cellsLeft / Math.max(1, maxCols))), maxCols, maxCells: cellsLeft };
}

// The table inside a box that reaches the farthest image or chart, so what follows in the flow, the next sheet or the
// preview's marker, starts below them. The preview's box stops at its clip. A sheet with no images or charts writes
// the bare table.
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
        // In stylesheet text entities stay literal, so escapeHtml there would draw "Bell MT & Co" as "Bell MT &amp;
        // Co". The quotes are all that could end the quoted name early, and the stylesheet seam strips the rest.
        if (family) {
            const name = forStylesheet ? family.replace(/["'\\]/g, '') : escapeHtml(family);
            const q = fontQuote(forStylesheet);
            parts.push(`font-family:${q}${name}${q},sans-serif`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (v.fs !== undefined) parts.push(`font-size:${cellFontSize(v.fs)}pt`);
        // A rule's colors win over the cell's own, as on the canvas.
        const textColor = cssColor(cfStyle?.textColor || v.fc);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle?.cellColor || v.bg);
        if (cellColor) parts.push(`background:${cellColor}`);
        // A rotated cell's span is placed absolutely (wrapForRotation), so no alignment acts on it. Any other cell
        // writes its own text-align, else Excel's General one as the canvas draws it, where left, the td's own, writes
        // none. A clipped cell's text places itself in its rows, and a plain one writes its vertical-align unless it is
        // middle, the table body's own.
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
            `position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;text-decoration:inherit;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)`;
        return `<span ${styleAttr(styles, decl)}>${inner}</span>`;
    }
    return inner;
}

// The data bar as the canvas paints it: a negative value fills the half left of the zero line, a positive one the half
// right of it. The canvas paints a negative bar red whatever the rule's color, so the export does too. The text's span
// hands the td's text decoration on to the clipped block inside it.
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

// Images and charts at their stored boxes, rotated about their centers, in the order the editor stacks them. An image
// whose name resolves to nothing renders nothing: a `pending:` name from an upload that never settled, or a media
// file deleted under the reference. A chart draws as the painter's inline SVG on white like the editor's chart box,
// so the gridlines stop at it, its ranges read from the materialized sheets.
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
