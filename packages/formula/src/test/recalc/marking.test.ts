import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { Engine } from '../../index';
import type { TestCell } from '../store/support';
import { random, source } from '../store/support';

// Which formulas a recalc computes again, on the workbooks where one tall reference or many small rectangles could
// make marking slow or wrong. A formula loaded with the text 'kept' shows anything else once it was computed.

const NO_CAP = Number.POSITIVE_INFINITY;
const KEPT = 'kept';
const GRID_ROWS = 1048576;
const GRID_COLUMNS = 16384;

function label(row: number, column: number): string {
    return `${String.fromCharCode(65 + column)}${row + 1}`;
}

function opened(cells: readonly TestCell[], other: readonly TestCell[] = []) {
    const engine = new Engine([source('s', cells), source('t', other)]);
    // The formulas of the first sheet that a recalc computed again, in the order they were given.
    const computed = (): string[] => {
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        return cells
            .filter(([row, column, , formula]) => formula !== undefined && engine.valueOf('s', row, column) !== KEPT)
            .map(([row, column]) => label(row, column));
    };
    return { engine, computed };
}

function shown(engine: Engine, rows: number, columns: number): unknown[] {
    const all: unknown[] = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const value = engine.valueOf('s', row, column);
            all.push(typeof value === 'object' && value !== null ? value.text : value);
        }
    }
    return all;
}

// Numbers in column A on every other row, B = A*2 and C = B+$F$1 on those rows, so every formula is a rectangle of
// its own, and at E1 one formula that reads a whole column.
function ladder(lines: number, reader: string | null, held: Literal | null, f1: number): TestCell[] {
    const cells: TestCell[] = [[0, 5, f1]];
    for (let line = 0; line < lines; line += 1) {
        cells.push([line * 2, 0, line], [line * 2, 1, held, '=RC[-1]*2'], [line * 2, 2, held, '=RC[-1]+R1C6']);
    }
    if (reader !== null) cells.push([0, 4, held, reader]);
    return cells;
}

const LINES = 300;
const READERS: [string, string | null][] = [
    ['no tall reader', null],
    ['a whole column', '=SUM(C1:C1)'],
    ['a range as long as the column', `=SUM(R1C1:R${LINES * 2}C1)`],
    ['a lookup in two whole columns', '=VLOOKUP(3,C1:C2,1,FALSE)'],
];
const every = (column: string) => Array.from({ length: LINES }, (_, line) => `${column}${line * 2 + 1}`);

describe('small rectangles under one tall reference', () => {
    test.each(READERS)('a first recalc computes every formula: %s', (_name, reader) => {
        const engine = new Engine([source('s', ladder(LINES, reader, null, 1))]);
        expect(engine.recalc(NO_CAP)).toEqual({ loops: [], stopped: false });
        for (const line of [0, 1, 150, LINES - 1]) {
            expect([engine.valueOf('s', line * 2, 1), engine.valueOf('s', line * 2, 2)]).toEqual([
                line * 2,
                line * 2 + 1,
            ]);
        }
        if (reader !== null) expect(engine.valueOf('s', 0, 4)).toBe(reader.includes('SUM') ? 44850 : 3);
    });

    test.each(READERS)('a write to the cell every line reads computes one formula a line: %s', (_name, reader) => {
        const { engine, computed } = opened(ladder(LINES, reader, KEPT, 1));
        expect(computed()).toEqual([]);
        engine.setValue('s', 0, 5, 2);
        expect(computed()).toEqual(every('C'));
    });

    test.each(READERS)('a write to one line computes that line and the tall reader: %s', (_name, reader) => {
        const { engine, computed } = opened(ladder(LINES, reader, KEPT, 1));
        engine.setValue('s', 200, 0, 7);
        expect(computed()).toEqual(reader === null ? ['B201', 'C201'] : ['B201', 'C201', 'E1']);
    });

    test.each(READERS)(
        'a write between two lines or past the last computes the readers it has: %s',
        (_name, reader) => {
            const between = opened(ladder(LINES, reader, KEPT, 1));
            between.engine.setValue('s', 201, 0, 7);
            expect(between.computed()).toEqual(reader === null ? [] : ['E1']);
            const past = opened(ladder(LINES, reader, KEPT, 1));
            past.engine.setValue('s', LINES * 2, 0, 7);
            expect(past.computed()).toEqual(reader === null || reader.includes('R1C1') ? [] : ['E1']);
        },
    );

    test.each(READERS)('after writes every cell equals a fresh load: %s', (_name, reader) => {
        const engine = new Engine([source('s', ladder(LINES, reader, null, 1))]);
        engine.recalc(NO_CAP);
        engine.setValue('s', 0, 5, 9);
        for (let line = 0; line < LINES; line += 3) engine.setValue('s', line * 2, 0, line + 1000);
        engine.recalc(NO_CAP);
        const cells = ladder(LINES, reader, null, 9).map(
            ([row, column, value, formula]): TestCell =>
                column === 0 && (row / 2) % 3 === 0 ? [row, column, row / 2 + 1000] : [row, column, value, formula],
        );
        const fresh = new Engine([source('s', cells)]);
        fresh.recalc(NO_CAP);
        expect(shown(engine, LINES * 2, 6)).toEqual(shown(fresh, LINES * 2, 6));
    });
});

