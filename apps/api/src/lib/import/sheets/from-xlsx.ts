// Reads an xlsx file into Eigen's sheets, straight from the SpreadsheetML, with the pictures and the warnings for what
// it left out. It runs in the transform process, which an xlsx import or convert hands the file to.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { Cell as FortuneCell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import {
    cellDisplay,
    cellWrapsText,
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
} from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import type { TransformWarning } from '../../document/transform/protocol';
import { lossCounter } from '../../document/transform/protocol';
import { budget } from '../../ooxml/budget';
import { drawingTheme } from '../../ooxml/drawingml';
import { optional } from '../../ooxml/opc';
import { MAX_DECOMPRESSED_BYTES } from '../../ooxml/zip';
import type { ImportedMedia } from '../image-types';
import { importMedia } from '../image-types';
import { IMPORT_MESSAGES, importError, TOO_MANY_CELLS } from '../messages';
import { readGrid } from './cells';
import type { Drawing } from './drawing';
import { placeDrawings, readSheetDrawing } from './drawing';
import { readBudget, readInBatches, readXlsxPackage } from './package';
import { readRules } from './rules';
import { readSharedStrings } from './strings';
import { defaultFontDigitWidth, readDxfs, readLooks, themePalette } from './styles';
import { readWorksheet } from './worksheet';

// A cell costs about 480 B in the sheets alone, and recalc and the snapshot copy it: the cells emitted count, merged and
// validated ones among them, and every sheet's span, so a tiny file can't declare far-apart cells whose grid recalc
// walks. The byte cap catches a bomb of few cells.
export const MAX_CELLS = 4_000_000;

// The snapshot spells a cell's text out per cell, its value, its display and a rich string's runs; real workbooks emit
// under 120M characters.
export const MAX_TEXT = 250_000_000;
// A shared formula's copy is translated before it is weighed, at about 3M characters a second. The corpus translates
// at most 3.1M characters, in a GOV.UK inspections workbook of 24,706 copies. Five times that is about 5 s.
export const MAX_SHARED_FORMULA_TEXT = 16_000_000;
// Recalc materialises a sheet's rows by its columns, each at least a default grid's, at about 13 bytes a slot, so a
// narrow sheet's span is far smaller than its grid. The corpus builds at most 27.3M, in docling's inflated test file of
// one sheet of a million rows. Four times that recalcs in about a second at 1.4 GB.
export const MAX_GRID_SLOTS = 110_000_000;

export type XlsxOptions = {
    maxMediaBytes: number;
};

