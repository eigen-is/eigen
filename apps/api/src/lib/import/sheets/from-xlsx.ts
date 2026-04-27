/// <reference path="../modules.d.ts" />
import type { BorderSide, CellBorderInfo, Cell as FortuneCell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import type { Alignment, Border, CellValue, Workbook, Worksheet, Cell as XlsxCell } from 'exceljs';

// Excel's date epoch is 1899-12-30 (not 1900-01-01 — Lotus 1-2-3 1900 leap-year bug).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const HORIZONTAL_MAP: Record<NonNullable<Alignment['horizontal']>, 0 | 1 | 2> = {
    left: 1,
    center: 0,
    right: 2,
    fill: 1,
    justify: 1,
    centerContinuous: 0,
    distributed: 0,
};

const VERTICAL_MAP: Record<NonNullable<Alignment['vertical']>, 0 | 1 | 2> = {
    top: 1,
    middle: 0,
    bottom: 2,
    distributed: 0,
    justify: 0,
};

// XLSX cells routinely carry fonts we don't bundle (Calibri, Arial, Times, Courier, …).
// Only Inter / Source Serif 4 / JetBrains Mono / Excalifont have face data inlined into
// the HTML / PDF export, so unmapped fonts fall back to the browser's generic family —
// inconsistent with the editor. Map common Office defaults into the closest of the four;
// anything unrecognized leaves `ff` unset so the document default (Inter) is used.
const FONT_MAP: Record<string, string> = {
    inter: 'Inter',
    'source serif 4': 'Source Serif 4',
    'source serif pro': 'Source Serif 4',
    'jetbrains mono': 'JetBrains Mono',
    excalifont: 'Excalifont',
    // sans-serif → Inter
    calibri: 'Inter',
    'calibri light': 'Inter',
    arial: 'Inter',
    helvetica: 'Inter',
    'helvetica neue': 'Inter',
    verdana: 'Inter',
    tahoma: 'Inter',
    'segoe ui': 'Inter',
    'trebuchet ms': 'Inter',
    // serif → Source Serif 4
    'times new roman': 'Source Serif 4',
    times: 'Source Serif 4',
    georgia: 'Source Serif 4',
    cambria: 'Source Serif 4',
    garamond: 'Source Serif 4',
    'book antiqua': 'Source Serif 4',
    palatino: 'Source Serif 4',
    'palatino linotype': 'Source Serif 4',
    // monospace → JetBrains Mono
    'courier new': 'JetBrains Mono',
    courier: 'JetBrains Mono',
    consolas: 'JetBrains Mono',
    monaco: 'JetBrains Mono',
    'lucida console': 'JetBrains Mono',
    menlo: 'JetBrains Mono',
    // handwritten → Excalifont
    'comic sans ms': 'Excalifont',
    'comic sans': 'Excalifont',
};

function mapToSupportedFont(name: string): string | null {
    return FONT_MAP[name.trim().toLowerCase()] ?? null;
}

const BORDER_STYLE_MAP: Record<string, number> = {
    thin: 1,
    hair: 2,
    dotted: 3,
    dashed: 4,
    dashDot: 5,
    dashDotDot: 6,
    double: 7,
    medium: 8,
    mediumDashed: 9,
    mediumDashDot: 10,
    mediumDashDotDot: 11,
    slantDashDot: 12,
    thick: 13,
};

type ThemePalette = string[];

export async function xlsxToSheets(buffer: Buffer): Promise<Sheet[]> {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const theme = extractThemePalette(workbook);

    const sheets: Sheet[] = [];
    workbook.worksheets.forEach((worksheet, index) => {
        sheets.push(worksheetToSheet(worksheet, index, theme));
    });
    return sheets;
}

