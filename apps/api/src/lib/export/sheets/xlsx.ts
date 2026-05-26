import type { BorderSide, Cell as FortuneCell, Sheet } from '@workspace/lib/sheets';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Border, Cell as XlsxCell } from 'exceljs';
import { readSheetsContent } from '../../document/sheets';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { resolveFontFamily } from './fonts';

// Excel's date epoch is 1899-12-30 (Lotus 1-2-3 1900 leap-year bug).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const REVERSE_HORIZONTAL: Record<number, 'left' | 'center' | 'right'> = {
    0: 'center',
    1: 'left',
    2: 'right',
};

const REVERSE_VERTICAL: Record<number, 'top' | 'middle' | 'bottom'> = {
    0: 'middle',
    1: 'top',
    2: 'bottom',
};

const REVERSE_BORDER_STYLE: Record<number, NonNullable<Border['style']>> = {
    1: 'thin',
    2: 'hair',
    3: 'dotted',
    4: 'dashed',
    5: 'dashDot',
    6: 'dashDotDot',
    7: 'double',
    8: 'medium',
    9: 'mediumDashed',
    10: 'mediumDashDot',
    11: 'mediumDashDotDot',
    12: 'slantDashDot',
    13: 'thick',
};

function hexToArgb(hex: string): string {
    return `FF${hex.replace('#', '')}`;
}

export async function exportSheetsToXlsx(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const sheets = await readSheetsContent(mount, drivePath);
    const buffer = await sheetsToXlsx(sheets);
    const title = stripEigenExtension(drivePath.name);

    return {
        data: buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: `${title}.xlsx`,
    };
}

export async function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer> {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();

    for (const sheet of sheets) {
        const worksheet = workbook.addWorksheet(sheet.name);
        const config = sheet.config ?? {};

        if (config.columnlen) {
            for (const [col, px] of Object.entries(config.columnlen)) {
                worksheet.getColumn(Number(col) + 1).width = px / 8;
            }
        }

        if (config.merge) {
            for (const m of Object.values(config.merge)) {
                worksheet.mergeCells(m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs);
            }
        }

        if (sheet.celldata) {
            for (const { r, c, v } of sheet.celldata) {
                if (!v) continue;
                // Skip non-anchor merge cells (only the anchor carries data).
                if (v.mc && (v.mc.r !== r || v.mc.c !== c)) continue;

                const cell = worksheet.getCell(r + 1, c + 1);
                applyCellValue(cell, v);
                applyCellStyle(cell, v);
            }
        }

        if (config.rowlen) {
            for (const [row, px] of Object.entries(config.rowlen)) {
                worksheet.getRow(Number(row) + 1).height = px * (3 / 4);
            }
        }

        if (config.borderInfo) {
            for (const border of config.borderInfo) {
                if (border.rangeType !== 'cell') continue;
                const { row_index, col_index, l, r, t, b } = border.value;
                const cell = worksheet.getCell(row_index + 1, col_index + 1);
                cell.border = {
                    ...(l && { left: toBorderSide(l) }),
                    ...(r && { right: toBorderSide(r) }),
                    ...(t && { top: toBorderSide(t) }),
                    ...(b && { bottom: toBorderSide(b) }),
                };
            }
        }

        if (sheet.showGridLines === false || sheet.showGridLines === 0) {
            worksheet.views = [{ showGridLines: false }];
        }
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
}

function applyCellValue(cell: XlsxCell, v: FortuneCell): void {
    if (v.f) {
        const formula = v.f.startsWith('=') ? v.f.slice(1) : v.f;
        cell.value = { formula, result: v.v ?? undefined } as XlsxCell['value'];
        if (v.ct?.fa) cell.numFmt = v.ct.fa;
        return;
    }

    if (v.ct?.t === 'd' && typeof v.v === 'number') {
        cell.value = new Date(EXCEL_EPOCH_MS + v.v * DAY_MS);
        if (v.ct.fa) cell.numFmt = v.ct.fa;
        return;
    }

    if (v.v !== undefined) cell.value = v.v;
    if (v.ct?.fa) cell.numFmt = v.ct.fa;
}

function applyCellStyle(cell: XlsxCell, v: FortuneCell): void {
    const fontName = resolveFontFamily(v.ff);
    if (v.bl === 1 || v.it === 1 || v.un === 1 || v.cl === 1 || typeof v.fs === 'number' || v.fc || fontName) {
        cell.font = {
            ...(v.bl === 1 && { bold: true }),
            ...(v.it === 1 && { italic: true }),
            ...(v.un === 1 && { underline: true as const }),
            ...(v.cl === 1 && { strike: true }),
            ...(typeof v.fs === 'number' && { size: v.fs }),
            ...(fontName && { name: fontName }),
            ...(v.fc && { color: { argb: hexToArgb(v.fc) } }),
        };
    }

    if (v.bg) {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: hexToArgb(v.bg) },
        };
    }

    const textRotation =
        v.rt === 'vertical'
            ? ('vertical' as const)
            : typeof v.rt === 'number' && v.rt !== 0 && v.rt >= -90 && v.rt <= 90
              ? v.rt
              : null;
    if (v.ht != null || v.vt != null || v.tb === '2' || textRotation != null) {
        cell.alignment = {
            ...(v.ht != null && v.ht in REVERSE_HORIZONTAL && { horizontal: REVERSE_HORIZONTAL[v.ht] }),
            ...(v.vt != null && v.vt in REVERSE_VERTICAL && { vertical: REVERSE_VERTICAL[v.vt] }),
            ...(v.tb === '2' && { wrapText: true }),
            ...(textRotation != null && { textRotation }),
        };
    }
}

function toBorderSide(side: BorderSide): Partial<Border> {
    return {
        style: REVERSE_BORDER_STYLE[side.style] ?? 'thin',
        color: { argb: hexToArgb(side.color) },
    };
}
