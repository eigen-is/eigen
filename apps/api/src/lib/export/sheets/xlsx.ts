import type {
    BorderSide,
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Cell as FortuneCell,
    InlineStringSegment,
    Sheet,
    SingleRange,
} from '@workspace/lib/sheets';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { columnIndexToLabel, iscelldata, rowIndexToLabel, toA1 } from '@workspace/sheet/engine';
import type {
    Border,
    ConditionalFormattingRule,
    DataValidation,
    DataValidationOperator,
    Font,
    RichText,
    Cell as XlsxCell,
} from 'exceljs';
import { readSheetsContent } from '../../document/sheets';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { resolveFontFamily } from './fonts';
import { expandBorderInfo } from './range-borders';

// Excel's date epoch is 1899-12-30 (Lotus 1-2-3 1900 leap-year bug).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
// Excel's default row height; the importer treats it as "no explicit height".
const DEFAULT_ROW_HEIGHT_PT = 15.75;

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

        if (config.rowhidden) {
            for (const row of Object.keys(config.rowhidden)) {
                const wsRow = worksheet.getRow(Number(row) + 1);
                wsRow.hidden = true;
                // exceljs only emits a row element when it has cells or a height — give
                // data-less hidden rows the default height so hidden="1" survives.
                if (!wsRow.height && wsRow.cellCount === 0) wsRow.height = DEFAULT_ROW_HEIGHT_PT;
            }
        }

        if (config.colhidden) {
            for (const col of Object.keys(config.colhidden)) {
                worksheet.getColumn(Number(col) + 1).hidden = true;
            }
        }

        if (config.borderInfo) {
            for (const [key, sides] of expandBorderInfo(config.borderInfo)) {
                const border = {
                    ...(sides.l && { left: toBorderSide(sides.l) }),
                    ...(sides.r && { right: toBorderSide(sides.r) }),
                    ...(sides.t && { top: toBorderSide(sides.t) }),
                    ...(sides.b && { bottom: toBorderSide(sides.b) }),
                };
                if (Object.keys(border).length === 0) continue;
                const [r, c] = key.split('_').map(Number);
                worksheet.getCell(r + 1, c + 1).border = border;
            }
        }

        if (sheet.filterRange) {
            worksheet.autoFilter = singleRangeToA1(sheet.filterRange);
        }

        if (sheet.conditionalFormatRules) {
            const total = sheet.conditionalFormatRules.length;
            for (const [index, rule] of sheet.conditionalFormatRules.entries()) {
                // The engine merges rules last-write-wins; Excel resolves conflicts by
                // the LOWEST priority number — the last array rule gets priority 1.
                const xlsxRule = toCfRule(rule, total - index);
                if (!xlsxRule) continue;
                worksheet.addConditionalFormatting({
                    ref: rule.cellrange.map(singleRangeToA1).join(' '),
                    rules: [xlsxRule as unknown as ConditionalFormattingRule],
                });
            }
        }

        if (sheet.dataVerification) {
            for (const [key, rule] of Object.entries(sheet.dataVerification)) {
                const [r, c] = key.split('_').map(Number);
                const validation = toDataValidation(rule, r, c);
                if (validation) worksheet.getCell(r + 1, c + 1).dataValidation = validation;
            }
        }

        // Gridlines and frozen panes must live in ONE view object — exceljs renders
        // a <sheetView> per entry and Excel only honours the first.
        const view: { showGridLines?: boolean; state?: 'frozen'; xSplit?: number; ySplit?: number } = {};
        if (sheet.showGridLines === false || sheet.showGridLines === 0) {
            view.showGridLines = false;
        }
        if (sheet.frozen) {
            // Both alias families freeze the same range (state/modules/freeze.ts).
            const { type, range } = sheet.frozen;
            const freezeRows = type === 'row' || type === 'both' || type === 'rangeRow' || type === 'rangeBoth';
            const freezeCols = type === 'column' || type === 'both' || type === 'rangeColumn' || type === 'rangeBoth';
            view.state = 'frozen';
            // row_focus/column_focus hold the 0-based index of the LAST frozen row/col;
            // Excel's splits count frozen rows/cols.
            if (freezeRows) view.ySplit = (range?.row_focus ?? 0) + 1;
            if (freezeCols) view.xSplit = (range?.column_focus ?? 0) + 1;
        }
        if (Object.keys(view).length > 0) {
            worksheet.views = [view];
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

    const richText = inlineSegmentsToRichText(v.ct?.s);
    if (richText) {
        cell.value = { richText };
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

// Inline-string segments carry the cell's hex defaults or rgb(…) strings produced by
// the editor's CSS pipeline (state/modules/inline-string.ts).
function colorToArgb(color: string): string | undefined {
    if (color.startsWith('#')) return hexToArgb(color);
    const rgb = color.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!rgb) return undefined;
    const hex = (i: number) => Number(rgb[i]).toString(16).padStart(2, '0').toUpperCase();
    return `FF${hex(1)}${hex(2)}${hex(3)}`;
}

function inlineSegmentsToRichText(segments: InlineStringSegment[] | undefined): RichText[] | null {
    if (!segments) return null;
    const runs: RichText[] = [];
    for (const seg of segments) {
        if (!seg.v) continue;
        const fontName = resolveFontFamily(seg.ff);
        const argb = seg.fc ? colorToArgb(seg.fc) : undefined;
        const font: Partial<Font> = {
            ...(seg.bl === 1 && { bold: true }),
            ...(seg.it === 1 && { italic: true }),
            ...(seg.un === 1 && { underline: true as const }),
            ...(seg.cl === 1 && { strike: true }),
            ...(typeof seg.fs === 'number' && { size: seg.fs }),
            ...(fontName && { name: fontName }),
            ...(argb && { color: { argb } }),
        };
        runs.push(Object.keys(font).length > 0 ? { text: seg.v, font } : { text: seg.v });
    }
    return runs.length > 0 ? runs : null;
}

function singleRangeToA1({ row, column }: SingleRange): string {
    const start = toA1(row[0], column[0]);
    const end = toA1(row[1], column[1]);
    return start === end ? start : `${start}:${end}`;
}

function singleRangeToAbsoluteA1({ row, column }: SingleRange): string {
    const abs = (r: number, c: number) => `$${columnIndexToLabel(c)}$${rowIndexToLabel(r)}`;
    const start = abs(row[0], column[0]);
    const end = abs(row[1], column[1]);
    return start === end ? start : `${start}:${end}`;
}

// Write-side cfRule model. exceljs's declared ConditionalFormattingRule union is narrower
// than what its writer accepts (the cellIs typing lists four of the eight operators,
// dataBar omits `color`) — mirror of the importer's loose XlsxCfRule read shape.
type XlsxCfWriteStyle = {
    font?: { color: { argb: string } };
    fill?: { type: 'pattern'; pattern: 'solid'; fgColor: { argb: string }; bgColor: { argb: string } };
};
type XlsxCfWriteRule = {
    type: 'cellIs' | 'containsText' | 'expression' | 'top10' | 'aboveAverage' | 'dataBar' | 'colorScale';
    priority: number;
    operator?: string;
    formulae?: string[];
    text?: string;
    rank?: number;
    percent?: boolean;
    bottom?: boolean;
    aboveAverage?: boolean;
    color?: { argb: string } | { argb: string }[];
    cfvo?: { type: string; value?: number }[];
    style?: XlsxCfWriteStyle;
};

const CF_CELL_IS_OPERATORS = new Set([
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'equal',
    'notEqual',
    'between',
    'notBetween',
]);

const CF_TOP10: Record<string, { percent: boolean; bottom: boolean }> = {
    top10: { percent: false, bottom: false },
    top10_percent: { percent: true, bottom: false },
    last10: { percent: false, bottom: true },
    last10_percent: { percent: true, bottom: true },
};

function toCfRule(rule: ConditionalFormatRule, priority: number): XlsxCfWriteRule | null {
    if (rule.type === 'dataBar') {
        return {
            type: 'dataBar',
            priority,
            color: { argb: hexToArgb(rule.format[0]) },
            cfvo: [{ type: 'min' }, { type: 'max' }],
        };
    }

    if (rule.type === 'colorGradation') {
        // The engine's format array is MAX→(MID)→MIN; xlsx colorScale lists MIN→(MID)→MAX.
        const color = rule.format
            .slice()
            .reverse()
            .map((hex) => ({ argb: hexToArgb(hex) }));
        const cfvo =
            color.length === 3
                ? [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }]
                : [{ type: 'min' }, { type: 'max' }];
        return { type: 'colorScale', priority, cfvo, color };
    }

    if (rule.type === 'icons') return null; // no exceljs writer / engine evaluator pair

    const style = toCfStyle(rule.format);
    const name = rule.conditionName;

    if (CF_CELL_IS_OPERATORS.has(name)) {
        const count = name === 'between' || name === 'notBetween' ? 2 : 1;
        const formulae = rule.conditionValue.slice(0, count).map(encodeCfOperand);
        return { type: 'cellIs', priority, operator: name, formulae, style };
    }

    if (name === 'textContains') {
        // exceljs synthesizes NOT(ISERROR(SEARCH("text",tl))) from `text` without escaping —
        // double embedded quotes here so the formula stays valid Excel syntax.
        return {
            type: 'containsText',
            priority,
            operator: 'containsText',
            text: String(rule.conditionValue[0]).replace(/"/g, '""'),
            style,
        };
    }

    if (name === 'formula') {
        const formula = String(rule.conditionValue[0]);
        return {
            type: 'expression',
            priority,
            formulae: [formula.startsWith('=') ? formula.slice(1) : formula],
            style,
        };
    }

    if (name in CF_TOP10) {
        return { type: 'top10', priority, rank: Number(rule.conditionValue[0]), ...CF_TOP10[name], style };
    }

    if (name === 'aboveAverage' || name === 'belowAverage') {
        return { type: 'aboveAverage', priority, aboveAverage: name === 'aboveAverage', style };
    }

    if (name === 'duplicateValue') {
        // exceljs 4.4.0 has no cfRule writer for duplicate/uniqueValues (it would emit an
        // invalid empty <conditionalFormatting>) — encode the standard COUNTIF recipe
        // instead: Excel shifts the relative anchor per target cell while the absolute
        // range refs stay pinned, so the expression counts the target cell's value across
        // all of the rule's ranges. Semantically exact in Excel; our importer re-imports
        // it as a formula rule (accepted drift, SHEETS-XLSX-FIDELITY backlog).
        const compare = rule.conditionValue[0] === '0' ? '>1' : rule.conditionValue[0] === '1' ? '=1' : null;
        if (compare == null) return null; // the engine evaluator ignores other values too
        const anchor = toA1(rule.cellrange[0].row[0], rule.cellrange[0].column[0]);
        const countifs = rule.cellrange.map((range) => `COUNTIF(${singleRangeToAbsoluteA1(range)},${anchor})`);
        return { type: 'expression', priority, formulae: [countifs.join('+') + compare], style };
    }

    // occurrenceDate: editor-only, no xlsx equivalent — recorded in the
    // SHEETS-XLSX-FIDELITY backlog.
    return null;
}

function toCfStyle(format: DefaultConditionalFormatRule['format']): XlsxCfWriteStyle | undefined {
    const style: XlsxCfWriteStyle = {};
    if (format.textColor) style.font = { color: { argb: hexToArgb(format.textColor) } };
    if (format.cellColor) {
        // dxf solid fills: Excel reads the visible color from bgColor, our importer
        // prefers fgColor — write the same color into both so either reader resolves it.
        const color = { argb: hexToArgb(format.cellColor) };
        style.fill = { type: 'pattern', pattern: 'solid', fgColor: color, bgColor: color };
    }
    return style.font || style.fill ? style : undefined;
}

// Inverse of the importer's parseCfLiteral: numeric literals pass through, anything else
// becomes a quoted Excel string literal with embedded quotes doubled.
function encodeCfOperand(value: string | number): string {
    const txt = String(value);
    return /^-?(\d+\.?\d*|\.\d+)$/.test(txt) ? txt : `"${txt.replace(/"/g, '""')}"`;
}

// Engine type2 → xlsx operator; exact reverse of the importer's DV_OPERATOR.
const DV_XLSX_OPERATOR: Record<string, DataValidationOperator> = {
    between: 'between',
    notBetween: 'notBetween',
    equal: 'equal',
    notEqualTo: 'notEqual',
    moreThanThe: 'greaterThan',
    lessThan: 'lessThan',
    greaterOrEqualTo: 'greaterThanOrEqual',
    lessThanOrEqualTo: 'lessThanOrEqual',
};

// Exact reverse of the importer's DV_DATE_OPERATOR.
const DV_XLSX_DATE_OPERATOR: Record<string, DataValidationOperator> = {
    between: 'between',
    notBetween: 'notBetween',
    equal: 'equal',
    notEqualTo: 'notEqual',
    earlierThan: 'lessThan',
    noEarlierThan: 'greaterThanOrEqual',
    laterThan: 'greaterThan',
    noLaterThan: 'lessThanOrEqual',
};

const DV_XLSX_TYPE: Record<string, DataValidation['type']> = {
    number: 'decimal',
    number_integer: 'whole',
    // Editor-only type; re-imports as `number` (Excel decimal admits integers anyway).
    number_decimal: 'decimal',
    text_length: 'textLength',
    date: 'date',
};

function toDataValidation(rule: DataVerificationRule, r: number, c: number): DataValidation | null {
    if (rule.type === 'dropdown') {
        // Inverse of the importer's listSource: range refs verbatim, literal lists as a
        // quoted Excel string with embedded quotes doubled.
        const source = iscelldata(rule.value1) ? rule.value1 : `"${rule.value1.replace(/"/g, '""')}"`;
        return withDvMessages(rule, { type: 'list', allowBlank: true, formulae: [source] });
    }

    if (rule.type === 'text_content') {
        // No native xlsx type — encode as a custom formula on the cell's own address
        // (Google Sheets' approach). One-way: the importer drops custom rules.
        const formula = textContentFormula(rule, toA1(r, c));
        if (formula == null) return null;
        return withDvMessages(rule, { type: 'custom', allowBlank: true, formulae: [formula] });
    }

    const type = DV_XLSX_TYPE[rule.type];
    if (type == null) return null; // checkbox / validity have no xlsx equivalent

    const operator = (type === 'date' ? DV_XLSX_DATE_OPERATOR : DV_XLSX_OPERATOR)[rule.type2];
    if (operator == null) return null;
    const toOperand = type === 'date' ? dateDvOperand : numericDvOperand;
    const value1 = toOperand(rule.value1);
    if (value1 == null) return null;
    const formulae: (number | Date)[] = [value1];
    if (operator === 'between' || operator === 'notBetween') {
        const value2 = toOperand(rule.value2);
        if (value2 == null) return null;
        formulae.push(value2);
    }
    return withDvMessages(rule, { type, operator, allowBlank: true, formulae });
}

function withDvMessages(rule: DataVerificationRule, validation: DataValidation): DataValidation {
    if (rule.hintShow && rule.hintValue) {
        validation.showInputMessage = true;
        validation.prompt = rule.hintValue;
    }
    // Excel's default "stop" error style blocks invalid input; without error attrs the
    // OOXML default (showErrorMessage=0) re-imports as prohibitInput: false.
    if (rule.prohibitInput === true) {
        validation.showErrorMessage = true;
        validation.errorStyle = 'stop';
    }
    return validation;
}

function textContentFormula(rule: DataVerificationRule, addr: string): string | null {
    const text = `"${rule.value1.replace(/"/g, '""')}"`;
    switch (rule.type2) {
        case 'include':
            return `ISNUMBER(SEARCH(${text},${addr}))`;
        case 'exclude':
            return `NOT(ISNUMBER(SEARCH(${text},${addr})))`;
        case 'equal':
            return `EXACT(${addr},${text})`;
        default:
            return null;
    }
}

// Mirrors the import direction's invalid-operand drop: no numeric literal → no rule.
function numericDvOperand(value: string): number | null {
    const n = value.trim() === '' ? Number.NaN : Number(value);
    return Number.isNaN(n) ? null : n;
}

// value1/value2 hold YYYY-MM-DD; exceljs's writer calls dateToExcel(new Date(formula)),
// so hand over JS Dates (UTC-midnight, matching the import direction's excelToDate).
function dateDvOperand(value: string): Date | null {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}
