import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { Recalc } from '../../recalc/recalc';
import { ReverseIndex } from '../../recalc/reverse-index';
import { SETTLED } from '../../store/column';
import { Workbook } from '../../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../../text/a1';
import type { TestCell } from '../store/support';
import { random, source } from '../store/support';
import type { Reader } from './closure';
import { cellKey, closure, factsOf, pendingOf, readersOf } from './closure';

// The law of marking: the formulas a marking flags are exactly those the definition reaches from its seeds, no
// fewer and no more, whatever was pending before it: a marking right after another, after a pass that stopped at
// its cap, after single formulas were computed, and after a rebuild of the index with flags standing. The same law
// holds for what a recalc computes after writes, where a cell can be written twice and cells come in any order.

const SHEETS = ['a', 'b', 'c'];
const KEPT = 'kept';
const ROWS = 40;
const COLUMNS = 10;

function generator(next: () => number) {
    const pick = (n: number) => Math.floor(next() * n);
    const end = (letter: string, size: number) => {
        if (pick(2) === 0) return `${letter}${1 + pick(size)}`;
        const offset = pick(8) === 0 ? pick(61) - 30 : pick(9) - 4;
        return offset === 0 ? letter : `${letter}[${offset}]`;
    };
    const sheet = () => (pick(4) === 0 ? `[${SHEETS[pick(3)]}]!` : '');
    const cell = () => `${sheet()}${end('R', ROWS)}${end('C', COLUMNS)}`;
    const range = () => `${cell()}:${end('R', ROWS)}${end('C', COLUMNS)}`;
    const columns = () => `${sheet()}${end('C', COLUMNS)}:${end('C', COLUMNS)}`;
    const rows = () => `${sheet()}${end('R', ROWS)}:${end('R', ROWS)}`;
    const formula = (): string => {
        switch (pick(16)) {
            case 0:
            case 1:
                return `=${cell()}+${pick(50)}`;
            case 2:
                return `=${cell()}*2-${cell()}`;
            case 3:
            case 4:
                return `=SUM(${range()})`;
            case 5:
                return `=SUM(${range()},${cell()})`;
            case 6:
            case 7:
                return `=SUM(${columns()})+${pick(9)}`;
            case 8:
                return `=SUM(${rows()})`;
            case 9:
                return `=SUM(${sheet()}R1:R${GRID_ROWS})`;
            case 10:
                return `=SUM(${cell()}:INDEX(${range()},1,1))`;
            case 11:
                return `='a:b'!${end('R', ROWS)}${end('C', COLUMNS)}+${cell()}`;
            case 12:
                return `='Nope'!R1C1+${cell()}`;
            case 13:
                return `=COUNTIF(${columns()},${cell()})`;
            case 14:
                return `=SUM(${columns()})+${cell()}`;
            default:
                return `=SUM(${sheet()}R${1 + pick(3)}C${1 + pick(3)}:R${1 + pick(ROWS)}C${1 + pick(3)})+${pick(99)}`;
        }
    };
    // A range reader for a tall block: its hosts are reached again and again by the spans of one marking.
    const tall = (): string => {
        const column = `C${1 + pick(4)}`;
        const moving = pick(2) === 0 ? 'C[-1]' : `C[${pick(5) - 2}]`;
        switch (pick(7)) {
            case 0:
                return `=SUM(R1${column}:R${column})`;
            case 1:
                return `=SUM(R[${-pick(6)}]${column}:R[${pick(6)}]${column})`;
            case 2:
                return `=SUM(R1${column}:R${1 + pick(ROWS)}${column})+R1${column}`;
            case 3:
                return `=SUM(${moving}:${moving})`;
            case 4:
                return `=SUM(R${moving}:R${ROWS}${column})`;
            case 5:
                return `=SUM(${column}:${column})+R[${pick(3) - 1}]${column}`;
            default:
                return `=SUM(R[${pick(9) - 4}]${moving}:R${1 + pick(ROWS)}${moving})`;
        }
    };
    return { pick, formula, tall };
}

