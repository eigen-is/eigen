import { describe, expect, test } from 'bun:test';
import type { Move } from '../../text';
import { GRID_ROWS, parseA1, printA1, printStored, sheetFinder, toA1, transformMove } from '../../text';
import { at, treeStored } from '../text/support';
import { CONTEXTS, random, reread, SHEETS, sheetName, shown, tree } from './support';

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
    const carried =
        sheet === edit.fromSheet &&
        row >= edit.row &&
        row < edit.row + edit.rows &&
        column >= edit.column &&
        column < edit.column + edit.columns;
    const place = carried ? toA1(row + edit.toRow - edit.row, column + edit.toColumn - edit.column) : toA1(row, column);
    const name = SHEETS.find((candidate) => candidate.id === (carried ? edit.toSheet : sheet))?.name;
    return `${name}!${place} ${shown(result.tree, place)}${result.lossy ? ' lossy' : ''}${result.recompute ? ' seed' : ''}`;
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
    test('to another sheet, whose name it gains: lossy, since the move back cannot tell it was not typed', () => {
        expect(after('=A1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet2!B1')).toBe('Sheet1!A2 =Sheet2!B1 lossy');
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

describe('an operand of the : operator that gains a sheet is stored as text that reads back', () => {
    const moved = (text: string, from: string, to: string) => {
        const before = tree(text, 'D1');
        const result = transformMove(before, move(from, to), 's1', 0, 3);
        const a1 = printA1(result.tree, 0, 3, sheetName);
        const back = parseA1(a1, 0, 3, sheetFinder(SHEETS));
        expect('reason' in back ? back.reason : printStored(back)).toBe(printStored(result.tree));
        expect(reread(result.tree)).toEqual(result.tree);
        return a1;
    };
    test('the formula moves to another sheet and names the one it left, behind a call and behind a range', () => {
        expect(moved('=SUM(INDEX(A1:A5,1):B2)', 'Sheet1!D1', 'Sheet2!D1')).toBe(
            '=SUM(INDEX(Sheet1!A1:A5,1):Sheet1!B2)',
        );
        expect(moved('=SUM(A1:A2:B2)', 'Sheet1!D1', 'Sheet2!D1')).toBe('=SUM(Sheet1!A1:A2:Sheet1!B2)');
        expect(moved('=SUM((A1):B2)', 'Sheet1!D1', 'Sheet2!D1')).toBe('=SUM((Sheet1!A1):Sheet1!B2)');
    });
    test('one operand moves to another sheet and the other stays', () => {
        expect(moved('=SUM(A1:A2:B2)', 'Sheet1!B2', 'Sheet2!B2')).toBe('=SUM(A1:A2:Sheet2!B2)');
        expect(moved('=SUM(INDEX(A1:A5,1):B2)', 'Sheet1!B2', 'Sheet2!C3')).toBe('=SUM(INDEX(A1:A5,1):Sheet2!C3)');
        expect(moved('=SUM(A1 :B2)', 'Sheet1!B2', 'Sheet2!B2')).toBe('=SUM(A1 :Sheet2!B2)');
        expect(moved('=SUM(A1: B2)', 'Sheet1!A1', 'Sheet3!A1')).toBe('=SUM(Sheet3!A1: B2)');
        expect(moved('=SUM(A1:B:C)', 'Sheet1!B1:C1048576', 'Sheet2!B1')).toBe('=SUM(A1:Sheet2!B:C)');
    });
});

describe('a range follows only when all of it is in the block', () => {
    test('all of it', () => {
        expect(after('=SUM(A1:A2)', 'Sheet1!A3', 'Sheet1!A1:A2', 'Sheet1!B1')).toBe('Sheet1!A3 =SUM(B1:B2)');
        expect(after('=SUM(A2:A$1)', 'Sheet1!A3', 'Sheet1!A1:B2', 'Sheet2!C5')).toBe(
            'Sheet1!A3 =SUM(Sheet2!C$5:C6) lossy',
        );
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
        expect(after('=SUM(1:1)', 'Sheet1!E5', 'Sheet1!A1:XFD1', 'Sheet2!A3')).toBe('Sheet1!E5 =SUM(Sheet2!3:3) lossy');
    });
});

describe('a reference to a cell the block landed on', () => {
    test('becomes #REF! and is lossy', () => {
        expect(after('=B1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet1!B1')).toBe('Sheet1!A2 =#REF! lossy seed');
        expect(after('=1+ Sheet2!$B$1', 'Sheet1!A2', 'Sheet1!A1', 'Sheet2!B1')).toBe(
            'Sheet1!A2 =1+ Sheet2!#REF! lossy seed',
        );
    });
    test('as does a range that is covered whole, and no other', () => {
        expect(after('=SUM(B1:B2)', 'Sheet1!D1', 'Sheet1!A1:A3', 'Sheet1!B1')).toBe('Sheet1!D1 =SUM(#REF!) lossy seed');
        expect(after('=SUM(B1:B4)', 'Sheet1!D1', 'Sheet1!A1:A3', 'Sheet1!B1')).toBe('Sheet1!D1 =SUM(B1:B4)');
    });
    test('as does a range the block covers whole where it lands on its own cells, though two of its cells moved', () => {
        expect(after('=SUM(D5:E6)', 'Sheet1!H1', 'Sheet1!C3:E5', 'Sheet1!C4')).toBe('Sheet1!H1 =SUM(#REF!) lossy seed');
    });
    test('but a cell of the block that only moves within it follows', () => {
        expect(after('=A2+A3', 'Sheet1!C1', 'Sheet1!A1:A2', 'Sheet1!A2')).toBe('Sheet1!C1 =A3+#REF! lossy seed');
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
    test('to another sheet, where it names the sheet it left, which is lossy as well', () => {
        expect(after('=A1*2', 'Sheet1!C1', 'Sheet1!C1', 'Sheet2!C1')).toBe('Sheet2!C1 =Sheet1!A1*2 lossy');
        expect(after('=SUM(Sheet3!A1:A3,B1)', 'Sheet1!C1', 'Sheet1!C1', 'Sheet2!E5')).toBe(
            'Sheet2!E5 =SUM(Sheet3!A1:A3,Sheet1!B1) lossy',
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
    test('a broken reference, though the formula itself moves or is landed beside', () => {
        const before = treeStored('=#REF!+[s2]!#REF!+SUM(#REF!)+SUM(#REF!:#REF!)+[s1]!#REF!:[s1]!Rate+#REF!#');
        for (const edit of [
            move('Sheet1!A1:B2', 'Sheet2!A1'),
            move('Sheet2!A1', 'Sheet1!C1'),
            move('Sheet2!C3', 'Sheet2!A1'),
        ]) {
            expect(transformMove(before, edit, 's1', 0, 0)).toMatchObject({ tree: before, lossy: false });
        }
    });
    test('a broken end of a range, whose other end follows the block alone', () => {
        const before = treeStored('=SUM(#REF!:R5C1)+SUM([s2]!#REF!:[s2]!R[4]C)');
        const result = transformMove(before, move('Sheet2!A1:A5', 'Sheet2!A9'), 's1', 0, 0);
        expect(printStored(result.tree)).toBe('=SUM(#REF!:R5C1)+SUM([s2]!#REF!:[s2]!R[12]C)');
        expect(result.tree.children[1].children[0].children[0]).toBe(before.children[1].children[0].children[0]);
    });
    test('a sum of thousands of terms, which is a tree that deep', () => {
        const before = treeStored(`=${'R[4]C+'.repeat(21000)}R1C1`);
        const result = transformMove(before, move('Sheet1!A5', 'Sheet1!A9'), 's1', 0, 0);
        expect(printStored(result.tree)).toBe(`=${'R[8]C+'.repeat(21000)}R1C1`);
    });
    test('a reference off the grid at its host', () => {
        const copied = tree('=A1', 'B2');
        expect(shown(transformMove(copied, move('Sheet1!A1:B1', 'Sheet1!C5'), 's1', 0, 1).tree, 'D5')).toBe('=#REF!');
    });
});

describe('a move and the move back', () => {
    const inside = (edit: Move, sheet: string, row: number, column: number, landed: boolean) =>
        sheet === (landed ? edit.toSheet : edit.fromSheet) &&
        row >= (landed ? edit.toRow : edit.row) &&
        row < (landed ? edit.toRow : edit.row) + edit.rows &&
        column >= (landed ? edit.toColumn : edit.column) &&
        column < (landed ? edit.toColumn : edit.column) + edit.columns;

    test('give every formula that is not lossy its stored text back, on one sheet and across two', () => {
        const pick = random(42);
        const kept = { broken: 0, same: 0, across: 0, carried: 0, followed: 0 };
        for (let run = 0; run < 40000; run += 1) {
            const cell = () => `${pick(2) ? '$' : ''}${'ABCDEF'[pick(6)]}${pick(2) ? '$' : ''}${1 + pick(8)}`;
            const prefix = () => ['', '', 'Sheet1!', 'Sheet2!', 'Sheet3!', 'Later!'][pick(6)];
            const range = `${prefix()}${cell()}:${cell()}`;
            const text = CONTEXTS[pick(CONTEXTS.length)](`${prefix()}${cell()}`, range, `${prefix()}${cell()}`);
            const [sheet, row, column] = [['s1', 's2'][pick(2)], pick(8), pick(6)];
            const there: Move = {
                fromSheet: ['s1', 's2'][pick(2)],
                row: pick(5),
                column: pick(4),
                rows: 1 + pick(4),
                columns: 1 + pick(3),
                toSheet: ['s1', 's2'][pick(2)],
                toRow: pick(6),
                toColumn: pick(5),
            };
            const back: Move = {
                ...there,
                fromSheet: there.toSheet,
                row: there.toRow,
                column: there.toColumn,
                toSheet: there.fromSheet,
                toRow: there.row,
                toColumn: there.column,
            };
            const carried = inside(there, sheet, row, column, false);
            // A formula the block lands on is overwritten and has no afterwards.
            if (!carried && inside(there, sheet, row, column, true)) continue;
            const before = tree(text, toA1(row, column));
            const moved = transformMove(before, there, sheet, row, column);
            const where = `${text} on ${sheet} at ${toA1(row, column)}, ${JSON.stringify(there)}`;
            expect([where, reread(moved.tree)]).toEqual([where, moved.tree]);
            if (printStored(moved.tree).includes('#REF!')) kept.broken += 1;
            if (moved.lossy) continue;
            const [sheet2, row2, column2] = carried
                ? [there.toSheet, row + there.toRow - there.row, column + there.toColumn - there.column]
                : [sheet, row, column];
            const returned = transformMove(moved.tree, back, sheet2, row2, column2);
            expect(`${where}: ${printStored(returned.tree)}`).toBe(`${where}: ${printStored(before)}`);
            if (there.fromSheet === there.toSheet) kept.same += 1;
            else if (carried) kept.carried += 1;
            else if (moved.tree !== before) kept.followed += 1;
            else kept.across += 1;
        }
        expect(kept.broken).toBeGreaterThan(1500);
        expect(kept.same).toBeGreaterThan(10000);
        expect(kept.across).toBeGreaterThan(5000);
        expect(kept.carried).toBeGreaterThan(100);
        expect(kept.followed).toBeGreaterThan(100);
    });

    // Accepted: undo restores the old text from its entry, and a move by hand there and back leaves a sheet name
    // that reads the same cell.
    test('leave a sheet name where a target or a host went to another sheet and came back', () => {
        const target = move('Sheet1!A1', 'Sheet2!B1');
        const there = transformMove(tree('=A1', 'A2'), target, 's1', 1, 0);
        expect([shown(there.tree, 'A2'), there.lossy, there.recompute]).toEqual(['=Sheet2!B1', true, false]);
        const back = transformMove(there.tree, move('Sheet2!B1', 'Sheet1!A1'), 's1', 1, 0);
        expect([shown(back.tree, 'A2'), back.lossy, back.recompute]).toEqual(['=Sheet1!A1', false, false]);

        const host = move('Sheet1!C1', 'Sheet2!C1');
        const away = transformMove(tree('=A1*2', 'C1'), host, 's1', 0, 2);
        expect([shown(away.tree, 'C1'), away.lossy, away.recompute]).toEqual(['=Sheet1!A1*2', true, false]);
        const home = transformMove(away.tree, move('Sheet2!C1', 'Sheet1!C1'), 's2', 0, 2);
        expect([shown(home.tree, 'C1'), home.lossy, home.recompute]).toEqual(['=Sheet1!A1*2', false, false]);
    });
});
