// The stored form of a whole workbook, `eigensheets/3`: the JSON text a document's snapshot holds, which a fold writes
// and a load reads. Readers compare their state by this text, so equal books encode to equal text on every reader:
// the encoder fixes every key order itself. A workbook repeats a few formula texts over many cells, so `formulas`
// keeps each once and a cell names it by index, and a column's cells stand in runs of consecutive rows with no row
// written per cell. The decoder rebuilds each sheet and holds it to the guard a `sheet` op's content meets.

import { isRecord } from '../core/guards';
import { MAX_SHEETS } from './limits';
import type { CellRecord, SheetContent } from './ops';
import { isGeneration, isNow, isSeed, isSheetContent } from './ops-validate';

const FORMAT = 'eigensheets/3';

// `g`, `now` and `seed` are the book's generation and the clock of its last batch. `computed` says every value is
// what a finished pass computed, so a formula with no value is a blank result; false says no formula's value is
// trusted. A writer writes what the workbook's `content` gives, never the flag by hand.
export type BookContent = { g: number; now: number; seed: number; computed: boolean; sheets: SheetContent[] };

// A column's cells on consecutive rows from `row`: a value alone stands bare, a formula is `[index]`, `[index, value]`
// or, with an error value, `[index, value, 1]`, and any other cell is its record with `f` an index.
type StoredRun = [column: number, row: number, ...cells: unknown[]];

export function encodeBook(book: BookContent): string {
    const formulas: string[] = [];
    const indexes = new Map<string, number>();
    const indexOf = (formula: string) => {
        let index = indexes.get(formula);
        if (index === undefined) {
            index = formulas.push(formula) - 1;
            indexes.set(formula, index);
        }
        return index;
    };
    const sheets = book.sheets.map((sheet) => {
        const runs: StoredRun[] = [];
        let run: StoredRun | undefined;
        for (const [row, column, cell] of sheet.cells) {
            if (run === undefined || run[0] !== column || run[1] + run.length - 2 !== row) {
                run = [column, row];
                runs.push(run);
            }
            run.push(storedCell(cell, indexOf));
        }
        return {
            id: sheet.id,
            fields: sorted(sheet.fields),
            cells: runs,
            looks: sorted(sheet.looks),
            bands: sheet.bands,
            rows: sorted(sheet.rows),
            columns: sorted(sheet.columns),
            records: sorted(sheet.records),
        };
    });
    const { g, now, seed, computed } = book;
    return JSON.stringify({ f: FORMAT, g, now, seed, computed, formulas, sheets });
}

// The book a text holds, or null when the text is not a whole `eigensheets/3` book: another format, no sheet or too
// many, two sheets with one id or two records of one type with one id, a formula index past the list, or a sheet the
// guard refuses. It never throws.
export function decodeBook(text: string): BookContent | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || Object.keys(value).length !== 7) return null;
    const { f, g, now, seed, computed, formulas, sheets } = value;
    if (f !== FORMAT || !isGeneration(g) || !isNow(now) || !isSeed(seed) || typeof computed !== 'boolean') return null;
    if (!Array.isArray(formulas) || !Array.isArray(sheets) || sheets.length === 0 || sheets.length > MAX_SHEETS)
        return null;
    const decoded: SheetContent[] = [];
    const ids = new Set<string>();
    // A type's name holds no space, so the first one ends it.
    const records = new Set<string>();
    for (const sheet of sheets) {
        if (!isRecord(sheet) || !Array.isArray(sheet['cells'])) return null;
        const cells: unknown[] = [];
        for (const run of sheet['cells']) {
            if (!Array.isArray(run) || run.length < 3 || typeof run[1] !== 'number') return null;
            for (let at = 2; at < run.length; at += 1)
                cells.push([run[1] + at - 2, run[0], decodedCell(run[at], formulas)]);
        }
        const content = { ...sheet, cells };
        if (!isSheetContent(content) || ids.has(content.id)) return null;
        ids.add(content.id);
        for (const [type, of] of Object.entries(content.records)) {
            for (const id of Object.keys(of ?? {})) {
                if (records.has(`${type} ${id}`)) return null;
                records.add(`${type} ${id}`);
            }
        }
        decoded.push(content);
    }
    return { g, now, seed, computed, sheets: decoded };
}

function storedCell(cell: CellRecord, indexOf: (formula: string) => number): unknown {
    const { v, e, f, s, link, qp, spill } = cell;
    if (s === undefined && link === undefined && qp === undefined && spill === undefined) {
        if (f === undefined && e === undefined && v !== undefined) return v;
        if (f !== undefined) {
            if (v === undefined) return [indexOf(f)];
            return e === undefined ? [indexOf(f), v] : [indexOf(f), v, e];
        }
    }
    return sorted(f === undefined ? cell : { ...cell, f: indexOf(f) });
}

// A cell in the record form the guard reads, or null where a formula index names no formula: the guard refuses it.
function decodedCell(stored: unknown, formulas: readonly string[]): unknown {
    if (isRecord(stored)) {
        if (stored['f'] === undefined) return stored;
        const f = typeof stored['f'] === 'number' ? formulas[stored['f']] : undefined;
        return f === undefined ? null : { ...stored, f };
    }
    if (!Array.isArray(stored)) return { v: stored };
    const [index, v, e] = stored;
    const f = typeof index === 'number' ? formulas[index] : undefined;
    if (f === undefined || stored.length > 3) return null;
    if (stored.length === 1) return { f };
    return stored.length === 2 ? { f, v } : { f, v, e };
}

// The same value with every object's keys sorted, so the text never depends on the order a writer set them in. A key
// set to `undefined` is left out by the JSON text, as an absent one is.
function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
}
