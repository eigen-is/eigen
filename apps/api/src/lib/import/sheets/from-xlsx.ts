/// <reference path="../modules.d.ts" />

import { EIGEN_FONTS, type EigenFont } from '@workspace/lib/constants/fonts';
import { formatInputDate } from '@workspace/lib/date';
import type {
    BorderSide,
    CellBorderInfo,
    ConditionalFormatConditionName,
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Cell as FortuneCell,
    Sheet,
    SheetConfig,
    SingleRange,
} from '@workspace/lib/sheets';
import {
    booleanDisplay,
    functionCopy,
    iscelldata,
    parseA1Range,
    toA1,
    unquoteSheetName,
    update,
} from '@workspace/sheet/engine';
import type {
    Alignment,
    AutoFilter,
    Border,
    CellRichTextValue,
    CellValue,
    Workbook,
    Worksheet,
    Cell as XlsxCell,
} from 'exceljs';
import he from 'he';
import JSZip from 'jszip';
import { ApiError } from '../../core/errors';
import { assertDecompressedSizeWithinBounds } from '../zip-size-guard';

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
// Only the four bundled fonts have face data inlined into the HTML / PDF export, so unmapped
// fonts fall back to the browser's generic family — inconsistent with the editor. Map common
// Office defaults to the closest bundled category; anything unrecognized leaves `ff` unset so
// the document default (Inter) is used.
const FONT_CATEGORY_MAP: Record<string, EigenFont['category']> = {
    inter: 'sans-serif',
    'source serif 4': 'serif',
    'source serif pro': 'serif',
    'jetbrains mono': 'monospace',
    excalifont: 'hand-drawn',
    // sans-serif
    calibri: 'sans-serif',
    'calibri light': 'sans-serif',
    arial: 'sans-serif',
    helvetica: 'sans-serif',
    'helvetica neue': 'sans-serif',
    verdana: 'sans-serif',
    tahoma: 'sans-serif',
    'segoe ui': 'sans-serif',
    'trebuchet ms': 'sans-serif',
    // serif
    'times new roman': 'serif',
    times: 'serif',
    georgia: 'serif',
    cambria: 'serif',
    garamond: 'serif',
    'book antiqua': 'serif',
    palatino: 'serif',
    'palatino linotype': 'serif',
    // monospace
    'courier new': 'monospace',
    courier: 'monospace',
    consolas: 'monospace',
    monaco: 'monospace',
    'lucida console': 'monospace',
    menlo: 'monospace',
    // hand-drawn
    'comic sans ms': 'hand-drawn',
    'comic sans': 'hand-drawn',
};

// The one bundled font per visual category, sourced from the canonical registry so a font
// rename never drifts from what the export embeds.
const BUNDLED_FONT_BY_CATEGORY = Object.fromEntries(EIGEN_FONTS.map((font) => [font.category, font.name])) as Record<
    EigenFont['category'],
    string
>;

