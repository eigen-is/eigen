// The applier of a `format` op, which the frame calls for each op of a batch: look keys and links set or cleared over
// rectangles of cells that share no cell, such as bold on a selection or a fill on a whole column, or line keys over
// spans of rows or columns, such as a height. Looks are written in the sheet's bands and links in its extras, never
// cell by cell. Its inverse restores only the keys the op named: per key, one op for each old value over the cells that
// held it, joined into rectangles, then the old content of each rich cell whose runs a format cannot say back.

import { GRID_COLUMNS } from '@workspace/formula/text';
import { MAX_STYLE_RUNS } from '@workspace/lib/sheets/limits';
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
import { LOOK_KEYS, RUN_KEYS } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { CellLink } from '@workspace/lib/sheets/types';
import { pick } from 'es-toolkit';
import type { Extra } from './extras';
import { unitsOf } from './extras';
import { LINE_KEYS } from './line-runs';
import { ColumnSweep } from './rect-index';
import type { Workbook } from './workbook';

type Look = Readonly<CellAttrs>;

// `checked`, it throws before a write for rectangles that reach more runs than the limit on formats, or links past it,
// and stops writing looks once they pass it: it then returns what undoes the part it wrote, and the frame refuses.
export function applyFormat(book: Workbook, op: FormatOp, checked: boolean): (FormatOp | InputOp)[] {
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
    if (checked) {
        let cells = 0;
        for (const [top, left, bottom, right] of op.ranges) cells += (bottom - top + 1) * (right - left + 1);
        // A span tiles one cell at least, so rectangles of no more cells than the limit reach no more runs.
        if (lookKeys.length > 0 && cells > MAX_STYLE_RUNS) {
            let tiles = 0;
            for (const rect of op.ranges) {
                tiles += bands.tiles(rect);
                if (tiles > MAX_STYLE_RUNS) throw new Refusal('too-many-formats');
            }
        }
        const over = link ? book.over({ extras: unitsOf({ link }) * cells }) : null;
        if (over) throw new Refusal(over);
    }

    // Read before any write: the rich cells a run-style key restyles, with the look they wore, and the links a link
    // write replaces.
    const rich: (readonly [row: number, column: number, extra: Extra, runs: readonly Run[], look: Look])[] = [];
    const links: Placed<CellLink>[] = [];
    const sweep = new ColumnSweep(op.ranges);
    if (runKeys.length > 0 || linked) {
        extras.within(sweep, (row, column, extra) => {
            if (extra.s && runKeys.length > 0) {
                rich.push([row, column, extra, extra.s, book.looks.look(bands.look(row, column))]);
            }
            if (extra.link && linked) links.push([row, column, extra.link]);
        });
    }

    // Per named key, the cells of each old value it changed, under that value as text, with the look of one of them.
    const changed = new Map(lookKeys.map((key) => [key, new Map<string, { look: Look; areas: Areas }>()]));
    let stopped = false;
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
        // The rectangles share no cell, so their order does not show: those over one span of columns are written as
        // one, rows down, the spans in the order the list first names them.
        const groups = new Map<number, Rect[]>();
        for (const rect of op.ranges) {
            const span = rect[1] * GRID_COLUMNS + rect[3];
            const group = groups.get(span);
            if (group) group.push(rect);
            else groups.set(span, [rect]);
        }
        for (const group of groups.values()) {
            if (stopped) break;
            group.sort((a, b) => a[0] - b[0]);
            for (const { c0, c1, r0, r1, look } of bands.write(group, to)) {
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
            stopped = checked && book.over() !== null;
        }
    }
    // The rectangles a key's inverse restores go in the reverse of the order they were written, so it cuts and joins
    // the bands as the write did, backwards.
    const inverse: (FormatOp | InputOp)[] = [];
    for (const [key, held] of changed) {
        for (const { look, areas } of held.values()) {
            const named = look[key] === undefined ? { clear: [key] } : { set: pick(look, [key]) };
            inverse.push({ kind: 'format', sheet, ranges: areas.joined().reverse(), ...named });
        }
    }
    const restored: Placed<CellContent>[] = [];
    for (const [row, column, extra, runs, look] of rich) {
        // Runs that all wear the look's value of every named key take it back with the look; others are put back whole,
        // also by a format that stopped before it restyled them: the looks it takes back restyle the cells they cross.
        if (runKeys.some((key) => runs.some((run) => run[key] !== look[key]))) restored.push([row, column, extra]);
        if (!stopped) extras.write(row, column, { ...extra, s: restyled(runs, runKeys, looks) });
    }
    if (linked && !stopped) {
        extras.link(sweep, link);
        if (link) inverse.push({ kind: 'format', sheet, ranges: op.ranges, clear: ['link'] });
        const held = new Map<string, { value: CellLink; areas: Areas }>();
        for (const [row, column, value] of links.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
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

// The formats that put each look back over the cells that wore it, given look by look: the look's keys set and the
// keys it lacks cleared, so a look is put back whole whatever the cells wear then.
export function wornLooks(
    book: Workbook,
    sheet: string,
    worn: readonly (readonly [look: number, rect: Rect])[],
): FormatOp[] {
    return [...Map.groupBy(worn, ([look]) => look)].map(([id, rects]) => {
        const areas = new Areas();
        for (const [, rect] of rects) areas.add(...rect);
        const look = book.looks.look(id);
        const clear = LOOK_KEYS.filter((key) => look[key] === undefined);
        const format: FormatOp = { kind: 'format', sheet, ranges: areas.joined(), set: { ...look } };
        return clear.length > 0 ? { ...format, clear } : format;
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
