// How a batch's cell and field ops land on a workbook's sheets, for a live tab, a joiner's replay and the server
// alike. opToPatchOnSheets leaves out the ops no sheet can take, such as a matrix that is no array or a peer's
// malformed validation rule, and applySheetWrites applies the rest one by one, skipping a write whose parent is gone.
// It lives in lib so the API can replay ops without the sheet package's state barrel, which reaches DOM code.

import type { Patch } from 'immer';
import { MAX_CHART_SPEC_ENTRIES } from '../charts/limits';
import { SHEET_CHART_KEYED_PART_KEYS } from '../charts/spec';
import { isRecord } from '../core/guards';
import { chartEntries, chartsWithinEntryCap } from './floating';
import type { Op, Sheet } from './types';
import { isCellLinkType, isPatchOp } from './types';
import { isSheetValidation, isSheetValidations, MAX_VALIDATIONS } from './validations';

// The batch's cell and field ops as writes on `sheets`, the sheet's index first. A sheet, row or column op is the
// caller's to apply, before this, since it settles which sheets there are.
export function opToPatchOnSheets(sheets: readonly Sheet[], ops: readonly Op[]): Patch[] {
    const patches: Patch[] = [];
    for (const op of ops) {
        if (!isPatchOp(op)) continue;
        // An op without a sheet id names no sheet, such as the whole `sheets` replace immer emits beside a row op.
        // The row op's own marker carries what changed.
        if (!op.id || !op.path.every(isKey)) continue;
        // A log written before a cell's `f` became the one record of its formula holds writes to a list no sheet has.
        if (op.path[0] === 'calcChain') continue;
        // No writer ships a sheet whole or its stored cell list, and a reader with no matrix would be the only one to
        // apply it.
        if (op.path.length === 0 || op.path[0] === 'celldata') continue;
        // Every op finds its sheet by id and a formula by name, so they change only through the checked sheet ops.
        if (op.path[0] === 'id' || op.path[0] === 'name') continue;
        // Every reader walks a sheet's matrix and its rows, so a write that would leave either no array is dropped.
        const writesMatrixOrRow = op.path.length === 1 || (op.path.length === 2 && typeof op.path[1] === 'number');
        if (op.path[0] === 'data' && writesMatrixOrRow && !Array.isArray(op.value)) continue;
        if (op.path[0] === 'dataValidations' && !isValidationWrite(op)) continue;
        if (op.path[0] === 'data' && !isCellWrite(op)) continue;
        if (op.path[0] === 'charts' && !isChartWrite(op)) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i !== -1) patches.push({ op: op.op, value: op.value, path: [i, ...op.path] });
    }
    return patches;
}

// One batch's writes, each on what the writes before it left and on copies of what it changes. A write whose parent
// is gone, or that names no place in it, is skipped alone on every reader. Paths are Sheet[]-rooted.
export function applySheetWrites(
    sheets: readonly Sheet[],
    writes: readonly Patch[],
): { sheets: Sheet[]; applied: Patch[] } {
    const result = [...sheets];
    const copied = new Set<unknown>();
    const sizes = new Map<string, number>();
    const applied: Patch[] = [];
    for (const write of writes) {
        const { op, path, value } = write;
        const last = path.length - 1;
        const above: Container[] = [result];
        for (let depth = 0; depth < last; depth += 1) {
            const next = held(above[depth], path[depth]);
            if (!isContainer(next)) break;
            above.push(next);
        }
        const parent = above[last];
        if (last < 1 || !parent || !resolves(parent, path[last], op, value)) continue;
        if (!withinCaps(above, write, sizes)) continue;
        applied.push(write);
        if (op === 'replace' && Object.is(held(parent, path[last]), value)) continue;
        let owner: Container = result;
        for (let depth = 1; depth <= last; depth += 1) {
            let next = above[depth];
            if (!copied.has(next)) {
                next = Array.isArray(next) ? next.slice() : { ...next };
                copied.add(next);
                put(owner, path[depth - 1], 'replace', next);
            }
            owner = next;
        }
        put(owner, path[last], op, value);
    }
    return { sheets: result, applied };
}

// A whole sheet a peer adds brings its cells past every cell write, as the matrix or as the stored list.
export function sheetHoldsNoBadLink({ data, celldata }: Record<string, unknown>): boolean {
    if (Array.isArray(data) && !data.flat().every(holdsNoBadLink)) return false;
    return !Array.isArray(celldata) || celldata.every((entry) => !isRecord(entry) || holdsNoBadLink(entry['v']));
}

// The editor writes a sheet's validations whole or one entry at a time. A write that would leave an entry not well
// formed, or one into an entry's fields, which the editor never sends, is dropped.
function isValidationWrite(op: Op): boolean {
    if (op.path.length === 1) return isSheetValidations(op.value);
    return op.path.length === 2 && (op.op === 'remove' || isSheetValidation(op.value));
}