function worksheetToSheet(worksheet: Worksheet, index: number, theme: ThemePalette): Sheet {
    const celldata: { r: number; c: number; v: FortuneCell }[] = [];
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const rowlen: NonNullable<SheetConfig['rowlen']> = {};
    const borderInfo: CellBorderInfo[] = [];

    const { merge, anchorByCell } = buildMergeStructures(worksheet.model.merges ?? []);

    // Compute column widths first (needed for auto-fit height estimation).
    const colWidthPx: Record<number, number> = {};
    (worksheet.columns ?? []).forEach((col, i) => {
        if (col && typeof col.width === 'number' && col.width > 0) {
            const px = Math.round(col.width * 8);
            colWidthPx[i] = px;
            columnlen[String(i)] = px;
        }
    });

    const DEFAULT_ROW_HEIGHT_PT = 15.75;
    const DEFAULT_ROW_HEIGHT_PX = 20;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const r = rowNumber - 1;
        let maxCellHeight = 0;

        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const c = colNumber - 1;
            const converted = convertCell(cell, theme);
            const mergeAnchor = anchorByCell.get(`${r}:${c}`);
            if (mergeAnchor) converted.mc = mergeAnchor;
            if (!mergeAnchor && isEmptyCell(converted)) return;
            celldata.push({ r, c, v: converted });

            const border = convertBorder(cell, r, c, theme);
            if (border) borderInfo.push(border);

            maxCellHeight = Math.max(maxCellHeight, estimateCellHeight(cell, c, r, merge, colWidthPx));
        });

        const isDefaultHeight = row.height === DEFAULT_ROW_HEIGHT_PT;
        if (!isDefaultHeight && typeof row.height === 'number' && row.height > 0) {
            rowlen[String(r)] = Math.round(row.height * (4 / 3));
        } else if (maxCellHeight > DEFAULT_ROW_HEIGHT_PX) {
            rowlen[String(r)] = Math.round(maxCellHeight);
        }
    });

    const config: SheetConfig = {};
    if (Object.keys(merge).length > 0) config.merge = merge;
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
    if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
    if (borderInfo.length > 0) config.borderInfo = borderInfo;

    const sheet: Sheet = {
        name: worksheet.name,
        id: `sheet-${index}`,
        order: index,
        celldata,
        config,
    };

    const view = worksheet.views?.[0];
    if (view && view.showGridLines === false) {
        sheet.showGridLines = false;
    }

    return sheet;
}

function buildMergeStructures(merges: string[]): {
    merge: NonNullable<SheetConfig['merge']>;
    anchorByCell: Map<string, { r: number; c: number; rs?: number; cs?: number }>;
} {
    const merge: NonNullable<SheetConfig['merge']> = {};
    const anchorByCell = new Map<string, { r: number; c: number; rs?: number; cs?: number }>();
    for (const range of merges) {
        const parsed = parseRange(range);
        if (!parsed) continue;
        const { top, left, bottom, right } = parsed;
        const rs = bottom - top + 1;
        const cs = right - left + 1;
        merge[`${top}_${left}`] = { r: top, c: left, rs, cs };
        for (let rr = top; rr <= bottom; rr++) {
            for (let cc = left; cc <= right; cc++) {
                // Anchor carries rs/cs; non-anchors carry only {r,c} pointing back to anchor.
                // Fortune-sheet uses `"rs" in cell.mc` as the anchor discriminator.
                const mc = rr === top && cc === left ? { r: top, c: left, rs, cs } : { r: top, c: left };
                anchorByCell.set(`${rr}:${cc}`, mc);
            }
        }
    }
    return { merge, anchorByCell };
}

function parseRange(range: string): { top: number; left: number; bottom: number; right: number } | null {
    const parts = range.split(':');
    if (parts.length !== 2) return null;
    const tl = parseA1(parts[0]);
    const br = parseA1(parts[1]);
    if (!tl || !br) return null;
    return { top: tl.r, left: tl.c, bottom: br.r, right: br.c };
}

function parseA1(addr: string): { r: number; c: number } | null {
    const match = addr.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    let col = 0;
    for (const ch of match[1]) {
        col = col * 26 + (ch.charCodeAt(0) - 64);
    }
    return { r: Number(match[2]) - 1, c: col - 1 };
}

const DEFAULT_FONT_SIZE = 11;
const DEFAULT_COL_WIDTH_PX = 100;
const PT_TO_PX = 4 / 3;
const LINE_HEIGHT_FACTOR = 1.35;

