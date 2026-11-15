import { describe, expect, test } from 'bun:test';
import { Engine, errorOf, NA } from '../../index';
import type { SheetSource } from '../../store/workbook';
import { Workbook } from '../../store/workbook';
import { ERRORS } from '../../values/errors';
import { stored } from '../recalc/support';
import type { TestCell } from './support';
import { source } from './support';

const ALL = Number.POSITIVE_INFINITY;

describe('load', () => {
    test('every kind of value comes back as it went in', () => {
        const engine = new Engine([
            source('s1', [
                [0, 0, 1.5],
                [1, 0, 'text'],
                [2, 0, true],
                [3, 0, false],
                [4, 0, NA],
                [5, 0, ''],
                [6, 0, 7, '=R1C1+5.5'],
                [7, 0, errorOf('#BUSY!')],
            ]),
            source('s2', [[2, 1, 'other']]),
        ]);
        const read = () => [0, 1, 2, 3, 4, 5, 6].map((row) => engine.valueOf('s1', row, 0));
        expect(read()).toEqual([1.5, 'text', true, false, NA, '', 7]);
        expect(engine.valueOf('s1', 4, 0)).toBe(NA);
        expect(engine.valueOf('s1', 7, 0)).toMatchObject({ text: '#BUSY!' });
        expect(engine.valueOf('s1', 7, 0)).toBe(engine.valueOf('s1', 7, 0));
        expect(engine.valueOf('s2', 2, 1)).toBe('other');
        engine.recalc(ALL);
        expect(read()).toEqual([1.5, 'text', true, false, NA, '', 7]);
    });

    test('a read past a column, or past the sheet, is empty', () => {
        const engine = new Engine([source('s1', [[2, 0, 1]])]);
        expect(engine.valueOf('s1', 3, 0)).toBeNull();
        expect(engine.valueOf('s1', 1000000, 0)).toBeNull();
        expect(engine.valueOf('s1', 0, 5)).toBeNull();
    });

    test('an error only a file knows is one object, from whichever sheet it came', () => {
        const engine = new Engine([
            source('s1', [
                [0, 0, errorOf('#BUSY!')],
                [1, 0, NA],
                [2, 0, errorOf('#FIELD!')],
                [3, 0, errorOf('#BUSY!')],
                [4, 0, errorOf('#FIELD!'), '=1/0'],
                [5, 0, null, '=R[-3]C'],
            ]),
            source('s2', [[0, 0, errorOf('#FIELD!')]]),
        ]);
        engine.addSheet(
            source('s3', [
                [0, 0, errorOf('#BLOCKED!')],
                [1, 0, errorOf('#BUSY!')],
                [2, 0, NA],
            ]),
            0,
        );
        engine.setValue('s2', 1, 0, errorOf('#BLOCKED!'));
        engine.recalc(ALL);
        const texts = (sheet: string, rows: number[]) =>
            rows
                .map((row) => engine.valueOf(sheet, row, 0))
                .map((value) => (typeof value === 'object' ? value?.text : value));
        expect(texts('s1', [0, 1, 2, 3, 4, 5])).toEqual(['#BUSY!', '#N/A', '#FIELD!', '#BUSY!', '#FIELD!', '#FIELD!']);
        expect(texts('s2', [0, 1])).toEqual(['#FIELD!', '#BLOCKED!']);
        expect(texts('s3', [0, 1, 2])).toEqual(['#BLOCKED!', '#BUSY!', '#N/A']);
        const same = [
            ['s3', 1, 's1', 0],
            ['s1', 3, 's1', 0],
            ['s2', 0, 's1', 2],
            ['s1', 5, 's1', 2],
            ['s2', 1, 's3', 0],
        ] as const;
        for (const [sheet, row, other, otherRow] of same) {
            expect(engine.valueOf(sheet, row, 0)).toBe(engine.valueOf(other, otherRow, 0));
        }
    });

    test('a sheet that is read and not taken leaves no text, formula or error in the tables', () => {
        const workbook = new Workbook([source('s1', [[0, 0, 'one', '=1+1']])]);
        const tables = () => [workbook.strings.size, workbook.shapes.size, workbook.error(ERRORS.length + 1)];
        const before = tables();
        let walks = 0;
        const stops: SheetSource = {
            id: 's2',
            name: 's2',
            cells: (cell) => {
                walks += 1;
                cell(0, 0, 'fresh', '=2+2');
                cell(1, 0, errorOf('#BUSY!'), null);
                if (walks === 2) throw new Error('stopped');
            },
        };
        expect(() => workbook.read(stops)).toThrow('stopped');
        expect(tables()).toEqual(before);
        workbook.read(source('s3', [[0, 0, errorOf('#FIELD!'), '=3+3']]));
        expect(tables()).toEqual(before);
        expect(before[2]).toBeUndefined();
    });

    test('a formula that came without a value is empty until a recalc computes it', () => {
        const engine = new Engine([
            source('s1', [
                [0, 0, null, '=1+1'],
                [1, 0, 5, '=1+1'],
            ]),
        ]);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([null, 5]);
        engine.recalc(ALL);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([2, 5]);
    });

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

describe('writes', () => {
    test('a write past the end of a column lands, and the rows between are empty', () => {
        const engine = new Engine([source('s1', [[9, 0, 1]])]);
        engine.setValue('s1', 10, 0, 2);
        engine.setValue('s1', 99, 0, 3);
        engine.setValue('s1', 3, 4, 'far');
        const read = () => [9, 10, 50, 99, 100].map((row) => engine.valueOf('s1', row, 0));
        expect(read()).toEqual([1, 2, null, 3, null]);
        expect([engine.valueOf('s1', 3, 4), engine.valueOf('s1', 3, 3)]).toEqual(['far', null]);
        engine.recalc(ALL);
        expect(read()).toEqual([1, 2, null, 3, null]);
    });

    test('a literal replaces a formula, a formula a literal, and a clear both', () => {
        const engine = new Engine([source('s1', [[0, 0, 5]])]);
        engine.setFormula('s1', 0, 0, '=1+1');
        expect(engine.valueOf('s1', 0, 0)).toBeNull();
        engine.recalc(ALL);
        expect(engine.valueOf('s1', 0, 0)).toBe(2);
        engine.setValue('s1', 0, 0, 'typed');
        expect(engine.valueOf('s1', 0, 0)).toBe('typed');
        engine.recalc(ALL);
        expect(engine.valueOf('s1', 0, 0)).toBe('typed');
        engine.setFormula('s1', 0, 0, '=1+1');
        engine.clear('s1', 0, 0);
        engine.clear('s1', 500, 9);
        engine.recalc(ALL);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 500, 9)]).toEqual([null, null]);
    });
});
