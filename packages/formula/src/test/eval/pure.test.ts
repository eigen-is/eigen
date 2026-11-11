import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { NAME } from '../../index';
import { engineOf, valueAt } from '../recalc/support';

// One call of every function, on A1:A3 = 1, 2, 3 and B1:B3 = x, y, x.
const SAMPLES: Readonly<Record<string, string>> = {
    ISBLANK: '=ISBLANK($A$9)',
    ISERROR: '=ISERROR(1/0)',
    ISNUMBER: '=ISNUMBER($A$1)',
    ISTEXT: '=ISTEXT($B$1)',
    NA: '=NA()',
    AND: '=AND($A$1:$A$3)',
    OR: '=OR($A$1:$A$3=5)',
    NOT: '=NOT($A$1)',
    IF: '=SUM(IF($B$1:$B$3="x",$A$1:$A$3))',
    IFERROR: '=IFERROR(1/0,$A$2)',
    IFNA: '=IFNA(NA(),$A$3)',
    TRUE: '=TRUE()',
    FALSE: '=FALSE()',
    ROW: '=SUM(ROW($A$1:$A$3))',
    COLUMN: '=SUM(COLUMN($A$1:$B$3))',
    INDEX: '=INDEX($A$1:$B$3,2,2)',
    MATCH: '=MATCH("y",$B$1:$B$3,0)',
    XMATCH: '=XMATCH("x",$B$1:$B$3,0,-1)',
    VLOOKUP: '=VLOOKUP(2,$A$1:$B$3,2,FALSE)',
    HLOOKUP: '=HLOOKUP(1,$A$1:$B$3,3)',
    LOOKUP: '=LOOKUP(2.5,$A$1:$A$3,$B$1:$B$3)',
    XLOOKUP: '=XLOOKUP("y",$B$1:$B$3,$A$1:$A$3)',
    ABS: '=SUM(ABS(-$A$1:$A$3))',
    ROUND: '=ROUND(2.675,2)',
    SUM: '=SUM(($B:$B="")*0.1)',
    SUMPRODUCT: '=SUMPRODUCT($A:$A,--($B:$B="x"))',
    SUMIF: '=SUMIF($B$1:$B$3,"x",$A$1:$A$3)',
    SUMIFS: '=SUMIFS($A$1:$A$3,$B$1:$B$3,"x")',
    AVERAGE: '=AVERAGE($A:$A*0.1)',
    MAX: '=MAX($A:$A*2)',
    MIN: '=MIN($A:$A-1)',
    COUNT: '=COUNT($A:$B)',
    COUNTA: '=COUNTA($A:$B&"")',
    COUNTBLANK: '=COUNTBLANK($A$1:$B$9)',
    COUNTIF: '=COUNTIF($B$1:$B$3,"x")',
    COUNTIFS: '=COUNTIFS($B$1:$B$3,"x",$A$1:$A$3,">1")',
    AVERAGEIF: '=AVERAGEIF($B$1:$B$3,"x",$A$1:$A$3)',
    AVERAGEIFS: '=AVERAGEIFS($A$1:$A$3,$B$1:$B$3,"x")',
    MAXIFS: '=MAXIFS($A$1:$A$3,$B$1:$B$3,"x")',
    MINIFS: '=MINIFS($A$1:$A$3,$B$1:$B$3,"x")',
    CONCATENATE: '=CONCATENATE($B$1,$A$1)',
    LEFT: '=LEFT($B$1&"abc",2)',
    MID: '=MID("abcdef",$A$2,$A$3)',
    REPLACE: '=REPLACE("abcdef",$A$2,$A$1,$B$2)',
    LEN: '=SUM(LEN($B:$B))',
    UPPER: '=UPPER($B$2)',
};

describe('a function answers the same for the same arguments, which is what lets one call stand for a run', () => {
    test.each([...FUNCTIONS.values()].map((entry) => entry.name))('%s', (name) => {
        const formula = SAMPLES[name];
        expect(formula).toBeDefined();
        const cells = { A1: 1, A2: 2, A3: 3, B1: 'x', B2: 'y', B3: 'x' };
        const engine = engineOf({ s1: { ...cells, N1: formula, N2: formula, N3: formula } });
        engine.recalc(Number.POSITIVE_INFINITY);
        const first = valueAt(engine, 'N1');
        expect(first).not.toBe(NAME);
        expect(valueAt(engine, 'N2')).toBe(first);
        expect(valueAt(engine, 'N3')).toBe(first);
    });
});
