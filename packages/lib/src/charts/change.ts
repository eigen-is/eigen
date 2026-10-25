// A change of a chart is a list of set, remove and move ops on paths into the spec as stored. Every editor hands one
// back instead of a new spec, and the writers apply it onto what is stored, so the keys and values this build doesn't
// know survive the edit. This file applies a change, and makes the two that are computed rather than picked: the
// diff Edit data saves, and the point moves a row insert or delete needs.

import { isEqual } from 'es-toolkit';
import { isRecord } from '../core/guards';
import type { ChartSpec, ChartSpecChange, ChartSpecOp, StoredChartSpec } from '../types/chart';
import type { StoredRecord } from './limits';
import { chartPointIndex, INHERITED_KEYS, own } from './limits';

// The stored spec with a change applied, sharing what it didn't touch. Every record it makes or copies has no
// prototype, and an op whose path names a key a plain object inherits is dropped, so a forged key can't reach
// Object.prototype.
export function applyChartSpecChange(stored: StoredChartSpec, change: ChartSpecChange): StoredChartSpec {
    const made: Made = new WeakMap();
    let next = stored;
    for (const op of change) {
        const paths = op.op === 'move' ? [op.from, op.path] : [op.path];
        if (paths.some((path) => path.length === 0 || path.some((key) => INHERITED_KEYS.has(key)))) continue;
        if (op.op === 'set') next = setIn(next, op.path, op.value, made);
        else if (op.op === 'remove') next = removeIn(next, op.path, made);
        else {
            const moved = getIn(next, op.from);
            next = removeIn(removeIn(next, op.from, made), op.path, made);
            if (moved !== undefined) next = setIn(next, op.path, moved, made);
        }
    }
    return next;
}

// The records one apply made, each keyed by itself, so a later op of that apply writes into one in place: N moves
// within a series' points copy its record once, not N times.
type Made = WeakMap<StoredChartSpec, StoredRecord>;

function writable(target: StoredChartSpec, made: Made): StoredRecord {
    const mine = made.get(target);
    if (mine) return mine;
    const next: StoredRecord = Object.assign(Object.create(null), target);
    made.set(next, next);
    return next;
}

function getIn(target: StoredChartSpec, [key, ...rest]: string[]): unknown {
    const value = own(target, key);
    if (rest.length === 0) return value;
    return isRecord(value) ? getIn(value, rest) : undefined;
}

function setIn(target: StoredChartSpec, [key, ...rest]: string[], value: unknown, made: Made): StoredChartSpec {
    const before = own(target, key);
    const next = writable(target, made);
    if (rest.length > 0) next[key] = setIn(isRecord(before) ? before : Object.create(null), rest, value, made);
    else next[key] = laidOver(before, value);
    return next;
}

function removeIn(target: StoredChartSpec, [key, ...rest]: string[], made: Made): StoredChartSpec {
    const before = own(target, key);
    if (before === undefined) return target;
    if (rest.length > 0) {
        const removed = isRecord(before) ? removeIn(before, rest, made) : before;
        return removed === before ? target : setIn(target, [key], removed, made);
    }
    const next = writable(target, made);
    delete next[key];
    return next;
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

// The ops that take every stored point, of the series this build reads and the ones it doesn't, from its index to
// target(index), null removing it, for a remap that keeps their order (a row op, Edit data's deleted rows). Per series
// the moves down run first from the lowest target, those up last from the highest, so none lands on a point still to
// move.
export function chartPointMoves(stored: StoredChartSpec, target: (index: number) => number | null): ChartSpecOp[] {
    const points = stored['points'];
    if (!isRecord(points)) return [];
    return Object.entries(points).flatMap(([id, entries]) => {
        if (!isRecord(entries)) return [];
        const path = (index: number) => ['points', id, String(index)];
        const removes: ChartSpecOp[] = [];
        const down: [number, number][] = [];
        const up: [number, number][] = [];
        for (const key of Object.keys(entries)) {
            const index = chartPointIndex(key);
            if (index === null) continue;
            const to = target(index);
            if (to === null) removes.push({ op: 'remove', path: path(index) });
            else if (to < index) down.push([index, to]);
            else if (to > index) up.push([index, to]);
        }
        down.sort((a, b) => a[1] - b[1]);
        up.sort((a, b) => b[1] - a[1]);
        const moves = [...down, ...up].map(
            ([from, to]): ChartSpecOp => ({ op: 'move', from: path(from), path: path(to) }),
        );
        return [...removes, ...moves];
    });
}
