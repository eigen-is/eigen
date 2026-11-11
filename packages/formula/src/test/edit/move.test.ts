// A move of a block of cells, as a cut and paste or a drag makes it: who follows the block, who reads an
// overwritten cell, and what a formula inside the block keeps reading.

import { describe, expect, test } from 'bun:test';
import type { Move } from '../../text';
import { GRID_ROWS, printStored, toA1, transformMove } from '../../text';
import { at } from '../text/support';
import { random, SHEETS, shown, tree } from './support';

// "Sheet1!A1:B4" → the sheet's id and the block's corner and size.
function block(text: string): { sheet: string; row: number; column: number; rows: number; columns: number } {
    const [name, cells] = text.split('!');
    const [first, last = first] = cells.split(':');
    const [row, column] = at(first);
    const [row2, column2] = at(last);
    const sheet = SHEETS.find((candidate) => candidate.name === name)?.id ?? name;
    return { sheet, row, column, rows: row2 - row + 1, columns: column2 - column + 1 };
}

function move(from: string, to: string): Move {
    const source = block(from);
    const target = block(to);
    return {
        fromSheet: source.sheet,
        row: source.row,
        column: source.column,
        rows: source.rows,
        columns: source.columns,
        toSheet: target.sheet,
        toRow: target.row,
        toColumn: target.column,
    };
}

// A formula typed at `host`, taken through the move: where it is afterwards and what it reads there.
function after(text: string, host: string, from: string, to: string): string {
    const { sheet, row, column } = block(host);
    const edit = move(from, to);
    const before = tree(text, toA1(row, column));
    const result = transformMove(before, edit, sheet, row, column);
    expect(result.tree === before).toBe(printStored(result.tree) === printStored(before));
    expect(result.recompute).toBe(result.lossy);
    const carried =
        sheet === edit.fromSheet &&
        row >= edit.row &&
        row < edit.row + edit.rows &&
        column >= edit.column &&
        column < edit.column + edit.columns;
    const place = carried ? toA1(row + edit.toRow - edit.row, column + edit.toColumn - edit.column) : toA1(row, column);
    const name = SHEETS.find((candidate) => candidate.id === (carried ? edit.toSheet : sheet))?.name;
    return `${name}!${place} ${shown(result.tree, place)}${result.lossy ? ' lossy' : ''}`;
}

describe('a reference to a cell in the moved block follows it', () => {
    test.each([
        ['=A1', 'Sheet1!A2 =B1'],
        ['=$A1', 'Sheet1!A2 =$B1'],
        ['=A$1', 'Sheet1!A2 =B$1'],
        ['=$A$1', 'Sheet1!A2 =$B$1'],
    ])('%s with A1 moved to B1', (text, expected) => {
        expect(after(text, 'Sheet1!A2', 'Sheet1!A1', 'Sheet1!B1')).toBe(expected);
    });
    test('from a formula on another sheet, which a cut used to leave behind', () => {
        expect(after('=Sheet1!A1', 'Sheet2!B1', 'Sheet1!A1', 'Sheet1!D4')).toBe('Sheet2!B1 =Sheet1!D4');
        expect(after('=SUM(Sheet2!A1)+SUM(A1)', 'Sheet1!C3', 'Sheet1!A1', 'Sheet1!B3')).toBe(
            'Sheet1!C3 =SUM(Sheet2!A1)+SUM(B3)',
        );
        expect(after('=Sheet1!A1+A1', 'Sheet2!C3', 'Sheet1!A1', 'Sheet1!B3')).toBe('Sheet2!C3 =Sheet1!B3+A1');
    });
    test('to another sheet, whose name it gains', () => {
        expect(after('=A1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet2!B1')).toBe('Sheet1!A2 =Sheet2!B1');
        expect(after('=Sheet1!$A$1', 'Sheet3!A2', 'Sheet1!A1', 'Sheet2!B1')).toBe('Sheet3!A2 =Sheet2!$B$1');
    });
    test('onto the sheet of the formula, where a written sheet name stays written', () => {
        expect(after('=Sheet2!A1', 'Sheet1!A2', 'Sheet2!A1', 'Sheet1!B1')).toBe('Sheet1!A2 =Sheet1!B1');
    });
    test('one cell of a filled column changes alone', () => {
        expect(after('=A11', 'Sheet1!C11', 'Sheet1!A11', 'Sheet1!B11')).toBe('Sheet1!C11 =B11');
        expect(after('=A12', 'Sheet1!C12', 'Sheet1!A11', 'Sheet1!B11')).toBe('Sheet1!C12 =A12');
    });
});

