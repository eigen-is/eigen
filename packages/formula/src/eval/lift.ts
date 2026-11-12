// A call whose arguments hold an array where one value is read: the body runs once per element of the arrays lined
// up, and the answers are an array of that shape. An array stores one element for a run of equal ones, so the body
// runs once per stored element and its answer stands for the whole run. An operator on an array is lifted here too.
// A lazy argument is evaluated after the elements, once, and only when an element picked it. A row whose arguments
// come in groups that are tried in turn, such as IFS, is stepped through here too, array or not. A blank answer is
// a 0 in the array, as a formula's is in its cell, so every reader of a computed array meets the same value.

import type { Sheet } from '../store/sheet';
import type { FormulaNode } from '../text/tree';
import { NodeKind } from '../text/tree';
import type { FormulaError } from '../values/errors';
import { CALC, NA, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isCell, isError, isReference } from '../values/value';
import type { Axis } from './bands';
import { align, apart } from './bands';
import { ends, isLazy, picked, read, run } from './call';
import type { Evaluator } from './evaluator';
import type { Frame } from './readers';
import type { Entry, Held, Lazy, Param } from './signature';
import { ANYWHERE, NEXT, Prepare, slotOf, TOKENS } from './signature';

// The frame holds the arguments as prepared, `count` of them written. Each element is read into the frame itself,
// so what a reader of the call was bound to is the element in progress.
export function lift(
    ctx: Evaluator,
    entry: Entry,
    frame: Frame,
    count: number,
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const prepared = frame.held.slice();
    const params = prepared.map((_, i) => slotOf(entry, i, count));
    const arrays: ArrayValue[] = [];
    // Per argument, which of the arrays it is, or -1.
    const lifting = prepared.map((value, i) =>
        isArray(value) && lifts(params[i], value) ? arrays.push(value) - 1 : -1,
    );
    const lined = lineUp(ctx, arrays, entry.volatile);
    if (lined === null) return CALC;
    const { down, across } = lined;
    // Filled element by element and never made at its size: an array made ten thousand long or longer throws the
    // engine that runs this out of its compiled code, for every call after it too.
    const items: (Scalar | Reference)[] = [];
    // Per element, the lazy argument it picked, or undefined for an element that has its value.
    const picks: (Lazy | undefined)[] = [];
    let references = false;
    // A text made for an element takes its length of the formula's work. A row that is handed a table whole
    // answers with a value the table holds, which is made for no element.
    const makes = !params.some((param) => param.prepare === Prepare.Whole);
    for (let r = 0; r < down.count; r += 1) {
        for (let c = 0; c < across.count; c += 1) {
            const failed = element(ctx, params, frame, prepared, lifting, arrays, lined, r, c);
            const result = failed ?? run(ctx, entry, frame.held, count, 0);
            // Of an element that answers an array, the first value: ROW of a range of three rows is its first row.
            let item = isLazy(result) ? null : isArray(result) ? result.items[0] : result;
            // And of one that answers a reference, the value of its first cell: a part of a range is a value
            // here, as Excel's INDEX(A1:B3,{1,2},1) is. A cell that holds nothing stays that cell, which is
            // passed over where a blank cell of a range is. Only a row that works a reference out keeps one
            // per element, and its array is then one of references.
            if (isReference(item)) {
                if (entry.returns === ANYWHERE) references = true;
                else item = ctx.first(item) ?? { ...item, bottom: item.top, right: item.left, next: null };
            }
            if (makes && typeof item === 'string' && !ctx.recalc.spend(item.length)) return CALC;
            if (isLazy(result)) picks[items.length] = result;
            items.push(item ?? 0);
        }
    }
    const made = arrayOf(lined.rows, lined.columns, items, down.ends, across.ends, references);
    return picks.length === 0 || !isArray(made) ? made : fill(ctx, entry, made, picks, node, sheet, row, column);
}

