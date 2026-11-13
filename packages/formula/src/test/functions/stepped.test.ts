import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { fn } from '../../functions/registry';
import { DIV0, NA, REF, VALUE } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import { evaluate, stored } from '../recalc/support';
import { F1 } from './collectors.test';

// The elements of a formula that answers one row.
function across(formula: string, count: number) {
    return Array.from({ length: count }, (_, at) => evaluate(`=INDEX(${formula.slice(1)},1,${at + 1})`, F1));
}

describe('a row whose arguments come in groups tries them in turn and stops at the first that decides', () => {
    test.each([
        // Excel batch 4: the first match ends the call, and an error is the result only when its group is reached.
        ['=IFS(TRUE,1,1/0,2)', 1],
        ['=IFS(1/0,1,TRUE,2)', DIV0],
        ['=IFS(FALSE,1,TRUE,2)', 2],
        ['=IFS(FALSE,1)', NA],
        ['=IFS("x",1)', VALUE],
        ['=SWITCH(1,1,"a",1/0,"b")', 'a'],
        ['=SWITCH(1,NA(),2,1,3)', NA],
        ['=SWITCH(1/0,1,2)', DIV0],
        ['=SWITCH(2,1,"a",2,"b")', 'b'],
        ['=SWITCH(3,1,"a","z")', 'z'],
        ['=SWITCH(3,1,"a")', NA],
        ['=SWITCH(3,1,"a",2,"b",1/0)', DIV0],
        ['=SWITCH(1,1,"a",1/0)', 'a'],
        // The count: whole groups, and one argument more only where the row takes one after them.
        ['=IFS()', VALUE],
        ['=IFS(TRUE)', VALUE],
        ['=IFS(TRUE,1,FALSE)', VALUE],
        ['=SWITCH(1,2)', VALUE],
        // Batch 5: an empty argument that is picked is the number 0 here, where IF gives a blank.
        ['=SWITCH(1,2,"a",)&"x"', '0x'],
        ['=IFS(TRUE,)&"x"', '0x'],
        ['=ISBLANK(SWITCH(1,2,"a",))', false],
        ['=ISBLANK(IFS(TRUE,Z9))', true],
        // A picked reference stays a reference.
        ['=COUNT(IFS(TRUE,C1:C4))', 3],
        ['=SUM(IFS(FALSE,1,TRUE,D1))', 0],
        ['=SUM(SWITCH(2,1,B1,2,A1:A3))', 60],
        // Batch 5: an early match hides a later array, so the answer is one value.
        ['=INDEX(IFS(TRUE,1,{TRUE,FALSE},2),1,2)', REF],
        ['=INDEX(SWITCH(1,1,"a",{1,2},"b"),1,2)', REF],
        ['=INDEX(IFS(FALSE,1,{TRUE,FALSE},2),1,2)', NA],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });

    test.each([
        // Batch 5, check 5: each element goes on only while no group decided it, and a branch that no element
        // picked is never evaluated.
        ['=IFS({FALSE,TRUE},1,TRUE,2)', [2, 1]],
        ['=IFS({TRUE,FALSE},1,TRUE,2)', [1, 2]],
        ['=IFS({FALSE,FALSE},1,TRUE,1/0)', [DIV0, DIV0]],
        ['=IFS({TRUE,TRUE},1,TRUE,1/0)', [1, 1]],
        ['=SWITCH({1,2,3},1,"a",2,"b","z")', ['a', 'b', 'z']],
        ['=SWITCH({1,2},1,"a",2,1/0)', ['a', DIV0]],
        ['=SWITCH({1,1},1,"a",2,1/0)', ['a', 'a']],
        ['=SWITCH({1,2,3},1,"a",2,"b")', ['a', 'b', NA]],
        ['=SWITCH({1,"x",3},1/0,"a",3,"b")', [DIV0, DIV0, DIV0]],
        ['=SWITCH({1,2},1,"a",NA(),"b")', ['a', NA]],
        // A picked argument that is an array lines up with the elements that picked it.
        ['=IFS({TRUE,FALSE},{1,2},TRUE,{10,20})', [1, 20]],
        // A test that is an array of another length leaves #N/A past its end, in an element still undecided.
        ['=IFS({TRUE,FALSE,TRUE},1,{TRUE,TRUE},2)', [1, 2, 1]],
        ['=IFS({FALSE,FALSE,FALSE},1,{TRUE,TRUE},2)', [2, 2, NA]],
        ['=IFS(FALSE,1,{TRUE,FALSE},2)', [2, NA]],
        ['=IFS({FALSE,"x",TRUE},1,TRUE,2)', [2, VALUE, 1]],
    ])('%s', (formula, expected) => {
        expect(across(formula, expected.length)).toEqual(expected);
    });
});

// No function of this build can tell whether it was called, so this test hands the recalc a row that counts.
test('a group that no element reaches is never evaluated, and a picked argument once', () => {
    let calls = 0;
    const functions = new Map(FUNCTIONS);
    functions.set(
        'CALLED',
        fn('CALLED', [], () => {
            calls += 1;
            return calls;
        }),
    );
    const run = (formula: string) => {
        calls = 0;
        const text = stored(formula, 'A1');
        const workbook = new Workbook([{ id: 's1', name: 'Sheet1', cells: (cell) => cell(0, 0, null, text) }]);
        new Recalc(workbook, functions).pass(Number.POSITIVE_INFINITY);
        return calls;
    };
    expect(run('=IFS(TRUE,1,CALLED()>0,2)')).toBe(0);
    expect(run('=SWITCH(1,1,"a",CALLED(),"b",CALLED())')).toBe(0);
    expect(run('=SWITCH(2,1,CALLED(),2,"b",CALLED())')).toBe(0);
    expect(run('=SUM(IFS({TRUE,TRUE,FALSE},CALLED(),TRUE,5))')).toBe(1);
    expect(run('=SUM(SWITCH({1,2,3},CALLED(),"a",9,"b",0))')).toBe(1);
});
