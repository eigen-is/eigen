import { describe, expect, test } from 'bun:test';
import type { FormulaNode, LineEdit } from '../../text';
import {
    GRID_COLUMNS,
    GRID_ROWS,
    hostClasses,
    NodeKind,
    parseStored,
    printStored,
    RefFlag,
    RefKind,
    ShapeTable,
    transformLines,
} from '../../text';
import { CONTEXTS, deleteRows, insertRows, random, reread, tree } from './support';

type End = { absolute: boolean; value: number };

// One reference in stored terms. `ends` are its one or two indexes or offsets on the edited axis, none for a whole
// column under a row edit. `sheet` is null for the host's own sheet.
type Reference = { prefix: string; sheet: string | null; whole: boolean; ends: End[] };

const PREFIXES: [string, string | null][] = [
    ['', null],
    ['', null],
    ['[s1]!', 's1'],
    ['[s2]!', 's2'],
    ["'Later'!", 'later'],
];

// The stored text of a reference: its ends on the edited axis, and on the other axis a fixed line and an offset.
function storedText(rows: boolean, base: number, { prefix, whole, ends }: Reference): string {
    const index = ({ absolute, value }: End) => (absolute ? String(value + base + 1) : value === 0 ? '' : `[${value}]`);
    const [along, across] = rows ? ['R', 'C'] : ['C', 'R'];
    if (ends.length === 0) return `${prefix}${across}1:${across}[2]`;
    if (whole) return `${prefix}${along}${index(ends[0])}:${along}${index(ends[1])}`;
    const corner = (end: End, other: string) => (rows ? `R${index(end)}C${other}` : `R${other}C${index(end)}`);
    return prefix + (ends.length === 1 ? corner(ends[0], '2') : `${corner(ends[0], '2')}:${corner(ends[1], '[1]')}`);
}

// The lines the slow version counts in: the 64 at one edge of the grid, numbered from 0, of which the first is line
// `base` of the grid. Only the grid's own edge is ever reached, as hosts and ends keep to the 6 to 13 lines there.
const MODEL_LINES = 64;
type ModelEdit = LineEdit & { lines: number };

// The axis after the edit as a list: every line that is left, by the number it had, and null for a new line.
function axisAfter(edit: ModelEdit): (number | null)[] {
    const axis: (number | null)[] = Array.from({ length: edit.lines }, (_, line) => line);
    if (edit.insert) axis.splice(edit.index, 0, ...Array.from({ length: edit.count }, () => null));
    else axis.splice(edit.index, edit.count);
    return axis.slice(0, edit.lines);
}

type Expected = {
    gone: boolean;
    first: number;
    second: number;
    lost: boolean;
    cut: boolean;
    resized: boolean;
};

// What a reference names after the edit, from a host on line `host` before it.
function slow(
    edit: ModelEdit,
    axis: (number | null)[],
    hostSheet: string,
    reference: Reference,
    host: number,
): Expected {
    const [first, second = first] = reference.ends.map((end) => (end.absolute ? end.value : host + end.value));
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    const same = { gone: false, first, second, lost: false, cut: false, resized: false };
    if ((reference.sheet ?? hostSheet) !== edit.sheet || low < 0 || high >= edit.lines) return same;
    // A new line joins the range when the lines on both sides of it belonged to it.
    const joins = edit.insert && low < edit.index && edit.index <= high;
    const held: number[] = [];
    axis.forEach((line, position) => {
        if (line === null ? joins : line >= low && line <= high) held.push(position);
    });
    let lost = false;
    for (let line = low; line <= high; line += 1) if (!axis.includes(line)) lost = true;
    if (held.length === 0) return { ...same, gone: true, lost: true, cut: true };
    const [start, end] = [held[0], held[held.length - 1]];
    return {
        gone: false,
        first: first <= second ? start : end,
        second: first <= second ? end : start,
        lost,
        cut: !axis.includes(low) || !axis.includes(high),
        resized: end - start !== high - low,
    };
}

// `edit` is in the model's lines and `real` in the grid's. The hosts are on the model's lines `first` to `last`.
type Sample = {
    edit: ModelEdit;
    real: LineEdit;
    base: number;
    first: number;
    last: number;
    hostSheet: string;
    references: Reference[];
    tree: FormulaNode;
};

function anywhere(pick: (below: number) => number): (texts: string[]) => string {
    return (texts) => CONTEXTS[pick(CONTEXTS.length)](texts[0], texts[1 % texts.length], texts[2 % texts.length]);
}

// The leaves of a tree in the order they were written.
function leaves(node: FormulaNode, into: FormulaNode[] = []): FormulaNode[] {
    if (node.children.length === 0) into.push(node);
    for (const child of node.children) leaves(child, into);
    return into;
}