function mapToSupportedFont(name: string): string | null {
    const category = FONT_CATEGORY_MAP[name.trim().toLowerCase()];
    return category ? BUNDLED_FONT_BY_CATEGORY[category] : null;
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

// Belt against a tiny file DECLARING an enormous grid (far-apart cells span the full Excel
// bounding box): walking rowCount×columnCount to build the Sheet output would blow up, and
// exceljs's fully-materialized in-memory model (~hundreds of bytes per cell) is itself the
// dominant memory term. 4 M cells (e.g. 40k rows × 100 cols) exceeds any realistic import
// while keeping that model to ~1–2 GB — survivable, unlike a 10 M-cell model (~2–4 GB).
// A dense sheet at this cap decompresses to ~140 MB, well under the shared byte cap: the
// CELL cap, not the byte cap, is the binding limit for a real spreadsheet, and neither
// rejects a sheet the other would allow. The byte cap independently catches a LOW-cell-count
// bomb (repeated bytes in one entry, or a forged xl/media/* blob) the cell cap can't see.
const MAX_CELLS = 4_000_000;

export async function xlsxToSheets(buffer: Buffer): Promise<Sheet[]> {
    // One JSZip pass, reused for the size guard AND the hyperlink read below. loadAsync
    // reads the central directory without decompressing, so the guard can run BEFORE
    // exceljs's xlsx.load — the OOM a bomb triggers happens inside load() and is not
    // catchable, so a post-load check would never fire.
    const zip = await JSZip.loadAsync(buffer);
    await assertDecompressedSizeWithinBounds(zip, 'Spreadsheet too large');

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    assertCellCountWithinBounds(workbook);

    const theme = extractThemePalette(workbook);
    const locationLinks = await readLocationHyperlinks(zip);

    const sheets: Sheet[] = [];
    for (const [index, worksheet] of workbook.worksheets.entries()) {
        sheets.push(worksheetToSheet(worksheet, index, theme, locationLinks.get(worksheet.name)));
    }
    return sheets;
}

function assertCellCountWithinBounds(workbook: Workbook): void {
    let cells = 0;
    for (const worksheet of workbook.worksheets) {
        cells += worksheet.rowCount * worksheet.columnCount;
        if (cells > MAX_CELLS) throw new ApiError(413, 'Spreadsheet has too many cells');
    }
}

function worksheetToSheet(
    worksheet: Worksheet,
    index: number,
    theme: ThemePalette,
    locationLinks: Map<string, string> | undefined,
): Sheet {
    const sheetId = `sheet-${index}`;
    const celldata: { r: number; c: number; v: FortuneCell }[] = [];
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const rowlen: NonNullable<SheetConfig['rowlen']> = {};
    const borderInfo: CellBorderInfo[] = [];
    const hyperlink: NonNullable<Sheet['hyperlink']> = {};

    const { merge, anchorByCell } = buildMergeStructures(worksheet.model.merges ?? []);

    // Compute column widths first (needed for auto-fit height estimation).
    const colWidthPx: Record<number, number> = {};
    const colhidden: NonNullable<SheetConfig['colhidden']> = {};
    for (const [i, col] of (worksheet.columns ?? []).entries()) {
        if (col && typeof col.width === 'number' && col.width > 0) {
            const px = Math.round(col.width * 8);
            colWidthPx[i] = px;
            columnlen[String(i)] = px;
        }
        // exceljs expands <col min/max hidden> ranges to per-column flags.
        if (col?.hidden) colhidden[String(i)] = 0;
    }

    const DEFAULT_ROW_HEIGHT_PT = 15.75;
    const DEFAULT_ROW_HEIGHT_PX = 20;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const r = rowNumber - 1;
        let maxCellHeight = 0;

        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const c = colNumber - 1;
            const converted = convertCell(cell, theme);
            // Location-form targets (Excel-authored internal links, and our own
            // exporter's output) route through the same internal mapping as
            // rel-based '#' targets. exceljs's writer keeps a caller-provided '#'
            // inside the location attribute, so strip one before prefixing.
            const location = locationLinks?.get(cell.address);
            const link =
                location != null ? mapHyperlink(`#${location.replace(/^#/, '')}`) : mapHyperlink(cell.hyperlink);
            if (link) {
                hyperlink[`${r}_${c}`] = link;
                // saveHyperlink invariant: the linked cell carries an hl backref
                // (patch.ts's cell-op path keys off it).
                converted.hl = { r, c, id: sheetId };
            }
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

    // Hidden flags can sit on row elements with no cell values (style-only hidden
    // rows), which the eachRow({includeEmpty:false}) pass above skips — Excel hides
    // them all the same. findRow doesn't materialize gap rows, and rowCount is
    // bounded by the last row element present in the file.
    const rowhidden: NonNullable<SheetConfig['rowhidden']> = {};
    for (let n = 1; n <= worksheet.rowCount; n++) {
        if (worksheet.findRow(n)?.hidden) rowhidden[String(n - 1)] = 0;
    }

    const config: SheetConfig = {};
    if (Object.keys(merge).length > 0) config.merge = merge;
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
    if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
    if (Object.keys(rowhidden).length > 0) config.rowhidden = rowhidden;
    if (Object.keys(colhidden).length > 0) config.colhidden = colhidden;
    if (borderInfo.length > 0) config.borderInfo = borderInfo;

    const sheet: Sheet = {
        name: worksheet.name,
        id: sheetId,
        order: index,
        celldata,
        config,
    };
    if (Object.keys(hyperlink).length > 0) sheet.hyperlink = hyperlink;

    const view = worksheet.views?.[0];
    if (view && view.showGridLines === false) {
        sheet.showGridLines = false;
    }

    if (view?.state === 'frozen') {
        const xSplit = view.xSplit ?? 0;
        const ySplit = view.ySplit ?? 0;
        // Excel: ySplit=N freezes the top N rows, xSplit=M the left M columns.
        // The engine range carries the 0-based index of the LAST frozen row/col.
        if (xSplit > 0 || ySplit > 0) {
            sheet.frozen = {
                type: xSplit > 0 && ySplit > 0 ? 'rangeBoth' : ySplit > 0 ? 'rangeRow' : 'rangeColumn',
                range: { row_focus: Math.max(ySplit - 1, 0), column_focus: Math.max(xSplit - 1, 0) },
            };
        }
    }

    // Only the autofilter SPAN imports — per-column criteria (<filterColumn>) need the
    // editor's condition model. A criteria-less autofilter matches what a fresh filter
    // enable writes (state/modules/filter.ts createFilter): filterRange only, no
    // per-column filter entries.
    const filterRange = autoFilterToFilterRange(worksheet.autoFilter);
    if (filterRange) sheet.filterRange = filterRange;

    const conditionalFormatRules = convertConditionalFormats(worksheet, theme);
    if (conditionalFormatRules.length > 0) sheet.conditionalFormatRules = conditionalFormatRules;

    const dataVerification = convertDataValidations(worksheet);
    if (Object.keys(dataVerification).length > 0) sheet.dataVerification = dataVerification;

    return sheet;
}

type XlsxCfColor = { argb?: string; theme?: number; tint?: number };

// Loose shape of a parsed <cfRule>. exceljs's declared ConditionalFormattingRule union is
// narrower than what file read-back produces: all eight cellIs operators appear (typings
// list four), `duplicateValues`/`uniqueValues`/`beginsWith`/… pass through as raw type
// strings, formulae entries are raw formula text, and dataBar `color` is a single object
// while colorScale's is an array.
type XlsxCfRule = {
    type: string;
    priority: number;
    operator?: string;
    formulae?: (string | number)[];
    text?: string;
    rank?: number;
    percent?: boolean;
    bottom?: boolean;
    aboveAverage?: boolean;
    color?: XlsxCfColor | XlsxCfColor[];
    style?: {
        font?: { color?: XlsxCfColor } | null;
        fill?: { pattern?: string; fgColor?: XlsxCfColor; bgColor?: XlsxCfColor } | null;
    } | null;
};

const CELL_IS_CONDITION: Record<string, ConditionalFormatConditionName> = {
    greaterThan: 'greaterThan',
    greaterThanOrEqual: 'greaterThanOrEqual',
    lessThan: 'lessThan',
    lessThanOrEqual: 'lessThanOrEqual',
    equal: 'equal',
    notEqual: 'notEqual',
    between: 'between',
    notBetween: 'notBetween',
};

const CELL_IS_FORMULA_OP: Record<string, string> = {
    greaterThan: '>',
    greaterThanOrEqual: '>=',
    lessThan: '<',
    lessThanOrEqual: '<=',
    equal: '=',
    notEqual: '<>',
};

// Text-operator and timePeriod rules read back without their own attribute payloads, but
// Excel stores the equivalent formula inside the cfRule — evaluate those through the
// engine's formula rule.
const FORMULA_BACKED_CF_TYPES = new Set(['containsText', 'notContainsText', 'beginsWith', 'endsWith', 'timePeriod']);

function convertConditionalFormats(worksheet: Worksheet, theme: ThemePalette): ConditionalFormatRule[] {
    // `conditionalFormattings` is a real Worksheet property (lib/doc/worksheet.js) missing
    // from exceljs's typings — same situation as `workbook._themes` in extractThemePalette.
    const blocks =
        (worksheet as unknown as { conditionalFormattings?: { ref: string; rules: XlsxCfRule[] }[] })
            .conditionalFormattings ?? [];

    const flat: { rule: XlsxCfRule; ranges: SingleRange[] }[] = [];
    for (const block of blocks) {
        // sqref can carry multiple space-separated ranges.
        const ranges: SingleRange[] = [];
        for (const token of block.ref.split(/\s+/)) {
            const range = a1ToSingleRange(token);
            if (range) ranges.push(range);
        }
        if (ranges.length === 0) continue;
        for (const rule of block.rules) flat.push({ rule, ranges });
    }

    // Excel resolves overlapping rules by priority: the LOWEST priority number wins a
    // conflicting style property. The engine applies rules in array order and merges the
    // compute map last-write-wins per property (applyCellStyle), so emit rules sorted by
    // priority DESCENDING — the highest-precedence rule is applied last and lands on top.
    flat.sort((a, b) => b.rule.priority - a.rule.priority);

    const rules: ConditionalFormatRule[] = [];
    for (const { rule, ranges } of flat) {
        rules.push(...mapCfRule(rule, ranges, theme));
    }
    return rules;
}

function mapCfRule(rule: XlsxCfRule, ranges: SingleRange[], theme: ThemePalette): ConditionalFormatRule[] {
    if (rule.type === 'colorScale') {
        // exceljs lists colorScale stops min→(mid)→max; the engine's colorGradation
        // format array is max→(mid)→min.
        const stops = Array.isArray(rule.color) ? rule.color : [];
        const format: string[] = [];
        for (const stop of stops) {
            const hex = resolveColor(stop, theme);
            if (hex) format.push(hex);
        }
        if (format.length !== stops.length || (format.length !== 2 && format.length !== 3)) return [];
        format.reverse();
        return [{ type: 'colorGradation', cellrange: ranges, format }];
    }

    if (rule.type === 'dataBar') {
        const color = Array.isArray(rule.color) ? rule.color[0] : rule.color;
        const hex = resolveColor(color, theme);
        // Single color → solid bar, like the editor's data-bar presets.
        return hex ? [{ type: 'dataBar', cellrange: ranges, format: [hex] }] : [];
    }

    const format = convertDxfFormat(rule.style, theme);

    if (rule.type === 'cellIs' && rule.operator != null && rule.operator in CELL_IS_CONDITION) {
        const operands = (rule.formulae ?? []).map(String);
        if (operands.length === 0) return [];
        const literals = operands.map(parseCfLiteral);
        if (literals.every((value) => value != null)) {
            return [
                {
                    type: 'default',
                    cellrange: ranges,
                    format,
                    conditionName: CELL_IS_CONDITION[rule.operator],
                    conditionRange: [],
                    conditionValue: literals,
                },
            ];
        }
        // Ref/function operand — the engine's comparison rules only hold literals, so
        // express the comparison as a formula rule anchored at the range's top-left.
        const tl = toA1(ranges[0].row[0], ranges[0].column[0]);
        if (rule.operator === 'between' || rule.operator === 'notBetween') {
            if (operands.length < 2) return [];
            const within = `AND(${tl}>=${operands[0]},${tl}<=${operands[1]})`;
            return cfFormulaRules(rule.operator === 'between' ? within : `NOT(${within})`, ranges, format);
        }
        return cfFormulaRules(`${tl}${CELL_IS_FORMULA_OP[rule.operator]}${operands[0]}`, ranges, format);
    }

    if (rule.type === 'containsText' && rule.operator === 'containsText') {
        const text = rule.text ?? extractSearchText(rule.formulae?.[0]);
        if (text != null) {
            return [
                {
                    type: 'default',
                    cellrange: ranges,
                    format,
                    conditionName: 'textContains',
                    conditionRange: [],
                    conditionValue: [text],
                },
            ];
        }
    }

    if (rule.type === 'expression' || FORMULA_BACKED_CF_TYPES.has(rule.type)) {
        const formula = rule.formulae?.[0];
        return formula == null ? [] : cfFormulaRules(String(formula), ranges, format);
    }

    if (rule.type === 'top10') {
        const conditionName = rule.bottom
            ? rule.percent
                ? 'last10_percent'
                : 'last10'
            : rule.percent
              ? 'top10_percent'
              : 'top10';
        return [
            {
                type: 'default',
                cellrange: ranges,
                format,
                conditionName,
                conditionRange: [],
                conditionValue: [String(rule.rank ?? 10)],
            },
        ];
    }

    if (rule.type === 'aboveAverage') {
        // The aboveAverage attribute defaults to true and is omitted from the XML when true.
        return [
            {
                type: 'default',
                cellrange: ranges,
                format,
                conditionName: rule.aboveAverage === false ? 'belowAverage' : 'aboveAverage',
                conditionRange: [],
                conditionValue: [],
            },
        ];
    }

    if (rule.type === 'duplicateValues' || rule.type === 'uniqueValues') {
        return [
            {
                type: 'default',
                cellrange: ranges,
                format,
                conditionName: 'duplicateValue',
                conditionRange: [],
                conditionValue: [rule.type === 'duplicateValues' ? '0' : '1'],
            },
        ];
    }

    // Skipped rule types: iconSet (no engine evaluator), containsBlanks-family rules
    // without a stored formula, and anything unrecognized. A dropped rule is honest;
    // a wrong rendering is not.
    return [];
}

// Excel anchors a CF formula's relative refs at the top-left of the FIRST range in the
// sqref and shifts them per target cell across ALL ranges. The engine instead re-anchors
// the formula at each cellrange entry's own top-left, so emit one rule per range with the
// formula pre-shifted from the sqref anchor to that range's top-left.
function cfFormulaRules(
    formula: string,
    ranges: SingleRange[],
    format: DefaultConditionalFormatRule['format'],
): DefaultConditionalFormatRule[] {
    const anchorRow = ranges[0].row[0];
    const anchorCol = ranges[0].column[0];
    return ranges.map((range) => {
        let shifted = formula;
        const dr = range.row[0] - anchorRow;
        const dc = range.column[0] - anchorCol;
        if (dr !== 0) shifted = functionCopy(shifted, 'down', dr);
        if (dc !== 0) shifted = functionCopy(shifted, 'right', dc);
        return {
            type: 'default',
            cellrange: [range],
            format,
            conditionName: 'formula',
            conditionRange: [],
            conditionValue: [`=${shifted}`],
        };
    });
}

function convertDxfFormat(style: XlsxCfRule['style'], theme: ThemePalette): DefaultConditionalFormatRule['format'] {
    const textColor = resolveColor(style?.font?.color, theme);
    // dxf solid fills carry the visible color in bgColor (Excel-authored) or in both
    // fgColor and bgColor (Google Sheets exports); pattern "none" marks a font-only dxf.
    const fill = style?.fill;
    const cellColor =
        fill != null && fill.pattern !== 'none'
            ? (resolveColor(fill.fgColor, theme) ?? resolveColor(fill.bgColor, theme))
            : null;
    return { textColor, cellColor };
}

// Excel string literals arrive wrapped in double quotes with embedded quotes
// doubled ('"say ""hi"""'). Returns the unescaped inner text, or null when the
// operand isn't a quoted literal.
function unquoteXlsxLiteral(txt: string): string | null {
    if (!(txt.startsWith('"') && txt.endsWith('"') && txt.length >= 2)) return null;
    return txt.slice(1, -1).replace(/""/g, '"');
}

// cellIs operands arrive as raw formula text: numeric literals, quoted strings, or
// refs/functions (→ null, handled via the formula-rule fallback). Quoted percent strings
// like "5%" come from Google Sheets exports that serialize a percent-format threshold as
// text — coerce them to the numeric form the engine's comparisons expect.
function parseCfLiteral(operand: string): string | null {
    const txt = operand.trim();
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(txt)) return txt;
    const inner = unquoteXlsxLiteral(txt);
    if (inner == null) return null;
    const pct = inner.match(/^(-?\d+(?:\.\d+)?)%$/);
    return pct ? String(Number(pct[1]) / 100) : inner;
}

