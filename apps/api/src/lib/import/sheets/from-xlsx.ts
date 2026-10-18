import type { Cell as FortuneCell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_COL_WIDTH, SHEET_DEFAULT_ROW_HEIGHT } from '@workspace/lib/sheets';
import { cellWrapsText, DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import { SML_NS } from '../../core/ooxml';
import { optional } from '../../core/opc';
import { xmlAttr, xmlChild } from '../../core/xml';
import { IMPORT_MESSAGES, importError, ONLY_CHART_SHEETS, TOO_MANY_CELLS } from '../messages';
import { readGrid } from './cells';
import { readBudget, readInBatches, readPackage } from './package';
import { readRules } from './rules';
import { readSharedStrings } from './strings';
import { readDxfs, readLooks, themePalette } from './styles';
import { digitWidthOf, readWorksheet } from './worksheet';

// xlsx bytes → Eigen's sheets, straight from the SpreadsheetML. Runs in the transform process.

const DEFAULT_ROW_HEIGHT_PT = 15.75;

// A cell costs about 480 B in the sheets alone, and recalc and the snapshot copy it: the cells emitted count, merged and
// validated ones among them, and every sheet's span, so a tiny file can't declare far-apart cells whose grid recalc
// walks. The byte cap catches a bomb of few cells.
export const MAX_CELLS = 4_000_000;

// A cell's text, value and display, is a copy per cell for a rich string and in the snapshot for any; real workbooks
// emit under 120M characters.
export const MAX_TEXT = 250_000_000;
// A shared formula's copy is translated before it is weighed, at about 3M characters a second. The 986 workbooks of
// the corpus translate at most 3.1M characters (a GOV.UK inspections workbook, 24,706 copies); five times that is
// about 5 s.
export const MAX_SHARED_FORMULA_TEXT = 16_000_000;
// Recalc materialises a sheet's rows by its columns, each at least a default grid's (engine/defaults.ts), about 13 bytes
// a slot, so a narrow sheet's span is far smaller than its grid. The 986 workbooks of the corpus build at most 27.3M
// (docling's inflated test file, one sheet of a million rows); four times that recalcs in about a second at 1.4 GB.
export const MAX_GRID_SLOTS = 110_000_000;

// Every worksheet's grid and what lies past it, charged against the output budget as it is read. The cells count what
// they emit, a value, a border, a row's height or hidden flag, a merged or linked cell, a column's width, a rule's range
// or a validated cell, and the grids recalc materialises; the text counts every value, display, formula, link and rule
// text, each shared string and shared formula once per copy.
export function xlsxToSheets(bytes: Uint8Array): Sheet[] {
    try {
        const book = readPackage(bytes);
        const budget = readBudget();
        const palette = themePalette(book.theme);
        const looks = readLooks(book.styles, palette);
        const strings = readSharedStrings(book.sharedStrings, palette, budget);
        const dxfs = readDxfs(book.styles, palette);
        const fonts = book.styles && xmlChild(book.styles, SML_NS, 'fonts');
        const font = fonts && xmlChild(fonts, SML_NS, 'font');
        const fontName = font && xmlChild(font, SML_NS, 'name');
        const digitWidth = digitWidthOf(fontName && xmlAttr(fontName, '', 'val'));
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
        for (const { name: written, path } of book.sheets) {
            const part = book.pkg.zip.read(path);
            if (!part) continue;
            const id = `sheet-${sheets.length}`;
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
            const worksheet = readWorksheet(rest, { id, digitWidth, rels, charge });
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
            const tallest = new Map<number, number>();
            for (const { r, c, v } of grid.celldata) {
                const height = estimateCellHeight(v, c, r, merge, columnlen);
                if (height > Math.max(SHEET_DEFAULT_ROW_HEIGHT, tallest.get(r) ?? 0)) tallest.set(r, height);
            }
            const rowlen: NonNullable<SheetConfig['rowlen']> = {};
            for (const [r, height] of tallest) rowlen[r] = Math.round(height);
            for (const [r, points] of grid.heights)
                if (points !== DEFAULT_ROW_HEIGHT_PT) rowlen[r] = Math.round(points * (4 / 3));
            const config: SheetConfig = { ...worksheet.config };
            if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
            if (Object.keys(grid.rowhidden).length > 0) config.rowhidden = grid.rowhidden;
            if (Object.keys(grid.borderInfo).length > 0) config.borderInfo = grid.borderInfo;
            const sheet: Sheet = {
                name,
                id,
                order: sheets.length,
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
        }
        // An import replaces the document's sheets: none read is a file it can't read, never an empty spreadsheet.
        if (sheets.length === 0)
            throw new ApiError(400, book.hasChartSheets ? ONLY_CHART_SHEETS : IMPORT_MESSAGES.xlsx.invalid);
        return sheets;
    } catch (error) {
        throw importError(error, 'xlsx');
    }
}

const DEFAULT_FONT_SIZE = 11;
const PT_TO_PX = 4 / 3;
const LINE_HEIGHT_FACTOR = 1.35;

function estimateCellHeight(
    converted: FortuneCell,
    c: number,
    r: number,
    merge: NonNullable<SheetConfig['merge']>,
    colWidthPx: Record<number, number>,
): number {
    const fontSize = converted.fs ?? DEFAULT_FONT_SIZE;
    const lineHeightPx = fontSize * PT_TO_PX * LINE_HEIGHT_FACTOR;
    if (!cellWrapsText(converted)) {
        return fontSize > DEFAULT_FONT_SIZE ? lineHeightPx + 6 : 0;
    }

    const text = String(converted.m ?? '');
    if (!text) return lineHeightPx + 6;

    let cellWidth = colWidthPx[c] ?? SHEET_DEFAULT_COL_WIDTH;
    const mergeKey = `${r}_${c}`;
    const mergeInfo = merge[mergeKey];
    if (mergeInfo?.cs && mergeInfo.cs > 1) {
        cellWidth = 0;
        for (let ci = mergeInfo.c; ci < mergeInfo.c + mergeInfo.cs; ci++) {
            cellWidth += colWidthPx[ci] ?? SHEET_DEFAULT_COL_WIDTH;
        }
    }

    const charsPerLine = Math.max(1, cellWidth / (fontSize * 0.6));
    let totalLines = 0;
    for (const line of text.split('\n')) {
        totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return totalLines * lineHeightPx + 6;
}
