// What the ops of an undo entry become when a peer's rows or columns land before the undo: each op then names the
// cells, lines and records it named, where the edit left them. A cell that was deleted leaves the op, a rectangle or
// a span of lines is cut in two around inserted lines and never grows over them, and a record op's fields go where the
// record itself goes. A stored formula in an op is rewritten as the engine rewrites a cell's, so a filled block is
// cut where its formula comes out differently. An entry that renumbers places itself has no shifted form.

import type { Edit, FormulaNode } from '@workspace/formula/text';
import { GONE, hostClasses, mapIndex, NodeKind, parseStored, storedKey, transformLines } from '@workspace/formula/text';
import type {
    CellContent,
    FormatOp,
    InputOp,
    LinesOp,
    Op,
    Placed,
    RecordOp,
    Rect,
    Span,
} from '@workspace/lib/sheets/ops';
import { isStructural } from '@workspace/lib/sheets/ops';
import { inputOf } from './apply-input';
import {
    chartAfter,
    commentAfter,
    filterAfter,
    filterColumnAfter,
    keyThrough,
    LineMap,
    lineSpan,
    mergeAfter,
    ruleAfter,
    sheetAfter,
    spansAfter,
    validationAfter,
} from './record-lines';

// Null when the entry has no shifted form: it holds an op that renumbers places, no op of it is left, or a formula
// of it would be too long to store.
export function shiftOps(ops: readonly Op[], edit: LinesOp): Op[] | null {
    const map = new LineMap(edit);
    const { axis } = map;
    const shifted: Op[] = [];
    for (const op of ops) {
        if (isStructural(op)) return null;
        let next: Op | undefined | null;
        switch (op.kind) {
            case 'input':
                next = inputAfter(op, edit, axis);
                break;
            case 'format':
                next = op.sheet === edit.sheet ? formatAfter(op, edit, axis) : op;
                break;
            case 'record':
                next = recordAfter(op, map);
                break;
        }
        if (next === null) return null;
        if (next) shifted.push(next);
    }
    return shifted.length > 0 ? shifted : null;
}

function onLines(rect: Rect, rows: boolean, [start, end]: Span): Rect {
    return rows ? [start, rect[1], end, rect[3]] : [rect[0], start, rect[2], end];
}

// An input on any sheet: its formulas may read the edited lines from another sheet. Undefined when no cell is left.
function inputAfter(op: InputOp, edit: LinesOp, axis: Edit): InputOp | undefined | null {
    const { rows } = edit;
    const here = op.sheet === edit.sheet;
    const runs: [Rect, CellContent | null][] = [];
    for (const [rect, content] of op.runs ?? []) {
        const [first, last] = lineSpan(rect, rows);
        const tree = content?.f === undefined ? undefined : parseStored(content.f);
        if (!content || !tree || 'reason' in tree) {
            const spans = here ? spansAfter(axis, first, last, 'closed') : [[first, last] as const];
            for (const span of spans) runs.push([onLines(rect, rows, span), content]);
            continue;
        }
        const references: FormulaNode[] = [];
        const walk = [tree];
        for (let node = walk.pop(); node; node = walk.pop()) {
            if (node.kind === NodeKind.Ref) references.push(node);
            walk.push(...node.children);
        }
        // One stored text reads differently along the edited lines: each stretch of hosts with one outcome is a run.
        for (const { start, end, tree: next } of hostClasses(tree, references, edit, op.sheet, first, last)) {
            const f = next === tree ? content.f : storedKey(next);
            if (typeof f !== 'string') return null;
            const span: Span = here ? [mapIndex(axis, start), mapIndex(axis, end)] : [start, end];
            runs.push([onLines(rect, rows, span), next === tree ? content : { ...content, f }]);
        }
    }
    const cells: Placed<CellContent | null>[] = [];
    for (const [row, column, content] of op.cells ?? []) {
        const line = rows ? row : column;
        const after = here ? mapIndex(axis, line) : line;
        if (after === GONE) continue;
        let next = content;
        if (content?.f !== undefined) {
            const f = keyThrough(content.f, (tree) => transformLines(tree, edit, op.sheet, line).tree);
            if (f === null) return null;
            if (f !== content.f) next = { ...content, f };
        }
        cells.push(rows ? [after, column, next] : [row, after, next]);
    }
    return inputOf(op.sheet, { runs, cells });
}

// A format on the edited sheet. Undefined when no cell or line of it is left.
function formatAfter(op: FormatOp, { rows }: LinesOp, axis: Edit): FormatOp | undefined {
    if ('lines' in op) {
        if ((op.lines === 'rows') !== rows) return op;
        const spans = op.spans.flatMap(([first, last]) => spansAfter(axis, first, last, 'closed'));
        return spans.length > 0 ? { ...op, spans } : undefined;
    }
    const ranges = op.ranges.flatMap((rect) =>
        spansAfter(axis, ...lineSpan(rect, rows), 'open').map((span) => onLines(rect, rows, span)),
    );
    return ranges.length > 0 ? { ...op, ranges } : undefined;
}

// A record op with the fields it sets where the store's own rules put them. Undefined when the record is gone, null
// when a rule's formula would be too long to store.
function recordAfter(op: RecordOp, map: LineMap): RecordOp | undefined | null {
    const here = op.sheet === map.edit.sheet;
    switch (op.type) {
        case 'sheet':
            return here ? { ...op, set: sheetAfter(op.set, map) } : op;
        case 'merge':
            return here ? withSet(op, (set) => mergeAfter(set, map)) : op;
        case 'filter':
            return here ? withSet(op, (set) => filterAfter(set, map)) : op;
        case 'filterColumn':
            return here ? withSet(op, (set) => filterColumnAfter(set, map)) : op;
        case 'comment':
            return here ? withSet(op, (set) => commentAfter(set, map)) : op;
        case 'validation':
            return here ? withSet(op, (set) => validationAfter(set, map)) : op;
        case 'conditionalFormat': {
            if (!op.set) return op;
            const rule = ruleAfter(op.set, map, op.sheet);
            if (rule === 'key-too-long') return null;
            return rule && { ...op, set: rule };
        }
        case 'image':
            return op;
        case 'chart':
            return withSet(op, (set) => chartAfter(set, map));
    }
}

// The op with what `after` makes of the fields it sets; an op that deletes its record sets none and stays.
function withSet<O extends RecordOp>(
    op: O,
    after: (set: NonNullable<O['set']>) => NonNullable<O['set']> | undefined,
): O | undefined {
    if (!op.set) return op;
    const set = after(op.set);
    return set && { ...op, set };
}