// exceljs read-back drops the containsText rule's `text` attribute but keeps the formula
// Excel stores in the file: NOT(ISERROR(SEARCH("<text>",<topLeftRef>))).
function extractSearchText(formula: string | number | undefined): string | null {
    if (formula == null) return null;
    const match = String(formula).match(/^NOT\(ISERROR\(SEARCH\("(.*)",/);
    return match ? match[1].replace(/""/g, '"') : null;
}

function a1ToSingleRange(ref: string): SingleRange | null {
    const parsed = parseA1Range(ref);
    if (!parsed) return null;
    return { row: [parsed.start.row, parsed.end.row], column: [parsed.start.col, parsed.end.col] };
}

// exceljs reads <autoFilter ref> back as the raw A1 ref string — Excel writes absolute
// refs like "$B$8:$L$432", which parseA1Range's optional $ anchors accept. Workbooks
// built programmatically can instead still carry the setter's {from, to} object with
// string addresses or 1-based {row, column} pairs.
function autoFilterToFilterRange(autoFilter: AutoFilter | undefined): SingleRange | null {
    if (autoFilter == null) return null;
    const toRef = (a: string | { row: number; column: number }) =>
        typeof a === 'string' ? a : toA1(a.row - 1, a.column - 1);
    const ref = typeof autoFilter === 'string' ? autoFilter : `${toRef(autoFilter.from)}:${toRef(autoFilter.to)}`;
    return a1ToSingleRange(ref);
}

// Loose shape of a parsed <dataValidation>. `worksheet.dataValidations.model` is a real
// property (lib/doc/worksheet.js) missing from exceljs's typings — same situation as
// `conditionalFormattings`. It maps cell addresses to rules with sqref ranges
// pre-expanded to per-cell keys, all cells of a range sharing ONE rule object. exceljs
// pre-coerces formulae on read: whole/textLength → parseInt, decimal → parseFloat,
// date → JS Date, list/custom → raw formula string; `operator` defaults to 'between'
// for the operand-carrying types.
type XlsxDataValidation = {
    type: string;
    operator?: string;
    formulae?: unknown[];
    showInputMessage?: boolean;
    showErrorMessage?: boolean;
    prompt?: string;
    errorStyle?: string;
};

const DV_TYPE: Record<string, string> = {
    list: 'dropdown',
    whole: 'number_integer',
    // Excel "decimal" accepts ANY real number, like the engine's `number` type;
    // the engine's `number_decimal` rejects integers and would block typing 5
    // into a "decimal between 1..10" cell.
    decimal: 'number',
    textLength: 'text_length',
    date: 'date',
};

// xlsx operator → engine type2 (see DataVerificationRule in @workspace/lib/sheets).
const DV_OPERATOR: Record<string, string> = {
    between: 'between',
    notBetween: 'notBetween',
    equal: 'equal',
    notEqual: 'notEqualTo',
    greaterThan: 'moreThanThe',
    lessThan: 'lessThan',
    greaterThanOrEqual: 'greaterOrEqualTo',
    lessThanOrEqual: 'lessThanOrEqualTo',
};

const DV_DATE_OPERATOR: Record<string, string> = {
    ...DV_OPERATOR,
    greaterThan: 'laterThan',
    lessThan: 'earlierThan',
    greaterThanOrEqual: 'noEarlierThan',
    lessThanOrEqual: 'noLaterThan',
};

// Column-wide validations ("D2:D1048576") are common in real workbooks, and exceljs
// pre-expands the sqref to one model entry per cell — emitting a rule object for each
// would put a multi-hundred-MB dataVerification map into the snapshot JSON while the
// converted grid only covers the data extent anyway. DV-only blank rows below the data
// are a legit pattern (pre-validated entry rows), hence the generous margins.
const DV_ROW_MARGIN = 1000;
const DV_COL_MARGIN = 100;

function convertDataValidations(worksheet: Worksheet): NonNullable<Sheet['dataVerification']> {
    const model =
        (worksheet as unknown as { dataValidations?: { model?: Record<string, XlsxDataValidation> } }).dataValidations
            ?.model ?? {};

    // rowCount/columnCount are bounded by the row/cell elements present in the file
    // (the structural extent the rest of the converter trusts, e.g. the rowhidden pass).
    const maxRow = worksheet.rowCount + DV_ROW_MARGIN;
    const maxCol = worksheet.columnCount + DV_COL_MARGIN;
    const rules: NonNullable<Sheet['dataVerification']> = {};
    // Object.keys, not entries: a column-wide rule pre-expands to ~1M model keys
    // and the tuple arrays would be pure transient garbage.
    for (const address of Object.keys(model)) {
        // Model keys are single-cell addresses (ranges arrive pre-expanded).
        const parsed = parseA1Range(address);
        if (!parsed) continue;
        if (parsed.start.row >= maxRow || parsed.start.col >= maxCol) continue;
        // Mapping per entry yields a fresh rule object per cell key — exceljs aliases
        // one object across an expanded range, and the engine mutates rules in place.
        const rule = mapDataValidation(model[address]);
        if (!rule) continue;
        rules[`${parsed.start.row}_${parsed.start.col}`] = rule;
    }
    return rules;
}

function mapDataValidation(dv: XlsxDataValidation): DataVerificationRule | null {
    const type = DV_TYPE[dv.type];
    if (type == null) return null; // custom / any have no engine equivalent

    const rule: DataVerificationRule = {
        type,
        type2: '',
        value1: '',
        value2: '',
        // showErrorMessage with Excel's default "stop" style blocks invalid input;
        // warning/information let the value through. The error text itself is dropped —
        // the engine generates its own failure copy.
        prohibitInput: dv.showErrorMessage === true && (dv.errorStyle == null || dv.errorStyle === 'stop'),
        hintShow: false,
        hintValue: '',
    };
    if (dv.showInputMessage && dv.prompt) {
        rule.hintShow = true;
        rule.hintValue = dv.prompt;
    }

    if (type === 'dropdown') {
        // type2 '' is the dialog's single-select value (multi-select is 'true');
        // Excel dropdowns are always single-select.
        const source = listSource(dv.formulae?.[0]);
        if (source == null) return null;
        rule.value1 = source;
        return rule;
    }

    const operator = dv.operator ?? 'between';
    const type2 = (type === 'date' ? DV_DATE_OPERATOR : DV_OPERATOR)[operator];
    if (type2 == null) return null;
    rule.type2 = type2;

    const toOperand = type === 'date' ? dateOperand : numericOperand;
    const value1 = toOperand(dv.formulae?.[0]);
    if (value1 == null) return null;
    rule.value1 = value1;
    if (operator === 'between' || operator === 'notBetween') {
        const value2 = toOperand(dv.formulae?.[1]);
        if (value2 == null) return null;
        rule.value2 = value2;
    }
    return rule;
}

// exceljs's read coercion turns a non-literal operand (e.g. a cell ref) into NaN —
// there is no literal to validate against, so the caller drops the rule.
function numericOperand(raw: unknown): string | null {
    return typeof raw === 'number' && !Number.isNaN(raw) ? String(raw) : null;
}

// Date operands arrive as JS Dates built from the serial in UTC terms (excelToDate).
// The engine's validateCellData parses value1/value2 with isdatetime + dayjs, which
// accept the YYYY-MM-DD that formatInputDate emits (toISOString-based, UTC).
function dateOperand(raw: unknown): string | null {
    if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return null;
    return formatInputDate(raw);
}

// A quoted literal ('"Red,Green,Blue"') becomes the engine's comma-list form; anything
// else is kept as a live range ref when valid — getDropdownList resolves refs (incl.
// quoted cross-sheet names) natively, so source edits keep propagating. Defined names
// are dropped program-wide; a garbage one-option dropdown is worse than no rule.
function listSource(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const inner = unquoteXlsxLiteral(raw);
    if (inner != null) return inner.length > 0 ? inner : null;
    const ref = raw.startsWith('=') ? raw.slice(1) : raw;
    return iscelldata(ref) ? ref : null;
}

function buildMergeStructures(merges: string[]): {
    merge: NonNullable<SheetConfig['merge']>;
    anchorByCell: Map<string, { r: number; c: number; rs?: number; cs?: number }>;
} {
    const merge: NonNullable<SheetConfig['merge']> = {};
    const anchorByCell = new Map<string, { r: number; c: number; rs?: number; cs?: number }>();
    for (const range of merges) {
        const parsed = parseA1Range(range);
        if (!parsed) continue;
        const { row: r, col: c } = parsed.start;
        const { row: br, col: bc } = parsed.end;
        const rs = br - r + 1;
        const cs = bc - c + 1;
        merge[`${r}_${c}`] = { r, c, rs, cs };
        for (let rr = r; rr <= br; rr++) {
            for (let cc = c; cc <= bc; cc++) {
                // Anchor carries rs/cs; non-anchors carry only {r,c} pointing back to anchor.
                // Fortune-sheet uses `"rs" in cell.mc` as the anchor discriminator.
                const mc = rr === r && cc === c ? { r, c, rs, cs } : { r, c };
                anchorByCell.set(`${rr}:${cc}`, mc);
            }
        }
    }
    return { merge, anchorByCell };
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
    if (isHyperlink(raw)) return hyperlinkText(raw);
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
    return (
        cell.v === undefined &&
        cell.f === undefined &&
        cell.bg === undefined &&
        cell.fc === undefined &&
        cell.hl === undefined
    );
}

// exceljs surfaces a cell's hyperlink target as a string: web/mailto targets
// verbatim, internal locations with a leading '#' (the rel-based form).
// Location-form entries never reach the cell through exceljs (see
// readLocationHyperlinks) and arrive here re-prefixed with '#' so both internal
// forms share this one mapping. External targets import verbatim; scheme safety
// is enforced at navigation/export time by resolveWebLink
// (@workspace/lib/sheets/web-link).
function mapHyperlink(target: string | undefined): { linkType: string; linkAddress: string } | null {
    if (target == null || target.trim().length === 0) return null;
    if (!target.startsWith('#')) return { linkType: 'webpage', linkAddress: target };
    const location = target.slice(1);
    if (location.length === 0) return null;
    // Quoted sheet name ('My Sheet', 'It''s') with an optional !ref tail. Sheet
    // names may legally contain '!', so don't split the quoted form on it.
    const quoted = location.match(/^('(?:[^']|'')*')(!.+)?$/);
    if (quoted) {
        // goToLink's sheet branch matches sheet names by exact equality → strip
        // the quotes; cellrange keeps the quoted form (getcellrange parses it).
        return quoted[2]
            ? { linkType: 'cellrange', linkAddress: location }
            : { linkType: 'sheet', linkAddress: unquoteSheetName(quoted[1]) };
    }
    return location.includes('!')
        ? { linkType: 'cellrange', linkAddress: location }
        : { linkType: 'sheet', linkAddress: location };
}

// exceljs drops location-form hyperlinks on read: the worksheet parse keeps the
// location attribute (hyperlink-xform.js parseOpen), but reconcile only maps
// rel-based entries onto cells and then deletes the parsed collection
// (worksheet-xform.js:469-474, 526) — the streaming reader never reads the
// attribute at all. Excel itself authors internal links in exactly this form
// (<hyperlink ref location=…> without a rel), so recover them straight from the
// worksheet XML. Returns sheet name → (anchor cell ref → location target).
// Reuses the zip loaded by xlsxToSheets — no second decompression pass.
async function readLocationHyperlinks(zip: JSZip): Promise<Map<string, Map<string, string>>> {
    const bySheet = new Map<string, Map<string, string>>();
    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (workbookXml == null || relsXml == null) return bySheet;

    const relTargets = new Map<string, string>();
    for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
        const id = xmlAttribute(tag, 'Id');
        const target = xmlAttribute(tag, 'Target');
        if (id != null && target != null) relTargets.set(id, target);
    }

    for (const tag of workbookXml.match(/<sheet\b[^>]*>/g) ?? []) {
        const name = xmlAttribute(tag, 'name');
        const rId = xmlAttribute(tag, 'r:id');
        const target = rId != null ? relTargets.get(rId) : undefined;
        if (name == null || target == null) continue;
        // Workbook-rel targets are relative to xl/ unless rooted.
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        const sheetXml = await zip.file(path)?.async('string');
        if (sheetXml == null) continue;
        const links = parseLocationHyperlinks(sheetXml);
        if (links.size > 0) bySheet.set(name, links);
    }
    return bySheet;
}

function parseLocationHyperlinks(sheetXml: string): Map<string, string> {
    const links = new Map<string, string>();
    const block = sheetXml.match(/<hyperlinks(?:\s[^>]*)?>([\s\S]*?)<\/hyperlinks>/);
    if (!block) return links;
    for (const tag of block[1].match(/<hyperlink\b[^>]*>/g) ?? []) {
        const ref = xmlAttribute(tag, 'ref');
        const location = xmlAttribute(tag, 'location');
        if (ref == null || location == null) continue;
        // ref may span a range; the anchor cell carries the link.
        links.set(ref.split(':')[0], location);
    }
    return links;
}

// OOXML attributes are double-quoted; entity decoding goes through `he` (already
// the mail parser's decoder), which covers the XML named + numeric entities.
function xmlAttribute(tag: string, name: string): string | null {
    const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
    return match ? he.decode(match[1]) : null;
}

function extractValueAndDisplay(cell: XlsxCell): { value?: string | number | boolean; display?: string } {
    const raw = cell.value;
    if (raw === null || raw === undefined) return {};

    if (typeof raw === 'number') {
        return { value: raw, display: numberDisplay(raw, cell.numFmt) };
    }

    if (typeof raw === 'boolean') {
        return { value: raw, display: booleanDisplay(raw) };
    }

    if (typeof raw === 'string') {
        return { value: raw, display: raw };
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
        const text = hyperlinkText(raw);
        return { value: text, display: text };
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
    if (typeof result === 'number') {
        return { value: result, display: numberDisplay(result, numFmt) };
    }
    if (typeof result === 'boolean') {
        return { value: result, display: booleanDisplay(result) };
    }
    if (typeof result === 'string') {
        return { value: result, display: result };
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
    // Render with the same formatter the sheet engine uses (numfmt) so the imported display
    // matches the editor — Excel date formats use lowercase month tokens (m/mm/mmm) and "…"
    // literal-text escapes that a hand-rolled replacer mangles. numfmt renders a bare serial
    // under 'General' as a raw number, so undated cells fall back to a date pattern; a malformed
    // format string from a hostile workbook makes numfmt throw, so guard this boundary.
    const fmt = numFmt && numFmt !== 'General' ? numFmt : 'm/d/yyyy';
    let display: string;
    try {
        display = update(fmt, serial);
    } catch {
        display = update('yyyy-mm-dd', serial);
    }
    return { value: serial, display };
}

function numberDisplay(value: number, numFmt?: string): string {
    if (!numFmt || numFmt === 'General') return String(value);
    // Same boundary guard as dateToSerialAndDisplay: a malformed format string from a
    // hostile workbook makes numfmt throw.
    try {
        return update(numFmt, value);
    } catch {
        return String(value);
    }
}

// Excel/ECMA-376 uses one format code (`m`/`M`, case-insensitively) for BOTH month and
// minute, resolved by context — minute when a run sits next to hours/seconds, month
// otherwise. numfmt (our renderer) resolves it the same way, so an imported `dd/mm/yyyy`
// DISPLAYS correctly. But the custom date/time dialog's tokenizer follows the Google
// convention (uppercase `M` month, lowercase `m` minute, case-significant), so a stored
// lowercase `mm` month shows a "Minute" chip — and editing that chip writes minute tokens
// into a month position. Canonicalise every `m`/`M` run to the Google convention at import,
// applying the exact same context classification numfmt uses, so the stored case matches the
// render and only the case of `m`/`M` ever changes. Bit flags mirror numfmt's dateChunks:
// only HOUR/SEC (a preceding one makes a run a minute) and MIN (a following seconds resolves
// a deferred month) participate; every other date token is a size-0 adjacency breaker.
const DATE_HOUR = 1;
const DATE_MIN = 2;
const DATE_SEC = 4;

type DateChunk = { size: number; used?: boolean; indeterminate?: boolean; mRef?: number };

// Split on top-level `;` section separators, leaving separators inside quoted literals,
// `\`-escapes and `[...]` brackets in place.
function splitFormatSections(fmt: string): string[] {
    const sections: string[] = [];
    let current = '';
    let i = 0;
    while (i < fmt.length) {
        const ch = fmt[i];
        if (ch === '"') {
            const end = fmt.indexOf('"', i + 1);
            const stop = end === -1 ? fmt.length : end + 1;
            current += fmt.slice(i, stop);
            i = stop;
        } else if (ch === '\\' && i + 1 < fmt.length) {
            current += fmt.slice(i, i + 2);
            i += 2;
        } else if (ch === '[') {
            const end = fmt.indexOf(']', i + 1);
            const stop = end === -1 ? fmt.length : end + 1;
            current += fmt.slice(i, stop);
            i = stop;
        } else if (ch === ';') {
            sections.push(current);
            current = '';
            i += 1;
        } else {
            current += ch;
            i += 1;
        }
    }
    sections.push(current);
    return sections;
}

function normalizeSectionMonthMinute(section: string): string {
    const out: string[] = [];
    const chunks: DateChunk[] = [];
    let i = 0;
    while (i < section.length) {
        const rest = section.slice(i);
        const ch = section[i];

        if (ch === '"') {
            const end = section.indexOf('"', i + 1);
            const stop = end === -1 ? section.length : end + 1;
            out.push(section.slice(i, stop));
            i = stop;
            continue;
        }
        // `\x` escape and `_x`/`*x` fill/skip all consume the next char as a literal —
        // its letter must never be read as a date token.
        if ((ch === '\\' || ch === '_' || ch === '*') && i + 1 < section.length) {
            out.push(section.slice(i, i + 2));
            i += 2;
            continue;
        }
        // AM/PM and A/P carry `m`/`p` letters but are not adjacency tokens — skip whole.
        const ampm = rest.match(/^(am\/pm|a\/p)/i);
        if (ampm) {
            out.push(ampm[0]);
            i += ampm[0].length;
            continue;
        }
        if (ch === '[') {
            const end = section.indexOf(']', i + 1);
            if (end !== -1) {
                const inner = section.slice(i + 1, end);
                if (/^m+$/i.test(inner)) {
                    // Elapsed minutes `[m]`/`[mm]` — always minute, always lowercase.
                    out.push(`[${'m'.repeat(inner.length)}]`);
                    chunks.push({ size: DATE_MIN });
                } else if (/^h+$/i.test(inner)) {
                    out.push(section.slice(i, end + 1));
                    chunks.push({ size: DATE_HOUR });
                } else if (/^s+$/i.test(inner)) {
                    out.push(section.slice(i, end + 1));
                    chunks.push({ size: DATE_SEC });
                } else {
                    // Colour / condition / currency locale — not a date token.
                    out.push(section.slice(i, end + 1));
                }
                i = end + 1;
                continue;
            }
        }

        const hour = rest.match(/^[hH]+/);
        if (hour) {
            out.push(hour[0]);
            chunks.push({ size: DATE_HOUR });
            i += hour[0].length;
            continue;
        }
        const sec = rest.match(/^[sS]+/);
        if (sec) {
            out.push(sec[0]);
            const last = chunks[chunks.length - 1];
            let usedByMinute = false;
            if (last && last.size & DATE_MIN) {
                usedByMinute = true;
            } else if (last?.indeterminate && last.mRef != null) {
                // Seconds resolve a deferred month back to a minute.
                last.indeterminate = false;
                last.size = DATE_MIN;
                out[last.mRef] = out[last.mRef].toLowerCase();
                usedByMinute = true;
            }
            chunks.push({ size: DATE_SEC, used: usedByMinute });
            i += sec[0].length;
            continue;
        }
        const month = rest.match(/^[mM]+/);
        if (month) {
            const len = month[0].length;
            const idx = out.length;
            if (len >= 3) {
                // mmm/mmmm/mmmmm are always month names.
                out.push('M'.repeat(len));
                chunks.push({ size: 0 });
            } else {
                const last = chunks[chunks.length - 1];
                if (last && !last.used && last.size & (DATE_HOUR | DATE_SEC)) {
                    last.used = true;
                    out.push('m'.repeat(len));
                    chunks.push({ size: DATE_MIN });
                } else {
                    // Undecided → month for now; a later seconds token may flip it.
                    out.push('M'.repeat(len));
                    chunks.push({ size: 0, indeterminate: true, mRef: idx });
                }
            }
            i += len;
            continue;
        }
        // Other date tokens (year/day/b-year/era/weekday) only break hour/second adjacency.
        const other = rest.match(/^([yY]+|[dD]+|[bB]+|[gG]+|e+|[aA]{3,})/);
        if (other) {
            out.push(other[0]);
            chunks.push({ size: 0 });
            i += other[0].length;
            continue;
        }

        out.push(ch);
        i += 1;
    }
    return out.join('');
}

export function normalizeMonthMinuteTokens(numFmt: string): string {
    if (!/[mM]/.test(numFmt)) return numFmt;
    return splitFormatSections(numFmt).map(normalizeSectionMonthMinute).join(';');
}

function buildCellType(cell: XlsxCell, value: string | number | boolean | undefined): FortuneCell['ct'] {
    const t = resolveType(cell, value);
    const rawNumFmt = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : null;
    // Store the Google-convention form so the custom date/time dialog labels chips correctly;
    // numfmt renders the canonicalised string identically to the original.
    const numFmt = rawNumFmt != null ? normalizeMonthMinuteTokens(rawNumFmt) : null;
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

// exceljs's CellHyperlinkValue declares `text: string`, but real-world xlsx files
// (notably Google Sheets exports) put a CellRichTextValue here. Flatten both shapes
// to a plain string so callers can rely on the return type.
function hyperlinkText(raw: { text: unknown }): string {
    const t = raw.text;
    if (typeof t === 'string') return t;
    if (t && typeof t === 'object' && 'richText' in t) {
        return (t as CellRichTextValue).richText.map((r) => r.text).join('');
    }
    return '';
}

function isError(value: unknown): value is { error: string } {
    return typeof value === 'object' && value !== null && 'error' in value;
}
