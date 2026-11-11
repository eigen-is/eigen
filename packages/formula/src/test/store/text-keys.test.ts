import { describe, expect, test } from 'bun:test';
import { NA } from '../../index';
import { at, engineOf, stored, valueAt } from '../recalc/support';

describe('the comparison form of a text', () => {
    test('texts that differ by case are equal, whenever each was written and whenever it was first compared', () => {
        const engine = engineOf({ s1: { A1: 'straße', A2: 'x', A3: '=A2&"y"', A4: '' } });
        let next = 1;
        const ask = (formula: string) => {
            const label = `D${next}`;
            next += 1;
            engine.setFormula('s1', ...at(label), stored(formula, label));
            engine.recalc(Number.POSITIVE_INFINITY);
            return valueAt(engine, label);
        };
        // The first comparison of the workbook, on texts that were loaded and one a formula made.
        expect(ask('=MATCH("XY",A1:A9,0)')).toBe(3);
        expect(ask('=COUNTIF(A1:A9,"X")')).toBe(1);
        expect(ask('=COUNTIF(A1:A9,"STRASSE")')).toBe(1);
        expect(ask('=MATCH("Q",A1:A9,0)')).toBe(NA);
        expect(ask('=COUNTBLANK(A1:A9)')).toBe(6);
        // Texts written after it, in another case than the ones before and than the key asked for.
        engine.setValue('s1', 4, 0, 'X');
        engine.setValue('s1', 5, 0, 'q');
        engine.setFormula('s1', 6, 0, stored('=A1&""', 'A7'));
        engine.setFormula('s1', 7, 0, stored('=A5&"Y"', 'A8'));
        expect(ask('=COUNTIF(A1:A9,"x")')).toBe(2);
        expect(ask('=COUNTIF(A1:A9,"x")')).toBe(2);
        expect(ask('=MATCH("Q",A1:A9,0)')).toBe(6);
        expect(ask('=COUNTIF(A1:A9,"Strasse")')).toBe(2);
        expect(ask('=XMATCH("xy",A1:A9,0,-1)')).toBe(8);
        expect(ask('=COUNTIF(A1:A9,"xY")')).toBe(2);
        expect(ask('=COUNTIF(A1:A9,"<>XY")')).toBe(7);
        expect(ask('=A3=A8')).toBe(true);
    });
});
