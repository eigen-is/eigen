// Wire codec for the sheets snapshot (the JSON string in the Yjs `state` map).
// v1 was JSON.stringify(Sheet[]), which repeats every cell's style keys and every
// border payload inline — 56MB for a real 340k-cell workbook, of which only 224
// distinct style combinations and ~110 distinct border payloads were measured.
// v2 interns both workbook-wide and drops the per-cell key names, ~5.5x smaller.
// The dictionary lives at the serialization seam only: the in-memory Sheet[] the
// decoder rebuilds is exactly today's shape.

import type { BorderInfo, Cell, CellBorderInfo, CellWithRowAndCol, Sheet, SheetConfig } from './types';

const FORMAT = 'eigensheets/2';

// Dictionary payloads. Deliberately loose Records: they hold whatever keys a cell
// or a border carried, including ones no current type knows about.
type StyleTuple = Record<string, unknown>;
type BorderSides = Record<string, unknown>;

// [row, col, styleIndex, content?]. styleIndex -1 = no style; a missing content
// slot = the cell had neither content nor extra keys (with -1: no cell at all).
type EncodedCell = [number, number, number, EncodedContent?];
// A bare primitive is a `v` whose `m` is exactly String(v) — the overwhelmingly
// common cell, encoded without either key name. Everything else spells out the
// keys it had verbatim (`cc` = commentCardIds).
type EncodedContent = string | number | boolean | Record<string, unknown>;
// [row, col, borderIndex] for a cell border; other rangeTypes ride along verbatim
// because the array order is semantic (later entries override earlier ones).
type EncodedBorder = [number, number, number] | BorderInfo;

type EncodedSheet = Omit<Sheet, 'celldata' | 'data' | 'config'> & {
    config?: Omit<SheetConfig, 'borderInfo'>;
    cells?: EncodedCell[];
    borderCells?: EncodedBorder[];
};

type SnapshotV2 = {
    f: typeof FORMAT;
    computed: boolean;
    styles: StyleTuple[];
    borders: BorderSides[];
    sheets: EncodedSheet[];
};

// Editor-runtime extras the wire shape omits: `selections` is a per-client cursor,
// `calcChain` (packages/sheet engine/types.ts) is regenerated on decode. lib cannot
// import the sheet package, so the entry shape is restated here.
type CalcChainEntry = { r: number; c: number; id: string };
type RuntimeSheet = Sheet & { selections?: unknown; calcChain?: CalcChainEntry[] };

export function encodeSheetsSnapshot(sheets: Sheet[], opts: { computed: boolean }): string {
    const styles: StyleTuple[] = [];
    const styleIndex = new Map<string, number>();
    const borders: BorderSides[] = [];
    const borderIndex = new Map<string, number>();

    const encoded = sheets.map((sheet) => {
        const {
            celldata,
            data: _data,
            selections: _selections,
            calcChain: _calcChain,
            config,
            ...rest
        } = sheet as RuntimeSheet;
        const out: EncodedSheet = { ...rest };

        if (celldata) {
            const cells: EncodedCell[] = [];
            for (const entry of celldata) cells.push(encodeCell(entry, styles, styleIndex));
            out.cells = cells;
        }

        if (config) {
            const { borderInfo, ...restConfig } = config;
            if (Object.keys(restConfig).length > 0) out.config = restConfig;
            if (borderInfo) out.borderCells = borderInfo.map((info) => encodeBorder(info, borders, borderIndex));
        }

        return out;
    });

    const snapshot: SnapshotV2 = { f: FORMAT, computed: opts.computed, styles, borders, sheets: encoded };
    return JSON.stringify(snapshot);
}

