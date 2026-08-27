import { describe, expect, test } from 'bun:test';
import { evaluateConditionalFormat } from '../../engine/conditional-format';
import type { Cell, CellMatrix } from '../../engine/types';

function numCell(v: number): Cell {
    return { v, ct: { t: 'n', fa: 'General' } };
}

function buildMatrix(values: number[][]): CellMatrix {
    return values.map((row) => row.map((v) => numCell(v)));
}

describe('engine/conditional-format — colorGradation', () => {
    test('2-color rule paints min/max cells with the configured stops', () => {
        const data = buildMatrix([[1], [10]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'colorGradation',
                    cellrange: [{ row: [0, 1], column: [0, 0] }],
                    format: ['#00ff00', '#ff0000'],
                },
            ],
            data,
        );
        // 2-color: format[0] = max color, format[1] = min color
        expect(styles['1_0']?.cellColor).toBe('#00ff00');
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
    });

    test('3-color rule assigns format[0]/[1]/[2] to max/avg/min', () => {
        const data = buildMatrix([[0], [5], [10]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'colorGradation',
                    cellrange: [{ row: [0, 2], column: [0, 0] }],
                    format: ['#ff0000', '#ffff00', '#00ff00'],
                },
            ],
            data,
        );
        expect(styles['2_0']?.cellColor).toBe('#ff0000');
        expect(styles['1_0']?.cellColor).toBe('#ffff00');
        expect(styles['0_0']?.cellColor).toBe('#00ff00');
    });

    test('interpolates between hex stops (regression for getColorGradation hex parsing)', () => {
        // The CF preset table stores hex (#rrggbb); the engine must interpolate them
        // without the original rgb(R, G, B)-only parser blowing up on .split.
        const data = buildMatrix([[0], [5], [10]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'colorGradation',
                    cellrange: [{ row: [0, 2], column: [0, 0] }],
                    format: ['#ff0000', '#00ff00'], // 2-color: max=red, min=green
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#00ff00'); // min
        expect(styles['2_0']?.cellColor).toBe('#ff0000'); // max
        // value 5 is halfway between 0 and 10 → interpolated rgb(128, 128, 0)-ish
        const mid = styles['1_0']?.cellColor;
        expect(mid).toMatch(/^rgb\(/);
        expect(mid).toBe('rgb(128, 128, 0)');
    });

    test('overlapping rules layer onto existing computeMap entries (regression for the format.cellColor-on-array bug)', () => {
        // Bug: when a prior rule populated computeMap[`${r}_${c}`], the colorGradation if-arm read
        // `format.cellColor` on an array-shaped format and blanked the cell color. The else-arm used
        // positional access correctly; both arms must agree.
        const data = buildMatrix([[1]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#888888' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: [0],
                },
                {
                    type: 'colorGradation',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: ['#00ff00', '#0000ff'],
                },
            ],
            data,
        );
        // 2-color min stop is format[1] = '#0000ff'.
        expect(styles['0_0']?.cellColor).toBe('#0000ff');
    });
});

