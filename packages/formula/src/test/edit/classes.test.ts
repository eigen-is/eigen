// The fast path held against a slow version that knows nothing of offsets: it resolves every end of every reference
// to the line it names at a host, sends the lines of a range through the edit one by one, and prints what is left.
// The transform is held to it host by host, and the classes of hosts for every host of a run.

import { describe, expect, test } from 'bun:test';
import type { LineEdit } from '../../text';
import {
    columnLabel,
    GONE,
    GRID_COLUMNS,
    GRID_ROWS,
    hostClasses,
    mapIndex,
    printStored,
    ShapeTable,
    toA1,
    transformLines,
} from '../../text';
import { random, shown, tree } from './support';

type End = { absolute: boolean; at: number };

// One reference as typed at the base host. `ends` are its one or two lines on the edited axis, none for a whole
// column under a row edit; `cross` its lines on the other axis, none for a whole row under a row edit.
type Reference = { prefix: string; sheet: string | null; ends: End[]; cross: End[] };

const PREFIXES: [string, string | null][] = [
    ['', null],
    ['', null],
    ['Sheet1!', 's1'],
    ['Sheet2!', 's2'],
    ['Later!', 'later'],
];

function leg(rows: boolean, line: End | undefined, cross: End | undefined): string {
    const column = rows ? cross : line;
    const row = rows ? line : cross;
    return (
        (column ? (column.absolute ? '$' : '') + columnLabel(column.at) : '') +
        (row ? (row.absolute ? '$' : '') + (row.at + 1) : '')
    );
}

function ordered(ends: End[]): End[] {
    return ends.length === 2 && ends[0].at > ends[1].at ? [ends[1], ends[0]] : ends;
}

// A reference as the formula bar shows it: the corners in order, each coordinate with its own $.
function print(rows: boolean, reference: Reference, ends: End[]): string {
    const lines = ordered(ends);
    const cross = ordered(reference.cross);
    const first = leg(rows, lines[0], cross[0]);
    const two = Math.max(lines.length, cross.length) === 2;
    return reference.prefix + (two ? `${first}:${leg(rows, lines[1] ?? lines[0], cross[1] ?? cross[0])}` : first);
}

// The text a reference typed at line `base` reads at the host on line `host` once the edit is done.
function slow(edit: LineEdit, hostSheet: string, reference: Reference, base: number, host: number): string {
    const { ends } = reference;
    if (ends.length === 0) return print(edit.rows, reference, ends);
    const targets = ends.map((end) => (end.absolute ? end.at : end.at + host - base));
    if (targets.some((target) => target < 0 || target >= edit.lines)) return `${reference.prefix}#REF!`;
    let low = Math.min(...targets);
    let high = Math.max(...targets);
    if ((reference.sheet ?? hostSheet) === edit.sheet) {
        // A new line joins the range when the lines on both sides of it belonged to it.
        const between = edit.insert && low < edit.index && edit.index <= high;
        while (low <= high && mapIndex(edit, low) === GONE) low += 1;
        if (low > high) return `${reference.prefix}#REF!`;
        while (mapIndex(edit, high) === GONE) high -= 1;
        low = mapIndex(edit, low);
        high = mapIndex(edit, high);
        if (between) high = Math.max(high, Math.min(edit.index + edit.count, edit.lines) - 1);
    }
    const flipped = targets.length === 2 && targets[0] > targets[1];
    return print(
        edit.rows,
        reference,
        ends.map((end, i) => ({ absolute: end.absolute, at: (i === 0) === flipped ? high : low })),
    );
}

type Sample = { edit: LineEdit; hostSheet: string; references: Reference[]; base: number; cross: number; text: string };

// A formula of one to three references typed at a host, and an edit, with the lines drawn from the top of the grid,
// from around the edit and from the bottom of the grid.
function sample(pick: (below: number) => number): Sample {
    const rows = pick(2) === 0;
    const lines = rows ? GRID_ROWS : GRID_COLUMNS;
    const count = 1 + pick(4);
    const index = [pick(12), lines - count - pick(8), lines - 1 - pick(3), 40 + pick(8)][pick(4)];
    const line = (): number =>
        Math.min(lines - 1, Math.max(0, [pick(14), index - 6 + pick(14), lines - 1 - pick(14)][pick(3)]));
    const end = (at: number): End => ({ absolute: pick(2) === 0, at });
    const edit: LineEdit = {
        insert: pick(2) === 0,
        index,
        count,
        lines,
        sheet: ['s1', 's1', 's2', 's3'][pick(4)],
        rows,
    };
    const references: Reference[] = [];
    for (let n = 1 + pick(3); n > 0; n -= 1) {
        const [prefix, sheet] = PREFIXES[pick(PREFIXES.length)];
        const kind = pick(8);
        const two = kind >= 3;
        references.push({
            prefix,
            sheet,
            ends: kind === 6 ? [] : two ? [end(line()), end(line())] : [end(line())],
            cross: kind === 7 ? [] : two ? [end(pick(6)), end(pick(6))] : [end(pick(6))],
        });
    }
    const text = `=SUM(${references.map((reference) => leg2(rows, reference)).join(',')})`;
    return { edit, hostSheet: ['s1', 's1', 's2'][pick(3)], references, base: line(), cross: 6 + pick(3), text };
}

