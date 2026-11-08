// Reads an xlsx file into Eigen's sheets, straight from the SpreadsheetML, with the pictures and the warnings for what
// it left out. It runs in the transform process, which an xlsx import or convert hands the file to.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { Cell, Sheet, SheetConfig } from '@workspace/lib/sheets';
import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import {
    cellDisplay,
    cellWrapsText,
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
    legalSheetNames,
    renameSheetTexts,
    sheetFinder,
    sheetNameKey,
} from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import type { TransformWarning } from '../../document/transform/protocol';
import { lossCounter } from '../../document/transform/protocol';
import { budget } from '../../ooxml/budget';
import { drawingTheme } from '../../ooxml/drawingml';
import { optional } from '../../ooxml/opc';
import { DEFAULT_FONT_SIZE_PT } from '../../ooxml/spreadsheetml';
import { MAX_DECOMPRESSED_BYTES } from '../../ooxml/zip';
import type { ImportedMedia } from '../image-types';
import { importMedia } from '../image-types';
import { IMPORT_MESSAGES, importError, TOO_MANY_CELLS } from '../messages';
import { readGrid } from './cells';
import type { Drawing } from './drawing';
import { placeDrawings, readSheetDrawing } from './drawing';
import { MAX_CELLS, MAX_GRID_SLOTS, MAX_SHARED_FORMULA_TEXT, MAX_TEXT } from './limits';
import { nameInliner } from './names';
import { readBudget, readInBatches, readXlsxPackage } from './package';
import { readRules } from './rules';
import { readSharedStrings } from './strings';
import { defaultFontDigitWidth, readDxfs, readLooks, themePalette } from './styles';
import { readWorksheet } from './worksheet';

export type XlsxOptions = {
    maxMediaBytes: number;
};

// Every worksheet's grid and what lies past it, charged against the output budget as it is read, a shared string or
// formula once per copy. A chart sheet is a sheet without a grid, and what was left out comes back as warnings.
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
        const inline = nameInliner(book.definedNames, losses.lost, emitted.translated.charge);
        const sheets: Sheet[] = [];
        // A file may hold a name a sheet can't have, or two of one name. Its formulas and a chart's refs name sheets as
        // the file writes them, so they mean the first of a name, and what names a repaired sheet follows it.
        const names = legalSheetNames(book.sheets.map(({ name }) => name));
        const repaired = new Map<string, string>();
        const sheetIds = new Map<string, string>();
        const drawings: Drawing[] = [];
        for (const [index, { name: written, path, hidden, chartSheet }] of book.sheets.entries()) {
            const part = book.pkg.zip.read(path);
            if (!part) continue;
            const id = `sheet-${sheets.length}`;
            const name = names[index];
            if (!sheetIds.has(sheetNameKey(written))) {
                sheetIds.set(sheetNameKey(written), id);
                if (name !== written) repaired.set(written, name);
            }
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
                inline: (formula) => inline(formula, written),
                placed: worksheet.placed,
            });
            // The cells' span, at least a default grid's so empty sheets add up, and the grid recalc materializes from
            // it, at least a default grid deep and wide, so a narrow sheet builds far more slots than it spans.
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
                // Excel fits a row to its content only when the row's height is not custom.
                if (grid.custom.has(r)) continue;
                const height = Math.round(estimateCellHeight(v, r, c, merge, columnlen, columnWidth));
                if (height > Math.max(rowHeight, tallest.get(r) ?? 0)) tallest.set(r, height);
            }
            const rowlen: NonNullable<SheetConfig['rowlen']> = Object.fromEntries(tallest);
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
                    dates: grid.dates,
                    charge,
                    chargeElements: reads.elements.charge,
                    lost: losses.lost,
                    inline: (formula) => inline(formula, written),
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
        const findRepaired = sheetFinder([...repaired.keys()].map((name) => ({ name })));
        return {
            sheets: sheets.map((sheet) => renameSheetTexts(sheet, findRepaired, repaired)),
            media: files.media,
            warnings: losses.warnings(),
        };
    } catch (error) {
        throw importError(error, 'xlsx');
    }
}

// The sheets alone, their pictures' media names left unresolved: the shape the tests and the audit compare.
export function xlsxToSheets(bytes: Uint8Array): Sheet[] {
    return readXlsx(bytes, { maxMediaBytes: MAX_DECOMPRESSED_BYTES }).sheets;
}

const LINE_HEIGHT_FACTOR = 1.35;
// The padding a cell draws above and below its text, in px.
const CELL_PADDING = 6;
// An average glyph's width, as a share of the font size.
const GLYPH_WIDTH = 0.6;

function estimateCellHeight(
    cell: Cell,
    r: number,
    c: number,
    merge: NonNullable<SheetConfig['merge']>,
    colWidthPx: Record<number, number>,
    defaultColWidth: number,
): number {
    // Excel's default font size for a cell whose look names none. A line is as tall as its largest rich run, as the
    // writer's refitsOnOpen counts it.
    const fontSize = (cell.ct?.s ?? []).reduce(
        (largest, run) => Math.max(largest, run.fs ?? 0),
        cell.fs ?? DEFAULT_FONT_SIZE_PT,
    );
    const lineHeightPx = ptToPx(fontSize) * LINE_HEIGHT_FACTOR;
    // An empty wrapped cell draws one line, as an unwrapped one does.
    const text = cellWrapsText(cell) ? String(cellDisplay(cell) ?? '') : '';
    if (!text) return fontSize > DEFAULT_FONT_SIZE_PT ? lineHeightPx + CELL_PADDING : 0;

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
