import { describe, expect, test } from 'bun:test';
import { NUM, VALUE } from '../../index';
import { evaluate } from '../recalc/support';

// Excel batch 13, part 2b. A number a hair under a whole one is that whole one to these four, and to no other:
// MID's start, REPT's count and CHOOSE's index are cut as they stand.
describe('a count that is a hair under a whole number is that whole number', () => {
    test.each([
        ['=FACT(4.99999)', 24],
        ['=FACT(4.999999999)', 120],
        ['=FACT(4.99999999999999)', 120],
        ['=FACT(170.9999)', 7.257415615308004e306],
        ['=FACT(170.999999999999)', NUM],
        ['=FACT(-1)', NUM],
        ['=LEFT("abcdef",2.999999999999)', 'abc'],
        ['=LEFT("abcdef",2.99999999999999)', 'abc'],
        ['=LEFT("abcdef",2.9999)', 'ab'],
        ['=LEFT("abcdef",-0.9)', VALUE],
        ['=LEFT("abcdef")', 'a'],
        ['=LEFT("abcdef","2")', 'ab'],
        ['=INDEX({10,20,30},2.99999999999999)', 30],
        ['=INDEX({10,20,30},2.9999)', 20],
        ['=INDEX({10,20;30,40},1.99999999999999,1.99999999999999)', 40],
        ['=INDEX({10,20,30},-0.5)', VALUE],
        ['=ROUND(1.5,0.999999999999999)', 1.5],
        ['=ROUND(1.55,0.9)', 2],
        ['=ROUND(1.55,-0.9)', 2],
        ['=MID("abcdef",1.99999999999999,2)', 'ab'],
        ['=REPT("a",2.99999999999999)', 'aa'],
        ['=CHOOSE(2.99999999999999,"a","b","c")', 'b'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });
});