// A rename and the exports read every link's type and address, so a write that leaves a link without them, or of a
// kind no reader follows, is dropped. The editor writes a link whole, as it writes a cell, a row or a matrix.
function isCellWrite({ op, path, value }: Op): boolean {
    if (path[3] === 'link') return path.length === 4 && (op === 'remove' || isLink(value));
    if (path.length > 3) return true;
    // No writer removes the matrix, a row or a cell's place: immer cuts an array by its `length`. A removal would
    // leave the matrix a size no snapshot keeps, and a joiner would apply the writes a live tab then skips.
    if (op === 'remove') return false;
    return Array.isArray(value) ? value.flat().every(holdsNoBadLink) : holdsNoBadLink(value);
}

function holdsNoBadLink(cell: unknown): boolean {
    if (!isRecord(cell)) return true;
    const { link } = cell;
    return link === undefined || isLink(link);
}

function isLink(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const { type, address } = value;
    return isCellLinkType(type) && typeof address === 'string';
}

// A chart's keyed parts stay records, as every writer of an entry expects, and nothing is written below an entry,
// which is a string.
function isChartWrite({ path, value }: Op): boolean {
    if (path.length > 4) return false;
    return path.length !== 3 || !SHEET_CHART_KEYED_PART_KEYS.has(String(path[2])) || isRecord(value);
}

type Container = Record<string, unknown> | unknown[];
type Key = string | number;

const isKey = (key: unknown): key is Key => typeof key === 'string' || typeof key === 'number';
const isContainer = (value: unknown): value is Container => typeof value === 'object' && value !== null;
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const entries = (value: unknown) => (isRecord(value) ? Object.keys(value).length : 0);

function held(parent: Container, key: Key): unknown {
    if (Array.isArray(parent)) return typeof key === 'number' ? parent[key] : undefined;
    return Object.hasOwn(parent, key) ? parent[key] : undefined;
}

// An array takes an index it holds, an add anywhere, and a `length` that cuts it, immer's undo of a grown array. A
// record's replace needs no key: immer writes one for a key held with no value, which a stored snapshot drops.
function resolves(parent: Container, key: Key, op: Patch['op'], value: unknown): boolean {
    if (!Array.isArray(parent)) return key !== '__proto__' && (op !== 'remove' || Object.hasOwn(parent, key));
    if (key === 'length') return op === 'replace' && isIndex(value) && value <= parent.length;
    return isIndex(key) && (op === 'add' || key < parent.length);
}

function put(parent: Container, key: Key, op: Patch['op'], value: unknown) {
    if (!Array.isArray(parent)) {
        if (op === 'remove') delete parent[key];
        else parent[key] = value;
    } else if (typeof key === 'string') parent.length = Number(value);
    else if (op === 'replace') parent[key] = value;
    else if (op === 'add') parent.splice(key, 0, value);
    else parent.splice(key, 1);
}

// A peer's op is untrusted, so a sheet's rules and a chart's entries stay within their caps as the batch goes, each
// counted once in `sizes`. A `replace` of a rule that is gone is skipped too, so a peer's delete wins.
function withinCaps(above: readonly Container[], { op, path, value }: Patch, sizes: Map<string, number>): boolean {
    const [sheet, field, id, key, entry] = path;
    const [, , collection, chart, part] = above;
    const kept = op !== 'remove';
    if (field !== 'charts' && field !== 'dataValidations') return true;
    if (path.length === 2) sizes.clear();
    if (field === 'dataValidations') {
        if (path.length !== 3 || !isRecord(collection)) return true;
        const known = Object.hasOwn(collection, id);
        const size = (sizes.get(`${sheet}`) ?? Object.keys(collection).length) + Number(kept) - Number(known);
        if (!known && (op === 'replace' || size > MAX_VALIDATIONS)) return false;
        sizes.set(`${sheet}`, size);
        return true;
    }
    const at = `${sheet}/${id}`;
    if (path.length === 2) return !isRecord(value) || chartsWithinEntryCap(value) === value;
    if (path.length === 3) {
        sizes.delete(at);
        return chartEntries(value) <= MAX_CHART_SPEC_ENTRIES;
    }
    if (!isRecord(chart)) return true;
    let size = sizes.get(at) ?? chartEntries(chart);
    if (path.length === 4) {
        size += (kept ? 1 + entries(value) : 0) - (Object.hasOwn(chart, key) ? 1 + entries(chart[key]) : 0);
    } else if (isRecord(part)) size += Number(kept) - Number(Object.hasOwn(part, entry));
    if (size > MAX_CHART_SPEC_ENTRIES) return false;
    sizes.set(at, size);
    return true;
}