describe('many shapes that read one cell', () => {
    const ROWS = 40;
    // A1 is read by every formula, each of a shape of its own, and column B by the formulas of its row.
    const cells: TestCell[] = [[0, 0, 1]];
    for (let row = 0; row < ROWS; row += 1) {
        cells.push([row, 1, row]);
        for (let column = 2; column < 7; column += 1) cells.push([row, column, KEPT, `=R1C1+RC2+${row * 9 + column}`]);
    }
    cells.push([0, 8, KEPT, '=SUM(C2:C2)']);

    test('a write to the cell computes all of them, and not the reader of another column', () => {
        const { engine, computed } = opened(cells);
        engine.setValue('s', 0, 0, 2);
        const all = cells.filter(([, column]) => column >= 2 && column < 7).map(([row, column]) => label(row, column));
        expect(computed()).toEqual(all);
    });

    test('a write to one row computes the formulas of that row and the reader of the column', () => {
        const { engine, computed } = opened(cells);
        engine.setValue('s', 17, 1, 2);
        expect(computed()).toEqual(['C18', 'D18', 'E18', 'F18', 'G18', 'I1']);
    });
});

describe('hosts that are reached more than once', () => {
    const ROWS = 60;
    // D is a running total of B, and on every third row E reads D.
    const cells: TestCell[] = [];
    for (let row = 0; row < ROWS; row += 1) {
        cells.push([row, 1, row], [row, 3, KEPT, '=SUM(R1C2:RC2)']);
        if (row % 3 === 0) cells.push([row, 4, KEPT, '=RC[-1]*2']);
    }
    const from = (first: number) =>
        cells.filter(([row, , , formula]) => formula !== undefined && row >= first).map(([row, c]) => label(row, c));

    test.each<[string, number[]]>([
        ['from the top down', [10, 20, 30, 40, 50]],
        ['from the bottom up', [50, 40, 30, 20, 10]],
        ['in no order', [30, 50, 10, 40, 20, 30]],
    ])('scattered writes under a running total, %s', (_name, rows) => {
        const { engine, computed } = opened(cells);
        for (const row of rows) engine.setValue('s', row, 1, 1);
        expect(computed()).toEqual(from(10));
    });

    test('two references of one shape reach the same hosts', () => {
        const block: TestCell[] = [];
        for (let row = 0; row < 8; row += 1) {
            for (let column = 3; column < 6; column += 1) block.push([row, column, KEPT, '=R1C1+R2C1+RC1']);
        }
        const { engine, computed } = opened(block);
        engine.setValue('s', 0, 0, 1);
        engine.setValue('s', 1, 0, 1);
        engine.setValue('s', 5, 0, 1);
        expect(computed()).toEqual(block.map(([row, column]) => label(row, column)));
    });

    test('a block that reads a block that reads a block', () => {
        const blocks: TestCell[] = [];
        for (let row = 0; row < 10; row += 1) {
            for (let column = 3; column < 6; column += 1) blocks.push([row, column, KEPT, '=R1C1+RC[-3]']);
            for (let column = 7; column < 10; column += 1) blocks.push([row, column, KEPT, '=RC[-4]']);
            for (let column = 11; column < 13; column += 1) blocks.push([row, column, KEPT, '=SUM(RC8:RC[-3])']);
        }
        const all = blocks.map(([row, column]) => label(row, column));
        const { engine, computed } = opened(blocks);
        engine.setValue('s', 4, 1, 1);
        expect(computed()).toEqual(['E5', 'I5', 'L5', 'M5']);
        engine.setValue('s', 0, 0, 1);
        expect(computed()).toEqual(all);
    });
});