describe('a range follows only when all of it is in the block', () => {
    test('all of it', () => {
        expect(after('=SUM(A1:A2)', 'Sheet1!A3', 'Sheet1!A1:A2', 'Sheet1!B1')).toBe('Sheet1!A3 =SUM(B1:B2)');
        expect(after('=SUM(A2:A$1)', 'Sheet1!A3', 'Sheet1!A1:B2', 'Sheet2!C5')).toBe('Sheet1!A3 =SUM(Sheet2!C$5:C6)');
    });
    test('part of it', () => {
        expect(after('=SUM(A1:A2)', 'Sheet1!A3', 'Sheet1!A1', 'Sheet1!B1')).toBe('Sheet1!A3 =SUM(A1:A2)');
        expect(after('=SUM(A1:A10)', 'Sheet1!C1', 'Sheet1!A10', 'Sheet1!A12')).toBe('Sheet1!C1 =SUM(A1:A10)');
        expect(after('=SUM(A1:A10)', 'Sheet1!C1', 'Sheet1!A1', 'Sheet1!B3')).toBe('Sheet1!C1 =SUM(A1:A10)');
    });
    test('a whole column follows whole columns and nothing less', () => {
        const columnA = `Sheet1!A1:A${GRID_ROWS}`;
        expect(after('=SUM(A:A)+SUM($A:B)', 'Sheet1!E1', columnA, 'Sheet1!C1')).toBe('Sheet1!E1 =SUM(C:C)+SUM($A:B)');
        expect(after('=SUM(A:A)', 'Sheet1!E1', 'Sheet1!A1:A100', 'Sheet1!C1')).toBe('Sheet1!E1 =SUM(A:A)');
        expect(after('=SUM(1:1)', 'Sheet1!E5', 'Sheet1!A1:XFD1', 'Sheet2!A3')).toBe('Sheet1!E5 =SUM(Sheet2!3:3)');
    });
});

describe('a reference to a cell the block landed on', () => {
    test('becomes #REF! and is lossy', () => {
        expect(after('=B1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet1!B1')).toBe('Sheet1!A2 =#REF! lossy');
        expect(after('=1+ Sheet2!$B$1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet2!B1')).toBe(
            'Sheet1!A2 =1+ Sheet2!#REF! lossy',
        );
    });
    test('as does a range that is covered whole, and no other', () => {
        expect(after('=SUM(B1:B2)', 'Sheet1!D1', 'Sheet1!A1:A3', 'Sheet1!B1')).toBe('Sheet1!D1 =SUM(#REF!) lossy');
        expect(after('=SUM(B1:B4)', 'Sheet1!D1', 'Sheet1!A1:A3', 'Sheet1!B1')).toBe('Sheet1!D1 =SUM(B1:B4)');
    });
    test('but a cell of the block that only moves within it follows', () => {
        expect(after('=A2+A3', 'Sheet1!C1', 'Sheet1!A1:A2', 'Sheet1!A2')).toBe('Sheet1!C1 =A3+#REF! lossy');
    });
});

