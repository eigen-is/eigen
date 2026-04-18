/// <reference path="../modules.d.ts" />
import type { CellStyle, Cell as FortuneCell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import type { Alignment, CellValue, Worksheet, Cell as XlsxCell } from 'exceljs';

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
    const merge: NonNullable<SheetConfig['merge']> = {};
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const rowlen: NonNullable<SheetConfig['rowlen']> = {};

    const merges = worksheet.model.merges ?? [];
    const mergeMap = buildMergeMap(merges, merge);

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const r = rowNumber - 1;
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const c = colNumber - 1;
            const converted = convertCell(cell);
            const mergeAnchor = mergeMap.get(`${r}:${c}`);
            if (mergeAnchor) converted.mc = mergeAnchor;
            celldata.push({ r, c, v: converted });
        });
        if (typeof row.height === 'number' && row.height > 0) {
            rowlen[String(r)] = row.height;
        }
    });

    (worksheet.columns ?? []).forEach((col, i) => {
        if (col && typeof col.width === 'number' && col.width > 0) {
            columnlen[String(i)] = col.width;
        }
    });

    const config: SheetConfig = {};
    if (Object.keys(merge).length > 0) config.merge = merge;
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
    if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;

    return {
        name: worksheet.name,
        id: `sheet-${index}`,
        order: index,
        celldata,
        config,
    };
}

function buildMergeMap(
    merges: string[],
    merge: NonNullable<SheetConfig['merge']>,
): Map<string, { r: number; c: number; rs?: number; cs?: number }> {
    const map = new Map<string, { r: number; c: number; rs?: number; cs?: number }>();
    for (const range of merges) {
        const parsed = parseRange(range);
        if (!parsed) continue;
        const { top, left, bottom, right } = parsed;
        const rs = bottom - top + 1;
        const cs = right - left + 1;
        const anchor = { r: top, c: left, rs, cs };
        merge[toA1(top, left)] = anchor;
        for (let rr = top; rr <= bottom; rr++) {
            for (let cc = left; cc <= right; cc++) {
                map.set(`${rr}:${cc}`, anchor);
            }
        }
    }
    return map;
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

function toA1(r: number, c: number): string {
    let letters = '';
    let n = c + 1;
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return `${letters}${r + 1}`;
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
        const serial = (raw.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
        return { value: serial, display: raw.toISOString() };
    }

    if (isFormulaValue(raw)) {
        return resolveFormulaResult(raw.result);
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

function resolveFormulaResult(result: unknown): { value?: string | number | boolean; display?: string } {
    if (result === null || result === undefined) return {};
    if (typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean') {
        return { value: result, display: String(result) };
    }
    if (result instanceof Date) {
        const serial = (result.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
        return { value: serial, display: result.toISOString() };
    }
    if (isError(result)) {
        return { value: result.error, display: result.error };
    }
    return {};
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
    if (typeof value === 'number') return 'n';
    if (typeof value === 'boolean') return 'b';
    if (typeof value === 'string') return 's';
    return undefined;
}

function applyStyle(cell: XlsxCell, target: FortuneCell): void {
    const style = cell.style;
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

function isFormulaValue(value: CellValue): value is Extract<CellValue, { formula: string }> {
    return typeof value === 'object' && value !== null && 'formula' in value;
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
