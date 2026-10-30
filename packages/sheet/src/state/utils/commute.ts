// Whether a peer's op batches that land in the op log before batches a tab already applied may simply apply after
// them. A host that keeps the grid's order with the log's calls commutes on such a late batch: when it holds, the tab
// applies the batch directly and keeps its undo, and otherwise it replays the log from an earlier state.

import type { Op } from '../types';

// Whether the fresh batches, applied after the overtaken ones, still give the workbook the log's order gives. They do
// when no batch adds, deletes or moves sheets, rows or columns. They also need that no op of one side writes a path an
// op of the other writes, or a path inside or above it. The recalc list counts too, since two formula cells added at
// once both append to it.
export function commutes(fresh: Iterable<Op[]>, overtaken: Op[][]): boolean {
    const written = new Set<string>();
    const above = new Set<string>();
    for (const ops of overtaken) {
        for (const op of ops) {
            const keys = pathKeys(op);
            if (!keys) return false;
            const [key, ...up] = keys;
            written.add(key);
            for (const k of up) above.add(k);
        }
    }
    for (const ops of fresh) {
        for (const op of ops) {
            const keys = pathKeys(op);
            if (!keys || above.has(keys[0]) || keys.some((key) => written.has(key))) return false;
        }
    }
    return true;
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