// Every worksheet's grid and what lies past it, charged against the output budget as it is read. The cells count what
// they emit, a value, a rich string's run, a border, a row's height or hidden flag, a merged or linked cell, a column's
// width, a rule's range or a validated cell, and the grids recalc materialises; the text counts every value, display,
// run, formula, link and rule text, each shared string and shared formula once per copy. A chart sheet is a sheet
// without a grid. The pictures come back beside the sheets as the media files their images name, and what was left out
// as warnings that count it.
export function readXlsx(
    bytes: Uint8Array,
    options: XlsxOptions,
): { sheets: Sheet[]; media: ImportedMedia[]; warnings: TransformWarning[] } {
    try {
        const book = readXlsxPackage(bytes);
        const reads = readBudget();
        const palette = themePalette(book.theme);
        const looks = readLooks(book.styles, palette);
        const strings = readSharedStrings(book.sharedStrings, palette, reads);
        const dxfs = readDxfs(book.styles, palette);
        const digitWidth = defaultFontDigitWidth(book.styles);
        const { tooLarge } = IMPORT_MESSAGES.xlsx;
        const emitted = {
            cells: budget(MAX_CELLS, TOO_MANY_CELLS),
            text: budget(MAX_TEXT, tooLarge),
            span: budget(MAX_CELLS, TOO_MANY_CELLS),
            slots: budget(MAX_GRID_SLOTS, tooLarge),
            translated: budget(MAX_SHARED_FORMULA_TEXT, tooLarge),
        };
        const charge = (cells: number, text: number) => {
            emitted.cells.charge(cells);
            emitted.text.charge(text);
        };
        const losses = lossCounter();
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
            if (named.has(written.toLowerCase())) {
                let copy = 2;
                while (taken.has(`${written} (${copy})`.toLowerCase())) copy++;
                name = `${written} (${copy})`;
            }
            named.add(name.toLowerCase());
            taken.add(name.toLowerCase());
            // The rest is parsed before the rows, so the merges and links are placed when the grid reads its cells.
            const { rest, children } = readInBatches(part, 'sheetData', 'row', reads);
            // A damaged rels part costs the external links, not the workbook.
            const rels = optional(() => book.pkg.relationships(path)) ?? new Map();
            const worksheet = readWorksheet(rest, { id, digitWidth, rels, palette, charge });
            const grid = readGrid(children, {
                looks,
                strings,
                date1904: book.date1904,
                palette,
                charge,
                chargeCopy: emitted.translated.charge,
                placed: worksheet.placed,
            });
            // The cells' span, at least a default grid's so empty sheets add up; and the grid recalc materialises from it,
            // at least a default grid deep and wide, so a narrow sheet builds far more slots than it spans.
            emitted.span.charge(
                Math.max(grid.rows * grid.columns, DEFAULT_SHEET_ROW_COUNT * DEFAULT_SHEET_COLUMN_COUNT),
            );
            emitted.slots.charge(
                Math.max(grid.rows, DEFAULT_SHEET_ROW_COUNT) * Math.max(grid.columns, DEFAULT_SHEET_COLUMN_COUNT),
            );
            const { merge = {}, columnlen = {} } = worksheet.config;
            const columnWidth = sheetDefaultColWidth(worksheet.sheet);
            const rowHeight = sheetDefaultRowHeight(worksheet.sheet);
            const tallest = new Map<number, number>();
            for (const { r, c, v } of grid.celldata) {
                const height = estimateCellHeight(v, r, c, merge, columnlen, columnWidth);
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
                    chargeElements: reads.elements.charge,
                    lost: losses.lost,
                }),
            };
            sheets.push(sheet);
            const drawing = readSheetDrawing(book.pkg, rest, rels);
            if (drawing) drawings.push({ sheet, chartSheet, ...drawing });
        }
        // An import replaces the document's sheets: none read is a file it can't read, never an empty spreadsheet.
        if (sheets.length === 0) throw new ApiError(400, IMPORT_MESSAGES.xlsx.invalid);
        const files = importMedia('xlsx', book.pkg.readMedia, options.maxMediaBytes);
        placeDrawings(drawings, {
            pkg: book.pkg,
            theme: drawingTheme(book.theme),
            sheetIds,
            spend: reads.elements.spend,
            charge,
            mediaName: files.name,
            lost: losses.lost,
        });
        // Excel refuses to hide every sheet, and the editor opens on one it shows.
        if (sheets.every((sheet) => sheet.hide === 1)) delete sheets[0].hide;
        return { sheets, media: files.media, warnings: losses.warnings() };
    } catch (error) {
        throw importError(error, 'xlsx');
    }
}

// The sheets alone, their pictures' media names left unresolved: the shape the tests and the audit compare.
export function xlsxToSheets(bytes: Uint8Array): Sheet[] {
    return readXlsx(bytes, { maxMediaBytes: MAX_DECOMPRESSED_BYTES }).sheets;
}

// Excel's default font size, which the estimate takes for a cell whose look names none.
const DEFAULT_FONT_SIZE = 11;
const LINE_HEIGHT_FACTOR = 1.35;
// The padding a cell draws above and below its text, in px.
const CELL_PADDING = 6;
// An average glyph's width, as a share of the font size.
const GLYPH_WIDTH = 0.6;

function estimateCellHeight(
    cell: FortuneCell,
    r: number,
    c: number,
    merge: NonNullable<SheetConfig['merge']>,
    colWidthPx: Record<number, number>,
    defaultColWidth: number,
): number {
    const fontSize = cell.fs ?? DEFAULT_FONT_SIZE;
    const lineHeightPx = ptToPx(fontSize) * LINE_HEIGHT_FACTOR;
    if (!cellWrapsText(cell)) {
        return fontSize > DEFAULT_FONT_SIZE ? lineHeightPx + CELL_PADDING : 0;
    }

    const text = String(cellDisplay(cell) ?? '');
    if (!text) return lineHeightPx + CELL_PADDING;

    let cellWidth = colWidthPx[c] ?? defaultColWidth;
    const mergeInfo = merge[`${r}_${c}`];
    if (mergeInfo?.cs && mergeInfo.cs > 1) {
        cellWidth = 0;
        for (let ci = mergeInfo.c; ci < mergeInfo.c + mergeInfo.cs; ci++) {
            cellWidth += colWidthPx[ci] ?? defaultColWidth;
        }
    }

    const charsPerLine = Math.max(1, cellWidth / (fontSize * GLYPH_WIDTH));
    let totalLines = 0;
    for (const line of text.split('\n')) {
        totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return totalLines * lineHeightPx + CELL_PADDING;
}