describe('formulas flagged one after another', () => {
    test('in neighboring columns on different rows', () => {
        // D3 and E7 read column A, and G and H read D and E on both rows.
        const cells: TestCell[] = [
            [2, 3, KEPT, '=RC[-3]'],
            [6, 4, KEPT, '=RC[-4]'],
            [2, 6, KEPT, '=RC[-3]'],
            [6, 6, KEPT, '=RC[-3]'],
            [2, 7, KEPT, '=RC[-3]'],
            [6, 7, KEPT, '=RC[-3]'],
        ];
        const { engine, computed } = opened(cells);
        for (let row = 2; row <= 6; row += 1) engine.setValue('s', row, 0, 1);
        expect(computed()).toEqual(['D3', 'E7', 'G3', 'H7']);
    });

    test('in different columns on rows that follow', () => {
        // D3 and F4 read column A, and H and I read D and F on both rows.
        const cells: TestCell[] = [
            [2, 3, KEPT, '=RC[-3]'],
            [3, 5, KEPT, '=RC[-5]'],
            [2, 7, KEPT, '=RC[-4]'],
            [3, 7, KEPT, '=RC[-4]'],
            [2, 8, KEPT, '=RC[-3]'],
            [3, 8, KEPT, '=RC[-3]'],
        ];
        const { engine, computed } = opened(cells);
        engine.setValue('s', 2, 0, 1);
        engine.setValue('s', 3, 0, 1);
        expect(computed()).toEqual(['D3', 'F4', 'H3', 'I4']);
    });
});

describe('formulas that came without a value', () => {
    test('a workbook that was never computed computes every formula, loops and unnamed cells included', () => {
        const engine = new Engine([
            source('s', [
                [0, 0, 1],
                [0, 1, null, '=RC[-1]+1'],
                [1, 1, null, '=R[-1]C+[t]!R1C1'],
                [2, 1, null, '=SUM(R1C1:INDEX(R1C1:R2C2,2,2))'],
                [3, 1, null, '=R[1]C'],
                [4, 1, null, '=R[-1]C'],
            ]),
            source('t', [[0, 0, null, '=[s]!R1C1*10']]),
        ]);
        const result = engine.recalc(NO_CAP);
        expect(result.stopped).toBe(false);
        expect(result.loops.map(({ row }) => row)).toEqual([3, 4]);
        expect([0, 1, 2].map((row) => engine.valueOf('s', row, 1))).toEqual([2, 12, 15]);
        expect(engine.valueOf('t', 0, 0)).toBe(10);
    });
});

type End = { readonly fixed: boolean; readonly at: number };
type Shape = {
    readonly kind: 'cell' | 'range' | 'columns' | 'rows';
    readonly rows: readonly [End, End];
    readonly columns: readonly [End, End];
};

const text = (letter: string, end: End) =>
    end.fixed ? `${letter}${end.at + 1}` : end.at === 0 ? letter : `${letter}[${end.at}]`;
const place = (end: End, host: number) => (end.fixed ? end.at : host + end.at);

