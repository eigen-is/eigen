// A worksheet's grid, read a batch of rows at a time: each cell's value, display, type, formula, look and rich text,
// the borders, the row heights and the hidden rows. Only what the file holds is walked, never the row or column
// numbers. The xlsx reader calls it for each worksheet, after the merges and links that place cells of their own.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { CellBorderSides, CellStyle, Cell as FortuneCell, InlineStringSegment } from '@workspace/lib/sheets';
import { columnLabelToIndex, REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { booleanDisplay, functionCopy, numberDisplay, update } from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlChild, xmlChildren, xmlText } from '../../core/xml';
import { isOn, SML_NS } from '../../ooxml/ooxml';
import {
    DATE_FORMAT,
    DAY_MS,
    DAYS_1904,
    EXCEL_EPOCH_MS,
    MAX_FORMULA_LENGTH,
    withoutFuturePrefixes,
} from '../../ooxml/spreadsheetml';
import { IMPORT_MESSAGES, TOO_MANY_CELLS } from '../messages';
import type { SharedString } from './strings';
import { readString, sharedStringText } from './strings';
import type { Look, ThemePalette } from './styles';
import { NO_LOOK } from './styles';

// A cell a merge or a link places before the grid is read.
export type PlacedCell = { r: number; c: number; v: FortuneCell };

export type GridContext = {
    looks: Look[];
    strings: SharedString[];
    date1904: boolean;
    palette: ThemePalette;
    // Called for each cell the grid emits, a value or a border, with the characters it writes, for a rich string's runs,
    // and for each row's height and hidden flag; a placed cell is charged already. Throws past the budget.
    charge(cells: number, text: number): void;
    // Called before a shared formula's copy is translated, with the characters to translate; throws past the budget.
    chargeCopy(chars: number): void;
    // The merged and linked cells, by cellKey: the grid's cell at one takes its keys, and the rest are emitted as they
    // are. Emptied by the read.
    placed: Map<number, PlacedCell>;
};

export type Grid = {
    celldata: { r: number; c: number; v: FortuneCell }[];
    borderInfo: Record<string, CellBorderSides>;
    // In points, as written.
    heights: Map<number, number>;
    // The rows of a height the file marks customHeight, which Excel draws at that height and never fits to their content.
    custom: Set<number>;
    rowhidden: Record<string, number>;
    // The rows and columns the cells reach; recalc materialises at least a default grid's.
    rows: number;
    columns: number;
    // A 1904 workbook's date cells, by cellKey, whose serials the reader moved to the 1900 system.
    dates: Set<number>;
};

// The grid's key of a cell, unique within a sheet.
export function cellKey(r: number, c: number): number {
    return r * REFERENCE_COLUMN_COUNT + c;
}

