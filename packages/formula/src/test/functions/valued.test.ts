import { describe, expect, test } from 'bun:test';
import { DIV0, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// The fixture of Excel batch 9: A1:A2 = 1.5, -2.5, B1 blank, B2 the text 3, B4 =1/0, B7 =NA(), C1:C3 = 2, 4, 6.
const F9: Cells = { A1: 1.5, A2: -2.5, A3: 0, B2: '3', B4: '=1/0', B7: '=NA()', C1: 2, C2: 4, C3: 6 };

describe('IFERROR and IFNA answer a value, where IF and CHOOSE hand a reference through', () => {
    test.each([
        ['=ISREF(IFERROR(B4,B1))', false],
        ['=ISREF(IFERROR(B4,A1:A2))', false],
        ['=ISREF(IFNA(B7,B1))', false],
        ['=SUM(IFERROR(B4,B2))', 3],
        ['=SUM(IFNA(B7,B2))', 3],
        ['=SUM(IFERROR(B4,A1:A2))', -1],
        ['=SUM(IFERROR(B4,(A1:A2,C1:C2)))', VALUE],
        ['=IFERROR(B4,B2)', '3'],
        ['=IFERROR(B4,B1)', 0],
        ['=IFERROR(B4,B4)', DIV0],
        ['=INDEX(IFERROR(B4,C1:C3),3,1)', 6],
        ['=ISREF(IF(TRUE,B4,2))', true],
        ['=SUM(IF(TRUE,B2,2))', 0],
        ['=ISREF(CHOOSE(1,B2,A1))', true],
        ['=ISREF(IFS(TRUE,B2))', true],
        ['=ISREF(SWITCH(1,1,B2))', true],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });
});
