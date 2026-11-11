import { describe, expect, test } from 'bun:test';
import { Engine } from '../../index';
import { stored } from '../recalc/support';
import type { TestCell } from './support';
import { source } from './support';

const ALL = Number.POSITIVE_INFINITY;

describe('load', () => {
    test('a cell reported empty leaves no trace, however far out it is', () => {
        const formulas = [
            '=A1:C3+D:F',
            '=SUM(A:F)',
            '=COUNTBLANK(D:F)',
            '=COUNTA(A:XFD)',
            '=MATCH(10,D:D,0)',
            '=XMATCH(10,D:D,0,-1)',
            '=XLOOKUP("",F:F,D:D,"none",0,-1)',
            '=COUNTIF(F:F,"")',
            '=SUM(--(E:E=""))',
            '=F1048576',
        ];
        const content: TestCell[] = [
            [0, 0, 1],
            [0, 3, 10],
            [2, 4, 'x'],
            ...formulas.map((formula, row): TestCell => [row, 9, null, stored(formula, `J${row + 1}`)]),
        ];
        const empties: TestCell[] = [
            [1048575, 5, null],
            [1048575, 16383, null],
            [700, 0, null],
            [5, 4, null],
            [40, 9, null],
        ];
        const plain = new Engine([source('s1', content)]);
        const padded = new Engine([source('s1', [...empties, ...content, ...empties])]);
        const read = (engine: Engine) => {
            const values = formulas.map((_, row) => engine.valueOf('s1', row, 9));
            for (const [row, column] of [...content, ...empties]) values.push(engine.valueOf('s1', row, column));
            return values;
        };
        expect(read(padded)).toEqual(read(plain));
        plain.recalc(ALL);
        padded.recalc(ALL);
        expect(read(padded)).toEqual(read(plain));
        for (const engine of [plain, padded]) engine.setValue('s1', 3, 3, 10);
        plain.recalc(ALL);
        padded.recalc(ALL);
        expect(read(padded)).toEqual(read(plain));
    });
});