// `rows` are the <row> elements of <sheetData>, in the file's order.
export function readGrid(rows: Iterable<XmlElement>, context: GridContext): Grid {
    const grid: Grid = {
        celldata: [],
        borderInfo: {},
        heights: new Map(),
        custom: new Set(),
        rowhidden: {},
        rows: 0,
        columns: 0,
        dates: new Set(),
    };
    // Cells come in order, each past the last; one that isn't may repeat an earlier cell, which keeps its first, so from
    // then on the cells emitted are kept by key.
    let last = -1;
    let emitted: Set<number> | undefined;
    const emit = (entry: PlacedCell) => {
        grid.celldata.push(entry);
        emitted?.add(cellKey(entry.r, entry.c));
        grid.rows = Math.max(grid.rows, entry.r + 1);
        grid.columns = Math.max(grid.columns, entry.c + 1);
    };
    // A shared formula's copies name it by its si, after the anchor that holds its text.
    const shared = new Map<string, { text: string; r: number; c: number }>();
    let r = -1;
    for (const row of rows) {
        const reference = xmlAttr(row, '', 'r');
        r = trackIndex(reference === undefined ? undefined : Number(reference), r, REFERENCE_ROW_COUNT);
        const height = Number.parseFloat(xmlAttr(row, '', 'ht') ?? '');
        // A custom height that draws no pixel is a row Excel draws as none, as the editor draws a hidden one.
        const pixels = Math.round(ptToPx(height));
        const custom = isOn(xmlAttr(row, '', 'customHeight')) === true;
        const none = pixels === 0 && (height > 0 || custom);
        if ((none || isOn(xmlAttr(row, '', 'hidden'))) && !(r in grid.rowhidden)) {
            context.charge(1, 0);
            grid.rowhidden[r] = 0;
        }
        if (pixels > 0) {
            if (!grid.heights.has(r)) context.charge(1, 0);
            grid.heights.set(r, height);
            if (custom) grid.custom.add(r);
            else grid.custom.delete(r);
        }
        let c = -1;
        for (const element of xmlChildren(row, SML_NS, 'c')) {
            const cellReference = xmlAttr(element, '', 'r');
            c = trackIndex(columnNumber(cellReference), c, REFERENCE_COLUMN_COUNT);
            // A cell naming another row than its row's is no Excel's.
            const named = rowNumber(cellReference);
            if (named !== undefined && named !== r + 1) continue;
            const key = cellKey(r, c);
            if (key <= last) emitted ??= new Set(grid.celldata.map((entry) => cellKey(entry.r, entry.c)));
            last = Math.max(last, key);
            if (emitted?.has(key)) continue;
            const look = context.looks[Number(xmlAttr(element, '', 's'))] ?? NO_LOOK;
            const cell = readCell(
                element,
                look,
                context,
                formulaOf(xmlChild(element, SML_NS, 'f'), r, c, shared, context),
            );
            const placed = context.placed.get(key);
            const empty =
                !placed &&
                cell.v === undefined &&
                cell.ct?.s === undefined &&
                cell.f === undefined &&
                cell.bg === undefined &&
                cell.fc === undefined;
            if (empty && !look.border) continue;
            context.charge(
                placed ? 0 : 1,
                textLength(cell.v) + textLength(cell.m) + textLength(cell.f) + textLength(cell.ct?.fa),
            );
            if (look.border) grid.borderInfo[`${r}_${c}`] = look.border;
            if (empty) continue;
            context.placed.delete(key);
            if (context.date1904 && cell.ct?.t === 'd') grid.dates.add(key);
            emit({ r, c, v: placed ? { ...cell, ...placed.v } : cell });
        }
    }
    for (const placed of context.placed.values()) emit(placed);
    context.placed.clear();
    return grid;
}

function readCell(element: XmlElement, look: Look, context: GridContext, formula: string | undefined): FortuneCell {
    const type = xmlAttr(element, '', 't');
    const v = xmlChild(element, SML_NS, 'v');
    const raw = v ? xmlText(v) : '';
    let value: string | number | boolean | undefined;
    let string: SharedString | undefined;
    let date = false;
    if (type === 'inlineStr') {
        const is = xmlChild(element, SML_NS, 'is');
        string = is && readString(is, context.palette);
        value = (string && sharedStringText(string)) || undefined;
    } else if (raw !== '') {
        if (type === 's') {
            string = context.strings[Number(raw)];
            value = string === undefined ? undefined : sharedStringText(string);
        } else if (type === 'str' || type === 'e') value = raw;
        else if (type === 'b') value = Number.parseInt(raw, 10) !== 0;
        else if (type === 'd') {
            value = isoSerial(raw);
            date = value !== undefined;
        } else {
            // A value Excel never writes, INF or 1e999, is the text it is.
            const number = DECIMAL.test(raw.trim()) ? Number(raw) : Number.NaN;
            value = Number.isFinite(number) ? number : raw;
        }
    }
    if (typeof value === 'number' && Number.isFinite(value) && !date && look.isDate) {
        date = true;
        if (context.date1904) value += DAYS_1904;
    }
    const cell: FortuneCell = { ...look.cell };
    // A rich string's text is its runs', as the editor keeps one: neither `v` nor `m` holds it. A formula's is its
    // cached result, plain.
    const runs = !formula && typeof string === 'object' && value ? runsOf(string.runs, look.font, context) : undefined;
    if (runs) {
        cell.ct = { fa: look.fa ?? 'General', t: 'inlineStr', s: runs };
        return cell;
    }
    if (value !== undefined) {
        cell.v = value;
        if (typeof value === 'number') {
            // numfmt renders a bare serial under General as a number, so a date without a format it can draw shows as
            // m/d/yyyy.
            cell.m = date ? update(look.numFmt ?? DATE_FORMAT, value) : numberDisplay(value, look.numFmt);
        } else cell.m = typeof value === 'boolean' ? booleanDisplay(value) : value;
    }
    if (formula) cell.f = `=${formula}`;
    const t = date ? 'd' : value === undefined ? undefined : VALUE_TYPE[typeof value];
    // The editor always pairs `t` with `fa`, General when the cell has no format.
    if (t || look.fa) cell.ct = { fa: look.fa ?? 'General', ...(t && { t }) };
    return cell;
}