describe('engine/conditional-format — comparison rules', () => {
    test('greaterThan applies textColor + cellColor on matching cells only', () => {
        const data = buildMatrix([[5, 50]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 1] }],
                    format: { textColor: '#ffffff', cellColor: '#ff0000' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: [10],
                },
            ],
            data,
        );
        expect(styles['0_0']).toBeUndefined();
        expect(styles['0_1']).toEqual({ textColor: '#ffffff', cellColor: '#ff0000' });
    });

    test('greaterThanOrEqual / lessThanOrEqual include the boundary value', () => {
        const data = buildMatrix([[5, 10, 15]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'greaterThanOrEqual',
                    conditionRange: [],
                    conditionValue: ['10'],
                },
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 2] }],
                    format: { textColor: '#0000ff' },
                    conditionName: 'lessThanOrEqual',
                    conditionRange: [],
                    conditionValue: ['10'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toEqual({ textColor: '#0000ff' });
        expect(styles['0_1']).toEqual({ cellColor: '#ff0000', textColor: '#0000ff' });
        expect(styles['0_2']).toEqual({ cellColor: '#ff0000' });
    });

    test('notEqual matches every cell except the condition value', () => {
        const data = buildMatrix([[0, 7]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 1] }],
                    format: { cellColor: '#00ff00' },
                    conditionName: 'notEqual',
                    conditionRange: [],
                    conditionValue: ['0'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toBeUndefined();
        expect(styles['0_1']?.cellColor).toBe('#00ff00');
    });

    test('notBetween matches numeric cells outside the bounds only, boundaries excluded', () => {
        const data = buildMatrix([[1, 2, 5, 8, 9]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 4] }],
                    format: { cellColor: '#ff8800' },
                    conditionName: 'notBetween',
                    conditionRange: [],
                    conditionValue: ['2', '8'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff8800');
        // between is inclusive, so its complement must not match the bound values.
        expect(styles['0_1']).toBeUndefined();
        expect(styles['0_2']).toBeUndefined();
        expect(styles['0_3']).toBeUndefined();
        expect(styles['0_4']?.cellColor).toBe('#ff8800');
    });

    test("a later rule without a text color does not erase an earlier rule's text color", () => {
        // Excel resolves each style property independently by rule precedence; the xlsx
        // importer emits rules ascending-precedence and relies on null fields not clobbering.
        const data = buildMatrix([[5]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { textColor: '#ff0000', cellColor: null },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['0'],
                },
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { textColor: null, cellColor: '#00ff00' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['1'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toEqual({ textColor: '#ff0000', cellColor: '#00ff00' });
    });

    test('aboveAverage matches cells strictly greater than the mean', () => {
        const data = buildMatrix([[1, 2, 3, 100]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 3] }],
                    format: { cellColor: '#abcdef' },
                    conditionName: 'aboveAverage',
                    conditionRange: [],
                    conditionValue: [],
                },
            ],
            data,
        );
        // mean = 26.5; only 100 is above
        expect(styles['0_0']).toBeUndefined();
        expect(styles['0_1']).toBeUndefined();
        expect(styles['0_2']).toBeUndefined();
        expect(styles['0_3']?.cellColor).toBe('#abcdef');
    });

    test('greaterThan skips text cells — ordering rules only match numbers (Excel/Google parity)', () => {
        // 'abc' > '5' is true lexicographically in JS (charcode); Excel/Google never
        // apply an ordering rule to a text cell.
        const data: CellMatrix = [[{ v: 'abc', ct: { t: 'g', fa: 'General' } }]];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['5'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toBeUndefined();
    });

    test('greaterThan coerces a string threshold and matches numeric cells', () => {
        const data = buildMatrix([[10]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['9'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
    });

    test('equal coerces both sides so a "5.0" threshold matches numeric cell 5', () => {
        const data = buildMatrix([[5]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#00ff00' },
                    conditionName: 'equal',
                    conditionRange: [],
                    conditionValue: ['5.0'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#00ff00');
    });

    test('notEqual coerces both sides so a "5.0" threshold excludes numeric cell 5', () => {
        const data = buildMatrix([[5]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#00ff00' },
                    conditionName: 'notEqual',
                    conditionRange: [],
                    conditionValue: ['5.0'],
                },
            ],
            data,
        );
        expect(styles['0_0']).toBeUndefined();
    });
});

describe('engine/conditional-format — dataBar', () => {
    test('all-positive range renders plus bars sized proportionally to max', () => {
        const data = buildMatrix([[10], [20], [40]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'dataBar',
                    cellrange: [{ row: [0, 2], column: [0, 0] }],
                    format: ['#638ec6'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.dataBar?.valueType).toBe('plus');
        expect(styles['1_0']?.dataBar?.valueType).toBe('plus');
        expect(styles['2_0']?.dataBar?.valueType).toBe('plus');
        // Largest cell fills the bar; smaller cells get proportional widths.
        if (styles['2_0']?.dataBar?.valueType === 'plus') {
            expect(styles['2_0'].dataBar.valueLen).toBe(1);
        }
    });

    test('mixed positive/negative range uses minus + plus bars on the same row split', () => {
        const data = buildMatrix([[-5], [10]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'dataBar',
                    cellrange: [{ row: [0, 1], column: [0, 0] }],
                    format: ['#638ec6'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.dataBar?.valueType).toBe('minus');
        expect(styles['1_0']?.dataBar?.valueType).toBe('plus');
    });
});

describe('engine/conditional-format — null / empty / disabled', () => {
    test('null rules returns an empty map', () => {
        const data = buildMatrix([[1, 2]]);
        expect(evaluateConditionalFormat(null, data)).toEqual({});
    });

    test('empty rules array returns an empty map', () => {
        const data = buildMatrix([[1, 2]]);
        expect(evaluateConditionalFormat([], data)).toEqual({});
    });

    test('formula rules are skipped when no evaluator is supplied', () => {
        const data = buildMatrix([[1]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['=A1>0'],
                },
            ],
            data,
        );
        expect(styles).toEqual({});
    });

    test('formula rules apply when an evaluator is supplied', () => {
        const data = buildMatrix([[1]]);
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['=A1>0'],
                },
            ],
            data,
            { evaluateFormula: () => true },
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
    });

    // xlsx sqrefs routinely run far past the used range, and each evaluation costs a
    // ref-shift plus a full formula parse: on a real workbook two thirds of them landed
    // on rows the matrix doesn't hold (129 818 evaluations for 44 498 reachable rows).
    // Columns are deliberately NOT clamped — a ragged matrix has no single column extent,
    // and this branch evaluates cells the matrix lacks on purpose (see the edges suite).
    test('formula rules are not evaluated past the last materialized row', () => {
        const data = buildMatrix([[1, 2]]);
        const seen: string[] = [];
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 99], column: [0, 2] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['=A1>0'],
                },
            ],
            data,
            {
                evaluateFormula: (_f, _sr, _sc, r, c) => {
                    seen.push(`${r}_${c}`);
                    return true;
                },
            },
        );
        expect(seen).toEqual(['0_0', '0_1', '0_2']);
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['1_0']).toBeUndefined();
    });
});
