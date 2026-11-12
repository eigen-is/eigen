import { describe, expect, test } from 'bun:test';
import type { LineEdit } from '../../text';
import { GONE, parseStored, printStored, toA1, transformLines } from '../../text';
import { at, treeStored } from '../text/support';
import { deleteColumns, deleteRows, insertColumns, insertRows, lineAfter, shown, tree } from './support';

type Outcome = { text: string; changed: boolean; lossy: boolean; recompute: boolean; resized: boolean; slid: boolean };

// A formula typed at `host` on `hostSheet`, taken through the edit and read back at the host's new place.
function after(text: string, host: string, edit: LineEdit, hostSheet = 's1'): Outcome {
    const before = tree(text, host);
    const [row, column] = at(host);
    const result = transformLines(before, edit, hostSheet, edit.rows ? row : column);
    const moved = hostSheet === edit.sheet ? lineAfter(edit, edit.rows ? row : column) : edit.rows ? row : column;
    expect(moved).not.toBe(GONE);
    const place = edit.rows ? toA1(moved, column) : toA1(row, moved);
    expect(result.tree === before).toBe(printStored(result.tree) === printStored(before));
    return {
        text: shown(result.tree, place),
        changed: result.tree !== before,
        lossy: result.lossy,
        recompute: result.recompute,
        resized: result.resized,
        slid: result.slid,
    };
}

const QUIET = { lossy: false, recompute: false, resized: false, slid: false };

describe('one row inserted at row 3 of Sheet1: what changes the stored form', () => {
    const edit = insertRows(3);
    test.each<[string, string, string, string, string, boolean]>([
        ['absolute, target at the line', '=$A$3', 'C1', 's1', '=$A$4', true],
        ['absolute, target past the line, host past it too', '=$A$5', 'C9', 's1', '=$A$6', true],
        ['absolute, target before the line, host past it', '=$A$2', 'C9', 's1', '=$A$2', false],
        ['absolute, target past the line, host on another sheet', '=Sheet1!$A$5', 'C1', 's2', '=Sheet1!$A$6', true],
        ['offset, both before the line', '=A1', 'C2', 's1', '=A1', false],
        ['offset, both past the line', '=A5', 'C7', 's1', '=A6', false],
        ['offset, host at the line and target past it', '=A5', 'C3', 's1', '=A6', false],
        ['offset, target past the line and host before', '=A5', 'C1', 's1', '=A6', true],
        ['offset, target before the line and host past', '=A1', 'C5', 's1', '=A1', true],
        ['offset, target right before the line and host at it', '=A2', 'C3', 's1', '=A2', true],
        ['offset to another sheet, host past the line', '=Sheet2!A5', 'C7', 's1', '=Sheet2!A5', true],
        ['offset to another sheet, host before the line', '=Sheet2!A5', 'C1', 's1', '=Sheet2!A5', false],
        ['offset from another sheet, target past the line', '=Sheet1!A5', 'C1', 's2', '=Sheet1!A6', true],
        ['offset from another sheet, target before the line', '=Sheet1!A2', 'C9', 's2', '=Sheet1!A2', false],
        ['its own sheet written, both past the line', '=Sheet1!A5', 'C7', 's1', '=Sheet1!A6', false],
        ['host and target both on other sheets', '=Sheet3!A5+A7+$A$9', 'C1', 's2', '=Sheet3!A5+A7+$A$9', false],
        ['the column axis, mixed', '=$A5+A$5', 'C1', 's1', '=$A6+A$6', true],
        ['a whole column', '=SUM(A:B)+SUM($A:$B)', 'C9', 's1', '=SUM(A:B)+SUM($A:$B)', false],
        ['a literal, a name and text', '=1+"A5"+Rate+TRUE', 'C9', 's1', '=1+"A5"+Rate+TRUE', false],
        ['a sheet that does not exist, host past the line', '=Later!A5', 'C7', 's1', '=Later!A5', true],
        ['a whole row past the line', '=SUM(5:6)', 'C1', 's1', '=SUM(6:7)', true],
    ])('%s', (_, text, host, hostSheet, expected, changed) => {
        expect(after(text, host, edit, hostSheet)).toMatchObject({ text: expected, changed });
    });
});