export function decodeSheetsSnapshot(snapshot: string): Sheet[] {
    // Every doc written before v2 stores a plain Sheet[] array.
    if (snapshot.trimStart().startsWith('[')) return JSON.parse(snapshot) as Sheet[];

    const { computed, styles, borders, sheets } = JSON.parse(snapshot) as SnapshotV2;
    return sheets.map((encoded) => {
        const { cells, borderCells, config, ...rest } = encoded;
        const sheet: RuntimeSheet = { ...rest };

        if (cells) {
            const celldata: CellWithRowAndCol[] = [];
            const calcChain: CalcChainEntry[] = [];
            const id = sheet.id;
            for (const [r, c, styleIdx, content] of cells) {
                const cell = decodeCell(styleIdx, content, styles);
                celldata.push({ r, c, v: cell });
                if (id != null && typeof cell?.f === 'string') calcChain.push({ r, c, id });
            }
            sheet.celldata = celldata;
            // A populated calcChain is the read path's "already computed" signal; a
            // snapshot flushed with stale values must leave it off so recalc fires.
            if (computed) sheet.calcChain = calcChain;
        }

        if (config || borderCells) {
            sheet.config = { ...config };
            if (borderCells) sheet.config.borderInfo = borderCells.map((entry) => decodeBorder(entry, borders));
        }

        return sheet;
    });
}

function encodeCell(entry: CellWithRowAndCol, styles: StyleTuple[], styleIndex: Map<string, number>): EncodedCell {
    if (entry.v == null) return [entry.r, entry.c, -1];

    const raw = entry.v as Record<string, unknown>;
    let style: StyleTuple | undefined;
    let content: Record<string, unknown> | undefined;
    let hasExtra = false;
    for (const key in raw) {
        const value = raw[key];
        if (value === undefined) continue;
        switch (key) {
            case 'v':
            case 'm':
            case 'f':
                (content ??= {})[key] = value;
                break;
            case 'mc':
            case 'hl':
            case 'spl':
                (content ??= {})[key] = value;
                hasExtra = true;
                break;
            case 'commentCardIds':
                (content ??= {})['cc'] = value;
                hasExtra = true;
                break;
            default:
                (style ??= {})[key] = value;
        }
    }

    const styleIdx = style ? intern(style, styles, styleIndex) : -1;
    if (!content) return [entry.r, entry.c, styleIdx];

    const v = content['v'];
    if (!hasExtra && content['f'] === undefined && isPrimitive(v) && content['m'] === String(v)) {
        return [entry.r, entry.c, styleIdx, v];
    }
    return [entry.r, entry.c, styleIdx, content];
}

function decodeCell(styleIdx: number, content: EncodedContent | undefined, styles: StyleTuple[]): Cell | null {
    if (styleIdx === -1 && content === undefined) return null;

    const cell: Record<string, unknown> = styleIdx === -1 ? {} : { ...styles[styleIdx] };
    if (content === undefined) return cell as Cell;
    if (typeof content !== 'object') {
        cell['v'] = content;
        cell['m'] = String(content);
        return cell as Cell;
    }
    for (const key in content) {
        if (key === 'cc') cell['commentCardIds'] = content[key];
        else cell[key] = content[key];
    }
    return cell as Cell;
}

function encodeBorder(info: BorderInfo, borders: BorderSides[], borderIndex: Map<string, number>): EncodedBorder {
    if (info.rangeType !== 'cell') return info;
    const { row_index, col_index, ...sides } = info.value;
    return [row_index, col_index, intern(sides, borders, borderIndex)];
}

function decodeBorder(entry: EncodedBorder, borders: BorderSides[]): BorderInfo {
    if (!Array.isArray(entry)) return entry;
    const value = { row_index: entry[0], col_index: entry[1], ...borders[entry[2]] } as CellBorderInfo['value'];
    return { rangeType: 'cell', value };
}

// Keys are sorted before stringifying so two payloads that were written in a
// different key order still land on one dictionary entry.
function intern(tuple: Record<string, unknown>, dict: Record<string, unknown>[], index: Map<string, number>): number {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(tuple).sort()) canonical[key] = tuple[key];
    const hash = JSON.stringify(canonical);
    const existing = index.get(hash);
    if (existing !== undefined) return existing;
    index.set(hash, dict.length);
    dict.push(canonical);
    return dict.length - 1;
}

function isPrimitive(value: unknown): value is string | number | boolean {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
