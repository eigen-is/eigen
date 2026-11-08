// Whether a peer's op batches that land in the op log before batches a tab already applied may simply apply after
// them. A host such as the sheets editor asks this when such a late batch arrives. When the batches commute, the tab
// applies the late ones directly and keeps its undo. When they don't, it applies the log again from an earlier state.

import type { Op } from '../types';

// Whether the fresh batches, applied after the overtaken ones, still give the workbook the log's order gives. They do
// when no batch adds, deletes, renames or moves sheets, rows or columns: a rename rewrites the formulas naming the sheet
// wherever they are. They also need that no op of one side writes a path an op of the other writes, or a path inside or
// above it.
export function commutes(fresh: Iterable<Op[]>, overtaken: Op[][]): boolean {
    const written = new Set<string>();
    const above = new Set<string>();
    for (const ops of overtaken) {
        const keys = batchKeys(ops);
        if (!keys) return false;
        for (const [key, ...up] of keys) {
            written.add(key);
            for (const k of up) above.add(k);
        }
    }
    for (const ops of fresh) {
        const keys = batchKeys(ops);
        if (!keys) return false;
        for (const opKeys of keys) {
            if (above.has(opKeys[0]) || opKeys.some((key) => written.has(key))) return false;
        }
    }
    return true;
}

// A tab checks the batches it already applied against every late batch that overtakes them, so each batch's keys are
// worked out once and kept for as long as the batch lives.
const keysByBatch = new WeakMap<Op[], string[][] | null>();

// The path keys of each op in a batch, or null when an op changes sheets, rows or columns.
function batchKeys(ops: Op[]): string[][] | null {
    const cached = keysByBatch.get(ops);
    if (cached !== undefined) return cached;
    const keys: string[][] = [];
    for (const op of ops) {
        const opKeys = pathKeys(op);
        if (!opKeys) {
            keysByBatch.set(ops, null);
            return null;
        }
        keys.push(opKeys);
    }
    keysByBatch.set(ops, keys);
    return keys;
}

// The key of the path an op writes, its sheet first, then the key of each path above it. An add or remove at an array
// index moves the entries after it, so it writes the whole array. Null for an op on sheets, rows or columns.
function pathKeys(op: Op): string[] | null {
    if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') return null;
    const last = op.path.at(-1);
    const wholeArray = (op.op !== 'replace' && typeof last === 'number') || last === 'length';
    const path = [op.id, ...(wholeArray ? op.path.slice(0, -1) : op.path)].map(String);
    return path.map((_, i) => JSON.stringify(path.slice(0, path.length - i)));
}
