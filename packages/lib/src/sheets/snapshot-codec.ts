// Encodes a workbook's sheets as the snapshot JSON its Yjs doc stores, and decodes the JSON back. A large workbook
// repeats a few cell styles and border payloads across many cells, so the encoder keeps each distinct one once in a
// dictionary and leaves the key names out of each cell. The dictionary exists only in the JSON: the decoder rebuilds
// the plain Sheet[] every other reader uses.

import { isRecord } from '../core/guards';
import { cloneSides, parseCellKey } from './borders';
import { wellFormedConditionalFormats, wellFormedValidations } from './range-rules';
import type {
    Cell,
    CellBorderSides,
    CellMatrix,
    CellWithRowAndCol,
    Sheet,
    SheetChart,
    SheetConfig,
    SheetImage,
} from './types';

const FORMAT = 'eigensheets/2';

// A cell's style keys. It is loose on purpose: it keeps whatever keys a cell carried, including ones no type knows.
type StyleTuple = Record<string, unknown>;

// [row, col, styleIndex, content?]. A styleIndex of -1 means no style. A missing content means the cell had no content
// and no extra keys. With both, there is no cell at all.
type EncodedCell = [number, number, number, EncodedContent?];
// The most common cell has an `m` that is exactly String(v), and it is written as the bare value. Any other content
// keeps its keys as they were, with `cc` for commentCardIds.
type EncodedContent = string | number | boolean | Record<string, unknown>;
// [row, col, borderIndex], one for each `config.borderInfo` key.
type EncodedBorder = [number, number, number];

type EncodedSheet = Omit<
    Sheet,
    'celldata' | 'data' | 'config' | 'images' | 'charts' | 'conditionalFormats' | 'dataValidations'
> & {
    config?: Omit<SheetConfig, 'borderInfo'>;
    cells?: EncodedCell[];
    borderCells?: EncodedBorder[];
    // Images, charts and rules are a few small records per sheet, written as they are; an empty map is left out and
    // the decoder adds it back. The rules are read as unknown, since the decoder keeps only the well-formed ones.
    images?: Record<string, SheetImage>;
    charts?: Record<string, SheetChart>;
    conditionalFormats?: unknown;
    dataValidations?: unknown;
};

type SnapshotV2 = {
    f: typeof FORMAT;
    computed: boolean;
    styles: StyleTuple[];
    borders: CellBorderSides[];
    sheets: EncodedSheet[];
};

export function encodeSheetsSnapshot(sheets: Sheet[], opts: { computed: boolean }): string {
    const styles: StyleTuple[] = [];
    const styleIndex = new Map<string, number>();
    const borders: CellBorderSides[] = [];
    const borderIndex = new Map<string, number>();

    const encoded = sheets.map((sheet) => {
        const { celldata, data, config, images, charts, conditionalFormats, dataValidations, ...rest } = sheet;
        const out: EncodedSheet = { ...rest };
        if (images && Object.keys(images).length > 0) out.images = images;
        if (charts && Object.keys(charts).length > 0) out.charts = charts;
        if (conditionalFormats && Object.keys(conditionalFormats).length > 0) {
            out.conditionalFormats = conditionalFormats;
        }
        if (dataValidations && Object.keys(dataValidations).length > 0) out.dataValidations = dataValidations;

        // The dense matrix is never written, but where it exists it holds the latest cells. An editor edit writes
        // `data` and leaves `celldata` stale, so the cells come from `data`, as they do at the end of a replay.
        const entries = data ? denseToEntries(data) : celldata;
        // A row op or a paste can grow the dense matrix past the sheet's `row` and `column`. A reader builds its grid
        // from those two, so they never say less than the matrix holds: a write into a row the reader lacks is skipped.
        if (data) {
            out.row = Math.max(rest.row ?? 0, data.length);
            out.column = data.reduce((widest, row) => Math.max(widest, row?.length ?? 0), rest.column ?? 0);
        }
        if (entries) {
            const cells: EncodedCell[] = [];
            for (const entry of entries) cells.push(encodeCell(entry, styles, styleIndex));
            out.cells = cells;
        }

        // An empty config is still written. A replayed op that adds to it, such as a merge or a row height, can't
        // resolve its path without one, and is skipped.
        if (config) {
            const { borderInfo, ...restConfig } = config;
            out.config = restConfig;
            if (borderInfo) {
                const borderCells: EncodedBorder[] = [];
                for (const [key, sides] of Object.entries(borderInfo)) {
                    borderCells.push([...parseCellKey(key), intern(sides, borders, borderIndex)]);
                }
                out.borderCells = borderCells;
            }
        }

        return out;
    });

    const snapshot: SnapshotV2 = { f: FORMAT, computed: opts.computed, styles, borders, sheets: encoded };
    return JSON.stringify(snapshot);
}

