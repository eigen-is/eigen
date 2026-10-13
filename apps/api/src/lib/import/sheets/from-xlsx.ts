import { bundledFont } from '@workspace/lib/constants/fonts';
import { formatInputDate } from '@workspace/lib/date';
import type {
    BorderSide,
    CellBorderSides,
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Cell as FortuneCell,
    Sheet,
    SheetConfig,
    SingleRange,
} from '@workspace/lib/sheets';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '@workspace/lib/sheets';
import {
    booleanDisplay,
    cellWrapsText,
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
    numberDisplay,
    parseA1Range,
    toA1,
} from '@workspace/sheet/engine';
import type { Alignment, AutoFilter, Border, CellValue, Workbook, Worksheet, Cell as XlsxCell } from 'exceljs';
import Range from 'exceljs/lib/doc/range';
import { ApiError } from '../../core/errors';
import { PACKAGE_RELATIONSHIPS_NS, parseOoxml, R_NS, SML_NS } from '../../core/ooxml';
import { optional } from '../../core/opc';
import { type XmlElement, XmlError, xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import { openZip, writeZip, ZipError, type ZipReader, type ZipWriteEntry } from '../../core/zip';
import { DAY_MS, dateDisplay, EXCEL_EPOCH_MS, readGrid } from './cells';
import { NOT_AN_XLSX, readInBatches, readPackage, SPREADSHEET_TOO_LARGE, TOO_MANY_CELLS } from './package';
import {
    CELL_IS_CONDITION,
    CELL_IS_FORMULA_OP,
    cfFormulaRule,
    DV_COL_MARGIN,
    DV_DATE_OPERATOR,
    DV_OPERATOR,
    DV_ROW_MARGIN,
    DV_TYPE,
    extractSearchText,
    FORMULA_BACKED_CF_TYPES,
    listSource,
    parseCfLiteral,
    readRules,
} from './rules';
import { readSharedStrings } from './strings';
import {
    BORDER_STYLE_MAP,
    HORIZONTAL_MAP,
    normalizeMonthMinuteTokens,
    readDxfs,
    readLooks,
    resolveColor,
    type ThemePalette,
    themePalette,
    VERTICAL_MAP,
} from './styles';
import { digitWidthOf, mapHyperlink, readWorksheet } from './worksheet';

const DEFAULT_ROW_HEIGHT_PT = 15.75;

// exceljs's model per cell dominates memory, and a tiny file can declare far-apart cells whose grid the conversion walks:
// the cells the parts hold count before exceljs loads (tallySheet), the grid they span after. The byte cap catches a bomb
// of few cells.
export const MAX_CELLS = 4_000_000;

export async function xlsxToSheets(buffer: Buffer): Promise<Sheet[]> {
    const checked = repackXlsx(buffer);

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(checked);
    assertCellCountWithinBounds(workbook);

    const zip = openZip(checked);
    // One after the other, so their trees are never alive together.
    const theme = themePalette(readPart(zip, 'xl/theme/theme1.xml') ?? undefined);
    const locationLinks = readLocationHyperlinks(zip);
    const digitWidth = digitWidthOf(readDefaultFontName(zip));

    const emitted = { text: 0 };
    const sheets: Sheet[] = [];
    for (const [index, worksheet] of workbook.worksheets.entries()) {
        sheets.push(worksheetToSheet(worksheet, index, theme, digitWidth, locationLinks.get(worksheet.name), emitted));
    }
    return sheets;
}

// The reader of our own, beside ExcelJS's until the import switches to it: every worksheet's grid and what lies past
// it, charged against the output budget as it is read. The cells count what they emit, a value, a border, a row's
// height or hidden flag, a merged or linked cell, a column's width, a rule's range or a validated cell, and the grids
// recalc materialises; the text counts every value, display, formula, link and rule text, each shared string and
// shared formula once per copy.
export function xlsxToSheetsOwn(bytes: Uint8Array): Sheet[] {
    try {
        const book = readPackage(bytes);
        const palette = themePalette(book.theme);
        const looks = readLooks(book.styles, palette);
        const strings = readSharedStrings(book.sharedStrings, palette);
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
            if (emitted.text > MAX_TEXT) throw new ApiError(413, SPREADSHEET_TOO_LARGE);
        };
        const chargeCopy = (chars: number) => {
            emitted.translated += chars;
            if (emitted.translated > MAX_SHARED_FORMULA_TEXT) throw new ApiError(413, SPREADSHEET_TOO_LARGE);
        };
        const sheets: Sheet[] = [];
        for (const { name, path } of book.sheets) {
            const part = book.pkg.zip.read(path);
            if (!part) continue;
            const id = `sheet-${sheets.length}`;
            // The rest is parsed before the rows, so the merges and links are placed when the grid reads its cells.
            const { rest, children } = readInBatches(part, 'sheetData', 'row');
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
            if (emitted.slots > MAX_GRID_SLOTS) throw new ApiError(413, SPREADSHEET_TOO_LARGE);
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
                    charge,
                }),
            };
            sheets.push(sheet);
        }
        return sheets;
    } catch (error) {
        // The zip's and the XML's messages speak of archives and markup; the user uploaded a spreadsheet.
        if (error instanceof ZipError)
            throw new ApiError(error.status, error.status === 413 ? SPREADSHEET_TOO_LARGE : NOT_AN_XLSX, {
                cause: error,
            });
        if (error instanceof XmlError) throw new ApiError(400, NOT_AN_XLSX, { cause: error });
        throw error;
    }
}

