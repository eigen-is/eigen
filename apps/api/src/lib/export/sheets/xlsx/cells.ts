// A worksheet's grid as <sheetData>'s rows, handed over a batch at a time so a sheet of millions of cells is never one
// string: each cell's value, type, formula and look with its own borders, and each row's height and hidden flag. The
// cells and the borders are walked in order, merged, never the row or column numbers between them.

import { pxToPt } from '@workspace/lib/docs/eigendoc';
import type { Cell, CellBorderSides, CellWithRowAndCol, Sheet } from '@workspace/lib/sheets';
import {
    columnIndexToLabel,
    parseCellKey,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    sheetDefaultRowHeight,
} from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { cellDisplay, cellWrapsText, rangeToA1, valueIsError } from '@workspace/sheet/engine';
import type { Lost } from '../../../document/transform/protocol';
import {
    cellFontSize,
    DEFAULT_FONT_SIZE_PT,
    MAX_FORMULA_LENGTH,
    withFuturePrefixes,
} from '../../../ooxml/spreadsheetml';
import type { SharedStringTable } from './strings';
import { BATCH_CHARS, cutText } from './strings';
import type { StyleRegistry } from './styles';

export type GridContext = {
    styles: StyleRegistry;
    strings: SharedStringTable;
    lost: Lost;
};

export type Grid = {
    // The area the cells and borders span.
    dimension: string;
    rows(): Generator<string>;
};

export function inGrid(r: number, c: number): boolean {
    return (
        Number.isInteger(r) &&
        Number.isInteger(c) &&
        r >= 0 &&
        c >= 0 &&
        r < REFERENCE_ROW_COUNT &&
        c < REFERENCE_COLUMN_COUNT
    );
}

export function keyOf(r: number, c: number): number {
    return r * REFERENCE_COLUMN_COUNT + c;
}

export function sheetGrid(sheet: Sheet, context: GridContext): Grid {
    const { lost } = context;
    const cells: CellWithRowAndCol[] = [];
    let ordered = true;
    for (const entry of sheet.celldata ?? []) {
        if (!entry.v) continue;
        if (!inGrid(entry.r, entry.c)) {
            lost('cells-dropped');
            continue;
        }
        const last = cells[cells.length - 1];
        if (last && keyOf(entry.r, entry.c) < keyOf(last.r, last.c)) ordered = false;
        cells.push(entry);
    }
    // Stable, so of a repeated cell the first is written.
    if (!ordered) cells.sort((a, b) => a.r - b.r || a.c - b.c);
    const { borderInfo = {}, rowlen = {}, rowhidden = {} } = sheet.config ?? {};
    const borders = sortedKeys(Object.keys(borderInfo), (key) => {
        const [r, c] = parseCellKey(key);
        return inGrid(r, c) ? keyOf(r, c) : undefined;
    });
    const rowKeys = sortedKeys([...Object.keys(rowlen), ...Object.keys(rowhidden)], (key) => {
        const r = Number(key);
        return inGrid(r, 0) ? r : undefined;
    });

    let top = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let bottom = -1;
    let right = -1;
    const span = (r: number, c: number) => {
        top = Math.min(top, r);
        left = Math.min(left, c);
        bottom = Math.max(bottom, r);
        right = Math.max(right, c);
    };
    for (const { r, c } of cells) span(r, c);
    for (const key of borders) span(Math.floor(key / REFERENCE_COLUMN_COUNT), key % REFERENCE_COLUMN_COUNT);
    const dimension = bottom < 0 ? 'A1' : rangeToA1({ row: [top, bottom], column: [left, right] });

    const labels: string[] = [];
    const cellXml = (r: number, c: number, cell: Cell | undefined, border: CellBorderSides | undefined): string => {
        // A merge's other cells keep their values, as Excel keeps them for the formulas that read them.
        const s = context.styles.xf(cell, border);
        const value = cell && valueXml(cell, context);
        if (!value && s === 0) return '';
        labels[c] ??= columnIndexToLabel(c);
        const attributes = `${s ? ` s="${s}"` : ''}${value?.t ? ` t="${value.t}"` : ''}`;
        return value?.xml
            ? `<c r="${labels[c]}${r + 1}"${attributes}>${value.xml}</c>`
            : `<c r="${labels[c]}${r + 1}"${attributes}/>`;
    };
    // The editor draws a row without a height of its own at the default. Excel and LibreOffice fit a row that isn't
    // custom to its content on open, so a row whose content they would grow is written custom at the default.
    const defaultHeight = sheetDefaultRowHeight(sheet);
    const rowAttributes = (r: number, refits: boolean): string => {
        const stored = Number(rowlen[r]);
        const px = stored > 0 && Number.isFinite(stored) ? stored : refits ? defaultHeight : 0;
        const height = px ? ` ht="${pxToPt(px)}" customHeight="1"` : '';
        return `${height}${rowhidden[r] != null ? ' hidden="1"' : ''}`;
    };

    function* rows(): Generator<string> {
        let batch = '';
        let ci = 0;
        let bi = 0;
        let ri = 0;
        const nextCell = () => (ci < cells.length ? keyOf(cells[ci].r, cells[ci].c) : Number.POSITIVE_INFINITY);
        const nextBorder = () => (bi < borders.length ? borders[bi] : Number.POSITIVE_INFINITY);
        for (;;) {
            const r = Math.min(
                Math.floor(Math.min(nextCell(), nextBorder()) / REFERENCE_COLUMN_COUNT),
                ri < rowKeys.length ? rowKeys[ri] : Number.POSITIVE_INFINITY,
            );
            if (r === Number.POSITIVE_INFINITY) break;
            while (ri < rowKeys.length && rowKeys[ri] === r) ri++;
            const end = keyOf(r + 1, 0);
            let content = '';
            let written = -1;
            let refits = false;
            for (;;) {
                const cellKey = nextCell();
                const borderKey = nextBorder();
                const key = Math.min(cellKey, borderKey);
                if (key >= end) break;
                const cell = cellKey === key ? cells[ci++].v : undefined;
                if (borderKey === key) bi++;
                if (key === written) continue;
                written = key;
                if (cell && !refits) refits = refitsOnOpen(cell);
                const c = key - r * REFERENCE_COLUMN_COUNT;
                content += cellXml(r, c, cell ?? undefined, borderKey === key ? borderInfo[`${r}_${c}`] : undefined);
            }
            const attributes = rowAttributes(r, refits);
            if (content || attributes) batch += `<row r="${r + 1}"${attributes}>${content}</row>`;
            if (batch.length >= BATCH_CHARS) {
                yield batch;
                batch = '';
            }
        }
        if (batch) yield batch;
    }

    return { dimension, rows };
}