// The encoder writes the format key first on purpose, so this check reads the start of the string and decodes nothing.
export function isCurrentSheetsSnapshot(snapshot: string): boolean {
    return snapshot.startsWith(`{"f":"${FORMAT}"`);
}

export function decodeSheetsSnapshot(snapshot: string): Sheet[] {
    return decodeSheetsWorkbook(snapshot).sheets;
}

// The sheets with the `computed` flag the encoder was given. A writer that encodes them again, such as the server's
// compaction, must pass the flag on.
export function decodeSheetsWorkbook(snapshot: string): { sheets: Sheet[]; computed: boolean } {
    const { f, computed, styles, borders, sheets } = JSON.parse(snapshot) as SnapshotV2;
    // A corrupt snapshot, an older format or a newer one throws here. Read on, it would become a half-empty workbook
    // that hides the problem.
    if (f !== FORMAT) throw unknownFormat(f);
    const ids = new Set<string>();
    const decoded = sheets.map((encoded) => {
        const { cells, borderCells, config, images, charts, conditionalFormats, dataValidations, ...rest } = encoded;
        // Every op names its sheet by id, so a sheet without an id of its own is as corrupt as a bad style index.
        // Making one here would give each reader a different sheet.
        if (typeof rest.id !== 'string' || ids.has(rest.id)) throw unknownFormat(rest.id);
        ids.add(rest.id);
        // Every sheet gets all four maps, even empty: the editor writes each image, chart or rule under its own key,
        // and that patch needs the map. A value that is no map is dropped, and so is a rule that is not well formed.
        const sheet: Sheet = {
            ...rest,
            images: isRecord(images) ? images : {},
            charts: isRecord(charts) ? charts : {},
            conditionalFormats: wellFormedConditionalFormats(conditionalFormats),
            dataValidations: wellFormedValidations(dataValidations),
        };

        if (cells) {
            const celldata: CellWithRowAndCol[] = [];
            for (const [r, c, styleIdx, content] of cells) {
                celldata.push({ r, c, v: decodeCell(styleIdx, content, styles) });
            }
            sheet.celldata = celldata;
        }

        if (config || borderCells) {
            sheet.config = { ...config };
            if (borderCells) {
                const borderInfo: Record<string, CellBorderSides> = {};
                for (const entry of borderCells) {
                    if (!Array.isArray(entry) || entry.length !== 3) throw unknownFormat(entry);
                    const [r, c, borderIdx] = entry;
                    // An index past the borders dictionary is as corrupt as a bad shape, so it throws the same error.
                    if (borders[borderIdx] === undefined) throw unknownFormat(entry);
                    borderInfo[`${r}_${c}`] = cloneSides(borders[borderIdx]);
                }
                sheet.config.borderInfo = borderInfo;
            }
        }

        return sheet;
    });
    return { sheets: decoded, computed };
}

function unknownFormat(found: unknown): Error {
    return new Error(`Unknown sheets snapshot format: ${String(found).slice(0, 40)}`);
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
    // An empty cell stays an empty object. An op recorded against it, such as one that sets its `v`, must still resolve
    // after a round trip. A null cell would roll back the whole replayed batch.
    if (Object.keys(entry.v).length === 0) return [entry.r, entry.c, -1, {}];

    let style: StyleTuple | undefined;
    let content: Record<string, unknown> | undefined;
    let hasExtra = false;
    for (const [key, value] of Object.entries(entry.v)) {
        if (value === undefined) continue;
        switch (key) {
            case 'v':
            case 'm':
            case 'f':
                (content ??= {})[key] = value;
                break;
            case 'mc':
            case 'link':
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

    // An index past the styles dictionary is as corrupt as one past the borders. Read on, it would become a cell with
    // no style that hides the problem.
    if (styleIdx !== -1 && styles[styleIdx] === undefined) throw unknownFormat(styleIdx);
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

// Cells that share a dictionary entry must not share its nested objects. An in-place edit outside an immer draft, such
// as one to `cell.ct`, would change every cell that shares the entry. So every object value is cloned deeply.
function materializeStyle(style: StyleTuple): Record<string, unknown> {
    const cell: Record<string, unknown> = {};
    for (const key in style) {
        const value = style[key];
        cell[key] = typeof value === 'object' && value !== null ? cloneJsonValue(value) : value;
    }
    return cell;
}

function cloneJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const key in value) out[key] = cloneJsonValue(value[key]);
        return out;
    }
    return value;
}

// The keys are sorted before the JSON is made, so two payloads written in a different key order share one entry.
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
