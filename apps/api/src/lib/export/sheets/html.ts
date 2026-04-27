import {
    type CellFormatStyle,
    type ComputeMap,
    type DataBar,
    evaluateConditionalFormat,
} from '@workspace/fortune-sheet/engine';
import { escapeHtml } from '@workspace/lib/html';
import type { Cell, CellBorderInfo, CellWithRowAndCol, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { getFontCSS } from '../fonts';
import { loadSheetsContent } from './content';
import { resolveFontFamily } from './fonts';

const DEFAULT_COL_WIDTH = 73;
const DEFAULT_ROW_HEIGHT = 19;
// Inline defaults applied to every td so the markup renders without the document <head>
// CSS (preview embedders strip it). Vertical-align is intentionally absent — buildCellStyle
// always emits one (`middle`, `top`, `bottom`, …) so we never end up with two competing
// declarations in a single style attribute.
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

const HORIZONTAL_ALIGN: Record<number, string> = {
    0: 'center',
    1: 'left',
    2: 'right',
};

const VERTICAL_ALIGN: Record<number, string> = {
    0: 'middle',
    1: 'top',
    2: 'bottom',
};

const BORDER_STYLE_CSS: Record<number, string> = {
    1: '1px solid',
    2: '1px dotted',
    3: '1px dotted',
    4: '1px dashed',
    5: '1px dashed',
    6: '1px dashed',
    7: '3px double',
    8: '2px solid',
    9: '2px dashed',
    10: '2px dashed',
    11: '2px dashed',
    12: '2px dashed',
    13: '3px solid',
};

export async function exportSheetsToHtml(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSheetsExportHtml(mount, drivePath);
    const title = drivePath.name.replace(/\.eigensheets$/, '');
    return {
        data: Buffer.from(html, 'utf-8'),
        contentType: 'text/html; charset=utf-8',
        fileName: `${title}.html`,
    };
}

export async function generateSheetsExportHtml(mount: Mount, drivePath: DrivePath): Promise<string> {
    const title = drivePath.name.replace(/\.eigensheets$/, '');
    const sheets = await loadSheetsContent(mount, drivePath);
    const bodyHtml = renderSheetsHtml(sheets);
    const sanitized = DOMPurify.sanitize(bodyHtml, { FORCE_BODY: true });
    return wrapInDocument(title, sanitized);
}

export function renderSheetsHtml(sheets: Sheet[]): string {
    return sheets.map((sheet, i) => renderSheet(sheet, i === sheets.length - 1)).join('\n');
}

export function getSheetContentSize(sheet: Sheet): { width: number; height: number } {
    const config = sheet.config ?? {};
    const borderMap = buildBorderMap(config.borderInfo);
    const { minRow, minCol, maxRow, maxCol } = getGridBounds(sheet, borderMap);
    if (maxRow < 0 || maxCol < 0) return { width: 0, height: 0 };

    let width = 0;
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c]) continue;
        width += config.columnlen?.[c] ?? DEFAULT_COL_WIDTH;
    }

    let height = 0;
    for (let r = minRow; r <= maxRow; r++) {
        if (config.rowhidden?.[r]) continue;
        height += config.rowlen?.[r] ?? DEFAULT_ROW_HEIGHT;
    }

    return { width, height };
}