describe('a formula inside the block keeps reading the cells it read', () => {
    test.each([
        ['=A1', 'Sheet1!A2', 'Sheet1!B1 =A1'],
        ['=$A1', 'Sheet1!A3', 'Sheet1!B2 =$A1'],
        ['=A$1', 'Sheet1!A4', 'Sheet1!B3 =A$1'],
        ['=$A$1', 'Sheet1!A5', 'Sheet1!B4 =$A$1'],
    ])('%s moved alone', (text, host, expected) => {
        expect(after(text, host, 'Sheet1!A2:A5', 'Sheet1!B1')).toBe(expected);
    });
    test.each([
        ['=A1', 'Sheet1!B1', 'Sheet1!C2 =B2'],
        ['=$A2', 'Sheet1!B2', 'Sheet1!C3 =$B3'],
        ['=A$3', 'Sheet1!B3', 'Sheet1!C4 =B$4'],
        ['=$A$4', 'Sheet1!B4', 'Sheet1!C5 =$B$5'],
    ])('%s moved with its target', (text, host, expected) => {
        expect(after(text, host, 'Sheet1!A1:B4', 'Sheet1!B2')).toBe(expected);
    });
    test('to another sheet, where it names the sheet it left', () => {
        expect(after('=A1*2', 'Sheet1!C1', 'Sheet1!C1', 'Sheet2!C1')).toBe('Sheet2!C1 =Sheet1!A1*2');
        expect(after('=SUM(Sheet3!A1:A3,B1)', 'Sheet1!C1', 'Sheet1!C1', 'Sheet2!E5')).toBe(
            'Sheet2!E5 =SUM(Sheet3!A1:A3,Sheet1!B1)',
        );
        expect(after('=Sheet2!A1+Later!A1', 'Sheet1!C1', 'Sheet1!C1', 'Sheet2!E5')).toBe(
            'Sheet2!E5 =Sheet2!A1+Later!A1',
        );
    });
    test('to another sheet with its target, which stays unnamed', () => {
        expect(after('=A2+3', 'Sheet1!A1', 'Sheet1!A1:B2', 'Sheet2!J10')).toBe('Sheet2!J10 =J11+3');
        expect(after('=A2+3', 'Sheet1!A1', 'Sheet1!A1', 'Sheet1!J10')).toBe('Sheet1!J10 =A2+3');
    });
    test('and a formula that moves with all it reads keeps its tree', () => {
        const before = tree('=A1+SUM($A$1:B2)', 'B3');
        expect(transformMove(before, move('Sheet1!A1:B3', 'Sheet1!D7'), 's1', 2, 1).tree).not.toBe(before);
        const relative = tree('=A1+SUM(A1:B2)', 'B3');
        expect(transformMove(relative, move('Sheet1!A1:B3', 'Sheet1!D7'), 's1', 2, 1).tree).toBe(relative);
    });
});

describe('what a move leaves alone', () => {
    test('a formula that reads nothing of the block or its landing place', () => {
        const before = tree('=A1+Sheet2!C9+SUM(C:C)+Rate', 'E9');
        expect(transformMove(before, move('Sheet1!G1:H5', 'Sheet2!A1'), 's1', 8, 4)).toEqual({
            tree: before,
            lossy: false,
            recompute: false,
        });
    });
    test('a reference off the grid at its host', () => {
        const copied = tree('=A1', 'B2');
        expect(shown(transformMove(copied, move('Sheet1!A1:B1', 'Sheet1!C5'), 's1', 0, 1).tree, 'D5')).toBe('=#REF!');
    });
});

test('a move and the move back give the stored text back, but for what was overwritten', () => {
    const pick = random(42);
    let kept = 0;
    for (let run = 0; run < 20000; run += 1) {
        const cell = () => `${pick(2) ? '$' : ''}${'ABCDEF'[pick(6)]}${pick(2) ? '$' : ''}${1 + pick(8)}`;
        const text = `=${cell()}+SUM(${cell()}:${cell()})`;
        const [row, column] = [pick(8), pick(6)];
        const source = { row: pick(5), column: pick(4), rows: 1 + pick(4), columns: 1 + pick(3) };
        const there: Move = { ...source, fromSheet: 's1', toSheet: 's1', toRow: pick(6), toColumn: pick(5) };
        const back: Move = {
            ...there,
            row: there.toRow,
            column: there.toColumn,
            toRow: there.row,
            toColumn: there.column,
        };
        const inside = (edit: Move, r: number, c: number) =>
            r >= edit.row && r < edit.row + edit.rows && c >= edit.column && c < edit.column + edit.columns;
        // A formula the block lands on is overwritten and has no afterwards.
        if (!inside(there, row, column) && inside(back, row, column)) continue;
        const carried = inside(there, row, column);
        const before = tree(text, toA1(row, column));
        const moved = transformMove(before, there, 's1', row, column);
        if (moved.lossy) continue;
        const [row2, column2] = carried
            ? [row + there.toRow - there.row, column + there.toColumn - there.column]
            : [row, column];
        const returned = transformMove(moved.tree, back, 's1', row2, column2);
        expect(`${text} ${printStored(returned.tree)}`).toBe(`${text} ${printStored(before)}`);
        kept += 1;
    }
    expect(kept).toBeGreaterThan(10000);
});
