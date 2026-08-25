import { describe, expect, test } from 'bun:test';
import { evaluateConditionalFormat } from '../../engine/conditional-format';
import type { Cell, CellMatrix, ConditionalFormatRule } from '../../engine/types';

// Pinning tests for evaluateConditionalFormat behaviors the base
// conditional-format.test.ts does not cover — especially the loop/guard quirks
// that a scan refactor could disturb: duplicateValue and formula visit every
// coordinate with NO nil guard (missing cells become String(null) === 'null' /
// get evaluated), top10/average aggregate per-range over ct.t==='n' cells but
// apply via Number(cellValueAt(...)) coercion to ANY non-nil cell, and
// dataBar/colorGradation aggregate min/max across ALL ranges of a rule.

function numCell(v: number): Cell {
    return { v, ct: { t: 'n', fa: 'General' } };
}

function textCell(v: string): Cell {
    return { v, ct: { t: 'g', fa: 'General' } };
}

function dateCell(serial: number): Cell {
    return { v: serial, ct: { t: 'd', fa: 'yyyy-MM-dd' } };
}

const RED = { cellColor: '#ff0000' };

describe('engine/conditional-format edges — remaining comparison ops', () => {
    test('lessThan matches numeric cells strictly below the threshold', () => {
        const data: CellMatrix = [[numCell(5), numCell(10), numCell(15)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'lessThan',
                    conditionRange: [],
                    conditionValue: ['10'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['0_1']).toBeUndefined();
        expect(styles['0_2']).toBeUndefined();
    });

    test('between includes both bounds', () => {
        const data: CellMatrix = [[numCell(1), numCell(2), numCell(5), numCell(8), numCell(9)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 4] }],
                    format: RED,
                    conditionName: 'between',
                    conditionRange: [],
                    conditionValue: ['2', '8'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toBeUndefined();
        expect(styles['0_1']?.cellColor).toBe('#ff0000');
        expect(styles['0_2']?.cellColor).toBe('#ff0000');
        expect(styles['0_3']?.cellColor).toBe('#ff0000');
        expect(styles['0_4']).toBeUndefined();
    });

    test('textContains substring-matches text and stringified numeric cells', () => {
        const data: CellMatrix = [[textCell('hello'), numCell(123), textCell('world')]];
        const ell = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'textContains',
                    conditionRange: [],
                    conditionValue: ['ell'],
                },
            ],
            data,
        );
        expect(ell['0_0']?.cellColor).toBe('#ff0000');
        expect(ell['0_1']).toBeUndefined();
        expect(ell['0_2']).toBeUndefined();

        const two = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'textContains',
                    conditionRange: [],
                    conditionValue: ['2'],
                },
            ],
            data,
        );
        expect(two['0_0']).toBeUndefined();
        expect(two['0_1']?.cellColor).toBe('#ff0000');
        expect(two['0_2']).toBeUndefined();
    });

    test('comparison rules skip missing rows in the apply range without throwing', () => {
        const data: CellMatrix = [[numCell(5)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 2], column: [0, 0] }],
                    format: RED,
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['0'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED });
    });
});

describe('engine/conditional-format edges — occurrenceDate', () => {
    // genarate('2024/1/15')[2] === 45306 (date serial); slash form has no '-'
    // so it takes the single-date path, 'a - b' takes the split path.
    test('single date matches only date-typed cells with that serial', () => {
        const data: CellMatrix = [[dateCell(45306), dateCell(45307), numCell(45306)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'occurrenceDate',
                    conditionRange: [],
                    conditionValue: ['2024/1/15'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['0_1']).toBeUndefined();
        // same serial but ct.t 'n', not 'd' — skipped
        expect(styles['0_2']).toBeUndefined();
    });

    test('date range matches serials inside [start, end] inclusive', () => {
        const data: CellMatrix = [
            [dateCell(45301), dateCell(45306), dateCell(45311), dateCell(45312), dateCell(45300)],
        ];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 4] }],
                    format: RED,
                    conditionName: 'occurrenceDate',
                    conditionRange: [],
                    conditionValue: ['2024/1/10 - 2024/1/20'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['0_1']?.cellColor).toBe('#ff0000');
        expect(styles['0_2']?.cellColor).toBe('#ff0000');
        expect(styles['0_3']).toBeUndefined();
        expect(styles['0_4']).toBeUndefined();
    });
});