describe('one column inserted at C of Sheet1 mirrors the rows', () => {
    const edit = insertColumns('C');
    test.each<[string, string, string, string, string, boolean]>([
        ['absolute, target past the line', '=$E$1', 'A9', 's1', '=$F$1', true],
        ['offset, both past the line', '=E1', 'G9', 's1', '=F1', false],
        ['offset, target before the line and host past', '=A1', 'G9', 's1', '=A1', true],
        ['offset to another sheet, host past the line', '=Sheet2!E1', 'G9', 's1', '=Sheet2!E1', true],
        ['offset from another sheet, target past the line', '=Sheet1!E1', 'A9', 's2', '=Sheet1!F1', true],
        ['the row axis, mixed', '=$E1+E$1', 'A9', 's1', '=$F1+F$1', true],
        ['a whole row', '=SUM(1:2)', 'G9', 's1', '=SUM(1:2)', false],
        ['a whole column past the line', '=SUM(E:F)', 'A9', 's1', '=SUM(F:G)', true],
    ])('%s', (_, text, host, hostSheet, expected, changed) => {
        expect(after(text, host, edit, hostSheet)).toMatchObject({ text: expected, changed });
    });
});

describe('a target in a deleted band', () => {
    test('a single reference becomes #REF! in place and is lossy', () => {
        expect(after('=SUM(B2,C2,D2)', 'E2', deleteColumns('C'))).toEqual({
            text: '=SUM(B2,#REF!,C2)',
            changed: true,
            lossy: true,
            recompute: true,
            resized: false,
            slid: false,
        });
    });
    test('it keeps its sheet and its whitespace', () => {
        expect(after('=1+ Sheet2!A1', 'A1', deleteRows(1, 1, 's2')).text).toBe('=1+ Sheet2!#REF!');
        expect(after('=Sheet1!A2', 'A1', deleteRows(2, 3)).text).toBe('=Sheet1!#REF!');
    });
    test('whatever its $ and wherever the host is', () => {
        for (const text of ['=A5', '=$A5', '=A$5', '=$A$5']) {
            expect(after(text, 'C1', deleteRows(5)).text).toBe('=#REF!');
            expect(after(text, 'C9', deleteRows(4, 6)).text).toBe('=#REF!');
            expect(after(`=Sheet1!${text.slice(1)}`, 'C9', deleteRows(5), 's2').text).toBe('=Sheet1!#REF!');
        }
    });
    test('a range inside the band is #REF! as a whole', () => {
        expect(after('=SUM(A2:A3)', 'A1', deleteRows(2, 3))).toMatchObject({ text: '=SUM(#REF!)', lossy: true });
        expect(after('=SUM(A:A)', 'C1', deleteColumns('A'))).toMatchObject({ text: '=SUM(#REF!)', lossy: true });
    });
    test('a range end in the band moves to the nearest row left, which is lossy and a seed', () => {
        const clamped = { changed: true, lossy: true, recompute: true, resized: true, slid: false };
        expect(after('=SUM(A3:A6)', 'B1', deleteRows(2, 4))).toEqual({ text: '=SUM(A2:A3)', ...clamped });
        expect(after('=SUM(A2:A5)', 'B1', deleteRows(4, 6))).toEqual({ text: '=SUM(A2:A3)', ...clamped });
        expect(after('=SUM($A$3:$B$10)', 'C5', deleteColumns('B'))).toEqual({ text: '=SUM($A$3:$A$10)', ...clamped });
    });
    test('a range typed with its corners out of order clamps the same', () => {
        expect(after('=SUM(A6:A3)', 'B1', deleteRows(2, 4)).text).toBe('=SUM(A2:A3)');
        expect(after('=SUM(A$6:A3)', 'B1', deleteRows(2, 4)).text).toBe('=SUM(A2:A$3)');
        expect(after('=SUM(A$6:A3)', 'B1', deleteRows(6, 8)).text).toBe('=SUM(A3:A$5)');
    });
});

