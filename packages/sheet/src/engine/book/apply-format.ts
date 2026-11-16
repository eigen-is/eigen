// The applier of a `format` op, which the frame calls for each op of a batch: look keys and links set or cleared over
// rectangles of cells, such as bold on a selection or a fill on a whole column, or line keys over spans of rows or
// columns, such as a height or a hidden row. Looks are written in the sheet's bands and links in its extras, never cell
// by cell. Its inverse restores only the keys the op named: per key, one op for each old value over the cells that held
// it, joined into rectangles, then the old content of each rich cell whose runs a format cannot say back.

import type {
    CellAttrKey,
    CellAttrs,
    CellContent,
    FormatOp,
    InputOp,
    LineAttrs,
    Placed,
    Rect,
    Run,
    RunStyle,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';
import { pick } from 'es-toolkit';
import type { Extra } from './extras';
import { placeOf } from './extras';
import { LINE_KEYS } from './line-runs';
import type { Workbook } from './workbook';

// Every run-style key once: the mapped type fails the build on a key left out.
const RUN_KEY: { readonly [K in keyof RunStyle]-?: K } = {
    bl: 'bl',
    it: 'it',
    ff: 'ff',
    fs: 'fs',
    fc: 'fc',
    cl: 'cl',
    un: 'un',
};
export const RUN_KEYS = Object.values(RUN_KEY);

type Look = Readonly<CellAttrs>;

export function applyFormat(book: Workbook, op: FormatOp): (FormatOp | InputOp)[] {
    const part = book.sheets.get(op.sheet);
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!part) return [];
    const { sheet } = op;
    if ('lines' in op) {
        const { set = {}, clear = [] } = op;
        const replaced = (op.lines === 'rows' ? part.rows : part.columns).write(op.spans, set, clear);
        const inverse: FormatOp[] = [];
        for (const key of LINE_KEYS.filter((name) => names(op, name))) {
            // The lines of each old value, under that value as text, with the keys of one of them.
            const held = new Map<string, { attrs: Readonly<LineAttrs>; spans: Span[] }>();
            for (const [[first, last], attrs] of replaced) {
                if (attrs[key] === set[key]) continue;
                const was = keyOf(attrs[key]);
                let group = held.get(was);
                if (!group) {
                    group = { attrs, spans: [] };
                    held.set(was, group);
                }
                const end = group.spans.at(-1);
                if (end && end[1] + 1 === first) group.spans[group.spans.length - 1] = [end[0], last];
                else group.spans.push([first, last]);
            }
            for (const { attrs, spans } of held.values()) {
                const named = attrs[key] === undefined ? { clear: [key] } : { set: pick(attrs, [key]) };
                inverse.push({ kind: 'format', sheet, lines: op.lines, spans, ...named });
            }
        }
        return inverse;
    }

    const { link, ...looks } = op.set ?? {};
    const { bands, extras } = part;
    const lookKeys = LOOK_KEYS.filter((key) => names(op, key));
    const runKeys = RUN_KEYS.filter((key) => lookKeys.includes(key));
    const linked = names(op, 'link');

    // Read before any write, each cell once however many rectangles hold it: the rich cells a run-style key restyles,
    // with the look they wore, and the links a link write replaces.
    const rich = new Map<
        number,
        readonly [row: number, column: number, extra: Extra, runs: readonly Run[], look: Look]
    >();
    const links = new Map<number, Placed<CellLink>>();
    if (runKeys.length > 0 || linked) {
        for (const rect of op.ranges) {
            for (const [row, column, extra] of extras.cells(rect)) {
                const place = placeOf(row, column);
                if (extra.s && runKeys.length > 0 && !rich.has(place)) {
                    rich.set(place, [row, column, extra, extra.s, book.looks.look(bands.look(row, column))]);
                }
                if (extra.link && linked) links.set(place, [row, column, extra.link]);
            }
        }
    }

    // Per named key, the cells of each old value it changed, under that value as text, with the look of one of them.
    // A rectangle reads what the rectangles before it wrote, so the cells it shares with them read as unchanged.
    const changed = new Map(lookKeys.map((key) => [key, new Map<string, { look: Look; areas: Areas }>()]));
    if (lookKeys.length > 0) {
        const worn = new Map<number, number>();
        const to = (id: number) => {
            let next = worn.get(id);
            if (next === undefined) {
                const look = { ...book.looks.look(id), ...looks };
                for (const key of lookKeys) if (looks[key] === undefined) delete look[key];
                next = book.looks.intern(look);
                worn.set(id, next);
            }
            return next;
        };
        for (const rect of op.ranges) {
            for (const { c0, c1, r0, r1, look } of bands.write(rect, to)) {
                const old = book.looks.look(look);
                for (const [key, held] of changed) {
                    const was = keyOf(old[key]);
                    if (was === keyOf(looks[key])) continue;
                    let group = held.get(was);
                    if (!group) {
                        group = { look: old, areas: new Areas() };
                        held.set(was, group);
                    }
                    group.areas.add(r0, c0, r1, c1);
                }
            }
        }
    }
    const restored: Placed<CellContent>[] = [];
    for (const [row, column, extra, runs, look] of rich.values()) {
        // Runs that all wear the look's value of every named key take it back with the look; others are put back whole.
        if (runKeys.some((key) => runs.some((run) => run[key] !== look[key]))) restored.push([row, column, extra]);
        extras.write(row, column, { ...extra, s: restyled(runs, runKeys, looks) });
    }
    if (linked) for (const rect of op.ranges) extras.link(rect, link);

    const inverse: (FormatOp | InputOp)[] = [];
    for (const [key, held] of changed) {
        for (const { look, areas } of held.values()) {
            const named = look[key] === undefined ? { clear: [key] } : { set: pick(look, [key]) };
            inverse.push({ kind: 'format', sheet, ranges: areas.joined(), ...named });
        }
    }
    if (linked) {
        if (link) inverse.push({ kind: 'format', sheet, ranges: op.ranges, clear: ['link'] });
        const held = new Map<string, { value: CellLink; areas: Areas }>();
        for (const [row, column, value] of [...links.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
            const was = keyOf(value);
            let group = held.get(was);
            if (!group) {
                group = { value, areas: new Areas() };
                held.set(was, group);
            }
            group.areas.add(row, column, row, column);
        }
        for (const group of held.values()) {
            inverse.push({ kind: 'format', sheet, ranges: group.areas.joined(), set: { link: group.value } });
        }
    }
    if (restored.length > 0) {
        restored.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        inverse.push({ kind: 'input', sheet, cells: restored });
    }
    return inverse;
}

// Whether a format sets or clears a key.
export function names<K extends string>(
    op: { set?: { [P in K]?: unknown }; clear?: readonly string[] },
    key: K,
): boolean {
    return op.set?.[key] !== undefined || (op.clear?.includes(key) ?? false);
}

// The runs of a rich cell as a format leaves them: each run-style key the format names set on every run, or cleared.
export function restyled(runs: readonly Run[], keys: readonly (keyof RunStyle)[], set: RunStyle): Run[] {
    return runs.map((run) => {
        const next: Run = { ...run };
        for (const key of keys) {
            if (set[key] === undefined) delete next[key];
            else Object.assign(next, { [key]: set[key] });
        }
        return next;
    });
}

// The rectangles of the cells that held one old value. They come band by band, rows down within a band, so a span
// joins the one above it as it comes, and once all are in, neighbours across bands over the same rows join.
export class Areas {
    private readonly rects: [top: number, left: number, bottom: number, right: number][] = [];

    public add(top: number, left: number, bottom: number, right: number): void {
        const last = this.rects.at(-1);
        if (last && last[1] === left && last[3] === right && last[2] + 1 === top) last[2] = bottom;
        else this.rects.push([top, left, bottom, right]);
    }

    public joined(): Rect[] {
        const joined: [number, number, number, number][] = [];
        const byRows = new Map<string, [number, number, number, number]>();
        for (const rect of this.rects) {
            const rows = `${rect[0]} ${rect[2]}`;
            const before = byRows.get(rows);
            if (before && before[3] + 1 === rect[1]) before[3] = rect[3];
            else {
                joined.push(rect);
                byRows.set(rows, rect);
            }
        }
        return joined;
    }
}

// A value as a key of the map of old values, a border side by its style and color whatever order its keys came in.
export function keyOf(value: CellAttrs[CellAttrKey] | LineAttrs[keyof LineAttrs] | CellLink): string {
    if (value === undefined) return '';
    if (typeof value !== 'object') return JSON.stringify(value);
    return 'style' in value ? `${value.style} ${value.color}` : `${value.type} ${value.address}`;
}
