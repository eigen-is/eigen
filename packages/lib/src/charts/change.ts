// A change of a chart is a list of set and remove ops on paths into the spec as stored. Every editor hands one
// back instead of a new spec, and the writers apply it onto what is stored, so the keys and values this build doesn't
// know survive the edit. This file applies a change, and makes the one that is computed rather than picked: the
// diff Edit data saves.

import { isEqual } from 'es-toolkit';
import { isRecord } from '../core/guards';
import type { ChartSpec, ChartSpecChange, ChartSpecOp, StoredChartSpec } from '../types/chart';
import type { StoredRecord } from './limits';
import { INHERITED_KEYS, own } from './limits';

// The stored spec with a change applied, sharing what it didn't touch. Every record it makes has no prototype, and
// an op naming a key a plain object inherits is dropped, so a forged key can't reach Object.prototype.
export function applyChartSpecChange(stored: StoredChartSpec, change: ChartSpecChange): StoredChartSpec {
    let next = stored;
    for (const op of change) {
        if (op.path.length === 0 || op.path.some((key) => INHERITED_KEYS.has(key))) continue;
        next = op.op === 'set' ? setIn(next, op.path, op.value) : removeIn(next, op.path);
    }
    return next;
}

function setIn(target: StoredChartSpec, [key, ...rest]: string[], value: unknown): StoredChartSpec {
    const before = own(target, key);
    const next = copyOf(target);
    if (rest.length > 0) next[key] = setIn(isRecord(before) ? before : Object.create(null), rest, value);
    else next[key] = laidOver(before, value);
    return next;
}

function removeIn(target: StoredChartSpec, [key, ...rest]: string[]): StoredChartSpec {
    const before = own(target, key);
    if (before === undefined) return target;
    if (rest.length > 0) {
        const removed = isRecord(before) ? removeIn(before, rest) : before;
        return removed === before ? target : setIn(target, [key], removed);
    }
    const next = copyOf(target);
    delete next[key];
    return next;
}

function copyOf(target: StoredChartSpec): StoredRecord {
    return Object.assign(Object.create(null), target);
}

// A list of records with ids (data.series) is set whole, each item laid over the stored item with its id, so the keys
// a newer build stored on a series survive this one's edit.
function laidOver(before: unknown, value: unknown): unknown {
    if (!Array.isArray(before) || !Array.isArray(value)) return value;
    const idOf = (item: unknown) => (isRecord(item) ? own(item, 'id') : undefined);
    const stored = new Map(before.flatMap((item) => (typeof idOf(item) === 'string' ? [[idOf(item), item]] : [])));
    return value.map((item) => {
        const previous = typeof idOf(item) === 'string' ? stored.get(idOf(item)) : undefined;
        return previous ? Object.assign(Object.create(null), previous, item) : item;
    });
}

// Edit data's Save, the one editor that diffs: the leaves the dialog changed from the spec it opened with, so a peer's
// edit meanwhile stands. Records are walked, arrays compared whole.
export function chartSpecChange(base: ChartSpec, next: ChartSpec): ChartSpecChange {
    const leaves = (before: unknown, after: unknown, path: string[]): ChartSpecOp[] => {
        if (isEqual(before, after)) return [];
        if (!isRecord(before) || !isRecord(after)) return [{ op: 'set', path, value: after }];
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        return [...keys].flatMap((key): ChartSpecOp[] =>
            Object.hasOwn(after, key)
                ? leaves(before[key], after[key], [...path, key])
                : [{ op: 'remove', path: [...path, key] }],
        );
    };
    return leaves(base, next, []);
}