// The upload route bounds only the compressed bytes, and exceljs inflates the whole package, where an out-of-memory
// can't be caught. So every entry is read once before it: openZip refuses an archive declaring more than the byte cap,
// and a read inflates no further than its entry declares, so an entry lying small is refused too.
// exceljs gets those reads stored in a new package, so its own zip reader sees only bytes openZip checked.
function repackXlsx(buffer: Buffer): Buffer {
    try {
        const zip = openZip(buffer);
        const entries: ZipWriteEntry[] = [];
        const tally: ExpansionTally = {
            sheets: 0,
            cells: 0,
            rows: 0,
            elements: 0,
            merges: 0,
            mergedCells: 0,
            validationKeys: 0,
        };
        for (const [name, read] of zip.files()) {
            const data = read();
            const bytes = canonicalPart(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            if (WORKSHEET_PART.test(name)) tallySheet(bytes, tally);
            else if (STRINGS_OR_STYLES_PART.test(name)) tallyElements(bytes, tally);
            tallyExpansions(bytes, tally);
            entries.push({ name, data: bytes, store: true });
        }
        const packed = writeZip(entries);
        return Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
    } catch (error) {
        if (!(error instanceof ZipError)) throw error;
        const message = error.status === 413 ? SPREADSHEET_TOO_LARGE : NOT_AN_XLSX;
        throw new ApiError(error.status, message, { cause: error });
    }
}

// What exceljs builds while it loads, before MAX_CELLS can count anything: a model per sheet, <c>, <row> and element; a
// merge's cells, each merge checked against every earlier one; a validation's sqref as a model key per cell.
type ExpansionTally = {
    sheets: number;
    cells: number;
    rows: number;
    elements: number;
    merges: number;
    mergedCells: number;
    validationKeys: number;
};

// Merged cells count against MAX_CELLS, as cells; exceljs checks each merge against every earlier one.
export const MAX_MERGES = 10_000;
// A validation key costs ~300 B, so 5M keys is ~1.5 GB, what 1M ordinary cells cost; four column-wide validations fit.
export const MAX_VALIDATION_KEYS = 5_000_000;
// An empty row costs ~600 B: two full sheets of rows is ~1.3 GB, and real workbooks hold under 1.1M row elements.
export const MAX_ROWS = 2 * REFERENCE_ROW_COUNT;
// A sheet holds a column object per column up to its last, ~3 MB at XFD; real workbooks hold under 50 sheets.
export const MAX_SHEETS = 500;
// exceljs's sheet list walks every id up to the largest; real ids stay far below.
export const MAX_SHEET_ID = 1_000_000;
// exceljs builds up to ~270 B per element, ~1 GB at the cap; real sheets, shared strings and styles hold under 70,000
// past the cell grid.
export const MAX_ELEMENTS = 4_000_000;
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

// Every part is counted, not only those exceljs reads as sheets: a byte search, as a sheet may be the decompressed cap.
function tallyExpansions(bytes: Buffer, tally: ExpansionTally): void {
    for (const attributes of startTags(bytes, 'mergeCell')) {
        tally.merges += 1;
        tally.mergedCells += rangeArea(attributes.get('ref') ?? '');
        if (tally.merges > MAX_MERGES || tally.mergedCells > MAX_CELLS) throw tooLarge();
    }
    for (const attributes of startTags(bytes, 'dataValidation')) {
        // exceljs keys every piece of a sqref split on whitespace.
        for (const [ref] of (attributes.get('sqref') ?? '').matchAll(/\S+/g)) {
            tally.validationKeys += rangeArea(ref);
            if (tally.validationKeys > MAX_VALIDATION_KEYS) throw tooLarge();
        }
    }
    for (const attributes of startTags(bytes, 'sheet')) {
        if (Number.parseInt(attributes.get('sheetId') ?? '', 10) > MAX_SHEET_ID) throw tooLarge();
    }
    for (const attributes of startTags(bytes, 'col')) {
        const bounds = [attributes.get('min'), attributes.get('max')];
        if (bounds.some((bound) => Number.parseInt(bound ?? '', 10) > REFERENCE_COLUMN_COUNT)) throw tooLarge();
    }
}

// exceljs's own test for a sheet part (lib/xlsx/xlsx.js): calcChain.xml holds a <c> per formula, which is no cell.
const WORKSHEET_PART = /xl\/worksheets\/sheet(\d+)[.]xml/;
const STRINGS_OR_STYLES_PART = /^\/?xl\/(?:sharedStrings|styles)\.xml$/;

function tallySheet(bytes: Buffer, tally: ExpansionTally): void {
    tally.sheets += 1;
    if (tally.sheets > MAX_SHEETS) throw tooLarge();
    tally.cells += countTags(bytes, CELL_OPEN, MAX_CELLS - tally.cells);
    if (tally.cells > MAX_CELLS) throw tooManyCells();
    tally.rows += countTags(bytes, ROW_OPEN, MAX_ROWS - tally.rows);
    if (tally.rows > MAX_ROWS) throw tooLarge();
    tallyElements(bytes, tally);
}

function tallyElements(bytes: Buffer, tally: ExpansionTally): void {
    tally.elements += countElements(bytes, MAX_ELEMENTS - tally.elements);
    if (tally.elements > MAX_ELEMENTS) throw tooLarge();
}

// The cell grid's own names: MAX_CELLS and MAX_ROWS bound them, and repeated in one cell they cost what their bytes do.
const GRID_NAMES = ['c', 'v', 'f', 't', 'is', 'row'].map((name) => Buffer.from(name));
const GRID_FIRSTS = new Set(GRID_NAMES.map((name) => name[0]));

// Every start tag but the grid's; an end tag, a comment, CDATA or a declaration starts `</`, `<!` or `<?`.
function countElements(bytes: Buffer, limit: number): number {
    let count = 0;
    for (let at = bytes.indexOf(0x3c); at >= 0 && count <= limit; at = bytes.indexOf(0x3c, at + 1)) {
        const first = bytes[at + 1];
        if (first === 0x2f || first === 0x21 || first === 0x3f) continue;
        if (GRID_FIRSTS.has(first) && GRID_NAMES.some((name) => isNameAt(bytes, at + 1, name))) continue;
        count += 1;
    }
    return count;
}

function isNameAt(bytes: Buffer, at: number, name: Buffer): boolean {
    return bytes.compare(name, 0, name.length, at, at + name.length) === 0 && NAME_ENDS.has(bytes[at + name.length]);
}

// A loop, not tagStarts: a real sheet holds millions of cells. It stops one past the limit.
function countTags(bytes: Buffer, open: Buffer, limit: number): number {
    let count = 0;
    for (let at = bytes.indexOf(open); at >= 0 && count <= limit; at = bytes.indexOf(open, at + open.length)) {
        if (NAME_ENDS.has(bytes[at + open.length])) count += 1;
    }
    return count;
}

// The bytes exceljs gets, made to read as the scan reads them.
function canonicalPart(bytes: Buffer): Buffer {
    // XML 1.1 reads a NEL or U+2028 in a value as a space too, and Excel writes 1.0 only.
    const version = XML_VERSION.exec(bytes.toString('latin1', 0, 128))?.[2];
    if (version !== undefined && version !== '1.0') throw new ApiError(400, NOT_AN_XLSX);
    return withoutDefinedNames(withSpacedTags(bytes));
}

const XML_VERSION = /^(?:\xef\xbb\xbf)?<\?xml\s+version\s*=\s*(["'])(.*?)\1/;
const SCANNED_TAGS = ['mergeCell', 'dataValidation', 'col', 'sheet'];

// exceljs's parser reads a raw tab, CR or LF in a value as a space, so the scanned tags carry spaces in their place.
function withSpacedTags(bytes: Buffer): Buffer {
    let spaced = bytes;
    for (const name of SCANNED_TAGS) {
        for (const at of tagStarts(bytes, name)) {
            // A `>` inside a value doesn't end the tag; nothing past a `<` is in it.
            let quote: number | undefined;
            for (let i = at + name.length + 1; i < bytes.length && bytes[i] !== 0x3c; i++) {
                const byte = bytes[i];
                if (byte === 0x3e && quote === undefined) break;
                if (byte === 0x22 || byte === 0x27) {
                    if (quote === undefined) quote = byte;
                    else if (quote === byte) quote = undefined;
                }
                if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) continue;
                if (spaced === bytes) spaced = Buffer.from(bytes);
                spaced[i] = 0x20;
            }
        }
    }
    return spaced;
}

// Eigen drops defined names, and exceljs expands each one's range per cell. It matches the element by its exact name at
// any depth, so renaming every start and end tag hides it, still well-formed.
const DEFINED_NAMES_TAG = /<(\/?)definedNames/g;

function withoutDefinedNames(bytes: Buffer): Buffer {
    if (bytes.indexOf('definedNames') < 0) return bytes;
    // latin1 maps each byte to one character and back, so every other byte stays as it was.
    return Buffer.from(bytes.toString('latin1').replace(DEFINED_NAMES_TAG, '<$1ignoredNames'), 'latin1');
}

function textLength(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}

function tooLarge(): ApiError {
    return new ApiError(413, SPREADSHEET_TOO_LARGE);
}

function tooManyCells(): ApiError {
    return new ApiError(413, 'Spreadsheet has too many cells');
}

// exceljs's own Range, whose bounds read a missing row or column as 1, so a range counts the cells exceljs walks; it
// throws, as exceljs does, past column XFD.
function rangeArea(ref: string): number {
    if (!ref.includes(':')) return 1;
    const { top, left, bottom, right } = new Range(ref);
    return (bottom - top + 1) * (right - left + 1);
}

// A Buffer, as a string needle costs an allocation per search.
const CELL_OPEN = Buffer.from('<c');
const ROW_OPEN = Buffer.from('<row');
// Whitespace, `/` or `>` ends a name, so `<cols` is no `<col`.
const NAME_ENDS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x2f, 0x3e]);