describe('the three flags', () => {
    const GREW = { lossy: false, recompute: false, resized: true, slid: false };
    const SHRANK = { lossy: false, recompute: true, resized: true, slid: false };
    test('a range that gained an empty row is resized, and neither lossy nor a seed by itself', () => {
        expect(after('=SUM(A1:A10)', 'A11', insertRows(5))).toEqual({ text: '=SUM(A1:A11)', changed: true, ...GREW });
    });
    test.each([
        ['=ROWS(A1:A10)', 'C1', 's1', '=ROWS(A1:A11)', true],
        ['=MATCH(5,A1:A10,0)', 'C1', 's1', '=MATCH(5,A1:A11,0)', true],
        ['=INDEX(Sheet1!$A$1:$A$10,7)', 'C1', 's2', '=INDEX(Sheet1!$A$1:$A$11,7)', true],
        ['=COUNTBLANK(A$1:A9)', 'B10', 's1', '=COUNTBLANK(A$1:A10)', false],
    ])(
        '%s reads a longer range after a row is inserted in it, whatever its tree does',
        (text, host, sheet, to, changed) => {
            expect(after(text, host, insertRows(5), sheet)).toEqual({ text: to, changed, ...GREW });
        },
    );
    test('a running total filled down is resized where the row lands in its range, and a seed only for a lost row', () => {
        const filled = tree('=SUM(A$1:A9)', 'B9');
        const outcomes = (edit: LineEdit) =>
            [4, 5, 6, 7].map((host) => {
                const { tree: mapped, lossy, recompute, resized } = transformLines(filled, edit, 's1', host);
                const flags = [lossy && 'lossy', recompute && 'seed', resized && 'resized'].filter(Boolean);
                return [mapped === filled ? 'same' : 'changed', ...flags].join(' ');
            });
        expect(outcomes(insertRows(1))).toEqual(['changed', 'changed', 'changed', 'changed']);
        expect(outcomes(insertRows(7))).toEqual(['same', 'same', 'same resized', 'same resized']);
        expect(outcomes(insertRows(9))).toEqual(['same', 'same', 'same', 'same']);
        expect(outcomes(deleteRows(3))).toEqual(Array.from({ length: 4 }, () => 'same seed resized'));
        expect(outcomes(deleteRows(1))).toEqual(Array.from({ length: 4 }, () => 'same lossy seed resized'));
    });
    test('a reference that only moved is none of the three', () => {
        expect(after('=A5+$A$5', 'C1', insertRows(2))).toEqual({ text: '=A6+$A$6', changed: true, ...QUIET });
        expect(after('=A5', 'C1', deleteRows(2))).toEqual({ text: '=A4', changed: true, ...QUIET });
        expect(after('=SUM(A5:B9)', 'C1', deleteRows(2))).toEqual({ text: '=SUM(A4:B8)', changed: true, ...QUIET });
        expect(after('=SUM(B5:C9)', 'A1', insertColumns('B'))).toEqual({
            text: '=SUM(C5:D9)',
            changed: true,
            ...QUIET,
        });
    });
    test('a range that lost rows from its middle is a seed that an insert restores', () => {
        expect(after('=SUM(B2:C5)', 'A7', deleteRows(3))).toEqual({ text: '=SUM(B2:C4)', changed: true, ...SHRANK });
    });
    test('a range with an end on the last row that loses a row off the grid keeps its size', () => {
        expect(after('=B2:B1048576', 'A3', insertRows(5))).toEqual({
            text: '=B2:B1048576',
            changed: false,
            lossy: true,
            recompute: true,
            resized: false,
            slid: false,
        });
    });
    test('rows shifting inside a whole column say so with the same tree, and are a seed only by what the store holds', () => {
        const seed = { changed: false, lossy: false, recompute: false, resized: false, slid: true };
        expect(after('=SUM(A:A)', 'C1', insertRows(9))).toEqual({ text: '=SUM(A:A)', ...seed });
        expect(after('=SUM(A:A)', 'C1', deleteRows(9))).toEqual({ text: '=SUM(A:A)', ...seed });
        expect(after('=SUM(Sheet1!A:A)', 'C1', insertRows(9), 's2')).toEqual({ text: '=SUM(Sheet1!A:A)', ...seed });
        expect(after('=SUM(3:4)', 'C9', insertColumns('B'))).toEqual({ text: '=SUM(3:4)', ...seed });
    });
    test('a whole column of another sheet is no seed', () => {
        expect(after('=SUM(Sheet2!A:A)', 'C1', insertRows(9))).toMatchObject(QUIET);
        expect(after('=SUM(A:A)', 'C1', insertRows(9), 's2')).toMatchObject(QUIET);
    });
    test('whole columns that gain a column are resized', () => {
        expect(after('=SUM(A:C)', 'E1', insertColumns('B'))).toEqual({ text: '=SUM(A:D)', changed: true, ...GREW });
    });
    test('a reference pushed off the last row is lossy', () => {
        expect(after('=A1048576', 'A1', insertRows(1))).toEqual({
            text: '=#REF!',
            changed: true,
            lossy: true,
            recompute: true,
            resized: false,
            slid: false,
        });
        expect(after('=B1048575:C1048575', 'A19', insertRows(5, 2)).text).toBe('=#REF!');
    });
    test('a range end pushed off the last row stops there, lossy and a seed', () => {
        expect(after('=B2:B1048575', 'A3', insertRows(5, 2))).toEqual({
            text: '=B2:B1048576',
            changed: true,
            lossy: true,
            recompute: true,
            resized: true,
            slid: false,
        });
        expect(after('=B2:B1048576', 'A3', insertRows(1048576)).text).toBe('=B2:B1048576');
    });
});