function renderSheet(sheet: Sheet, isLast: boolean): string {
    const config = sheet.config ?? {};
    const showGrid = sheet.showGridLines !== false && sheet.showGridLines !== 0;

    // Build a border lookup from borderInfo: "r,c" -> { l?, r?, t?, b? }
    const borderMap = buildBorderMap(config.borderInfo);

    // Conditional formatting — engine produces a "r_c" -> { textColor, cellColor, dataBar } map.
    // Evaluation needs the dense `data` matrix; loaded snapshots without it skip CF (the canvas
    // painter does the same fallback).
    const cfMap: ComputeMap | null =
        sheet.luckysheet_conditionformat_save && sheet.data
            ? evaluateConditionalFormat(sheet.luckysheet_conditionformat_save, sheet.data)
            : null;

    // Find the minimal bounding box containing all visible content
    const { minRow, minCol, maxRow, maxCol } = getGridBounds(sheet, borderMap);
    if (maxRow < 0 || maxCol < 0) {
        return `<div class="sheet"></div>`;
    }

    // Build merge lookup: "r,c" -> { rs, cs } for anchor cells
    const mergeAnchors = new Map<string, { rs: number; cs: number }>();
    const mergedCells = new Set<string>();
    if (config.merge) {
        for (const m of Object.values(config.merge)) {
            mergeAnchors.set(`${m.r},${m.c}`, { rs: m.rs, cs: m.cs });
            for (let dr = 0; dr < m.rs; dr++) {
                for (let dc = 0; dc < m.cs; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    mergedCells.add(`${m.r + dr},${m.c + dc}`);
                }
            }
        }
    }

    // Build cell lookup: "r,c" -> CellWithRowAndCol
    const cellMap = new Map<string, CellWithRowAndCol>();
    if (sheet.celldata) {
        for (const cd of sheet.celldata) {
            cellMap.set(`${cd.r},${cd.c}`, cd);
        }
    }

    // Colgroup
    const cols: string[] = [];
    let tableWidth = 0;
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c]) continue;
        const w = config.columnlen?.[c] ?? DEFAULT_COL_WIDTH;
        tableWidth += w;
        cols.push(`<col style="width:${w}px">`);
    }
    const colgroup = `<colgroup>${cols.join('')}</colgroup>`;

    // Rows
    const rows: string[] = [];
    for (let r = minRow; r <= maxRow; r++) {
        if (config.rowhidden?.[r]) continue;
        const h = config.rowlen?.[r] ?? DEFAULT_ROW_HEIGHT;
        const cells: string[] = [];

        for (let c = minCol; c <= maxCol; c++) {
            if (config.colhidden?.[c]) continue;
            const key = `${r},${c}`;

            // Skip non-anchor merged cells
            if (mergedCells.has(key)) continue;

            const cd = cellMap.get(key);
            const v = cd?.v ?? null;
            const merge = mergeAnchors.get(key);
            const cfStyle = cfMap ? cfMap[`${r}_${c}`] : undefined;

            const attrs: string[] = [];
            if (merge) {
                if (merge.cs > 1) attrs.push(`colspan="${merge.cs}"`);
                if (merge.rs > 1) attrs.push(`rowspan="${merge.rs}"`);
            }

            const cellStyle = buildCellStyle(v, borderMap.get(key), showGrid, cfStyle);
            const style = cellStyle ? `${BASE_TD_STYLE};${cellStyle}` : BASE_TD_STYLE;
            attrs.push(`style="${style}"`);

            const display = getCellDisplay(v);
            const dataBarLayer = cfStyle?.dataBar ? renderDataBar(cfStyle.dataBar, display) : null;
            const inner = wrapForRotation(v, dataBarLayer ?? display);
            const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            cells.push(`<td${attrStr}>${inner}</td>`);
        }

        rows.push(`<tr style="height:${h}px">${cells.join('')}</tr>`);
    }

    const pageBreak = isLast ? '' : ' style="page-break-after:always"';
    return `<div class="sheet"${pageBreak}>
<table style="border-collapse:collapse;table-layout:fixed;font-family:&quot;Inter&quot;,system-ui,sans-serif;font-size:11px;color:#1a1a2e;background:#fff;width:${tableWidth}px">${colgroup}<tbody>${rows.join('')}</tbody></table>
</div>`;
}

function getCellDisplay(v: Cell | null): string {
    if (!v) return '';
    if (v.m != null) return escapeHtml(String(v.m));
    if (v.v == null) return '';
    if (typeof v.v === 'boolean') return v.v ? 'TRUE' : 'FALSE';
    return escapeHtml(String(v.v));
}

// Mirrors the dataBar geometry + colors from the canvas painter
// (packages/fortune-sheet/src/state/canvas.ts ~line 1660). For a "minus" entry the bar fills
// the negative half (left of the zero line); for "plus" it fills the positive half.
// Colors match canvas exactly: positive bars use `format` (user-configurable), negative
// bars use a hardcoded red — that's a long-standing canvas behavior, intentionally
// inherited here for visual parity. Diverging would mean the export differs from what
// users see on screen.
function renderDataBar(bar: DataBar, display: string): string {
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
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${bar.format[0]}, ${bar.format[1]})` : bar.format[0];
    } else {
        // Mixed range, positive value: bar starts at the zero line (minusLen) and extends right.
        left = bar.minusLen * 100;
        width = bar.plusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${bar.format[0]}, ${bar.format[1]})` : bar.format[0];
    }

    const barStyle = `position:absolute;top:0;left:${left}%;width:${width}%;height:100%;background:${fill};z-index:0`;
    return `<div style="${barStyle}"></div><span style="position:relative;z-index:1">${display}</span>`;
}