function estimateCellHeight(
    cell: XlsxCell,
    c: number,
    r: number,
    merge: NonNullable<SheetConfig['merge']>,
    colWidthPx: Record<number, number>,
): number {
    const fontSize = cell.style?.font?.size ?? DEFAULT_FONT_SIZE;
    const lineHeightPx = fontSize * PT_TO_PX * LINE_HEIGHT_FACTOR;
    const wrapText = cell.style?.alignment?.wrapText === true;

    if (!wrapText) {
        return fontSize > DEFAULT_FONT_SIZE ? lineHeightPx + 6 : 0;
    }

    const text = getCellTextContent(cell);
    if (!text) return lineHeightPx + 6;

    let cellWidth = colWidthPx[c] ?? DEFAULT_COL_WIDTH_PX;
    const mergeKey = `${r}_${c}`;
    const mergeInfo = merge[mergeKey];
    if (mergeInfo?.cs && mergeInfo.cs > 1) {
        cellWidth = 0;
        for (let ci = mergeInfo.c; ci < mergeInfo.c + mergeInfo.cs; ci++) {
            cellWidth += colWidthPx[ci] ?? DEFAULT_COL_WIDTH_PX;
        }
    }

    const charsPerLine = Math.max(1, cellWidth / (fontSize * 0.6));
    let totalLines = 0;
    for (const line of text.split('\n')) {
        totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return totalLines * lineHeightPx + 6;
}

function getCellTextContent(cell: XlsxCell): string | null {
    const raw = cell.value;
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (isRichText(raw)) return raw.richText.map((r) => r.text).join('');
    if (isHyperlink(raw)) return raw.text;
    if (isFormulaValue(raw) || isSharedFormula(raw)) {
        const result = raw.result;
        if (typeof result === 'string') return result;
        if (typeof result === 'number') return String(result);
    }
    return null;
}

function convertCell(cell: XlsxCell, theme: ThemePalette): FortuneCell {
    const result: FortuneCell = {};

    const { value, display } = extractValueAndDisplay(cell);
    if (value !== undefined) result.v = value;
    if (display !== undefined) result.m = display;

    if (cell.formula) {
        result.f = `=${cell.formula}`;
    }

    const ct = buildCellType(cell, value);
    if (ct) result.ct = ct;

    applyStyle(cell, result, theme);

    return result;
}

function isEmptyCell(cell: FortuneCell): boolean {
    return cell.v === undefined && cell.f === undefined && cell.bg === undefined && cell.fc === undefined;
}

function extractValueAndDisplay(cell: XlsxCell): { value?: string | number | boolean; display?: string } {
    const raw = cell.value;
    if (raw === null || raw === undefined) return {};

    if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
        return { value: raw, display: String(raw) };
    }

    if (raw instanceof Date) {
        return dateToSerialAndDisplay(raw, cell.numFmt);
    }

    if (isFormulaValue(raw)) {
        return resolveFormulaResult(raw.result, cell.numFmt);
    }

    if (isSharedFormula(raw)) {
        return resolveFormulaResult(raw.result, cell.numFmt);
    }

    if (isRichText(raw)) {
        const text = raw.richText.map((r) => r.text).join('');
        return { value: text, display: text };
    }

    if (isHyperlink(raw)) {
        return { value: raw.text, display: raw.text };
    }

    if (isError(raw)) {
        return { value: raw.error, display: raw.error };
    }

    return {};
}

function resolveFormulaResult(
    result: unknown,
    numFmt?: string,
): { value?: string | number | boolean; display?: string } {
    if (result === null || result === undefined) return {};
    if (typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean') {
        return { value: result, display: String(result) };
    }
    if (result instanceof Date) {
        return dateToSerialAndDisplay(result, numFmt);
    }
    if (isError(result)) {
        return { value: result.error, display: result.error };
    }
    return {};
}