// A call of a row whose groups of arguments are tried in turn, such as IFS and SWITCH. A group is evaluated only
// while an element is undecided, so the first group that decides a call hides every later one, errors included.
export function step(
    ctx: Evaluator,
    entry: Entry,
    frame: Frame,
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const given = node.children;
    const { held } = frame;
    const { slots, fixed, group } = entry;
    const groups = Math.trunc((given.length - fixed) / group);
    // What the body is called with: the arguments before the groups, one group, and the token of the argument
    // after the groups, which an element that no group decided picks.
    const params = slots.slice(0, fixed + group);
    const last = slots.length > params.length ? TOKENS[fixed + groups * group] : undefined;
    held.length = slots.length;
    if (last !== undefined) held[params.length] = last;
    const prepared: Held[] = [];
    // What each element answers so far: its value, or the lazy argument it picked, NEXT while it is undecided.
    let made: Scalar | Reference | ArrayValue = null;
    let picks: (Lazy | undefined)[] = [NEXT];
    let undecided = true;
    // One round per group, and a last one in which what is still undecided picks the argument after the groups.
    for (let g = 0; g <= groups && undecided; g += 1) {
        const arrays: ArrayValue[] = isArray(made) ? [made] : [];
        const lifting: number[] = [];
        for (let i = 0; i < params.length && g < groups; i += 1) {
            const place = i < fixed ? i : i + g * group;
            // The arguments before the groups are evaluated in the first round, a group in its own.
            if (params[i].prepare === Prepare.Lazy) prepared[i] = TOKENS[place];
            else if (i >= fixed || g === 0) {
                const empty = given[place].kind === NodeKind.Empty;
                prepared[i] = empty ? null : ctx.operand(given[place], sheet, row, column);
            }
            const value = prepared[i];
            lifting[i] = isArray(value) ? arrays.push(value) - 1 : -1;
        }
        const lined = lineUp(ctx, arrays, false);
        if (lined === null) return CALC;
        const { down, across } = lined;
        const items: (Scalar | Reference)[] = [];
        const next: (Lazy | undefined)[] = [];
        undecided = false;
        for (let r = 0; r < down.count; r += 1) {
            for (let c = 0; c < across.count; c += 1) {
                const from = isArray(made) ? placeAt(made, down, across, 0, r, c) : 0;
                let result: Value | Lazy = from < 0 ? NA : (picks[from] ?? (isArray(made) ? made.items[from] : made));
                if (result === NEXT && g === groups) result = last ?? NA;
                else if (result === NEXT) {
                    const failed = element(ctx, params, frame, prepared, lifting, arrays, lined, r, c);
                    result = failed ?? run(ctx, entry, held, given.length, 0);
                }
                undecided ||= result === NEXT;
                next.push(isLazy(result) ? result : undefined);
                items.push(isLazy(result) ? null : isArray(result) ? result.items[0] : result);
            }
        }
        picks = next;
        made = arrayOf(lined.rows, lined.columns, items, down.ends, across.ends);
    }
    if (isArray(made)) return fill(ctx, entry, made, picks, node, sheet, row, column);
    return picks[0] === undefined ? made : picked(ctx, entry, picks[0], node, sheet, row, column);
}

// One element of a call that runs once per element, read into the frame as the arguments of a call of its own
// are: the failure that is the answer of the element, or null with the frame ready for the body.
function element(
    ctx: Evaluator,
    params: readonly Param<unknown>[],
    frame: Frame,
    prepared: readonly Held[],
    lifting: readonly number[],
    arrays: readonly ArrayValue[],
    lined: Lined,
    r: number,
    c: number,
): FormulaError | null {
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        const k = lifting[i];
        let value = prepared[i];
        if (k >= 0) {
            const from = placeAt(arrays[k], lined.down, lined.across, k, r, c);
            const item = from < 0 ? NA : arrays[k].items[from];
            if (param.prepare === Prepare.Reference) value = item;
            else value = param.prepare === Prepare.Corner ? ctx.first(item) : single(ctx, item);
        }
        value = read(param, value, frame, i);
        if (isError(value) && ends(param)) return value;
        frame.held[i] = value;
    }
    return null;
}