function buildCellStyle(
    v: Cell | null,
    borders: { l?: string; r?: string; t?: string; b?: string } | undefined,
    showGrid: boolean,
    cfStyle: CellFormatStyle | undefined,
): string {
    const parts: string[] = [];

    const rotated = isNumericRotation(v);

    if (v) {
        const family = resolveFontFamily(v.ff);
        // The style attribute is wrapped in double quotes by the caller, so the
        // font-family quotes must be HTML-encoded (`&quot;`) — using literal `"`
        // here closes the attribute early and silently drops every later declaration
        // (color, background, etc.). Family name is escaped to defang stray quotes.
        if (family) parts.push(`font-family:&quot;${escapeHtml(family)}&quot;,sans-serif`);
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (typeof v.fs === 'number') parts.push(`font-size:${v.fs}pt`);
        // CF colors override the static `fc`/`bg` fields, matching the canvas painter.
        if (cfStyle?.textColor) {
            parts.push(`color:${cfStyle.textColor}`);
        } else if (v.fc) {
            parts.push(`color:${v.fc}`);
        }
        if (cfStyle?.cellColor) {
            parts.push(`background:${cfStyle.cellColor}`);
        } else if (v.bg) {
            parts.push(`background:${v.bg}`);
        }
        // Rotated cells skip ht/vt — the rotated span is absolutely-positioned in the
        // cell (see wrapForRotation) so neither alignment property has anything to act
        // on. Non-rotated cells emit text-align if the user picked one, plus a single
        // vertical-align (default `middle`, matching the canvas painter).
        if (!rotated) {
            if (v.ht != null && v.ht in HORIZONTAL_ALIGN) parts.push(`text-align:${HORIZONTAL_ALIGN[v.ht]}`);
            const valign = v.vt != null && v.vt in VERTICAL_ALIGN ? VERTICAL_ALIGN[v.vt] : 'middle';
            parts.push(`vertical-align:${valign}`);
        }
        if (v.tb === '2') parts.push('white-space:pre-wrap;word-wrap:break-word');
        if (v.un === 1 && v.cl === 1) {
            parts.push('text-decoration:underline line-through');
        } else if (v.un === 1) {
            parts.push('text-decoration:underline');
        } else if (v.cl === 1) {
            parts.push('text-decoration:line-through');
        }
    } else if (cfStyle) {
        // CF can land on a cell with no `v` (engine still emits an entry for empty cells in some
        // rules); render its color overrides without dragging in the v-block defaults.
        if (cfStyle.textColor) parts.push(`color:${cfStyle.textColor}`);
        if (cfStyle.cellColor) parts.push(`background:${cfStyle.cellColor}`);
    }

    if (borders) {
        if (borders.l) parts.push(`border-left:${borders.l}`);
        if (borders.r) parts.push(`border-right:${borders.r}`);
        if (borders.t) parts.push(`border-top:${borders.t}`);
        if (borders.b) parts.push(`border-bottom:${borders.b}`);
    } else if (showGrid) {
        parts.push('border:1px solid #d4d4d4');
    }

    // `position:relative` is the cell's contribution to two unrelated overlay patterns:
    // the absolutely-positioned data-bar div from renderDataBar() and the rotated span
    // from wrapForRotation(). One declaration covers both.
    if (rotated || cfStyle?.dataBar) {
        parts.push('position:relative');
    }

    return parts.join(';');
}

function isNumericRotation(v: Cell | null): v is Cell & { rt: number } {
    return !!v && typeof v.rt === 'number' && v.rt !== 0 && v.rt >= -90 && v.rt <= 90;
}

