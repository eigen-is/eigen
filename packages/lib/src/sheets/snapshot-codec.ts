// Wire codec for the sheets snapshot (the JSON string in the Yjs `state` map).
// v1 was JSON.stringify(Sheet[]), which repeats every cell's style keys and every
// border payload inline — 56MB for a real 340k-cell workbook, of which only 224
// distinct style combinations and ~110 distinct border payloads were measured.
// v2 interns both workbook-wide and drops the per-cell key names, ~4.5x smaller.
// The dictionary lives at the serialization seam only: the in-memory Sheet[] the
// decoder rebuilds is exactly today's shape.

import type { BorderSide, Cell, CellBorderSides, CellMatrix, CellWithRowAndCol, Sheet, SheetConfig } from './types';

const FORMAT = 'eigensheets/2';

// Cell style payload. Deliberately loose: it holds whatever keys a cell carried,
// including ones no current type knows about.
type StyleTuple = Record<string, unknown>;

// [row, col, styleIndex, content?]. styleIndex -1 = no style; a missing content
// slot = the cell had neither content nor extra keys (with -1: no cell at all).
type EncodedCell = [number, number, number, EncodedContent?];
// A bare primitive is a `v` whose `m` is exactly String(v) — the overwhelmingly
// common cell, encoded without either key name. Everything else spells out the
// keys it had verbatim (`cc` = commentCardIds).
type EncodedContent = string | number | boolean | Record<string, unknown>;
// [row, col, borderIndex] — one per `config.borderInfo` key.
type EncodedBorder = [number, number, number];

type EncodedSheet = Omit<Sheet, 'celldata' | 'data' | 'config'> & {
    config?: Omit<SheetConfig, 'borderInfo'>;
    cells?: EncodedCell[];
    borderCells?: EncodedBorder[];
};

type SnapshotV2 = {
    f: typeof FORMAT;
    computed: boolean;
    styles: StyleTuple[];
    borders: CellBorderSides[];
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
    const borders: CellBorderSides[] = [];
    const borderIndex = new Map<string, number>();

    const encoded = sheets.map((sheet) => {
        const {
            celldata,
            data,
            selections: _selections,
            calcChain: _calcChain,
            config,
            ...rest
        } = sheet as RuntimeSheet;
        const out: EncodedSheet = { ...rest };

        // The dense matrix never goes on the wire, but it is the authoritative copy
        // when present: editor state edits write `data` and leave `celldata` stale,
        // so folding it in here is what the read path's withSyncedCelldataIfData
        // does — without it a flushed workbook persists as its pre-edit celldata.
        const entries = data ? denseToEntries(data) : celldata;
        if (entries) {
            const cells: EncodedCell[] = [];
            for (const entry of entries) cells.push(encodeCell(entry, styles, styleIndex));
            out.cells = cells;
        }

        // An empty config still ships: every fresh sheet has one, and a replayed op
        // adding to it (`config.merge.0_0`, a row height, …) cannot resolve its path
        // against an absent config — immer rejects the whole batch.
        if (config) {
            const { borderInfo, ...restConfig } = config;
            out.config = restConfig;
            if (borderInfo) {
                const borderCells: EncodedBorder[] = [];
                for (const [key, sides] of Object.entries(borderInfo)) {
                    const [r, c] = key.split('_').map(Number);
                    borderCells.push([r, c, intern(sides, borders, borderIndex)]);
                }
                out.borderCells = borderCells;
            }
        }

        return out;
    });

    const snapshot: SnapshotV2 = { f: FORMAT, computed: opts.computed, styles, borders, sheets: encoded };
    return JSON.stringify(snapshot);
}

export function decodeSheetsSnapshot(snapshot: string): Sheet[] {
    const { f, computed, styles, borders, sheets } = JSON.parse(snapshot) as SnapshotV2;
    // Fail crisp on a corrupt envelope, a v1 array or a future format — silent
    // garbage-in would materialize a half-empty workbook instead of surfacing the problem.
    if (f !== FORMAT) throw new Error(`Unknown sheets snapshot format: ${String(f).slice(0, 40)}`);
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
            if (borderCells) {
                const borderInfo: Record<string, CellBorderSides> = {};
                for (const [r, c, borderIdx] of borderCells) borderInfo[`${r}_${c}`] = cloneSides(borders[borderIdx]);
                sheet.config.borderInfo = borderInfo;
            }
        }

        return sheet;
    });
}

function denseToEntries(data: CellMatrix): CellWithRowAndCol[] {
    const entries: CellWithRowAndCol[] = [];
    for (let r = 0; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (v != null) entries.push({ r, c, v });
        }
    }
    return entries;
}

function encodeCell(entry: CellWithRowAndCol, styles: StyleTuple[], styleIndex: Map<string, number>): EncodedCell {
    if (entry.v == null) return [entry.r, entry.c, -1];
    // An empty cell object is not null: an op patch recorded against it (e.g.
    // ['data', r, c, 'v']) must still resolve through it after a round-trip —
    // a null parent would roll back the whole replayed batch.
    if (Object.keys(entry.v).length === 0) return [entry.r, entry.c, -1, {}];

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

    const cell: Record<string, unknown> = styleIdx === -1 ? {} : materializeStyle(styles[styleIdx]);
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

// Consumers sharing a dictionary entry (cell styles, border side payloads) must
// not share nested object identity — an in-place `cell.ct.x = …` outside an immer
// draft would corrupt every sibling. Primitives copy by value; object values deep-clone.
function materializeStyle(style: StyleTuple): Record<string, unknown> {
    const cell: Record<string, unknown> = {};
    for (const key in style) {
        const value = style[key];
        cell[key] = typeof value === 'object' && value !== null ? cloneJsonValue(value) : value;
    }
    return cell;
}

const BORDER_SIDE_KEYS = ['l', 'r', 't', 'b', 's'] as const;

// Cells sharing a dictionary entry must not share side-object identity (see materializeStyle).
function cloneSides(sides: CellBorderSides): CellBorderSides {
    const out: CellBorderSides = {};
    for (const key of BORDER_SIDE_KEYS) {
        const side: BorderSide | undefined = sides[key];
        if (side) out[key] = { style: side.style, color: side.color };
    }
    return out;
}

function cloneJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const key in value as Record<string, unknown>)
            out[key] = cloneJsonValue((value as Record<string, unknown>)[key]);
        return out;
    }
    return value;
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