describe('engine/conditional-format edges — duplicateValue', () => {
    test("'0' styles every occurrence of a duplicated value", () => {
        const data: CellMatrix = [[numCell(7), numCell(8), numCell(7)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'duplicateValue',
                    conditionRange: [],
                    conditionValue: ['0'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED, '0_2': RED });
    });

    test("'0' visits missing cells too — two empty coordinates count as duplicates of 'null'", () => {
        // duplicateValue has no nil guard: String(cellValueAt) of a missing cell
        // is 'null', so two holes in the range duplicate each other.
        const data: CellMatrix = [[numCell(5)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'duplicateValue',
                    conditionRange: [],
                    conditionValue: ['0'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_1': RED, '0_2': RED });
    });

    test("'1' styles unique values, including a single missing coordinate", () => {
        const data: CellMatrix = [[numCell(7), numCell(8), numCell(7)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: RED,
                    conditionName: 'duplicateValue',
                    conditionRange: [],
                    conditionValue: ['1'],
                },
            ],
            data,
        );
        // 8 is unique; the lone hole at 0_3 is a unique 'null' entry.
        expect(styles).toEqual({ '0_1': RED, '0_3': RED });
    });

    test('the duplicate map is per-range: the same value once in each range stays unique', () => {
        const data: CellMatrix = [[numCell(9), numCell(9)]];
        const rule = (mode: string): ConditionalFormatRule => ({
            type: 'default',
            cellrange: [
                { row: [0, 0], column: [0, 0] },
                { row: [0, 0], column: [1, 1] },
            ],
            format: RED,
            conditionName: 'duplicateValue',
            conditionRange: [],
            conditionValue: [mode],
        });
        expect(evaluateConditionalFormat([rule('0')], data)).toEqual({});
        expect(evaluateConditionalFormat([rule('1')], data)).toEqual({ '0_0': RED, '0_1': RED });
    });
});

describe('engine/conditional-format edges — top10 family', () => {
    test('top10 aggregates numeric-typed cells but applies by Number() coercion — a text "30" matches', () => {
        const data: CellMatrix = [[numCell(10), numCell(20), numCell(30), textCell('30')]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: RED,
                    conditionName: 'top10',
                    conditionRange: [],
                    conditionValue: ['2'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_1': RED, '0_2': RED, '0_3': RED });
    });

    test('top10 styles a nil-v cell when 0 is in the winning set (Number(null) === 0)', () => {
        const nilV: Cell = { ct: { t: 'n', fa: 'General' } };
        const data: CellMatrix = [[numCell(0), numCell(-5), nilV]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'top10',
                    conditionRange: [],
                    conditionValue: ['1'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED, '0_2': RED });
    });

    test('top10_percent takes floor(n% of count) items from the top', () => {
        const data: CellMatrix = [[numCell(1), numCell(2), numCell(3), numCell(4)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: RED,
                    conditionName: 'top10_percent',
                    conditionRange: [],
                    conditionValue: ['50'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_2': RED, '0_3': RED });
    });

    test('last10 takes the bottom n items', () => {
        const data: CellMatrix = [[numCell(1), numCell(2), numCell(3), numCell(4)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: RED,
                    conditionName: 'last10',
                    conditionRange: [],
                    conditionValue: ['2'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED, '0_1': RED });
    });

    test('last10_percent takes floor(n% of count) items from the bottom', () => {
        const data: CellMatrix = [[numCell(1), numCell(2), numCell(3), numCell(4)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: RED,
                    conditionName: 'last10_percent',
                    conditionRange: [],
                    conditionValue: ['50'],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED, '0_1': RED });
    });
});

describe('engine/conditional-format edges — above/belowAverage coercion', () => {
    test('belowAverage styles any non-nil cell whose Number() value is below the numeric mean — nil v coerces to 0', () => {
        const nilV: Cell = { ct: { t: 'n', fa: 'General' } };
        // dArr = [1, 3] (numeric-typed only), mean = 2; nil-v cell applies as 0 < 2.
        const data: CellMatrix = [[numCell(1), numCell(3), nilV]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'belowAverage',
                    conditionRange: [],
                    conditionValue: [],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_0': RED, '0_2': RED });
    });

    test('aboveAverage applies to a numeric-looking text cell excluded from the mean', () => {
        // mean over numeric-typed cells = 2; text '100' coerces to 100 > 2.
        const data: CellMatrix = [[numCell(1), numCell(3), textCell('100')]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'aboveAverage',
                    conditionRange: [],
                    conditionValue: [],
                },
            ],
            data,
        );
        expect(styles).toEqual({ '0_1': RED, '0_2': RED });
    });
});

describe('engine/conditional-format edges — cross-range aggregation', () => {
    test('dataBar min/max aggregate across ALL ranges of the rule', () => {
        const data: CellMatrix = [[numCell(-5), numCell(10)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'dataBar',
                    cellrange: [
                        { row: [0, 0], column: [0, 0] },
                        { row: [0, 0], column: [1, 1] },
                    ],
                    format: ['#638ec6'],
                },
            ],
            data,
        );
        // Global min=-5/max=10: plusLen=round(10/15*10)/10, minusLen=round(5/15*10)/10.
        expect(styles['0_0']?.dataBar).toEqual({
            valueType: 'minus',
            minusLen: 0.3,
            valueLen: 1,
            format: ['#638ec6'],
        });
        expect(styles['0_1']?.dataBar).toEqual({
            valueType: 'plus',
            plusLen: 0.7,
            minusLen: 0.3,
            valueLen: 1,
            format: ['#638ec6'],
        });
    });

    test('colorGradation min/max aggregate across ALL ranges of the rule', () => {
        const data: CellMatrix = [[numCell(1), numCell(10)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'colorGradation',
                    cellrange: [
                        { row: [0, 0], column: [0, 0] },
                        { row: [0, 0], column: [1, 1] },
                    ],
                    format: ['#00ff00', '#ff0000'],
                },
            ],
            data,
        );
        // If aggregation were per-range each cell would be its own min AND max
        // and both would take the min stop.
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['0_1']?.cellColor).toBe('#00ff00');
    });
});

describe('engine/conditional-format edges — formula scan', () => {
    test('evaluator runs per coordinate with a per-range anchor, missing cells included, and "=" is prefixed', () => {
        // data[0][1] does not exist — the formula branch has no nil guard.
        const data: CellMatrix = [[numCell(1)], [numCell(2)]];
        const calls: [string, number, number, number, number][] = [];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [
                        { row: [0, 0], column: [0, 1] },
                        { row: [1, 1], column: [0, 0] },
                    ],
                    format: RED,
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['A1>0'],
                },
            ],
            data,
            {
                evaluateFormula: (formula, anchorRow, anchorCol, targetRow, targetCol) => {
                    calls.push([formula, anchorRow, anchorCol, targetRow, targetCol]);
                    return true;
                },
            },
        );
        expect(calls).toEqual([
            ['=A1>0', 0, 0, 0, 0],
            ['=A1>0', 0, 0, 0, 1],
            ['=A1>0', 1, 0, 1, 0],
        ]);
        expect(styles).toEqual({ '0_0': RED, '0_1': RED, '1_0': RED });
    });

    test('non-boolean evaluator results pass through !!Number(): "2" applies, "0" and "x" do not', () => {
        const data: CellMatrix = [[numCell(1), numCell(1), numCell(1)]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: RED,
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['=X'],
                },
            ],
            data,
            {
                evaluateFormula: (_formula, _ar, _ac, _r, c) => (c === 0 ? '2' : c === 1 ? '0' : 'x'),
            },
        );
        expect(styles).toEqual({ '0_0': RED });
    });
});