// Whether an array at a parameter runs the call once per element: where one value is read, of a range's first
// cell too, and an array of references where only a reference is taken.
export function lifts(param: Param<unknown>, array: ArrayValue): boolean {
    if (param.prepare === Prepare.Reference) return array.references;
    return param.prepare === Prepare.Scalar || param.prepare >= Prepare.Corner;
}

type Lined = { readonly rows: number; readonly columns: number; readonly down: Axis; readonly across: Axis };

const ONE: Axis = { count: 1, ends: null, from: [] };

// The shape of an operation over these arrays and how each of them runs along it, or null when the formula has
// no room to store the result. `apiece` cuts every run into single elements.
function lineUp(ctx: Evaluator, arrays: readonly ArrayValue[], apiece: boolean): Lined | null {
    let rows = 1;
    let columns = 1;
    for (const array of arrays) {
        rows = Math.max(rows, array.rows);
        columns = Math.max(columns, array.columns);
    }
    // With no array there is one element.
    if (arrays.length === 0) return { rows, columns, down: ONE, across: ONE };
    const down = align(arrays, rows, true);
    const across = align(arrays, columns, false);
    // A row that answers anew at every call makes each written element by a call of its own.
    if (apiece && ctx.recalc.room(rows * columns)) {
        return { rows, columns, down: apart(down, rows), across: apart(across, columns) };
    }
    return !apiece && ctx.recalc.room(down.count * across.count) ? { rows, columns, down, across } : null;
}

// Where array `k` stores its element for a run of rows and a run of columns, or -1 past its end.
function placeAt(array: ArrayValue, down: Axis, across: Axis, k: number, r: number, c: number): number {
    const rows = down.from[k];
    const columns = across.from[k];
    const i = rows === null ? r : rows[r];
    const j = columns === null ? c : columns[c];
    return i < 0 || j < 0 ? -1 : i * array.width + j;
}

// An element where one value is read: a reference to one cell is that cell, and one to several is #VALUE!.
export function single(ctx: Evaluator, item: Scalar | Reference): Scalar {
    if (!isReference(item)) return item;
    const value = isCell(item) ? ctx.read(item) : VALUE;
    return isArray(value) ? VALUE : value;
}

// The elements that picked a lazy argument, filled from it. Each picked argument is evaluated once, for its
// values, and an array among them lines up with the elements as any array does.
function fill(
    ctx: Evaluator,
    entry: Entry,
    made: ArrayValue,
    picks: readonly (Lazy | undefined)[],
    node: FormulaNode,
    sheet: Sheet,
    row: number,
    column: number,
): Value {
    const values: (Scalar | ArrayValue)[] = [];
    const arrays = [made];
    // Per argument that was picked, which of the arrays its value is, or 0 for one value.
    const places: number[] = [];
    for (const token of picks) {
        if (token === undefined || places[token.index] !== undefined) continue;
        const value = ctx.read(picked(ctx, entry, token, node, sheet, row, column));
        values[token.index] = value;
        places[token.index] = isArray(value) ? arrays.push(value) - 1 : 0;
    }
    const lined = lineUp(ctx, arrays, false);
    if (lined === null) return CALC;
    const { down, across } = lined;
    const width = across.count;
    const items: (Scalar | Reference)[] = [];
    for (let r = 0; r < down.count; r += 1) {
        for (let c = 0; c < width; c += 1) {
            const from = placeAt(made, down, across, 0, r, c);
            const token = from < 0 ? undefined : picks[from];
            let item: Scalar | Reference = from < 0 ? NA : made.items[from];
            if (token !== undefined) {
                const value = values[token.index];
                const at = isArray(value) ? placeAt(value, down, across, places[token.index], r, c) : -1;
                item = !isArray(value) ? value : at < 0 ? NA : value.items[at];
            }
            items.push(item ?? 0);
        }
    }
    return arrayOf(lined.rows, lined.columns, items, down.ends, across.ends, made.references);
}
