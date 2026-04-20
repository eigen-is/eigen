import type { Cell, CellBorderInfo, CellWithRowAndCol, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { getFontCSS } from '../fonts';
import { escapeHtml } from '../media';
import { loadSheetsContent } from './content';

const DEFAULT_COL_WIDTH = 73;
const DEFAULT_ROW_HEIGHT = 19;
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px;vertical-align:middle';

// Matches fortune-sheet locale fontarray — index maps to font family name.
const FONT_ARRAY = ['Inter', 'Source Serif 4', 'JetBrains Mono', 'Excalifont'];

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

function renderSheet(sheet: Sheet, isLast: boolean): string {
    const config = sheet.config ?? {};
    const showGrid = sheet.showGridLines !== false && sheet.showGridLines !== 0;

    // Build a border lookup from borderInfo: "r,c" -> { l?, r?, t?, b? }
    const borderMap = buildBorderMap(config.borderInfo);

    // Find the minimal bounding box containing all visible content
    const { minRow, minCol, maxRow, maxCol } = getGridBounds(sheet, borderMap);
    if (maxRow < 0 || maxCol < 0) {
        return `<div class="sheet"><h2>${escapeHtml(sheet.name)}</h2></div>`;
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
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c]) continue;
        const w = config.columnlen?.[c] ?? DEFAULT_COL_WIDTH;
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

            const attrs: string[] = [];
            if (merge) {
                if (merge.cs > 1) attrs.push(`colspan="${merge.cs}"`);
                if (merge.rs > 1) attrs.push(`rowspan="${merge.rs}"`);
            }

            const cellStyle = buildCellStyle(v, borderMap.get(key), showGrid);
            const style = cellStyle ? `${BASE_TD_STYLE};${cellStyle}` : BASE_TD_STYLE;
            attrs.push(`style="${style}"`);

            const display = getCellDisplay(v);
            const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            cells.push(`<td${attrStr}>${display}</td>`);
        }

        rows.push(`<tr style="height:${h}px">${cells.join('')}</tr>`);
    }

    const pageBreak = isLast ? '' : ' style="page-break-after:always"';
    return `<div class="sheet"${pageBreak}>
<h2>${escapeHtml(sheet.name)}</h2>
<table style="border-collapse:collapse;table-layout:fixed;font-family:&quot;Inter&quot;,system-ui,sans-serif;font-size:11px;color:#1a1a2e;background:#fff;width:max-content">${colgroup}<tbody>${rows.join('')}</tbody></table>
</div>`;
}

function getCellDisplay(v: Cell | null): string {
    if (!v) return '';
    if (v.m != null) return escapeHtml(String(v.m));
    if (v.v == null) return '';
    if (typeof v.v === 'boolean') return v.v ? 'TRUE' : 'FALSE';
    return escapeHtml(String(v.v));
}

function buildCellStyle(
    v: Cell | null,
    borders: { l?: string; r?: string; t?: string; b?: string } | undefined,
    showGrid: boolean,
): string {
    const parts: string[] = [];

    if (v) {
        if (v.ff != null) {
            const family = typeof v.ff === 'number' ? FONT_ARRAY[v.ff] : v.ff;
            if (family) parts.push(`font-family:"${family}",sans-serif`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (typeof v.fs === 'number') parts.push(`font-size:${v.fs}pt`);
        if (v.fc) parts.push(`color:${v.fc}`);
        if (v.bg) parts.push(`background:${v.bg}`);
        if (v.ht != null && v.ht in HORIZONTAL_ALIGN) parts.push(`text-align:${HORIZONTAL_ALIGN[v.ht]}`);
        if (v.vt != null && v.vt in VERTICAL_ALIGN) parts.push(`vertical-align:${VERTICAL_ALIGN[v.vt]}`);
        if (v.tb === '2') parts.push('white-space:pre-wrap;word-wrap:break-word');
        if (v.un === 1 && v.cl === 1) {
            parts.push('text-decoration:underline line-through');
        } else if (v.un === 1) {
            parts.push('text-decoration:underline');
        } else if (v.cl === 1) {
            parts.push('text-decoration:line-through');
        }
    }

    if (borders) {
        if (borders.l) parts.push(`border-left:${borders.l}`);
        if (borders.r) parts.push(`border-right:${borders.r}`);
        if (borders.t) parts.push(`border-top:${borders.t}`);
        if (borders.b) parts.push(`border-bottom:${borders.b}`);
    } else if (showGrid) {
        parts.push('border:1px solid #d4d4d4');
    }

    return parts.join(';');
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

function wrapInDocument(title: string, bodyHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${SHEET_CSS}</style>
</head>
<body>
    ${bodyHtml}
</body>
</html>`;
}

const SHEET_CSS = `
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

.sheet h2 {
    font-size: 13px;
    font-weight: 600;
    color: #333;
    margin-bottom: 0.5rem;
}

td {
    padding: 1px 2px;
    overflow: hidden;
    vertical-align: middle;
    white-space: nowrap;
}

@page {
    size: landscape;
    margin: 1.5cm;
}

@media print {
    body { padding: 0; background: #fff; }
    .sheet { margin-bottom: 0; }
    .sheet h2 { font-size: 11px; }
}
`;