// As typed: the corners in the order they were drawn, which the tree keeps.
function leg2(rows: boolean, { prefix, ends, cross }: Reference): string {
    const first = leg(rows, ends[0], cross[0]);
    return prefix + (Math.max(ends.length, cross.length) === 2 ? `${first}:${leg(rows, ends[1], cross[1])}` : first);
}

function place(rows: boolean, line: number, cross: number): string {
    return rows ? toA1(line, cross) : toA1(cross, line);
}

function expected({ edit, hostSheet, references, base }: Sample, host: number): string {
    return `=SUM(${references.map((reference) => slow(edit, hostSheet, reference, base, host)).join(',')})`;
}

describe('the fast path against the slow version', () => {
    test('the transform at the host a formula was typed at', () => {
        const pick = random(20261111);
        let changed = 0;
        for (let run = 0; run < 30000; run += 1) {
            const drawn = sample(pick);
            const { edit, hostSheet, base, cross, text } = drawn;
            const after = hostSheet === edit.sheet ? mapIndex(edit, base) : base;
            if (after === GONE) continue;
            const before = tree(text, place(edit.rows, base, cross));
            const result = transformLines(before, edit, hostSheet, base);
            if (result.tree !== before) changed += 1;
            expect(`${text} → ${shown(result.tree, place(edit.rows, after, cross))}`).toBe(
                `${text} → ${expected(drawn, base)}`,
            );
        }
        expect(changed).toBeGreaterThan(6000);
    });

    test('the classes for every host of a run', () => {
        const pick = random(7);
        const table = new ShapeTable();
        let split = 0;
        let single = 0;
        for (let run = 0; run < 6000; run += 1) {
            const drawn = sample(pick);
            const { edit, hostSheet, base, cross, text } = drawn;
            const { rows, lines } = edit;
            const shape = table.shape(table.internTree(tree(text, place(rows, base, cross))));
            if (shape.tree === null) throw new Error(text);
            const from = Math.max(0, Math.min(base, lines - 1 - pick(60)) - pick(30));
            const to = Math.min(lines - 1, from + 20 + pick(60));
            const classes = hostClasses(shape.tree, shape.refs, edit, hostSheet, from, to);
            if (classes.length > 1) split += 1;
            let next = 0;
            let covered = from - 1;
            for (let host = from; host <= to; host += 1) {
                const after = hostSheet === edit.sheet ? mapIndex(edit, host) : host;
                while (next < classes.length && classes[next].end < host) next += 1;
                const found = next < classes.length && classes[next].start <= host ? classes[next] : undefined;
                if (after === GONE) {
                    expect(found).toBeUndefined();
                    continue;
                }
                if (found === undefined) throw new Error(`${text}: no class for the host on line ${host}`);
                expect(found.start).toBeGreaterThan(covered);
                if (found.end === host) covered = host;
                if (found.start === found.end) single += 1;
                const where = `${text} from line ${base} at line ${host}`;
                expect(`${where} → ${shown(found.tree, place(rows, after, cross))}`).toBe(
                    `${where} → ${expected(drawn, host)}`,
                );
                const direct = transformLines(shape.tree, edit, hostSheet, host);
                expect(printStored(found.tree)).toBe(printStored(direct.tree));
                expect(found.tree === shape.tree).toBe(direct.tree === shape.tree);
                expect([found.lossy, found.recompute]).toEqual([direct.lossy, direct.recompute]);
            }
        }
        expect(split).toBeGreaterThan(2000);
        expect(single).toBeGreaterThan(500);
    });

    test('a column filled down splits into few classes, not one per cell', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.internTree(tree('=A1+$B$9+SUM(C$1:C5)+Sheet2!A5', 'D5')));
        if (shape.tree === null) throw new Error('unparsed');
        const rows: LineEdit = { insert: true, index: 2, count: 1, lines: GRID_ROWS, sheet: 's1', rows: true };
        const classes = hostClasses(shape.tree, shape.refs, rows, 's1', 4, 10003);
        expect(classes.map(({ start, end }) => [start, end])).toEqual([
            [4, 5],
            [6, 10003],
        ]);
        expect(classes.map(({ tree: mapped }) => printStored(mapped))).toEqual([
            '=R[-5]C[-3]+R10C2+SUM(R1C[-1]:RC[-1])+[s2]!R[-1]C[-3]',
            '=R[-4]C[-3]+R10C2+SUM(R1C[-1]:RC[-1])+[s2]!R[-1]C[-3]',
        ]);
    });
});