// A workbook of a few fills, later ones over earlier ones so runs are split: single cells, runs, blocks, every
// other row or column, tall blocks, and now and then hosts at the last rows or the last columns of the grid.
function cellsOf(pick: (n: number) => number, formula: () => string, tall: () => string): TestCell[][] {
    const sheets: Map<number, TestCell>[] = SHEETS.map(() => new Map());
    const fills = 3 + pick(8);
    for (let fill = 0; fill < fills; fill += 1) {
        const cells = sheets[pick(3)];
        // Most formulas come with a value, so they are settled.
        const value = pick(8) === 0 ? null : 0;
        const kind = pick(16);
        let text = formula();
        let top = pick(ROWS);
        let left = pick(COLUMNS);
        let height = 1;
        let width = 1;
        let rowStep = 1;
        let columnStep = 1;
        if (kind < 3) height = 2 + pick(30);
        else if (kind < 6) {
            height = 2 + pick(8);
            width = 2 + pick(5);
        } else if (kind < 8) {
            height = 2 + pick(12);
            rowStep = 2;
        } else if (kind < 9) {
            width = 2 + pick(4);
            columnStep = 2;
        } else if (kind < 12) {
            text = tall();
            top = pick(6);
            height = 30 + pick(40);
            width = 1 + pick(3);
        } else if (kind < 13 && pick(6) === 0) {
            height = 1 + pick(5);
            top = GRID_ROWS - height;
            left = pick(3);
        } else if (kind < 14 && pick(4) === 0) {
            width = 1 + pick(4);
            left = GRID_COLUMNS - width;
        } else if (kind < 15) {
            // Hosts at the first rows and columns, where a reference that moves up or left leaves the grid.
            top = 0;
            left = 0;
            height = 2 + pick(6);
            width = 1 + pick(4);
        }
        for (let r = 0; r < height; r += 1) {
            for (let c = 0; c < width; c += 1) {
                const row = top + r * rowStep;
                const column = left + c * columnStep;
                cells.set(row * GRID_COLUMNS + column, [row, column, value, text]);
            }
        }
    }
    for (const cells of sheets) {
        for (let i = 0; i < 12; i += 1) {
            const row = pick(ROWS);
            const column = pick(COLUMNS);
            cells.set(row * GRID_COLUMNS + column, [row, column, pick(9)]);
        }
    }
    return sheets.map((cells) => [...cells.values()]);
}

function run(seed: number, books: number): { markings: number; flagged: number; stops: number } {
    let markings = 0;
    let flagged = 0;
    let stops = 0;
    for (let book = 0; book < books; book += 1) {
        const { pick, formula, tall } = generator(random(seed * 100003 + book));
        const workbook = new Workbook(cellsOf(pick, formula, tall).map((cells, s) => source(SHEETS[s], cells)));
        const recalc = new Recalc(workbook, FUNCTIONS);
        const index = new ReverseIndex();
        let readers: Reader[] = [];
        const rebuild = () => {
            const facts = factsOf(workbook);
            index.rebuild(workbook);
            readers = readersOf(workbook, facts);
        };
        rebuild();
        for (let marking = 0; marking < 14; marking += 1) {
            const before = pick(12);
            if (before === 3 || before === 4) {
                if (recalc.pass(1 + pick(6)).stopped) stops += 1;
            } else if (before === 5) recalc.pass(Number.POSITIVE_INFINITY);
            else if (before < 9) {
                // Formulas computed one by one: half of those pending, the ones of one column, or one alone.
                const one = before === 8 ? pick(pendingOf(workbook).size + 1) : -1;
                const only = before === 7 ? pick(COLUMNS) : -1;
                let met = 0;
                for (const sheet of workbook.sheets) {
                    sheet.columns.forEach((cells, c) => {
                        for (let row = 0; cells.pending > 0 && row < cells.length; row += 1) {
                            if (cells.kind[row] <= SETTLED) continue;
                            met += 1;
                            if (one >= 0 ? met === one : only >= 0 ? c === only : pick(2) === 0) cells.computed(row);
                        }
                    });
                }
            } else if (before < 11) {
                // A formula comes or goes, and the index is built again with every flag standing.
                const sheet = workbook.sheets[pick(3)];
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                const what = pick(4);
                if (what < 2) workbook.fillFormula(sheet, row, column, row, column, what === 0 ? formula() : tall());
                else if (what === 2) workbook.setValue(sheet, row, column, pick(9));
                else workbook.clear(sheet, row, column);
                rebuild();
            }
            const seeds: number[] = [];
            const spans = pick(7);
            for (let i = 0; i < spans; i += 1) {
                const far = pick(12);
                const column = far === 0 ? GRID_COLUMNS - 1 - pick(5) : far === 1 ? COLUMNS + pick(30) : pick(COLUMNS);
                const tallness = pick(14);
                const first = tallness === 0 ? GRID_ROWS - 1 - pick(6) : tallness === 1 ? 0 : pick(ROWS + 35);
                const last =
                    tallness === 1 ? GRID_ROWS - 1 : Math.min(GRID_ROWS - 1, first + (pick(3) === 0 ? pick(9) : 0));
                seeds.push(pick(3), column, first, last);
                // The same span twice, as a cell written twice.
                if (pick(9) === 0) seeds.push(...seeds.slice(-4));
            }
            const expected = pendingOf(workbook);
            const reached = closure(workbook, readers, seeds);
            for (const key of reached) expected.add(key);
            index.mark(workbook, seeds);
            const marked = pendingOf(workbook);
            const missed = [...expected].filter((key) => !marked.has(key));
            const extra = [...marked].filter((key) => !expected.has(key));
            expect({ seed, book, marking, missed, extra }).toEqual({ seed, book, marking, missed: [], extra: [] });
            markings += 1;
            flagged += reached.size;
        }
    }
    return { markings, flagged, stops };
}