// Render the cell's content with rotation applied. The td has `position:relative` (set in
// buildCellStyle), so the span anchors itself absolutely at the cell corner the rotation
// pivots around — no inline-flow / vertical-align gymnastics, no zero-height wrapper.
//
// Geometry mirrors the canvas painter (text.ts ~line 1692). Three pieces:
//
//   1. Anchor: positive rt (CCW / "up") pins to left+bottom; negative rt (CW / "down")
//      pins to left+top. transform-origin matches the same corner so the pivot stays
//      exactly on the cell edge.
//
//   2. Rotation: CSS `rotate()` is CW-positive while our `rt` is CCW-positive (matching
//      Excel/OOXML), so the emitted angle is negated.
//
//   3. Counter-translation: rotating around a corner makes the character tops (positive
//      rt) or character bottoms (negative rt) swing past the cell's left edge — at
//      rt = ±90 the whole rotated bbox sits OUTSIDE the cell and `overflow:hidden`
//      eats it. Canvas adds a `textHeight * sin(rt)` rightward offset to the pivot for
//      the same reason; in CSS we get the same effect with `translateX(|sin(rt)| em)`
//      applied AFTER rotation (the transform reads right-to-left). 1em ≈ font-size ≈
//      canvas's textHeight, so the offset scales naturally with the cell's font.
//
// `rt: 'vertical'` uses CSS writing-mode for stacked top-to-bottom characters; the span
// flows naturally without absolute positioning since writing-mode handles the layout.
function wrapForRotation(v: Cell | null, inner: string): string {
    if (!v || v.rt == null) return inner;
    if (v.rt === 'vertical') {
        return `<span style="writing-mode:vertical-rl;text-orientation:upright">${inner}</span>`;
    }
    if (isNumericRotation(v)) {
        const { rt } = v;
        const cssAngle = -rt;
        const yPin = rt > 0 ? 'bottom:0' : 'top:0';
        const origin = rt > 0 ? 'left bottom' : 'left top';
        const overhangEm = Math.abs(Math.sin((rt * Math.PI) / 180)).toFixed(3);
        return (
            `<span style="position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)">${inner}</span>`
        );
    }
    return inner;
}

function buildBorderMap(
    borderInfo?: CellBorderInfo[],
): Map<string, { l?: string; r?: string; t?: string; b?: string }> {
    const map = new Map<string, { l?: string; r?: string; t?: string; b?: string }>();
    if (!borderInfo) return map;

    for (const border of borderInfo) {
        if (border.rangeType !== 'cell') continue;
        const { row_index, col_index, l, r, t, b } = border.value;
        const key = `${row_index},${col_index}`;
        const entry: { l?: string; r?: string; t?: string; b?: string } = {};
        if (l) entry.l = borderSideToCSS(l);
        if (r) entry.r = borderSideToCSS(r);
        if (t) entry.t = borderSideToCSS(t);
        if (b) entry.b = borderSideToCSS(b);
        map.set(key, entry);
    }

    return map;
}

function borderSideToCSS(side: { style: number; color: string }): string {
    const css = BORDER_STYLE_CSS[side.style] ?? '1px solid';
    return `${css} ${side.color}`;
}

function hasVisibleContent(v: Cell | null): boolean {
    if (!v) return false;
    if (v.v != null || v.m != null) return true;
    if (v.bg || v.fc) return true;
    if (v.bl === 1 || v.it === 1 || v.un === 1 || v.cl === 1) return true;
    if (v.mc && 'rs' in v.mc) return true; // merge anchor
    return false;
}

function getGridBounds(
    sheet: Sheet,
    borderMap: Map<string, { l?: string; r?: string; t?: string; b?: string }>,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
    let minRow = Number.MAX_SAFE_INTEGER;
    let minCol = Number.MAX_SAFE_INTEGER;
    let maxRow = -1;
    let maxCol = -1;

    if (sheet.celldata) {
        for (const { r, c, v } of sheet.celldata) {
            if (!hasVisibleContent(v) && !borderMap.has(`${r},${c}`)) continue;
            if (r < minRow) minRow = r;
            if (c < minCol) minCol = c;
            if (r > maxRow) maxRow = r;
            if (c > maxCol) maxCol = c;
        }
    }

    // Extend bounds to cover border cells
    for (const key of borderMap.keys()) {
        const [r, c] = key.split(',').map(Number);
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
    }

    // Extend bounds to cover merge ranges
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

    if (maxRow < 0) return { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 };
    return { minRow, minCol, maxRow, maxCol };
}

export function wrapInDocument(title: string, bodyHtml: string, pageSize?: { width: number; height: number }): string {
    const pageCSS = pageSize
        ? `@page { size: ${pageSize.width}px ${pageSize.height}px; margin: 40px; }`
        : '@page { size: landscape; margin: 1.5cm; }';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${SHEET_CSS_BASE}${pageCSS}${SHEET_CSS_PRINT}</style>
</head>
<body>
    ${bodyHtml}
</body>
</html>`;
}

const SHEET_CSS_BASE = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
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
