import type {
    BorderSide,
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Cell as FortuneCell,
    InlineStringSegment,
    MergeCell,
    Sheet,
    SingleRange,
} from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import {
    columnIndexToLabel,
    iscelldata,
    parseA1Range,
    quoteSheetName,
    rowIndexToLabel,
    toA1,
} from '@workspace/sheet/engine';
import type {
    Border,
    Borders,
    ConditionalFormattingRule,
    DataValidation,
    DataValidationOperator,
    Font,
    RichText,
    Cell as XlsxCell,
} from 'exceljs';
import JSZip from 'jszip';
import { runTransformToBytes } from '../../document/transform/run-transform';
import { EXPORT_TRANSFORM_DEADLINE_MS } from '../../document/transform/runner';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { resolveFontFamily } from './fonts';
import { type CellBorderSides, expandBorderInfo } from './range-borders';

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

export async function exportSheetsToXlsx(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    const title = stripEigenExtension(drivePath.name);
    const job = { kind: 'export', documentType: 'eigensheets', format: 'xlsx', title } as const;

    return {
        data: await runTransformToBytes(mount, drivePath, job, { deadlineMs: EXPORT_TRANSFORM_DEADLINE_MS, signal }),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: `${title}.xlsx`,
    };
}

export async function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer> {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // Internal-link labels per worksheet (1-based, matching sheetN.xml), injected
    // as the `display` attribute by rewriteInternalHyperlinks below.
    const internalLinkLabels = new Map<number, Map<string, string>>();

    for (const [sheetIndex, sheet] of sheets.entries()) {
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

        if (sheet.hyperlink) {
            const cellByKey = new Map<string, FortuneCell>();
            for (const { r, c, v } of sheet.celldata ?? []) {
                if (v) cellByKey.set(`${r}_${c}`, v);
            }
            for (const [key, link] of Object.entries(sheet.hyperlink)) {
                const cell = cellByKey.get(key);
                // exceljs models a hyperlink as the cell VALUE ({text, hyperlink}),
                // so a formula cell can't carry one — the formula wins.
                if (cell?.f) continue;
                const target = hyperlinkTarget(link, sheet.name);
                // Blocked scheme or unbuildable location: the cell stays plain text.
                if (target == null) continue;
                // Keep the display applyCellValue produced: ct.s runs survive inside
                // a hyperlink value — exceljs's CellHyperlinkValue declares
                // `text: string`, but its writer stores the display via
                // SharedStringsXform.add, which dispatches on `.richText`, so the
                // runs land intact in sharedStrings.xml.
                const richText = inlineSegmentsToRichText(cell?.ct?.s);
                const display = cell?.m != null ? String(cell.m) : cell?.v != null ? String(cell.v) : '';
                const [r, c] = key.split('_').map(Number);
                worksheet.getCell(r + 1, c + 1).value = {
                    // exceljs detects hyperlink values by `text && hyperlink` — an
                    // empty display string would degrade the cell to a plain object,
                    // so fall back to the link address.
                    text: richText ? { richText } : display !== '' ? display : link.linkAddress,
                    hyperlink: target,
                } as XlsxCell['value'];
                if (link.linkType !== 'webpage') {
                    const label = richText ? richText.map((run) => run.text).join('') : display;
                    const labels = internalLinkLabels.get(sheetIndex + 1) ?? new Map<string, string>();
                    internalLinkLabels.set(sheetIndex + 1, labels);
                    labels.set(toA1(r, c), label !== '' ? label : link.linkAddress);
                }
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
            // exceljs merge constituents SHARE the master's style object (lib/doc/
            // cell.js merge() assigns `this.style = master.style`), so writing
            // `cell.border` per constituent would clobber the shared border — the
            // last constituent wins and the merge loses e.g. its left edge. Compose
            // ONE border per merge instead: a side counts only from constituents on
            // the merge's matching edge (the editor's render compute ignores
            // non-edge sides under a merge, packages/sheet state/modules/border.ts);
            // same-side conflicts resolve last-write-wins per side in map order.
            const mergeAt = mergeConstituents(config.merge);
            const mergeBorders = new Map<string, CellBorderSides>();
            for (const [key, sides] of expandBorderInfo(config.borderInfo)) {
                const [r, c] = key.split('_').map(Number);
                const merge = mergeAt.get(key);
                if (merge) {
                    const union = mergeBorders.get(`${merge.r}_${merge.c}`) ?? {};
                    if (sides.l && c === merge.c) union.l = sides.l;
                    if (sides.r && c === merge.c + merge.cs - 1) union.r = sides.r;
                    if (sides.t && r === merge.r) union.t = sides.t;
                    if (sides.b && r === merge.r + merge.rs - 1) union.b = sides.b;
                    mergeBorders.set(`${merge.r}_${merge.c}`, union);
                    continue;
                }
                const border = toBorder(sides);
                if (border) worksheet.getCell(r + 1, c + 1).border = border;
            }
            for (const [key, sides] of mergeBorders) {
                const border = toBorder(sides);
                if (!border) continue;
                const [r, c] = key.split('_').map(Number);
                // One write through the anchor lands on every constituent via the
                // shared style — Excel renders the merge perimeter from the edge
                // cells' sides and ignores the sides facing inward.
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
    return rewriteInternalHyperlinks(Buffer.from(arrayBuffer), internalLinkLabels);
}

// exceljs rels EVERY hyperlink (worksheet-xform prepare), so location-form internal
// links come out with a redundant TargetMode="External" rel and an r:id on the
// element. Per ECMA-376 the r:id wins over location, so Excel/Google chase the rel
// — and `'Sheet'!A1` is not a resolvable URI (Google shows "Invalid link"). Excel
// and Google author internal links location-only, with the link label in the
// display attribute; rewrite our elements to that exact form — strip the junk
// rel, inject display.
async function rewriteInternalHyperlinks(
    buffer: Buffer,
    labelsBySheet: Map<number, Map<string, string>>,
): Promise<Buffer> {
    const zip = await JSZip.loadAsync(buffer);
    let changed = false;
    for (const path of Object.keys(zip.files)) {
        const sheetFile = path.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
        if (!sheetFile) continue;
        const labels = labelsBySheet.get(Number(sheetFile[1]));
        const ids: string[] = [];
        const xml = await zip.files[path].async('string');
        const stripped = xml.replace(/<hyperlink\b[^>]*>/g, (el) => {
            const rid = el.includes('location="') ? el.match(/ r:id="(rId\d+)"/) : null;
            if (!rid) return el;
            ids.push(rid[1]);
            let out = el.replace(rid[0], '');
            // Google's importer labels internal links from the display attribute
            // (its own xlsx exports carry it); without one it shows its rewritten
            // #gid=N target as the cell text. exceljs never writes display.
            const ref = out.match(/ ref="([^"]+)"/);
            const label = ref ? labels?.get(ref[1]) : undefined;
            if (label != null) out = out.replace('/>', ` display="${escapeXmlAttribute(label)}"/>`);
            return out;
        });
        if (ids.length === 0) continue;
        changed = true;
        zip.file(path, stripped);
        const relsPath = `xl/worksheets/_rels/sheet${sheetFile[1]}.xml.rels`;
        const relsFile = zip.file(relsPath);
        if (relsFile) {
            let rels = await relsFile.async('string');
            for (const id of ids) {
                rels = rels.replace(new RegExp(`<Relationship [^>]*Id="${id}"[^>]*/>`), '');
            }
            zip.file(relsPath, rels);
        }
    }
    if (!changed) return buffer;
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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

function toBorder(sides: CellBorderSides): Partial<Borders> | null {
    const border = {
        ...(sides.l && { left: toBorderSide(sides.l) }),
        ...(sides.r && { right: toBorderSide(sides.r) }),
        ...(sides.t && { top: toBorderSide(sides.t) }),
        ...(sides.b && { bottom: toBorderSide(sides.b) }),
    };
    return Object.keys(border).length > 0 ? border : null;
}

function mergeConstituents(merge: Record<string, MergeCell> | undefined): Map<string, MergeCell> {
    const byCell = new Map<string, MergeCell>();
    for (const m of Object.values(merge ?? {})) {
        for (let r = m.r; r < m.r + m.rs; r += 1) {
            for (let c = m.c; c < m.c + m.cs; c += 1) {
                byCell.set(`${r}_${c}`, m);
            }
        }
    }
    return byCell;
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

// Mirror of exceljs's hyperlink-xform isInternalLink detection: a target matching
// this pattern is written as <hyperlink location=…> (the Excel-native internal
// form); anything else becomes an external rel. The pattern only admits a single
// trailing cell ref, so internal targets must end in one. Known exceljs edge
// (accepted): a webpage URL containing exactly one '!' with a cell-ref-shaped
// tail would be misdetected as internal by the same pattern — vanishingly rare.
const INTERNAL_LOCATION = /^[^!]+![a-zA-Z]+\d+$/;

function hyperlinkTarget(link: { linkType: string; linkAddress: string }, ownSheetName: string): string | null {
    if (link.linkType === 'webpage') return resolveWebLink(link.linkAddress);

    const location =
        link.linkType === 'sheet'
            ? // linkAddress is the bare sheet name; a location needs a !ref tail.
              `${quoteSheetName(link.linkAddress)}!A1`
            : cellrangeLocation(link.linkAddress, ownSheetName);
    // A target that fails exceljs's pattern (e.g. a sheet name containing '!')
    // would be written as a corrupt external rel — drop the link instead.
    return location != null && INTERNAL_LOCATION.test(location) ? location : null;
}

// cellrange linkAddress is stored verbatim from import/editor ('Sheet 2'!A1,
// Sheet2!B2:C3, bare A1). Keep the stored sheet prefix, reduce a range tail to
// its top-left cell (accepted drift — the location form only admits a single
// cell ref), and give bare refs the own sheet's quoted name (a location needs one).
function cellrangeLocation(linkAddress: string, ownSheetName: string): string | null {
    const quoted = linkAddress.match(/^('(?:[^']|'')*')!(.+)$/);
    const bang = linkAddress.indexOf('!');
    const [prefix, ref] = quoted
        ? [quoted[1], quoted[2]]
        : bang >= 0
          ? [linkAddress.slice(0, bang), linkAddress.slice(bang + 1)]
          : [quoteSheetName(ownSheetName), linkAddress];
    const parsed = parseA1Range(ref);
    return parsed ? `${prefix}!${toA1(parsed.start.row, parsed.start.col)}` : null;
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
        // it as a formula rule (accepted drift, docs/SHEETS.md).
        const compare = rule.conditionValue[0] === '0' ? '>1' : rule.conditionValue[0] === '1' ? '=1' : null;
        if (compare == null) return null; // the engine evaluator ignores other values too
        const anchor = toA1(rule.cellrange[0].row[0], rule.cellrange[0].column[0]);
        const countifs = rule.cellrange.map((range) => `COUNTIF(${singleRangeToAbsoluteA1(range)},${anchor})`);
        return { type: 'expression', priority, formulae: [countifs.join('+') + compare], style };
    }

    // occurrenceDate: editor-only, no xlsx equivalent — accepted drift (docs/SHEETS.md).
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
