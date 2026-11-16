import { describe, expect, test } from 'bun:test';
import { Engine, errorOf, NA } from '../../index';
import type { SheetSource } from '../../store/workbook';
import { Workbook } from '../../store/workbook';
import { GRID_ROWS } from '../../text';
import { ERRORS } from '../../values/errors';
import { stored } from '../recalc/support';
import type { TestCell } from './support';
import { source } from './support';

const ALL = Number.POSITIVE_INFINITY;

describe('load', () => {
    test('every kind of value comes back as it went in', () => {
        const engine = new Engine(
            [
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
            ],
            0,
            0,
            false,
        );
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
        const engine = new Engine([source('s1', [[2, 0, 1]])], 0, 0, false);
        expect(engine.valueOf('s1', 3, 0)).toBeNull();
        expect(engine.valueOf('s1', 1000000, 0)).toBeNull();
        expect(engine.valueOf('s1', 0, 5)).toBeNull();
    });

    test.each([
        ['a row above the first', -1, 0],
        ['a row that is a fraction', 0.5, 0],
        ['a row that is not a number', Number.NaN, 0],
        ['a row past the grid', GRID_ROWS, 0],
        ['a column left of the first', 0, -1],
        ['a column that is a fraction', 0, 0.5],
        ['a column that is not a number', 0, Number.NaN],
        ['a column that is infinite', 0, Number.POSITIVE_INFINITY],
    ])('a read of %s is empty', (_, row, column) => {
        const engine = new Engine(
            [
                source('s1', [
                    [0, 0, 1, '=1+1'],
                    [1, 0, null, '=2+2'],
                    [0, 1, 3],
                ]),
            ],
            0,
            0,
            false,
        );
        const read = () => {
            const walked: number[] = [];
            engine.cells('s1', (at) => walked.push(at), row, column);
            return [
                engine.valueOf('s1', row, column),
                engine.formulaOf('s1', row, column),
                engine.isPending('s1', row, column),
                engine.nextCell('s1', column, row, row),
                walked,
            ];
        };
        expect(read()).toEqual([null, null, false, -1, []]);
        engine.recalc(ALL);
        expect(read()).toEqual([null, null, false, -1, []]);
    });

    test('a read of a sheet no sheet has throws', () => {
        const engine = new Engine([source('s1', []), source('s2', [])], 0, 0, false);
        expect(() => engine.valueOf('s3', 0, 0)).toThrow('No sheet s3');
    });

    test('an error only a file knows is one object, from whichever sheet it came', () => {
        const engine = new Engine(
            [
                source('s1', [
                    [0, 0, errorOf('#BUSY!')],
                    [1, 0, NA],
                    [2, 0, errorOf('#FIELD!')],
                    [3, 0, errorOf('#BUSY!')],
                    [4, 0, errorOf('#FIELD!'), '=1/0'],
                    [5, 0, errorOf('#FIELD!'), '=R[-3]C'],
                ]),
                source('s2', [[0, 0, errorOf('#FIELD!')]]),
            ],
            0,
            0,
            true,
        );
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
        const workbook = new Workbook([source('s1', [[0, 0, 'one', '=1+1']])], false);
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
        expect(() => workbook.read(stops, false)).toThrow('stopped');
        expect(tables()).toEqual(before);
        workbook.read(source('s3', [[0, 0, errorOf('#FIELD!'), '=3+3']]), false);
        expect(tables()).toEqual(before);
        expect(before[2]).toBeUndefined();
    });

    test('a sheet whose cells lie far apart takes its ids by reading those cells, and no row between them', () => {
        const far = GRID_ROWS - 1;
        const cells: TestCell[] = [
            [0, 0, 'top'],
            [far, 0, 'far', '=R1C1&"!"'],
            [far, 1, 7],
            [far, 2, errorOf('#BUSY!')],
            [far, 3, null, '=R1C1&"!"'],
            [far, 4, 'far'],
        ];
        const workbook = new Workbook([source('s0', [[0, 0, 'other', '=1+1']])], false);
        const draft = workbook.read(source('s1', cells), false);
        let reads = 0;
        const counted = <Plane extends object>(plane: Plane): Plane =>
            new Proxy(plane, {
                get: (target, key) => {
                    reads += 1;
                    return Reflect.get(target, key);
                },
                set: (target, key, value) => Reflect.set(target, key, value),
            });
        for (const column of draft.sheet.columns) {
            column.kind = counted(column.kind);
            column.ref = counted(column.ref);
            column.shape = counted(column.shape);
        }
        const sheet = workbook.adopt(draft);
        // Three planes of six cells at most, where the columns hold over five million rows.
        expect(reads).toBeLessThanOrEqual(3 * cells.length);
        expect(reads).toBeGreaterThan(0);
        const held = sheet.columns.map((column) => workbook.value(column, far));
        expect(held.map((value) => (typeof value === 'object' ? (value?.text ?? 'blank') : value))).toEqual([
            'far',
            7,
            '#BUSY!',
            'blank',
            'far',
        ]);
        expect(workbook.value(sheet.columns[0], 0)).toBe('top');
        expect([0, 3].map((c) => workbook.shapes.shape(sheet.columns[c].shape[far]).text)).toEqual([
            '=R1C1&"!"',
            '=R1C1&"!"',
        ]);
        expect(sheet.columns.map((column) => `${column.pending} ${column.errors}`)).toEqual([
            '1 0',
            '0 0',
            '0 1',
            '1 0',
            '0 0',
        ]);
    });

    test('a cell its source reports twice holds what was reported last, and a formula once reported stays', () => {
        const twice: TestCell[] = [
            [0, 0, 'first'],
            [0, 0, 'second'],
            [1, 0, 'first'],
            [1, 0, 5],
            [2, 0, errorOf('#BUSY!')],
            [2, 0, errorOf('#FIELD!')],
            [3, 0, 1, '=1+1'],
            [3, 0, 'third', '=2+2'],
            [4, 0, 'same'],
            [4, 0, 'same'],
            [5, 0, null, '=3+3'],
            [5, 0, errorOf('#BUSY!')],
            [6, 0, errorOf('#FIELD!')],
            [6, 0, NA],
        ];
        // The tables hold texts, shapes and errors of another sheet already, so no id is its number in the sheet.
        const others: TestCell[] = [
            [0, 0, 'p', '=7+7'],
            [1, 0, 'q', '=8+8'],
            [2, 0, errorOf('#BLOCKED!'), '=9+9'],
        ];
        const engine = new Engine([source('s0', others), source('s1', twice)], 0, 0, false);
        engine.addSheet(source('s2', twice), 2);
        for (const sheet of ['s1', 's2']) {
            const read = [0, 1, 2, 3, 4, 5, 6].map((row) => engine.valueOf(sheet, row, 0));
            expect(read.map((value) => (typeof value === 'object' ? value?.text : value))).toEqual([
                'second',
                5,
                '#FIELD!',
                'third',
                'same',
                '#BUSY!',
                '#N/A',
            ]);
            expect([3, 5, 6].map((row) => engine.formulaOf(sheet, row, 0))).toEqual(['=2+2', '=3+3', null]);
        }
    });

    test('a formula of a load that is not computed holds what it came with until a recalc computes it', () => {
        const engine = new Engine(
            [
                source('s1', [
                    [0, 0, null, '=1+1'],
                    [1, 0, 5, '=1+1'],
                ]),
            ],
            0,
            0,
            false,
        );
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([null, 5]);
        engine.recalc(ALL);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([2, 2]);
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
        const plain = new Engine([source('s1', content)], 0, 0, false);
        const padded = new Engine([source('s1', [...empties, ...content, ...empties])], 0, 0, false);
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
        const engine = new Engine([source('s1', [[9, 0, 1]])], 0, 0, false);
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
        const engine = new Engine([source('s1', [[0, 0, 5]])], 0, 0, false);
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
