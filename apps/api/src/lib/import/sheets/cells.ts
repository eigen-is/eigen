import type { CellBorderSides, Cell as FortuneCell } from '@workspace/lib/sheets';
import {
    booleanDisplay,
    functionCopy,
    numberDisplay,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    update,
} from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import { isOn, SML_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlText } from '../../core/xml';
import { NOT_AN_XLSX, TOO_MANY_CELLS } from './package';
import { type SharedString, stringOf, textOf } from './strings';
import { type Look, NO_LOOK, type ThemePalette } from './styles';
import { cellKey, type PlacedCell } from './worksheet';

// A worksheet's grid, read a batch of rows at a time: each cell's value, display, type, formula and look, the
// borders, the row heights and the hidden rows. Only what the file holds is walked, never the row or column numbers.

// Excel's date epoch is 1899-12-30 (not 1900-01-01 — Lotus 1-2-3 1900 leap-year bug).
export const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
export const DAY_MS = 86_400_000;

// A 1904 workbook counts its days from 1904-01-01, 1,462 days after the 1900 system's day 0.
export const DAYS_1904 = 1462;

export type GridContext = {
    looks: Look[];
    strings: SharedString[];
    date1904: boolean;
    palette: ThemePalette;
    // Called for each cell the grid emits, a value or a border, with the characters it writes, and for each row's height
    // and hidden flag; a placed cell is charged already. Throws past the budget.
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
    rowhidden: Record<string, number>;
    // The rows and columns the cells reach; recalc materialises at least a default grid's.
    rows: number;
    columns: number;
};

// `rows` are the <row> elements of <sheetData>, in the file's order.
export function readGrid(rows: Iterable<XmlElement>, context: GridContext): Grid {
    const grid: Grid = { celldata: [], borderInfo: {}, heights: new Map(), rowhidden: {}, rows: 0, columns: 0 };
    const emit = (entry: PlacedCell) => {
        grid.celldata.push(entry);
        grid.rows = Math.max(grid.rows, entry.r + 1);
        grid.columns = Math.max(grid.columns, entry.c + 1);
    };
    // A shared formula's copies name it by its si, after the anchor that holds its text.
    const shared = new Map<string, { text: string; r: number; c: number }>();
    let r = -1;
    for (const row of rows) {
        const reference = xmlAttr(row, '', 'r');
        r = indexOf(reference === undefined ? undefined : Number(reference), r, REFERENCE_ROW_COUNT);
        if (isOn(xmlAttr(row, '', 'hidden')) && !(r in grid.rowhidden)) {
            context.charge(1, 0);
            grid.rowhidden[r] = 0;
        }
        const height = Number.parseFloat(xmlAttr(row, '', 'ht') ?? '');
        if (height > 0) {
            if (!grid.heights.has(r)) context.charge(1, 0);
            grid.heights.set(r, height);
        }
        let c = -1;
        for (const element of xmlChildren(row, SML_NS, 'c')) {
            c = indexOf(columnNumber(xmlAttr(element, '', 'r')), c, REFERENCE_COLUMN_COUNT);
            const look = context.looks[Number(xmlAttr(element, '', 's'))] ?? NO_LOOK;
            const cell = readCell(
                element,
                look,
                context,
                formulaOf(xmlChild(element, SML_NS, 'f'), r, c, shared, context),
            );
            const placed = context.placed.get(cellKey(r, c));
            const empty =
                !placed &&
                cell.v === undefined &&
                cell.f === undefined &&
                cell.bg === undefined &&
                cell.fc === undefined;
            if (empty && !look.border) continue;
            context.charge(placed ? 0 : 1, length(cell.v) + length(cell.m) + length(cell.f));
            if (look.border) grid.borderInfo[`${r}_${c}`] = look.border;
            if (empty) continue;
            context.placed.delete(cellKey(r, c));
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
    let date = false;
    if (type === 'inlineStr') {
        const is = xmlChild(element, SML_NS, 'is');
        value = (is && textOf(stringOf(is, context.palette))) || undefined;
    } else if (raw !== '') {
        if (type === 's') {
            const string = context.strings[Number(raw)];
            value = string === undefined ? undefined : textOf(string);
        } else if (type === 'str' || type === 'e') value = raw;
        else if (type === 'b') value = Number.parseInt(raw, 10) !== 0;
        else if (type === 'd') {
            value = isoSerial(raw);
            date = value !== undefined;
        } else value = Number.parseFloat(raw);
    }
    if (typeof value === 'number' && Number.isFinite(value) && !date && look.isDate) {
        date = true;
        if (context.date1904) value += DAYS_1904;
    }
    const cell: FortuneCell = { ...look.cell };
    if (value !== undefined) {
        cell.v = value;
        if (typeof value === 'number') {
            cell.m = date ? dateDisplay(value, look.numFmt) : numberDisplay(value, look.numFmt);
            if (!look.aligned) cell.ht = 2;
        } else cell.m = typeof value === 'boolean' ? booleanDisplay(value) : value;
    }
    if (formula) cell.f = `=${formula}`;
    const t = date
        ? 'd'
        : value === undefined
          ? undefined
          : typeof value === 'number'
            ? 'n'
            : typeof value === 'boolean'
              ? 'b'
              : 's';
    // Fortune-sheet always pairs `t` with `fa`, General when the cell has no format.
    if (t || look.fa) cell.ct = { fa: look.fa ?? 'General', ...(t && { t }) };
    return cell;
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
    const text = xmlText(f);
    if (type === 'dataTable') return undefined;
    if (type !== 'shared') return text;
    const si = xmlAttr(f, '', 'si') ?? '';
    if (xmlAttr(f, '', 'ref')) {
        shared.set(si, { text, r, c });
        return text;
    }
    const anchor = shared.get(si);
    if (!anchor?.text) return undefined;
    context.chargeCopy(anchor.text.length);
    return functionCopy(anchor.text, r - anchor.r, c - anchor.c);
}

// numfmt renders a bare serial under General as a number, so a date without a date format shows as m/d/yyyy; a
// malformed format, which a hostile workbook can carry, as yyyy-mm-dd.
export function dateDisplay(serial: number, numFmt: string | undefined): string {
    try {
        return update(numFmt && numFmt !== 'General' ? numFmt : 'm/d/yyyy', serial);
    } catch {
        return update('yyyy-mm-dd', serial);
    }
}

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

// The letters of a cell reference, 1-based; the digits are the row's. Four letters are past the last column already.
function columnNumber(reference: string | undefined): number | undefined {
    if (reference === undefined) return undefined;
    let column = 0;
    let letters = 0;
    for (; letters < Math.min(reference.length, 4); letters++) {
        const code = reference.charCodeAt(letters) | 0x20;
        if (code < 0x61 || code > 0x7a) break;
        column = column * 26 + code - 0x60;
    }
    return letters > 0 ? column : Number.NaN;
}

// 0-based. A row or cell without its reference is the one after the previous.
function indexOf(number: number | undefined, previous: number, count: number): number {
    const index = number === undefined ? previous + 1 : number - 1;
    if (!Number.isInteger(index) || index < 0) throw new ApiError(400, NOT_AN_XLSX);
    if (index >= count) throw new ApiError(413, TOO_MANY_CELLS);
    return index;
}

function length(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}