function stored({ kind, rows, columns }: Shape): string {
    if (kind === 'columns') return `${text('C', columns[0])}:${text('C', columns[1])}`;
    if (kind === 'rows') return `${text('R', rows[0])}:${text('R', rows[1])}`;
    const first = `${text('R', rows[0])}${text('C', columns[0])}`;
    return kind === 'cell' ? first : `${first}:${text('R', rows[1])}${text('C', columns[1])}`;
}

// The area a host reads, by the definition, or null when the reference leaves the grid there.
function areaOf({ kind, rows, columns }: Shape, row: number, column: number) {
    const along = (ends: readonly [End, End], host: number, whole: boolean, size: number) => {
        if (whole) return [0, size - 1];
        const first = place(ends[0], host);
        const second = kind === 'cell' ? first : place(ends[1], host);
        return [Math.min(first, second), Math.max(first, second)];
    };
    const [top, bottom] = along(rows, row, kind === 'columns', GRID_ROWS);
    const [left, right] = along(columns, column, kind === 'rows', GRID_COLUMNS);
    return top < 0 || bottom >= GRID_ROWS || left < 0 || right >= GRID_COLUMNS ? null : { top, bottom, left, right };
}

describe('the hosts of a rectangle that read written cells, against the definition', () => {
    test.each([[1], [2], [3], [4], [5], [6]])('random shapes, rectangles and writes: seed %i', (seed) => {
        const next = random(seed);
        const pick = (n: number) => Math.floor(next() * n);
        const end = (): End => (pick(2) === 0 ? { fixed: true, at: pick(11) } : { fixed: false, at: pick(7) - 3 });
        let reached = 0;
        for (let round = 0; round < 250; round += 1) {
            const shape: Shape = {
                kind: (['cell', 'range', 'range', 'range', 'columns', 'rows'] as const)[pick(6)],
                rows: [end(), end()],
                columns: [end(), end()],
            };
            const top = pick(5);
            const left = pick(5);
            const height = 1 + pick(6);
            const width = 1 + pick(6);
            const same = pick(3) === 0;
            const formula = `=SUM(${same ? '' : '[t]!'}${stored(shape)})`;
            const hosts: TestCell[] = [];
            for (let column = left; column < left + width; column += 1) {
                for (let row = top; row < top + height; row += 1) hosts.push([row, column, KEPT, formula]);
            }
            const held = (row: number, column: number) =>
                row >= top && row < top + height && column >= left && column < left + width;
            for (let probe = 0; probe < 8; probe += 1) {
                const column = pick(14);
                const first = pick(14);
                const last = pick(3) === 0 ? Math.min(13, first + pick(5)) : first;
                // A write to a host would take its formula away.
                if (same && column >= left && column < left + width && last >= top && first < top + height) continue;
                const { engine, computed } = opened(hosts);
                for (let row = first; row <= last; row += 1) engine.setValue(same ? 's' : 't', row, column, 7);
                // The hosts that read a written cell, then those that read one of those, until no more are found.
                const expected = new Set<string>();
                let found = true;
                while (found) {
                    found = false;
                    for (const [row, c] of hosts) {
                        const area = areaOf(shape, row, c);
                        if (area === null || expected.has(label(row, c))) continue;
                        let reads =
                            column >= area.left && column <= area.right && first <= area.bottom && last >= area.top;
                        for (let r = area.top; same && !reads && r <= Math.min(area.bottom, 12); r += 1) {
                            for (let at = area.left; !reads && at <= Math.min(area.right, 12); at += 1) {
                                reads = held(r, at) && expected.has(label(r, at));
                            }
                        }
                        if (reads) {
                            expected.add(label(row, c));
                            found = true;
                        }
                    }
                }
                reached += expected.size;
                const wanted = hosts.map(([row, c]) => label(row, c)).filter((name) => expected.has(name));
                expect([formula, label(top, left), height, width, column, first, last, ...computed()]).toEqual([
                    formula,
                    label(top, left),
                    height,
                    width,
                    column,
                    first,
                    last,
                    ...wanted,
                ]);
            }
        }
        expect(reached).toBeGreaterThan(1000);
    });
});
