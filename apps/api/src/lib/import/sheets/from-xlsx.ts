import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { Cell as FortuneCell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import {
    cellDisplay,
    cellWrapsText,
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
} from '@workspace/sheet/engine';
import { drawingTheme } from '../../core/drawingml';
import { ApiError } from '../../core/errors';
import { optional } from '../../core/opc';
import { MAX_DECOMPRESSED_BYTES } from '../../core/zip';
import type { CountedWarningCode, TransformWarning } from '../../document/transform/protocol';
import { type ImportedMedia, importMedia } from '../image-types';
import { IMPORT_MESSAGES, importError, TOO_MANY_CELLS } from '../messages';
import { readGrid } from './cells';
import { type Drawing, placeDrawings, readDrawing } from './drawing';
import { readBudget, readInBatches, readPackage } from './package';
import { readRules } from './rules';
import { readSharedStrings } from './strings';
import { defaultFontDigitWidth, readDxfs, readLooks, themePalette } from './styles';
import { readWorksheet } from './worksheet';

// xlsx bytes → Eigen's sheets, straight from the SpreadsheetML. Runs in the transform process.

// A cell costs about 480 B in the sheets alone, and recalc and the snapshot copy it: the cells emitted count, merged and
// validated ones among them, and every sheet's span, so a tiny file can't declare far-apart cells whose grid recalc
// walks. The byte cap catches a bomb of few cells.
export const MAX_CELLS = 4_000_000;

// The snapshot spells a cell's text out per cell, its value, its display and a rich string's runs; real workbooks emit
// under 120M characters.
export const MAX_TEXT = 250_000_000;
// A shared formula's copy is translated before it is weighed, at about 3M characters a second. The 986 workbooks of
// the corpus translate at most 3.1M characters (a GOV.UK inspections workbook, 24,706 copies); five times that is
// about 5 s.
export const MAX_SHARED_FORMULA_TEXT = 16_000_000;
// Recalc materialises a sheet's rows by its columns, each at least a default grid's (engine/defaults.ts), about 13 bytes
// a slot, so a narrow sheet's span is far smaller than its grid. The 986 workbooks of the corpus build at most 27.3M
// (docling's inflated test file, one sheet of a million rows); four times that recalcs in about a second at 1.4 GB.
export const MAX_GRID_SLOTS = 110_000_000;

export type XlsxOptions = {
    // The upload cap, which bounds the pictures' bytes as an upload of each would be bounded.
    maxMediaBytes: number;
};

// The sheets alone, their pictures' media names left unresolved: the shape the tests and the audit compare.
export function xlsxToSheets(bytes: Uint8Array, warnings: TransformWarning[] = []): Sheet[] {
    return readXlsx(bytes, { maxMediaBytes: MAX_DECOMPRESSED_BYTES }, warnings).sheets;
}

// Every worksheet's grid and what lies past it, charged against the output budget as it is read. The cells count what
// they emit, a value, a rich string's run, a border, a row's height or hidden flag, a merged or linked cell, a column's
// width, a rule's range or a validated cell, and the grids recalc materialises; the text counts every value, display,
// run, formula, link and rule text, each shared string and shared formula once per copy. A chart sheet is a sheet
// without a grid. The pictures come back beside the sheets as the media files their images name. What was left out is
// counted in `warnings`.
export function readXlsx(
    bytes: Uint8Array,
    options: XlsxOptions,
    warnings: TransformWarning[] = [],
): { sheets: Sheet[]; media: ImportedMedia[] } {
    try {
        const book = readPackage(bytes);
        const budget = readBudget();
        const palette = themePalette(book.theme);
        const looks = readLooks(book.styles, palette);
        const strings = readSharedStrings(book.sharedStrings, palette, budget);
        const dxfs = readDxfs(book.styles, palette);
        const digitWidth = defaultFontDigitWidth(book.styles);
        const emitted = { cells: 0, text: 0, span: 0, slots: 0, translated: 0 };
        const charge = (cells: number, text: number) => {
            emitted.cells += cells;
            emitted.text += text;
            if (emitted.cells > MAX_CELLS) throw new ApiError(413, TOO_MANY_CELLS);
            if (emitted.text > MAX_TEXT) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
        };
        const chargeCopy = (chars: number) => {
            emitted.translated += chars;
            if (emitted.translated > MAX_SHARED_FORMULA_TEXT) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
        };
        const sheets: Sheet[] = [];
        // Excel refuses two sheets of one name, in any case: the first keeps it, so a formula naming it means that one,
        // and a later one is numbered as Excel numbers a copy, past every name the workbook holds.
        const taken = new Set(book.sheets.map(({ name }) => name.toLowerCase()));
        const named = new Set<string>();
        // A chart's refs name sheets as the workbook writes them: the first of a name is the one they mean.
        const sheetIds = new Map<string, string>();
        const drawings: Drawing[] = [];
        for (const { name: written, path, hidden, chartSheet } of book.sheets) {
            const part = book.pkg.zip.read(path);
            if (!part) continue;
            const id = `sheet-${sheets.length}`;
            if (!sheetIds.has(written.toLowerCase())) sheetIds.set(written.toLowerCase(), id);
            let name = written;
            for (let copy = 2; named.has(name.toLowerCase()); copy++) {
                name = `${written} (${copy})`;
                if (taken.has(name.toLowerCase())) name = written;
            }
            named.add(name.toLowerCase());
            taken.add(name.toLowerCase());
            // The rest is parsed before the rows, so the merges and links are placed when the grid reads its cells.
            const { rest, children } = readInBatches(part, 'sheetData', 'row', budget);
            // A damaged rels part costs the external links, not the workbook.
            const rels = optional(() => book.pkg.relationships(path)) ?? new Map();
            const worksheet = readWorksheet(rest, { id, digitWidth, rels, palette, charge });
            const grid = readGrid(children, {
                looks,
                strings,
                date1904: book.date1904,
                palette,
                charge,
                chargeCopy,
                placed: worksheet.placed,
            });
            // The cells' span, at least a default grid's so empty sheets add up; and the grid recalc materialises from it,
            // at least a default grid deep and wide, so a narrow sheet builds far more slots than it spans.
            emitted.span += Math.max(grid.rows * grid.columns, DEFAULT_SHEET_ROW_COUNT * DEFAULT_SHEET_COLUMN_COUNT);
            if (emitted.span > MAX_CELLS) throw new ApiError(413, TOO_MANY_CELLS);
            emitted.slots +=
                Math.max(grid.rows, DEFAULT_SHEET_ROW_COUNT) * Math.max(grid.columns, DEFAULT_SHEET_COLUMN_COUNT);
            if (emitted.slots > MAX_GRID_SLOTS) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
            const { merge = {}, columnlen = {} } = worksheet.config;
            const columnWidth = sheetDefaultColWidth(worksheet.sheet);
            const rowHeight = sheetDefaultRowHeight(worksheet.sheet);
            const tallest = new Map<number, number>();
            for (const { r, c, v } of grid.celldata) {
                const height = estimateCellHeight(v, c, r, merge, columnlen, columnWidth);
                if (height > Math.max(rowHeight, tallest.get(r) ?? 0)) tallest.set(r, height);
            }
            const rowlen: NonNullable<SheetConfig['rowlen']> = {};
            for (const [r, height] of tallest) rowlen[r] = Math.round(height);
            // A row at the sheet's default height has none of its own.
            for (const [r, points] of grid.heights) {
                const pixels = Math.round(ptToPx(points));
                if (pixels !== rowHeight) rowlen[r] = pixels;
            }
            const config: SheetConfig = { ...worksheet.config };
            if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
            if (Object.keys(grid.rowhidden).length > 0) config.rowhidden = grid.rowhidden;
            if (Object.keys(grid.borderInfo).length > 0) config.borderInfo = grid.borderInfo;
            const sheet: Sheet = {
                name,
                id,
                order: sheets.length,
                ...(hidden && { hide: 1 }),
                celldata: grid.celldata,
                config,
                ...worksheet.sheet,
                ...readRules(rest, {
                    dxfs,
                    palette,
                    date1904: book.date1904,
                    rows: grid.rows,
                    columns: grid.columns,
                    dates: grid.dates,
                    charge,
                    chargeElements: budget.chargeElements,
                }),
            };
            sheets.push(sheet);
            const drawing = readDrawing(book.pkg, rest, rels);
            if (drawing) drawings.push({ sheet, chartSheet: chartSheet === true, ...drawing });
        }
        // An import replaces the document's sheets: none read is a file it can't read, never an empty spreadsheet.
        if (sheets.length === 0) throw new ApiError(400, IMPORT_MESSAGES.xlsx.invalid);
        const files = importMedia('xlsx', (path) => optional(() => book.pkg.zip.read(path)), options.maxMediaBytes);
        const losses = new Map<CountedWarningCode, number>();
        placeDrawings(drawings, {
            pkg: book.pkg,
            theme: drawingTheme(book.theme),
            sheetIds,
            spend: budget.spendElements,
            charge,
            mediaName: files.name,
            lost: (code) => losses.set(code, (losses.get(code) ?? 0) + 1),
        });
        for (const [code, count] of losses) warnings.push({ code, count });
        // Excel refuses to hide every sheet, and the editor opens on one it shows.
        if (sheets.every((sheet) => sheet.hide === 1)) delete sheets[0].hide;
        return { sheets, media: files.media };
    } catch (error) {
        throw importError(error, 'xlsx');
    }
}

const DEFAULT_FONT_SIZE = 11;
const LINE_HEIGHT_FACTOR = 1.35;

function estimateCellHeight(
    converted: FortuneCell,
    c: number,
    r: number,
    merge: NonNullable<SheetConfig['merge']>,
    colWidthPx: Record<number, number>,
    defaultColWidth: number,
): number {
    const fontSize = converted.fs ?? DEFAULT_FONT_SIZE;
    const lineHeightPx = ptToPx(fontSize) * LINE_HEIGHT_FACTOR;
    if (!cellWrapsText(converted)) {
        return fontSize > DEFAULT_FONT_SIZE ? lineHeightPx + 6 : 0;
    }

    const text = String(cellDisplay(converted) ?? '');
    if (!text) return lineHeightPx + 6;

    let cellWidth = colWidthPx[c] ?? defaultColWidth;
    const mergeKey = `${r}_${c}`;
    const mergeInfo = merge[mergeKey];
    if (mergeInfo?.cs && mergeInfo.cs > 1) {
        cellWidth = 0;
        for (let ci = mergeInfo.c; ci < mergeInfo.c + mergeInfo.cs; ci++) {
            cellWidth += colWidthPx[ci] ?? defaultColWidth;
        }
    }

    const charsPerLine = Math.max(1, cellWidth / (fontSize * 0.6));
    let totalLines = 0;
    for (const line of text.split('\n')) {
        totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return totalLines * lineHeightPx + 6;
}
