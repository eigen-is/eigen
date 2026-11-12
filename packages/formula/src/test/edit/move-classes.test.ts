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
        for (let run = 0; run < 4000; run += 1) {
            const shape = table.shape(table.intern(`=SUM(${reference()},${reference()})+@${reference()}`));
            if (shape.tree === null) throw new Error(shape.text);
            const sheets = ['s1', 's2'];
            const move: Move = {
                fromSheet: sheets[pick(2)],
                row: near(pick, GRID_ROWS - 4),
                column: near(pick, GRID_COLUMNS - 4),
                rows: 1 + pick(4),
                columns: 1 + pick(4),
                toSheet: sheets[pick(2)],
                toRow: near(pick, GRID_ROWS - 4),
                toColumn: near(pick, GRID_COLUMNS - 4),
            };
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
                    const inBlock = (sheet: string, first: number, firstColumn: number) =>
                        hostSheet === sheet &&
                        row >= first &&
                        row < first + move.rows &&
                        column >= firstColumn &&
                        column < firstColumn + move.columns;
                    const moves = inBlock(move.fromSheet, move.row, move.column);
                    const where = `${run} ${shape.text} ${JSON.stringify(move)} ${hostSheet} ${row},${column}`;
                    if (!moves && inBlock(move.toSheet, move.toRow, move.toColumn)) {
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
        expect(classes).toBeLessThan(hosts / 2);
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
