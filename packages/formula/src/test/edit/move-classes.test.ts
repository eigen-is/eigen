import { describe, expect, test } from 'bun:test';
import type { Move } from '../../edit/move';
import { moveClasses } from '../../edit/move';
import { GRID_COLUMNS, GRID_ROWS, printStored, ShapeTable, transformMove } from '../../text';
import { random } from './support';

// Hosts, corners and blocks sit on the first and the last ten lines of both axes, where a class is cut by the grid.
function near(pick: (below: number) => number, lines: number): number {
    return pick(2) === 0 ? pick(10) : lines - 1 - pick(10);
}

describe('the classes of a move', () => {
    test('give every host of a block what the transform gives that host alone, at the edges of the grid too', () => {
        const pick = random(3);
        const table = new ShapeTable();
        const index = (fixed: boolean, lines: number) => (fixed ? String(1 + near(pick, lines)) : `[${pick(21) - 10}]`);
        const corner = (rows: boolean, columns: boolean) =>
            (rows ? `R${index(pick(2) === 0, GRID_ROWS)}` : '') +
            (columns ? `C${index(pick(2) === 0, GRID_COLUMNS)}` : '');
        const reference = () => {
            const sheet = ['', '', '[s1]!', '[s2]!'][pick(4)];
            const kind = pick(6);
            if (kind < 3) return sheet + corner(true, true);
            if (kind < 5) return `${sheet}${corner(true, true)}:${corner(true, true)}`;
            return kind === 5 && pick(2) === 0
                ? `${sheet}${corner(false, true)}:${corner(false, true)}`
                : `${sheet}${corner(true, false)}:${corner(true, false)}`;
        };
        let hosts = 0;
        let classes = 0;
        let carried = 0;
        let seeds = 0;
        let lossy = 0;
        let cut = 0;
        for (let run = 0; run < 4000; run += 1) {
            const shape = table.shape(table.intern(`=SUM(${reference()},${reference()})+@${reference()}`));
            if (shape.tree === null) throw new Error(shape.text);
            const sheets = ['s1', 's2'];
            const move: Move = {
                fromSheet: sheets[pick(2)],
                row: near(pick, GRID_ROWS),
                column: near(pick, GRID_COLUMNS),
                rows: 1 + pick(4),
                columns: 1 + pick(4),
                toSheet: sheets[pick(2)],
                toRow: near(pick, GRID_ROWS),
                toColumn: near(pick, GRID_COLUMNS),
            };
            // What of the block is on the grid before and after is what moves.
            const fitRows = Math.min(move.rows, GRID_ROWS - move.row, GRID_ROWS - move.toRow);
            const fitColumns = Math.min(move.columns, GRID_COLUMNS - move.column, GRID_COLUMNS - move.toColumn);
            if (fitRows < move.rows || fitColumns < move.columns) cut += 1;
            const hostSheet = sheets[pick(2)];
            const top = pick(2) === 0 ? pick(6) : GRID_ROWS - 12 + pick(6);
            const left = pick(2) === 0 ? pick(6) : GRID_COLUMNS - 12 + pick(6);
            const bottom = top + pick(7);
            const right = left + pick(7);
            const found = moveClasses(shape.tree, shape.refs, move, hostSheet, top, bottom, left, right);
            classes += found.length;
            for (let row = top; row <= bottom; row += 1) {
                for (let column = left; column <= right; column += 1) {
                    const own = found.filter(
                        (c) => row >= c.top && row <= c.bottom && column >= c.left && column <= c.right,
                    );
                    const inBlock = (
                        sheet: string,
                        first: number,
                        firstColumn: number,
                        rows: number,
                        columns: number,
                    ) =>
                        hostSheet === sheet &&
                        row >= first &&
                        row < first + rows &&
                        column >= firstColumn &&
                        column < firstColumn + columns;
                    const moves = inBlock(move.fromSheet, move.row, move.column, fitRows, fitColumns);
                    const where = `${run} ${shape.text} ${JSON.stringify(move)} ${hostSheet} ${row},${column}`;
                    // A host the block lands on is gone, and so is one of the block that does not fit on the grid.
                    const gone =
                        inBlock(move.toSheet, move.toRow, move.toColumn, fitRows, fitColumns) ||
                        inBlock(move.fromSheet, move.row, move.column, move.rows, move.columns);
                    if (!moves && gone) {
                        expect([where, own.length]).toEqual([where, 0]);
                        continue;
                    }
                    const direct = transformMove(shape.tree, move, hostSheet, row, column);
                    expect([where, own.length]).toEqual([where, 1]);
                    const [one] = own;
                    expect([
                        where,
                        printStored(one.tree),
                        one.lossy,
                        one.recompute,
                        one.carried,
                        one.tree === shape.tree,
                    ]).toEqual([
                        where,
                        printStored(direct.tree),
                        direct.lossy,
                        direct.recompute,
                        moves,
                        direct.tree === shape.tree,
                    ]);
                    hosts += 1;
                    if (moves) carried += 1;
                    if (direct.recompute) seeds += 1;
                    if (direct.lossy) lossy += 1;
                }
            }
        }
        expect(hosts).toBeGreaterThan(50000);
        expect(carried).toBeGreaterThan(300);
        expect(seeds).toBeGreaterThan(3000);
        expect(lossy).toBeGreaterThan(300);
        expect(cut).toBeGreaterThan(300);
        expect(classes).toBeLessThan(hosts / 2);
    });
    test('a block that does not fit on the grid moves the part that does, and what read the rest is a seed', () => {
        const table = new ShapeTable();
        const move: Move = {
            fromSheet: 's1',
            row: 0,
            column: 0,
            rows: 4,
            columns: 2,
            toSheet: 's1',
            toRow: GRID_ROWS - 2,
            toColumn: 5,
        };
        const outcome = (text: string, row: number, column: number) => {
            const shape = table.shape(table.intern(text));
            if (shape.tree === null) throw new Error(text);
            const moved = transformMove(shape.tree, move, 's1', row, column);
            return [printStored(moved.tree), moved.recompute, moved.lossy];
        };
        // A1:B2 goes, A3:B4 is gone: a reference into the part that went follows it, one into the rest stays.
        expect(outcome('=R2C2', 9, 9)).toEqual([`=R${GRID_ROWS}C7`, false, false]);
        expect(outcome('=R3C1', 9, 9)).toEqual(['=R3C1', true, false]);
        expect(outcome('=SUM(R1C1:R4C2)', 9, 9)).toEqual(['=SUM(R1C1:R4C2)', true, false]);
        expect(outcome('=SUM(R1C1:R2C2)', 9, 9)).toEqual([`=SUM(R${GRID_ROWS - 1}C6:R${GRID_ROWS}C7)`, false, false]);
        expect(outcome('=R5C1', 9, 9)).toEqual(['=R5C1', false, false]);
        // A formula that went keeps reading the cell that stayed behind and is gone.
        expect(outcome('=R[2]C', 1, 0)).toEqual([`=R[${4 - GRID_ROWS}]C[-5]`, true, false]);
        const shape = table.shape(table.intern('=R[9]C[9]'));
        if (shape.tree === null) throw new Error(shape.text);
        const classes = moveClasses(shape.tree, shape.refs, move, 's1', 0, 5, 0, 2);
        expect(classes.map((c) => [c.top, c.bottom, c.left, c.right, c.carried])).toEqual([
            [0, 1, 0, 1, true],
            [0, 1, 2, 2, false],
            [2, 3, 2, 2, false],
            [4, 5, 0, 1, false],
            [4, 5, 2, 2, false],
        ]);
    });
    test('a cell read by a filled column is a few classes, however long the column', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.intern('=R1C1+RC[-1]'));
        if (shape.tree === null) throw new Error(shape.text);
        const move: Move = {
            fromSheet: 's1',
            row: 0,
            column: 0,
            rows: 1,
            columns: 1,
            toSheet: 's1',
            toRow: 6,
            toColumn: 4,
        };
        const short = moveClasses(shape.tree, shape.refs, move, 's1', 0, 999, 2, 2);
        const long = moveClasses(shape.tree, shape.refs, move, 's1', 0, 99999, 2, 2);
        expect(long.length).toBe(short.length);
        expect(long.length).toBeLessThan(6);
        expect(long.every((found) => printStored(found.tree) === '=R7C5+RC[-1]' && !found.recompute)).toBe(true);
    });
    test('a reference that neither follows nor breaks is a seed when it reads a cell the block left or landed on', () => {
        const table = new ShapeTable();
        const seed = (text: string, move: Move) => {
            const { tree } = table.shape(table.intern(text));
            if (tree === null) throw new Error(text);
            const moved = transformMove(tree, move, 's1', 0, 5);
            return [moved.tree === tree, moved.recompute];
        };
        const move: Move = {
            fromSheet: 's1',
            row: 4,
            column: 0,
            rows: 1,
            columns: 1,
            toSheet: 's2',
            toRow: 4,
            toColumn: 4,
        };
        expect(seed('=SUM(R1C1:R10C1)', move)).toEqual([true, true]);
        expect(seed('=SUM([s2]!R1C5:R10C5)', move)).toEqual([true, true]);
        expect(seed('=SUM(C1:C1)+SUM([s2]!R5:R5)', move)).toEqual([true, true]);
        expect(seed('=SUM(R1C2:R10C2)+SUM([s2]!R1C1:R10C1)+R4C1+SUM(R6C1:R9C1)', move)).toEqual([true, false]);
        expect(seed('=R5C1', move)).toEqual([false, false]);
    });
});