// The runs with text, a copy per cell, charged each as a cell before they are built; plain text takes the cell's font.
function runsOf(runs: (string | InlineStringSegment)[], font: CellStyle, context: GridContext): InlineStringSegment[] {
    const shown = runs.filter((run) => (typeof run === 'string' ? run : run.v));
    context.charge(
        shown.length,
        shown.reduce((text, run) => text + (typeof run === 'string' ? run : (run.v ?? '')).length, 0),
    );
    return shown.map((run) => (typeof run === 'string' ? { ...font, v: run } : run));
}

// A shared formula's anchor holds its text and range; a copy shifts the anchor's relative references by its offset. A
// data table's cells hold values Excel computed, with no formula of their own.
function formulaOf(
    f: XmlElement | undefined,
    r: number,
    c: number,
    shared: Map<string, { text: string; r: number; c: number }>,
    context: GridContext,
): string | undefined {
    if (!f) return undefined;
    const type = xmlAttr(f, '', 't');
    if (type === 'dataTable') return undefined;
    const text = withoutFuturePrefixes(xmlText(f));
    if (type !== 'shared') return text;
    const si = xmlAttr(f, '', 'si') ?? '';
    if (xmlAttr(f, '', 'ref')) {
        shared.set(si, { text, r, c });
        return text;
    }
    const anchor = shared.get(si);
    // Past Excel's 8,192 characters a formula is no Excel's, and its translation costs about a hundred times its text.
    if (!anchor?.text || anchor.text.length > MAX_FORMULA_LENGTH) return undefined;
    context.chargeCopy(anchor.text.length);
    return functionCopy(anchor.text, r - anchor.r, c - anchor.c);
}

const VALUE_TYPE: Record<string, 'n' | 'b' | 's'> = { number: 'n', boolean: 'b', string: 's' };

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// A date cell, as Strict and LibreOffice write one: ISO 8601, read as a serial in the 1900 system.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/;

function isoSerial(text: string): number | undefined {
    const match = ISO_DATE.exec(text);
    if (!match) return undefined;
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
    const ms =
        Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) + Number(second) * 1000;
    return (ms - EXCEL_EPOCH_MS) / DAY_MS;
}

// The letters of a cell reference, 1-based; the digits are the row's. Four letters are past the last column already,
// so no more are read.
function columnNumber(reference: string | undefined): number | undefined {
    if (reference === undefined) return undefined;
    const letters = /^[a-z]{1,4}/i.exec(reference);
    return letters ? columnLabelToIndex(letters[0]) + 1 : Number.NaN;
}

// The digits after a cell reference's letters; undefined for none.
function rowNumber(reference: string | undefined): number | undefined {
    const at = reference?.search(/\d/) ?? -1;
    return reference === undefined || at < 0 ? undefined : Number(reference.slice(at));
}

// 0-based. A row or cell without its reference is the one after the previous.
function trackIndex(number: number | undefined, previous: number, count: number): number {
    const index = number === undefined ? previous + 1 : number - 1;
    if (!Number.isInteger(index) || index < 0) throw new ApiError(400, IMPORT_MESSAGES.xlsx.invalid);
    if (index >= count) throw new ApiError(413, TOO_MANY_CELLS);
    return index;
}

function textLength(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}