// Where each start tag of an element begins, by its unprefixed name, the only one exceljs matches.
function* tagStarts(bytes: Buffer, name: string): Generator<number> {
    const open = Buffer.from(`<${name}`);
    for (let at = bytes.indexOf(open); at >= 0; at = bytes.indexOf(open, at + open.length)) {
        if (NAME_ENDS.has(bytes[at + open.length])) yield at;
    }
}

// A name after whitespace, as a lookbehind: matched from the whitespace, a long run is retried from each of its starts.
const ATTRIBUTE = /(?<=\s)([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// The attributes of each start tag of an element. No attribute value holds a `<`, so a tag runs to the next one.
function* startTags(bytes: Buffer, name: string): Generator<Map<string, string>> {
    for (const at of tagStarts(bytes, name)) {
        const next = bytes.indexOf('<', at + 1);
        const markup = bytes.toString('utf8', at + name.length + 1, next < 0 ? bytes.length : next);
        const attributes = new Map<string, string>();
        for (const [, key, double, single] of markup.matchAll(ATTRIBUTE))
            attributes.set(key, unescapeXml(double ?? single));
        yield attributes;
    }
}

const XML_REFERENCE = /&(?:#(\d+)|#x([\da-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// As exceljs's parser reads a value, so a character reference hides no `:` from the count.
function unescapeXml(value: string): string {
    return value.replace(XML_REFERENCE, (reference, decimal, hex, entity) => {
        if (entity) return XML_ENTITIES[entity];
        const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : reference;
    });
}

function assertCellCountWithinBounds(workbook: Workbook): void {
    let slots = 0;
    let cells = 0;
    for (const worksheet of workbook.worksheets) {
        // A row past the grid needs no cell, and every walk to the last row visits each row number before it.
        if (worksheet.rowCount > REFERENCE_ROW_COUNT) throw tooManyCells();
        // Each row walks every column up to its last cell, in columnCount and in the conversion, so those come first.
        for (let n = 1; n <= worksheet.rowCount; n++) slots += worksheet.findRow(n)?.cellCount ?? 0;
        if (slots > MAX_CELLS) throw tooManyCells();
        cells += worksheet.rowCount * worksheet.columnCount;
        if (cells > MAX_CELLS) throw tooManyCells();
    }
}

function worksheetToSheet(
    worksheet: Worksheet,
    index: number,
    theme: ThemePalette,
    digitWidth: number,
    locationLinks: Map<string, string> | undefined,
    emitted: { text: number },
): Sheet {
    const sheetId = `sheet-${index}`;
    const celldata: { r: number; c: number; v: FortuneCell }[] = [];
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const rowlen: NonNullable<SheetConfig['rowlen']> = {};
    const borderInfo: NonNullable<SheetConfig['borderInfo']> = {};
    const hyperlink: NonNullable<Sheet['hyperlink']> = {};

    const { merge, anchorByCell } = buildMergeStructures(worksheet.model.merges ?? []);

    // Compute column widths first (needed for auto-fit height estimation).
    const colWidthPx: Record<number, number> = {};
    const colhidden: NonNullable<SheetConfig['colhidden']> = {};
    for (const [i, col] of (worksheet.columns ?? []).entries()) {
        if (col && typeof col.width === 'number' && col.width > 0) {
            const px = Math.round(col.width * digitWidth);
            colWidthPx[i] = px;
            columnlen[String(i)] = px;
        }
        // exceljs expands <col min/max hidden> ranges to per-column flags.
        if (col?.hidden) colhidden[String(i)] = 0;
    }

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
            // A border is config, not cell content, so it is read before the
            // empty-cell skip decides whether a celldata entry exists.
            const border = convertBorder(cell, theme);
            if (border) borderInfo[`${r}_${c}`] = border;

            const mergeAnchor = anchorByCell.get(`${r}:${c}`);
            if (mergeAnchor) converted.mc = mergeAnchor;
            if (!mergeAnchor && isEmptyCell(converted)) return;
            emitted.text += textLength(converted.v) + textLength(converted.m);
            if (emitted.text > MAX_TEXT) throw tooLarge();
            celldata.push({ r, c, v: converted });

            maxCellHeight = Math.max(maxCellHeight, estimateCellHeight(converted, c, r, merge, colWidthPx));
        });

        const isDefaultHeight = row.height === DEFAULT_ROW_HEIGHT_PT;
        if (!isDefaultHeight && typeof row.height === 'number' && row.height > 0) {
            rowlen[String(r)] = Math.round(row.height * (4 / 3));
        } else if (maxCellHeight > SHEET_DEFAULT_ROW_HEIGHT) {
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
    if (Object.keys(borderInfo).length > 0) config.borderInfo = borderInfo;

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
export type XlsxCfRule = {
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

function convertConditionalFormats(worksheet: Worksheet, theme: ThemePalette): ConditionalFormatRule[] {
    const blocks = worksheet.conditionalFormattings ?? [];

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

    const comparison = CELL_IS_CONDITION.get(rule.operator ?? '');
    if (rule.type === 'cellIs' && rule.operator != null && comparison) {
        const operands = (rule.formulae ?? []).map(String);
        if (operands.length === 0) return [];
        const literals = operands.map(parseCfLiteral);
        if (literals.every((value) => value != null)) {
            return [
                {
                    type: 'default',
                    cellrange: ranges,
                    format,
                    conditionName: comparison,
                    conditionRange: [],
                    conditionValue: literals,
                },
            ];
        }
        // Ref/function operand — the engine's comparison rules only hold literals, so
        // express the comparison as a formula rule anchored at the first range's top-left.
        const tl = toA1(ranges[0].row[0], ranges[0].column[0]);
        if (rule.operator === 'between' || rule.operator === 'notBetween') {
            if (operands.length < 2) return [];
            const within = `AND(${tl}>=${operands[0]},${tl}<=${operands[1]})`;
            return [cfFormulaRule(rule.operator === 'between' ? within : `NOT(${within})`, ranges, format)];
        }
        return [cfFormulaRule(`${tl}${CELL_IS_FORMULA_OP.get(rule.operator)}${operands[0]}`, ranges, format)];
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

    if (FORMULA_BACKED_CF_TYPES.has(rule.type)) {
        const formula = rule.formulae?.[0];
        return formula == null ? [] : [cfFormulaRule(String(formula), ranges, format)];
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
export type XlsxDataValidation = {
    type: string;
    operator?: string;
    formulae?: unknown[];
    showInputMessage?: boolean;
    showErrorMessage?: boolean;
    prompt?: string;
    errorStyle?: string;
};

function convertDataValidations(worksheet: Worksheet): NonNullable<Sheet['dataVerification']> {
    const model = worksheet.dataValidations?.model ?? {};

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
    const type = DV_TYPE.get(dv.type);
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
    const type2 = (type === 'date' ? DV_DATE_OPERATOR : DV_OPERATOR).get(operator);
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

// exceljs drops location-form hyperlinks on read: the worksheet parse keeps the
// location attribute (hyperlink-xform.js parseOpen), but reconcile only maps
// rel-based entries onto cells and then deletes the parsed collection
// (worksheet-xform.js:469-474, 526) — the streaming reader never reads the
// attribute at all. Excel itself authors internal links in exactly this form
// (<hyperlink ref location=…> without a rel), so recover them straight from the
// worksheet XML. Returns sheet name → (anchor cell ref → location target).
export function readLocationHyperlinks(zip: ZipReader): Map<string, Map<string, string>> {
    const bySheet = new Map<string, Map<string, string>>();
    // One sheet at a time: each is decoded whole, and together they can reach the decompressed cap.
    for (const { name, path } of readSheetPaths(zip) ?? []) {
        const bytes = zip.read(path);
        const text = bytes && new TextDecoder().decode(bytes);
        const hyperlinks = text && readHyperlinksBlock(text);
        if (!hyperlinks) continue;
        const links = new Map<string, string>();
        for (const hyperlink of xmlChildren(hyperlinks, SML_NS, 'hyperlink')) {
            const ref = xmlAttr(hyperlink, '', 'ref');
            const location = xmlAttr(hyperlink, '', 'location');
            // ref may span a range; the anchor cell carries the link.
            if (ref != null && location != null) links.set(ref.split(':')[0], location);
        }
        if (links.size > 0) bySheet.set(name, links);
    }
    return bySheet;
}

// Each sheet's name and part path, as plain values: the workbook and rels trees are gone before any sheet is read.
function readSheetPaths(zip: ZipReader): { name: string; path: string }[] | undefined {
    const workbook = readPart(zip, 'xl/workbook.xml');
    const rels = readPart(zip, 'xl/_rels/workbook.xml.rels');
    const sheets = workbook?.ns === SML_NS ? xmlChild(workbook, SML_NS, 'sheets') : undefined;
    if (!sheets || !rels) return undefined;

    const relTargets = new Map<string, string>();
    for (const rel of xmlChildren(rels, PACKAGE_RELATIONSHIPS_NS, 'Relationship')) {
        const id = xmlAttr(rel, '', 'Id');
        const target = xmlAttr(rel, '', 'Target');
        if (id != null && target != null) relTargets.set(id, target);
    }
    // exceljs reads each part once and names it by the last sheet naming it.
    const names = new Map<string, string>();
    for (const sheet of xmlChildren(sheets, SML_NS, 'sheet')) {
        const name = xmlAttr(sheet, '', 'name');
        const rId = xmlAttr(sheet, R_NS, 'id');
        const target = rId != null ? relTargets.get(rId) : undefined;
        if (name == null || target == null) continue;
        // As exceljs resolves them (workbook-xform.js), not as OPC does, so the links land on its sheets by name.
        names.set(target.startsWith('/') ? target.slice(1) : `xl/${target}`, name);
    }
    return [...names].map(([path, name]) => ({ name, path }));
}

// A tree costs far more heap than its input, so what is parsed is bounded by length and by its `<` and `=` counts; past any bound a part is skipped like a malformed one.
type ParseBound = { length: number; tags: number; attributes: number };
// Workbook, rels and theme run to a few KB and a few hundred tags in a real file. Length in bytes.
const PART_BOUND: ParseBound = { length: 1024 * 1024, tags: 10_000, attributes: 100_000 };
// Excel caps a sheet at 66,530 hyperlinks, each one tag of at most six attributes in ~130-300 characters, plus
// slack. Length in UTF-16 code units: the block is a slice of the decoded sheet.
const HYPERLINKS_BOUND: ParseBound = { length: 32 * 1024 * 1024, tags: 70_000, attributes: 490_000 };

function withinParseBound(parts: (string | Uint8Array)[], bound: ParseBound): boolean {
    if (parts.reduce((length, part) => length + part.length, 0) > bound.length) return false;
    const left = { '<': bound.tags, '=': bound.attributes };
    for (const part of parts) {
        for (const char of ['<', '='] as const) {
            const next = (from: number) =>
                typeof part === 'string' ? part.indexOf(char, from) : part.indexOf(char.charCodeAt(0), from);
            for (let at = next(0); at >= 0; at = next(at + 1)) {
                if (--left[char] < 0) return false;
            }
        }
    }
    return true;
}

// The root's start tag (the prolog's `<?` and `<!` never match) and its name; an attribute value may hold `>`.
const ROOT_START_TAG = /<([^\s?!/<>][^\s/<>]*)(?:\s+[^\s=/<>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*>/;
// Global for their lastIndex: each search starts where the schema puts what it looks for.
const SHEET_DATA_END = /<\/(?:[^\s/<>:]+:)?sheetData\s*>|<(?:[^\s/<>:]+:)?sheetData\s*\/>/g;
const HYPERLINKS_START_TAG = /<((?:[^\s/<>:]+:)?hyperlinks)[\s/>]/g;
const FONT_START_TAG = /<((?:[^\s/<>:]+:)?font)[\s/>]/g;

// The rest of a sheet can be the whole decompressed cap, so only its hyperlinks block is parsed. The schema puts
// the block after the sheet data, so the search starts past it: past the bulk of the sheet, and past any opener a
// comment there could hide.
function readHyperlinksBlock(sheet: string): XmlElement | undefined {
    const wrapped = readElement(sheet, HYPERLINKS_START_TAG, HYPERLINKS_BOUND, SHEET_DATA_END);
    return wrapped ? xmlChild(wrapped, SML_NS, 'hyperlinks') : undefined;
}

// The name of styles fonts[0], the default font: what a column width counts the digits of. The schema puts no font
// before it, and a styles part with thousands of formats runs past PART_BOUND, so only that element is parsed.
function readDefaultFontName(zip: ZipReader): string | undefined {
    const bytes = zip.read('xl/styles.xml');
    const wrapped = bytes && readElement(new TextDecoder().decode(bytes), FONT_START_TAG, PART_BOUND);
    const font = wrapped && xmlChild(wrapped, SML_NS, 'font');
    const name = font && xmlChild(font, SML_NS, 'name');
    return name ? xmlAttr(name, '', 'val') : undefined;
}

// The first element a start tag pattern finds, past `skip` when it matches, parsed alone inside the prolog and the
// root's start tag, so the namespaces bound there stay bound and a DOCTYPE is still refused. Returns that root.
function readElement(part: string, start: RegExp, bound: ParseBound, skip?: RegExp): XmlElement | null {
    const root = ROOT_START_TAG.exec(part);
    if (!root) return null;
    const head = part.slice(0, root.index + root[0].length);
    start.lastIndex = head.length;
    if (skip) {
        skip.lastIndex = head.length;
        if (skip.exec(part)) start.lastIndex = skip.lastIndex;
    }
    const open = start.exec(part);
    if (!open) return null;
    // An end tag that doesn't match is Bun's to refuse.
    const end = part.indexOf(`</${open[1]}`, open.index);
    const close = end < 0 ? -1 : part.indexOf('>', end);
    if (close < 0) return null;
    const block = part.slice(open.index, close + 1);
    return withinParseBound([head, block], bound) ? parsePart(`${head}${block}</${root[1]}>`) : null;
}

function readPart(zip: ZipReader, path: string): XmlElement | null {
    const bytes = zip.read(path);
    return bytes && withinParseBound([bytes], PART_BOUND) ? parsePart(bytes) : null;
}

// exceljs has read the workbook by now, so a part Bun refuses (malformed, a DOCTYPE) costs only what these reads
// take from it: the location links or the theme colors, never the import. Strict reads as transitional.
function parsePart(xml: string | Uint8Array): XmlElement | null {
    try {
        return parseOoxml(xml);
    } catch (error) {
        if (error instanceof XmlError) return null;
        throw error;
    }
}

function extractValueAndDisplay(cell: XlsxCell): { value?: string | number | boolean; display?: string } {
    const raw = cell.value;

    if (isFormulaValue(raw) || isSharedFormula(raw)) {
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

    // The remaining shapes are exactly the scalars a formula resolves to.
    return resolveFormulaResult(raw, cell.numFmt);
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
    return { value: serial, display: dateDisplay(serial, numFmt) };
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
            const mapped = bundledFont(font.name);
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
    const horizontal = HORIZONTAL_MAP.get(alignment.horizontal ?? '');
    if (horizontal !== undefined) {
        target.ht = horizontal;
    }
    // ExcelJS reads xlsx's vertical center as middle.
    const vertical = VERTICAL_MAP.get(alignment.vertical === 'middle' ? 'center' : (alignment.vertical ?? ''));
    if (vertical !== undefined) {
        target.vt = vertical;
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

function convertBorder(cell: XlsxCell, theme: ThemePalette): CellBorderSides | null {
    const border = cell.style?.border;
    if (!border) return null;

    const l = convertBorderSide(border.left, theme);
    const r = convertBorderSide(border.right, theme);
    const t = convertBorderSide(border.top, theme);
    const b = convertBorderSide(border.bottom, theme);
    // Our slash `s` is a top-left → bottom-right diagonal, i.e. xlsx's diagonalDown; a
    // diagonalUp-only border has no equivalent in our single-direction slash and is dropped.
    const s = border.diagonal?.down ? convertBorderSide(border.diagonal, theme) : null;
    const sides: CellBorderSides = {
        ...(l && { l }),
        ...(r && { r }),
        ...(t && { t }),
        ...(b && { b }),
        ...(s && { s }),
    };
    return Object.keys(sides).length > 0 ? sides : null;
}

function convertBorderSide(side: Partial<Border> | undefined, theme: ThemePalette): BorderSide | null {
    const style = BORDER_STYLE_MAP.get(side?.style ?? '');
    if (style === undefined) return null;
    const color = resolveColor(side?.color, theme) ?? '#000000';
    return { style, color };
}

function isFormulaValue(value: CellValue): value is Extract<CellValue, { formula: string }> {
    return typeof value === 'object' && value !== null && 'formula' in value;
}

function isSharedFormula(value: CellValue): value is Extract<CellValue, { sharedFormula: string }> {
    return typeof value === 'object' && value !== null && 'sharedFormula' in value;
}

function isRichText(value: unknown): value is Extract<CellValue, { richText: unknown }> {
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
    if (isRichText(t)) return t.richText.map((r) => r.text).join('');
    return '';
}

function isError(value: unknown): value is { error: string } {
    return typeof value === 'object' && value !== null && 'error' in value;
}