function dateToSerialAndDisplay(date: Date, numFmt?: string): { value: number; display: string } {
    const serial = (date.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
    const display = formatDateForDisplay(date, numFmt);
    return { value: serial, display };
}

function formatDateForDisplay(date: Date, numFmt?: string): string {
    const y = date.getUTCFullYear();
    const M = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const H = date.getUTCHours();
    const m = date.getUTCMinutes();
    const s = date.getUTCSeconds();
    if (!numFmt || numFmt === 'General') return `${M}/${d}/${y}`;
    const h12 = H === 0 ? 12 : H > 12 ? H - 12 : H;
    const ampm = H >= 12 ? 'PM' : 'AM';
    return numFmt
        .replace('yyyy', String(y))
        .replace('yy', String(y).slice(-2))
        .replace(/MM(?!M)/, String(M).padStart(2, '0'))
        .replace(/M(?!M)/, String(M))
        .replace('dd', String(d).padStart(2, '0'))
        .replace(/\bd\b/, String(d))
        .replace('hh', String(numFmt.includes('AM/PM') ? h12 : H).padStart(2, '0'))
        .replace(/\bh\b/, String(numFmt.includes('AM/PM') ? h12 : H))
        .replace('ss', String(s).padStart(2, '0'))
        .replace('mm', String(m).padStart(2, '0'))
        .replace('AM/PM', ampm);
}

function buildCellType(cell: XlsxCell, value: string | number | boolean | undefined): FortuneCell['ct'] {
    const t = resolveType(cell, value);
    const numFmt = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : null;
    if (t == null && numFmt == null) return undefined;
    // Fortune-sheet always pairs `t` with `fa`. When Excel reports General (or no numFmt),
    // persist 'General' so numfmt receives a valid format string; otherwise date serials and
    // percents render as raw numbers.
    const ct: NonNullable<FortuneCell['ct']> = { fa: numFmt ?? 'General' };
    if (t) ct.t = t;
    return ct;
}

function resolveType(cell: XlsxCell, value: string | number | boolean | undefined): string | undefined {
    const raw = cell.value;
    if (raw instanceof Date) return 'd';
    if (isFormulaValue(raw) && raw.result instanceof Date) return 'd';
    if (isSharedFormula(raw) && raw.result instanceof Date) return 'd';
    if (typeof value === 'number') return 'n';
    if (typeof value === 'boolean') return 'b';
    if (typeof value === 'string') return 's';
    return undefined;
}

function applyStyle(cell: XlsxCell, target: FortuneCell, theme: ThemePalette): void {
    const style = cell.style;

    const hasExplicitAlignment = style?.alignment?.horizontal != null;
    if (!hasExplicitAlignment && typeof target.v === 'number') {
        target.ht = 2;
    }

    if (!style) return;

    const font = style.font;
    if (font) {
        if (font.bold) target.bl = 1;
        if (font.italic) target.it = 1;
        if (font.underline) target.un = 1;
        if (font.strike) target.cl = 1;
        if (typeof font.size === 'number') target.fs = font.size;
        if (typeof font.name === 'string' && font.name.length > 0) {
            const mapped = mapToSupportedFont(font.name);
            if (mapped) target.ff = mapped;
        }
        const fc = resolveColor(font.color, theme);
        if (fc) target.fc = fc;
    }

    const fill = style.fill;
    if (fill && fill.type === 'pattern' && fill.pattern !== 'none') {
        const bg = resolveColor(fill.fgColor, theme);
        if (bg) target.bg = bg;
    }

    const alignment = style.alignment;
    if (alignment) {
        applyAlignment(alignment, target);
    }
}

function applyAlignment(alignment: Partial<Alignment>, target: FortuneCell): void {
    if (alignment.horizontal && alignment.horizontal in HORIZONTAL_MAP) {
        target.ht = HORIZONTAL_MAP[alignment.horizontal];
    }
    if (alignment.vertical && alignment.vertical in VERTICAL_MAP) {
        target.vt = VERTICAL_MAP[alignment.vertical];
    }
    if (alignment.wrapText) {
        target.tb = '2';
    }
    if (alignment.textRotation === 'vertical') {
        target.rt = 'vertical';
    } else if (
        typeof alignment.textRotation === 'number' &&
        alignment.textRotation >= -90 &&
        alignment.textRotation <= 90 &&
        alignment.textRotation !== 0
    ) {
        target.rt = alignment.textRotation;
    }
}

function argbToHex(argb: string): string {
    const rgb = argb.length === 8 ? argb.slice(2) : argb;
    return `#${rgb.toUpperCase()}`;
}

function resolveColor(
    color: { argb?: string; theme?: number; tint?: number } | undefined,
    theme: ThemePalette,
): string | null {
    if (!color) return null;
    if (color.argb) {
        const hex = argbToHex(color.argb);
        return color.tint != null ? applyTint(hex, color.tint) : hex;
    }
    if (color.theme != null && color.theme < theme.length) {
        const hex = theme[color.theme];
        return color.tint != null ? applyTint(hex, color.tint) : hex;
    }
    return null;
}

function applyTint(hex: string, tint: number): string {
    const raw = hex.replace('#', '');
    let r = Number.parseInt(raw.substring(0, 2), 16);
    let g = Number.parseInt(raw.substring(2, 4), 16);
    let b = Number.parseInt(raw.substring(4, 6), 16);
    if (tint > 0) {
        r = Math.round(r + (255 - r) * tint);
        g = Math.round(g + (255 - g) * tint);
        b = Math.round(b + (255 - b) * tint);
    } else {
        r = Math.round(r * (1 + tint));
        g = Math.round(g * (1 + tint));
        b = Math.round(b * (1 + tint));
    }
    const toHex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// SpreadsheetML theme indices: 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4-9=accent1-6, 10=hlink, 11=folHlink.
// The clrScheme XML lists them as dk1,lt1,dk2,lt2,accent1-6,hlink,folHlink — reorder to match.
const CLR_SCHEME_ELEMENTS = [
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
] as const;
const THEME_INDEX_ORDER = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11] as const;

function extractThemePalette(workbook: Workbook): ThemePalette {
    const themeXml = (workbook as unknown as { _themes?: Record<string, string> })._themes?.['theme1'];
    if (!themeXml) return [];
    const schemeMatch = themeXml.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
    if (!schemeMatch) return [];
    const scheme = schemeMatch[1];

    const xmlColors: string[] = [];
    for (const el of CLR_SCHEME_ELEMENTS) {
        const block = scheme.match(new RegExp(`<a:${el}>([\\s\\S]*?)</a:${el}>`));
        if (!block) {
            xmlColors.push('#000000');
            continue;
        }
        const srgb = block[1].match(/srgbClr\s+val="([A-Fa-f0-9]{6})"/);
        const sys = block[1].match(/sysClr[^>]*lastClr="([A-Fa-f0-9]{6})"/);
        xmlColors.push(srgb ? `#${srgb[1].toUpperCase()}` : sys ? `#${sys[1].toUpperCase()}` : '#000000');
    }

    const palette: ThemePalette = [];
    for (const xmlIndex of THEME_INDEX_ORDER) {
        palette.push(xmlColors[xmlIndex]);
    }
    return palette;
}

function convertBorder(cell: XlsxCell, r: number, c: number, theme: ThemePalette): CellBorderInfo | null {
    const border = cell.style?.border;
    if (!border) return null;

    const l = convertBorderSide(border.left, theme);
    const r_ = convertBorderSide(border.right, theme);
    const t = convertBorderSide(border.top, theme);
    const b = convertBorderSide(border.bottom, theme);
    if (!l && !r_ && !t && !b) return null;

    const value: CellBorderInfo['value'] = { row_index: r, col_index: c };
    if (l) value.l = l;
    if (r_) value.r = r_;
    if (t) value.t = t;
    if (b) value.b = b;
    return { rangeType: 'cell', value };
}

function convertBorderSide(side: Partial<Border> | undefined, theme: ThemePalette): BorderSide | null {
    if (!side?.style || !(side.style in BORDER_STYLE_MAP)) return null;
    const color = resolveColor(side.color, theme) ?? '#000000';
    return { style: BORDER_STYLE_MAP[side.style], color };
}

function isFormulaValue(value: CellValue): value is Extract<CellValue, { formula: string }> {
    return typeof value === 'object' && value !== null && 'formula' in value;
}

function isSharedFormula(value: CellValue): value is Extract<CellValue, { sharedFormula: string }> {
    return typeof value === 'object' && value !== null && 'sharedFormula' in value;
}

function isRichText(value: CellValue): value is Extract<CellValue, { richText: unknown }> {
    return typeof value === 'object' && value !== null && 'richText' in value;
}

function isHyperlink(value: CellValue): value is Extract<CellValue, { hyperlink: string }> {
    return typeof value === 'object' && value !== null && 'hyperlink' in value && 'text' in value;
}

function isError(value: unknown): value is { error: string } {
    return typeof value === 'object' && value !== null && 'error' in value;
}