// A formula of one to three references and an edit, on the first or the last 6 to 13 lines of the grid, with targets
// on and off it.
function sample(pick: (below: number) => number, write: (texts: string[]) => string): Sample {
    const rows = pick(2) === 0;
    const lines = 6 + pick(8);
    const atEnd = pick(2) === 0;
    const first = atEnd ? MODEL_LINES - lines : 0;
    const base = atEnd ? (rows ? GRID_ROWS : GRID_COLUMNS) - MODEL_LINES : 0;
    const insert = pick(2) === 0;
    const at = pick(lines);
    const real: LineEdit = {
        insert,
        index: base + first + at,
        count: 1 + pick(insert ? (pick(4) === 0 ? lines + 2 : 3) : lines - at),
        sheet: ['s1', 's1', 's2', 's3'][pick(4)],
        rows,
    };
    const end = (): End => {
        const absolute = pick(2) === 0;
        return { absolute, value: absolute ? first + pick(lines) : pick(lines + 4) - (lines >> 1) - 2 };
    };
    const references: Reference[] = [];
    for (let n = 1 + pick(3); n > 0; n -= 1) {
        const [prefix, sheet] = PREFIXES[pick(PREFIXES.length)];
        const kind = pick(10);
        const ends = kind === 9 ? [] : kind < 3 ? [end()] : [end(), end()];
        references.push({ prefix, sheet, whole: kind === 8, ends });
    }
    const text = write(references.map((reference) => storedText(rows, base, reference)));
    const parsed = parseStored(text);
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason}`);
    return {
        edit: { ...real, index: first + at, lines: MODEL_LINES },
        real,
        base,
        first,
        last: first + lines - 1,
        hostSheet: ['s1', 's1', 's2'][pick(3)],
        references,
        tree: parsed,
    };
}

// The two lines a reference leaf names on the edited axis at a host, read from its fields.
function named(rows: boolean, leaf: FormulaNode, host: number): [number, number] {
    const absolute = leaf.flags & (rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute);
    const absolute2 = leaf.flags & (rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute);
    const first = (rows ? leaf.row : leaf.column) + (absolute ? 0 : host);
    return [first, leaf.op === RefKind.Cell ? first : (rows ? leaf.row2 : leaf.column2) + (absolute2 ? 0 : host)];
}

describe('the fast path against the slow version', () => {
    test('the transform: the cells it names, its flags and the edit that takes it back', () => {
        const pick = random(20261111);
        const seen = { changed: 0, gone: 0, lossy: 0, recompute: 0, resized: 0, offGrid: 0, undone: 0 };
        for (let run = 0; run < 20000; run += 1) {
            const asArguments = (texts: string[]) => `=SUM(${texts.join(',')})`;
            const { edit, real, base, first, last, hostSheet, references, tree: before } = sample(pick, asArguments);
            const { rows } = edit;
            const axis = axisAfter(edit);
            const text = printStored(before);
            const written = leaves(before);
            for (let host = first; host <= last; host += 1) {
                const hostAfter = hostSheet === edit.sheet ? axis.indexOf(host) : host;
                if (hostAfter === -1) continue;
                const where = `${text} on ${hostSheet} at line ${base + host}, ${JSON.stringify(real)}`;
                const result = transformLines(before, real, hostSheet, base + host);
                const stored = printStored(result.tree);
                expect(`${where}: ${result.tree === before}`).toBe(`${where}: ${stored === text}`);
                expect([where, reread(result.tree)]).toEqual([where, result.tree]);
                const flags = { lossy: false, recompute: false, resized: false, slid: false };
                const mapped = leaves(result.tree);
                references.forEach((reference, i) => {
                    const leaf = mapped[i];
                    const was = written[i];
                    if (reference.ends.length === 0) {
                        if ((reference.sheet ?? hostSheet) === edit.sheet) flags.slid = true;
                        expect(leaf).toBe(was);
                        return;
                    }
                    const expected = slow(edit, axis, hostSheet, reference, host);
                    if (expected.lost) flags.recompute = true;
                    if (expected.cut) flags.lossy = true;
                    if (expected.resized) flags.resized = true;
                    if (expected.gone) {
                        seen.gone += 1;
                        expect(`${where}: ${leaf.kind}`).toBe(`${where}: ${NodeKind.Error}`);
                        expect([leaf.sheetKind, leaf.sheet]).toEqual([was.sheetKind, was.sheet]);
                        return;
                    }
                    if (Math.min(expected.first, expected.second) < 0) seen.offGrid += 1;
                    expect(`${where}: ${leaf.kind} ${named(rows, leaf, base + hostAfter)}`).toBe(
                        `${where}: ${NodeKind.Ref} ${[base + expected.first, base + expected.second]}`,
                    );
                    expect([leaf.op, leaf.flags, leaf.sheetKind, leaf.sheet]).toEqual([
                        was.op,
                        was.flags,
                        was.sheetKind,
                        was.sheet,
                    ]);
                    expect(rows ? [leaf.column, leaf.column2] : [leaf.row, leaf.row2]).toEqual(
                        rows ? [was.column, was.column2] : [was.row, was.row2],
                    );
                });
                const { lossy, recompute, resized, slid } = result;
                expect(`${where}: ${JSON.stringify({ lossy, recompute, resized, slid })}`).toBe(
                    `${where}: ${JSON.stringify(flags)}`,
                );
                if (result.tree !== before) seen.changed += 1;
                if (lossy) seen.lossy += 1;
                if (recompute) seen.recompute += 1;
                if (resized) seen.resized += 1;
                // The edit that takes this one back gives every formula that lost nothing its stored text again.
                const back = { ...edit, insert: !edit.insert };
                const returns = hostSheet !== edit.sheet || axisAfter(back).indexOf(hostAfter) === host;
                if (lossy || !returns) continue;
                seen.undone += 1;
                const undone = transformLines(
                    result.tree,
                    { ...real, insert: !real.insert },
                    hostSheet,
                    base + hostAfter,
                );
                expect(`${where}: ${printStored(undone.tree)}`).toBe(`${where}: ${text}`);
            }
        }
        expect(seen.changed).toBeGreaterThan(30000);
        expect(seen.gone).toBeGreaterThan(5000);
        expect(seen.lossy).toBeGreaterThan(10000);
        expect(seen.recompute).toBeGreaterThan(15000);
        expect(seen.resized).toBeGreaterThan(10000);
        expect(seen.offGrid).toBeGreaterThan(5000);
        expect(seen.undone).toBeGreaterThan(40000);
    });

    test('wherever a reference stands, what comes out is stored text that reads back as the same tree', () => {
        const pick = random(5);
        const seen = { broken: 0, spill: 0, intersection: 0, union: 0 };
        for (let run = 0; run < 12000; run += 1) {
            const { edit, real, base, first, last, hostSheet, tree: before } = sample(pick, anywhere(pick));
            const axis = axisAfter(edit);
            for (let host = first; host <= last; host += 1) {
                if (hostSheet === edit.sheet && !axis.includes(host)) continue;
                const result = transformLines(before, real, hostSheet, base + host);
                const where = `${printStored(before)} on ${hostSheet} at line ${base + host}, ${JSON.stringify(real)}`;
                expect([where, reread(result.tree)]).toEqual([where, result.tree]);
                const stored = printStored(result.tree);
                if (!stored.includes('#REF!')) continue;
                seen.broken += 1;
                if (stored.includes('#REF!#')) seen.spill += 1;
                if (stored.includes('#REF! ') || stored.includes(' #REF!')) seen.intersection += 1;
                if (stored.includes('(#REF!,') || stored.includes(',#REF!)')) seen.union += 1;
            }
        }
        expect(seen.broken).toBeGreaterThan(3000);
        expect(seen.spill).toBeGreaterThan(500);
        expect(seen.intersection).toBeGreaterThan(500);
        expect(seen.union).toBeGreaterThan(500);
    });

    test('the classes give every host of a run what the transform gives it', () => {
        const pick = random(7);
        const table = new ShapeTable();
        let split = 0;
        let single = 0;
        let stretches = 0;
        for (let run = 0; run < 12000; run += 1) {
            const { edit, real, base, first, last, hostSheet, tree: parsed } = sample(pick, anywhere(pick));
            const axis = axisAfter(edit);
            const shape = table.shape(table.internTree(parsed));
            if (shape.tree === null) throw new Error(shape.text);
            const from = base + first + (pick(3) === 0 ? pick(last - first + 1) : 0);
            const to = pick(3) === 0 ? from + pick(base + last + 1 - from) : base + last;
            const classes = hostClasses(shape.tree, shape.refs, real, hostSheet, from, to);
            if (classes.length > 1) split += 1;
            const where = `${shape.text} on ${hostSheet} over ${from} to ${to}, ${JSON.stringify(real)}`;
            let next = 0;
            for (let host = from; host <= to; host += 1) {
                while (next < classes.length && classes[next].end < host) next += 1;
                const found = next < classes.length && classes[next].start <= host ? classes[next] : undefined;
                if (hostSheet === edit.sheet && !axis.includes(host - base)) {
                    expect(`${where}: line ${host} ${found === undefined}`).toBe(`${where}: line ${host} true`);
                    continue;
                }
                if (found === undefined) throw new Error(`${where}: no class for the host on line ${host}`);
                const direct = transformLines(shape.tree, real, hostSheet, host);
                const flags = [found.lossy, found.recompute, found.resized, found.slid];
                const same = found.tree === shape.tree;
                expect(`${where}: line ${host} ${printStored(found.tree)} ${flags} ${same}`).toBe(
                    `${where}: line ${host} ${printStored(direct.tree)} ${[direct.lossy, direct.recompute, direct.resized, direct.slid]} ${direct.tree === shape.tree}`,
                );
            }
            classes.forEach(({ start, end }, i) => {
                expect(Object.is(start, -0)).toBe(false);
                expect(start >= from && start <= end && end <= to).toBe(true);
                if (i > 0) expect(start).toBeGreaterThan(classes[i - 1].end);
                if (start === end) single += 1;
                else stretches += 1;
            });
        }
        expect(split).toBeGreaterThan(3000);
        expect(single).toBeGreaterThan(2000);
        expect(stretches).toBeGreaterThan(8000);
    });
});

describe('a column filled down splits into few classes, not one per cell', () => {
    const classesOf = (text: string, host: string, edit: LineEdit, from: number, to: number) => {
        const table = new ShapeTable();
        const shape = table.shape(table.internTree(tree(text, host)));
        if (shape.tree === null) throw new Error('unparsed');
        const classes = hostClasses(shape.tree, shape.refs, edit, 's1', from, to);
        // The whole run for a short one, and for a long one both ends of every class.
        for (const { start, end, tree: mapped, lossy, recompute, resized } of classes) {
            const step = Math.max(1, end - start);
            for (let line = start; line <= end; line += to - from > 200000 ? step : 1) {
                const direct = transformLines(shape.tree, edit, 's1', line);
                expect([line, printStored(mapped), lossy, recompute, resized]).toEqual([
                    line,
                    printStored(direct.tree),
                    direct.lossy,
                    direct.recompute,
                    direct.resized,
                ]);
            }
        }
        return classes.map(({ start, end, tree: mapped }) => [start, end, printStored(mapped)]);
    };

    test('a row inserted above a mix of references', () => {
        expect(classesOf('=A1+$B$9+SUM(C$1:C5)+Sheet2!A5', 'D5', insertRows(3), 4, 10003)).toEqual([
            [4, 5, '=R[-5]C[-3]+R10C2+SUM(R1C[-1]:RC[-1])+[s2]!R[-1]C[-3]'],
            [6, 10003, '=R[-4]C[-3]+R10C2+SUM(R1C[-1]:RC[-1])+[s2]!R[-1]C[-3]'],
        ]);
    });

    test('a reference to another sheet splits the run only where the host crosses the line', () => {
        expect(classesOf('=Sheet2!A1', 'D5', insertRows(3), 0, 999)).toEqual([
            [0, 1, '=[s2]!R[-4]C[-3]'],
            [2, 999, '=[s2]!R[-5]C[-3]'],
        ]);
    });

    test('a running total whose fixed end is deleted is one class', () => {
        expect(classesOf('=SUM(A$2:A2)', 'B2', deleteRows(2), 1, 99999)).toEqual([[2, 99999, '=SUM(R2C[-1]:RC[-1])']]);
    });

    test('only the hosts whose own end falls in the deleted rows get a class each', () => {
        expect(classesOf('=SUM(A$1:A2)', 'B5', deleteRows(5, 7), 3, GRID_ROWS - 1)).toEqual([
            [3, 3, '=SUM(R1C[-1]:R[-3]C[-1])'],
            [7, 7, '=SUM(R1C[-1]:R[-1]C[-1])'],
            [8, 8, '=SUM(R1C[-1]:R[-2]C[-1])'],
            [9, 9, '=SUM(R1C[-1]:R[-3]C[-1])'],
            [10, GRID_ROWS - 1, '=SUM(R1C[-1]:R[-3]C[-1])'],
        ]);
    });

    test('a broken reference splits nothing, as it reads no cell', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.intern('=[s1]!#REF!+SUM([s1]!#REF!:[s1]!#REF!)+[s1]!#REF!#'));
        if (shape.tree === null) throw new Error('unparsed');
        expect(hostClasses(shape.tree, shape.refs, insertRows(50), 's2', 0, 99)).toEqual([
            { start: 0, end: 99, tree: shape.tree, lossy: false, recompute: false, resized: false, slid: false },
        ]);
    });

    test('a class that starts on the first line starts on 0', () => {
        const [[start]] = classesOf('=A1', 'B1', insertRows(50), 0, 99);
        expect(Object.is(start, 0)).toBe(true);
    });
});
