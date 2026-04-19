/// <reference path="../modules.d.ts" />
import type {
    BorderSide,
    CellBorderInfo,
    CellStyle,
    Cell as FortuneCell,
    Sheet,
    SheetConfig,
} from '@workspace/lib/sheets';
import type { Alignment, Border, CellValue, Worksheet, Cell as XlsxCell } from 'exceljs';

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

export async function xlsxToSheets(buffer: Buffer): Promise<Sheet[]> {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheets: Sheet[] = [];
    workbook.worksheets.forEach((worksheet, index) => {
        sheets.push(worksheetToSheet(worksheet, index));
    });
    return sheets;
}

function worksheetToSheet(worksheet: Worksheet, index: number): Sheet {
    const celldata: { r: number; c: number; v: FortuneCell }[] = [];
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const rowlen: NonNullable<SheetConfig['rowlen']> = {};
    const borderInfo: CellBorderInfo[] = [];

    const { merge, anchorByCell } = buildMergeStructures(worksheet.model.merges ?? []);

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const r = rowNumber - 1;
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const c = colNumber - 1;
            const converted = convertCell(cell);
            const mergeAnchor = anchorByCell.get(`${r}:${c}`);
            if (mergeAnchor) converted.mc = mergeAnchor;
            celldata.push({ r, c, v: converted });

            const border = convertBorder(cell, r, c);
            if (border) borderInfo.push(border);
        });
        if (typeof row.height === 'number' && row.height > 0) {
            // ExcelJS row height is in points; fortune-sheet expects pixels (1pt ≈ 4/3 px at 96 DPI).
            rowlen[String(r)] = Math.round(row.height * (4 / 3));
        }
    });

    (worksheet.columns ?? []).forEach((col, i) => {
        if (col && typeof col.width === 'number' && col.width > 0) {
            // ExcelJS column width is in "character units"; fortune-sheet expects pixels.
            columnlen[String(i)] = Math.round(col.width * 8);
        }
    });

    const config: SheetConfig = {};
    if (Object.keys(merge).length > 0) config.merge = merge;
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
    if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
    if (borderInfo.length > 0) config.borderInfo = borderInfo;

    return {
        name: worksheet.name,
        id: `sheet-${index}`,
        order: index,
        celldata,
        config,
    };
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

function convertCell(cell: XlsxCell): FortuneCell {
    const result: FortuneCell = {};

    const { value, display } = extractValueAndDisplay(cell);
    if (value !== undefined) result.v = value;
    if (display !== undefined) result.m = display;

    if (cell.formula) {
        result.f = `=${cell.formula}`;
    }

    const ct = buildCellType(cell, value);
    if (ct) result.ct = ct;

    applyStyle(cell, result);

    return result;
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
    if (!numFmt || numFmt === 'General') return `${M}/${d}/${y}`;
    return numFmt
        .replace('yyyy', String(y))
        .replace('yy', String(y).slice(-2))
        .replace(/MM(?!M)/, String(M).padStart(2, '0'))
        .replace(/M(?!M)/, String(M))
        .replace('dd', String(d).padStart(2, '0'))
        .replace(/\bd\b/, String(d));
}

function buildCellType(cell: XlsxCell, value: string | number | boolean | undefined): FortuneCell['ct'] {
    const ct: NonNullable<FortuneCell['ct']> = {};
    if (cell.numFmt && cell.numFmt !== 'General') {
        ct.fa = cell.numFmt;
    }
    const t = resolveType(cell, value);
    if (t) ct.t = t;
    return Object.keys(ct).length > 0 ? ct : undefined;
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

function applyStyle(cell: XlsxCell, target: FortuneCell): void {
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
        if (typeof font.size === 'number') target.fs = font.size;
        if (font.color?.argb) target.fc = argbToHex(font.color.argb);
    }

    const fill = style.fill;
    if (fill && fill.type === 'pattern' && fill.fgColor?.argb) {
        target.bg = argbToHex(fill.fgColor.argb);
    }

    const alignment = style.alignment;
    if (alignment) {
        applyAlignment(alignment, target);
    }
}

function applyAlignment(alignment: Partial<Alignment>, target: CellStyle): void {
    if (alignment.horizontal && alignment.horizontal in HORIZONTAL_MAP) {
        target.ht = HORIZONTAL_MAP[alignment.horizontal];
    }
    if (alignment.vertical && alignment.vertical in VERTICAL_MAP) {
        target.vt = VERTICAL_MAP[alignment.vertical];
    }
}

function argbToHex(argb: string): string {
    const rgb = argb.length === 8 ? argb.slice(2) : argb;
    return `#${rgb.toUpperCase()}`;
}

function convertBorder(cell: XlsxCell, r: number, c: number): CellBorderInfo | null {
    const border = cell.style?.border;
    if (!border) return null;

    const l = convertBorderSide(border.left);
    const r_ = convertBorderSide(border.right);
    const t = convertBorderSide(border.top);
    const b = convertBorderSide(border.bottom);
    if (!l && !r_ && !t && !b) return null;

    const value: CellBorderInfo['value'] = { row_index: r, col_index: c };
    if (l) value.l = l;
    if (r_) value.r = r_;
    if (t) value.t = t;
    if (b) value.b = b;
    return { rangeType: 'cell', value };
}

function convertBorderSide(side: Partial<Border> | undefined): BorderSide | null {
    if (!side?.style || !(side.style in BORDER_STYLE_MAP)) return null;
    const color = side.color?.argb ? argbToHex(side.color.argb) : '#000000';
    return { style: BORDER_STYLE_MAP[side.style], color };
}

function isFormulaValue(value: CellValue): value is Extract<CellValue, { formula: string }> {
    return typeof value === 'object' && value !== null && 'formula' in value;
}

function isSharedFormula(value: CellValue): value is CellValue & { sharedFormula: string; result?: CellValue } {
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