// Whether Excel and LibreOffice would fit a row that isn't custom to this cell on open: it wraps text it holds, as the
// editor's own auto-grow asks, or its font or one of its runs' is larger than Excel's default.
function refitsOnOpen(cell: Cell): boolean {
    if (cellWrapsText(cell) && cellDisplay(cell)) return true;
    if (cellFontSize(cell.fs) > DEFAULT_FONT_SIZE_PT) return true;
    return cell.ct?.s?.some((run) => cellFontSize(run.fs) > DEFAULT_FONT_SIZE_PT) ?? false;
}

function sortedKeys(keys: string[], keyOfEntry: (key: string) => number | undefined): Float64Array {
    const out = new Float64Array(keys.length);
    let length = 0;
    for (const key of keys) {
        const value = keyOfEntry(key);
        if (value !== undefined) out[length++] = value;
    }
    return out.subarray(0, length).sort();
}

// A formula with its cached result, else the value: a number, a boolean, an error or text. Text a cell shows is a shared
// string, a formula's result inline, as Excel writes them.
function valueXml(cell: Cell, context: GridContext): { t?: string; xml: string } | undefined {
    const stored = typeof cell.f === 'string' ? cell.f.replace(/^=/, '') : '';
    let formula = stored && withFuturePrefixes(stored);
    if (formula.length > MAX_FORMULA_LENGTH) {
        context.lost('formulas-dropped');
        formula = '';
    }
    const v = cell.v;
    if (formula) {
        const f = `<f>${escapeXml(formula)}</f>`;
        if (typeof v === 'string') {
            if (valueIsError(v)) return { t: 'e', xml: `${f}<v>${v}</v>` };
            return { t: 'str', xml: `${f}<v>${escapeXml(cutText(v, context.lost))}</v>` };
        }
        const result = v === undefined ? undefined : scalarXml(v);
        return { t: result?.t, xml: `${f}${result?.xml ?? ''}` };
    }
    const runs = cell.ct?.s && context.strings.runs(cell.ct.s);
    if (runs !== undefined) return { t: 's', xml: `<v>${runs}</v>` };
    if (typeof v === 'string') return { t: 's', xml: `<v>${context.strings.text(v)}</v>` };
    return v === undefined ? undefined : scalarXml(v);
}

// Excel holds no infinity or NaN: #NUM! is its overflow.
function scalarXml(v: number | boolean): { t?: string; xml: string } {
    if (typeof v === 'boolean') return { t: 'b', xml: `<v>${v ? 1 : 0}</v>` };
    return Number.isFinite(v) ? { xml: `<v>${v}</v>` } : { t: 'e', xml: '<v>#NUM!</v>' };
}