// Recalcs of workbooks whose formulas came with the text 'kept' or were never computed: a formula that shows
// anything else was computed. The cells are written in runs down or up a column, some of them again from the same
// row, from a row inside the run or from the row after it.
function written(seed: number, books: number): { passes: number; computed: number } {
    let passes = 0;
    let computed = 0;
    for (let book = 0; book < books; book += 1) {
        const { pick, formula, tall } = generator(random(seed * 100019 + book));
        const sources = cellsOf(pick, formula, tall).map((cells, s) =>
            source(
                SHEETS[s],
                cells.map(
                    ([row, column, value, text]): TestCell =>
                        text === undefined ? [row, column, value] : [row, column, value === null ? null : KEPT, text],
                ),
            ),
        );
        const workbook = new Workbook(sources);
        const recalc = new Recalc(workbook, FUNCTIONS);
        // A formula that was never computed is a seed of the first recalc.
        const seeds: number[] = [];
        for (const key of pendingOf(workbook)) {
            const row = key % GRID_ROWS;
            const column = Math.floor(key / GRID_ROWS) % GRID_COLUMNS;
            seeds.push(Math.floor(key / GRID_ROWS / GRID_COLUMNS), column, row, row);
        }
        for (let pass = 0; pass < 8; pass += 1) {
            const runs = pick(6);
            for (let run = 0; run < runs; run += 1) {
                const s = pick(3);
                const column = pick(COLUMNS);
                const length = 1 + pick(6);
                const up = pick(2) === 0;
                const times = 1 + pick(3);
                let from = pick(ROWS);
                for (let time = 0; time < times; time += 1) {
                    for (let i = 0; i < length; i += 1) {
                        const row = up ? from + length - 1 - i : from + i;
                        seeds.push(s, column, row, row);
                        recalc.setValue(workbook.sheets[s], row, column, pick(9));
                    }
                    from += pick(length + 1);
                }
            }
            const expected = pendingOf(workbook);
            // A pass with nothing written marks nothing.
            const reached = seeds.length > 0 ? closure(workbook, readersOf(workbook, factsOf(workbook)), seeds) : [];
            for (const key of reached) expected.add(key);
            recalc.pass(Number.POSITIVE_INFINITY);
            const shown = new Set<number>();
            workbook.sheets.forEach((sheet, s) => {
                sheet.columns.forEach((cells, column) => {
                    for (let row = 0; row < cells.length; row += 1) {
                        if (cells.shape[row] === 0) continue;
                        if (workbook.value(cells, row) !== KEPT) shown.add(cellKey(s, column, row));
                        workbook.put(cells, row, KEPT);
                    }
                });
            });
            const missed = [...expected].filter((key) => !shown.has(key));
            const extra = [...shown].filter((key) => !expected.has(key));
            expect({ seed, book, pass, missed, extra }).toEqual({ seed, book, pass, missed: [], extra: [] });
            passes += 1;
            computed += shown.size;
            seeds.length = 0;
        }
    }
    return { passes, computed };
}

describe('a marking flags what the definition reaches, no less and no more', () => {
    test('the generator writes formulas that parse', () => {
        const { formula, tall } = generator(random(1));
        const workbook = new Workbook([source('a', []), source('b', []), source('c', [])]);
        for (let i = 0; i < 400; i += 1)
            workbook.fillFormula(workbook.sheets[0], i, 0, i, 0, i % 2 ? formula() : tall());
        for (let id = 1; id <= workbook.shapes.size; id += 1) expect(workbook.shapes.shape(id).tree).not.toBeNull();
    });

    test('the definition itself: a chain, a block and a reader of unnamed cells', () => {
        const workbook = new Workbook([
            source('a', [
                [0, 0, 1],
                [1, 0, 0, '=R[-1]C+1'],
                [2, 0, 0, '=R[-1]C+1'],
                [0, 2, 0, '=SUM(R1C1:R2C1)'],
                [5, 5, 0, '=SUM(RC[-1]:INDEX(R1C1:R2C2,1,1))'],
                [7, 7, 0, '=R[-9]C'],
            ]),
        ]);
        const readers = readersOf(workbook, factsOf(workbook));
        const keys = (cells: [number, number][]) => new Set(cells.map(([row, column]) => cellKey(0, column, row)));
        expect(closure(workbook, readers, [0, 0, 1, 1])).toEqual(
            keys([
                [5, 5],
                [2, 0],
                [0, 2],
            ]),
        );
        expect(closure(workbook, readers, [])).toEqual(keys([[5, 5]]));
        workbook.sheets[0].columns[0].markDirty(1);
        expect(closure(workbook, readers, [0, 0, 0, 0])).toEqual(
            keys([
                [5, 5],
                [0, 2],
            ]),
        );
    });

    test.each([[1], [2], [3], [4], [5], [6], [7], [8]])(
        'random workbooks and markings: seed %i',
        (seed) => {
            const { markings, flagged, stops } = run(seed, 150);
            expect(markings).toBe(2100);
            expect(flagged).toBeGreaterThan(8000);
            expect(stops).toBeGreaterThan(20);
        },
        120000,
    );

    test.each([[1], [2], [3], [4]])(
        'random workbooks and writes, a cell more than once and in any order: seed %i',
        (seed) => {
            const { passes, computed } = written(seed, 150);
            expect(passes).toBe(1200);
            expect(computed).toBeGreaterThan(8000);
        },
        120000,
    );
});