describe('what the transform leaves alone', () => {
    test('a reference off the grid at its host stays off the grid when the host moves', () => {
        const copied = tree('=A1+SUM(A1:A3)', 'B2');
        const result = transformLines(copied, insertRows(1, 3), 's1', 0);
        expect(shown(copied, 'B1')).toBe('=#REF!+SUM(#REF!)');
        expect(shown(result.tree, 'B4')).toBe('=#REF!+SUM(#REF!)');
        expect(result).toMatchObject(QUIET);
    });
    test('a broken reference, which is no reference to the cell the formula is in', () => {
        const before = treeStored('=#REF!+[s2]!#REF!+SUM(#REF!)+SUM(#REF!:#REF!)+[s1]!#REF!:[s1]!Rate+#REF!#');
        for (const edit of [insertRows(1), deleteRows(1), insertRows(1, 1, 's2'), deleteColumns('A')]) {
            expect(transformLines(before, edit, 's1', 0)).toEqual({ tree: before, ...QUIET });
        }
    });
    test('a broken end of a range, whose other end moves alone', () => {
        const before = treeStored('=SUM(#REF!:R5C1)+SUM([s1]!#REF!:[s1]!R[4]C)');
        const result = transformLines(before, insertRows(1), 's2', 0);
        expect(printStored(result.tree)).toBe('=SUM(#REF!:R5C1)+SUM([s1]!#REF!:[s1]!R[5]C)');
        expect(result.tree.children[1].children[0].children[0]).toBe(before.children[1].children[0].children[0]);
    });
    test('a sum of thousands of terms, which is a tree that deep', () => {
        const before = treeStored(`=${'R[4]C+'.repeat(21000)}R1C1`);
        const result = transformLines(before, insertRows(3), 's1', 0);
        expect(printStored(result.tree)).toBe(`=${'R[5]C+'.repeat(21000)}R1C1`);
        expect(transformLines(before, insertRows(3), 's2', 0).tree).toBe(before);
    });
    test('every part of the formula around its references', () => {
        const text = '= IF( A5>0, {1,2;3,4}, -A5% ) & "x" & LAMBDA(x,x+A5)(2)';
        expect(after(text, 'C1', insertRows(2)).text).toBe(text.replaceAll('A5', 'A6'));
    });
    test('an edit of a sheet the formula does not touch returns the same tree', () => {
        const before = tree('=A5+Sheet2!A5', 'C7');
        expect(transformLines(before, insertRows(1, 1, 's3'), 's1', 6).tree).toBe(before);
    });
});

describe('what comes out is stored text that reads back as the same tree', () => {
    const reread = (text: string): [string, string] => {
        const stored = printStored(transformLines(tree(text, 'D1'), deleteRows(5), 's1', 0).tree);
        const back = parseStored(stored);
        return [stored, 'reason' in back ? back.reason : printStored(back)];
    };
    test.each([
        ['=A5', '=#REF!'],
        ['=SUM(A5,Sheet1!A5)', '=SUM(#REF!,[s1]!#REF!)'],
        ['=-A5%+@A5', '=-#REF!%+@#REF!'],
        ['=(A5,B5)', '=(#REF!,#REF!)'],
        ['=A5:B5:C7', '=#REF!:R[5]C[-1]'],
        ['=SUM(A3:A$5)+A$9', '=SUM(R[2]C[-3]:R4C[-3])+R8C[-3]'],
        ['=A5#', '=#REF!#'],
        ['=A1:B2 A5', '=RC[-3]:R[1]C[-2] #REF!'],
        ['=SUM(A5:A5 A1)', '=SUM(#REF! RC[-3])'],
    ])('%s', (text, stored) => {
        expect(reread(text)).toEqual([stored, stored]);
    });
});
