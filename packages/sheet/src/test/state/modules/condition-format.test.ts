import { describe, expect, it } from 'bun:test';
import type { SingleRange } from '@workspace/lib/sheets';
import type { Context } from '../../../index';
import type { ConditionRuleType } from '../../../state/modules/condition-format';
import { addConditionRule, conditionRuleError, getComputeMap } from '../../../state/modules/condition-format';
import type { ConditionRulesProps } from '../../../state/types';
import { contextFactory, workbookContextFactory } from '../factories/context';
import { formatList, formatsOf } from '../factories/validations';

function ctxWithRules(): Context {
    const ctx = contextFactory() as Context;
    for (const sheet of ctx.sheets) {
        sheet.conditionalFormats = formatsOf([
            {
                type: 'default',
                ranges: [{ row: [0, 3], column: [0, 3] }],
                format: { cellColor: '#ff0000' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ]);
    }
    return ctx;
}

describe('state/condition-format — getComputeMap cache', () => {
    it('keeps a sheet computed across a visit to another sheet', () => {
        // One cache slot made every A→B→A tab switch a guaranteed miss. On a sheet
        // carrying formula rules that recompute costs seconds, which is what made
        // reopening a tab as slow as opening it the first time.
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.currentSheetId = 'id_2';
        getComputeMap(ctx);
        ctx.currentSheetId = 'id_1';

        expect(getComputeMap(ctx)).toBe(first);
    });

    it('recomputes when the sheet data is replaced', () => {
        // immer replaces `data` by reference on any edit, so reference equality on it
        // is the whole invalidation contract — dropping it from the key serves stale styles.
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.sheets[0].data = ctx.sheets[0].data!.map((row) => [...row]);

        expect(getComputeMap(ctx)).not.toBe(first);
    });

    it('drops the entry for a sheet the workbook no longer has', () => {
        // Each entry retains the sheet's whole CellMatrix, so a session that opened
        // several large workbooks used to pin every matrix it had ever rendered.
        const ctx = ctxWithRules();
        ctx.currentSheetId = 'id_2';
        const second = getComputeMap(ctx);
        const removed = ctx.sheets[1];

        // Sheet deleted (or the workbook closed) — the next miss sweeps it out.
        ctx.sheets = [ctx.sheets[0]];
        ctx.currentSheetId = 'id_1';
        getComputeMap(ctx);

        // Same rules and same data by reference: a surviving entry would hit.
        ctx.sheets = [ctx.sheets[0], removed];
        ctx.currentSheetId = 'id_2';
        expect(getComputeMap(ctx)).not.toBe(second);
    });

    it('drops the entry for a sheet that was edited while another was current', () => {
        // Sheets are edited while not current routinely — cross-sheet recalc, a collab
        // peer's edit, a row/col op. immer replaces `data` by reference, so that entry
        // can never hit again, yet it pinned a whole CellMatrix + ComputeMap until you
        // navigated back to the sheet.
        const ctx = ctxWithRules();
        const original = ctx.sheets[0].data;
        const first = getComputeMap(ctx);

        ctx.currentSheetId = 'id_2';
        ctx.sheets[0].data = original!.map((row) => [...row]);
        getComputeMap(ctx);

        // Put the very same matrix back: an entry that survived the sweep still keys
        // on it and would hit.
        ctx.sheets[0].data = original;
        ctx.currentSheetId = 'id_1';
        expect(getComputeMap(ctx)).not.toBe(first);
    });

    it('recomputes when the rules are replaced', () => {
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.sheets[0].conditionalFormats = formatsOf(formatList(ctx.sheets[0].conditionalFormats));

        expect(getComputeMap(ctx)).not.toBe(first);
    });
});

// Values for 'Sheet1'!A1:D6; 'Data'!A1:B2 is [[1, 0], [0, 1]].
const GRID = [
    [1, 5, 0, 1],
    [3, 2, 0, 2],
    [4, 0, 0, 0],
    [3, 7, 0, 0],
    [0, 1, 0, 0],
    [6, 3, 0, 0],
];

function numberRows(rows: number[][]) {
    return rows.map((row) => row.map((v) => ({ v, m: String(v), ct: { t: 'n', fa: 'General' } })));
}

const range = (r0: number, r1: number, c0: number, c1: number): SingleRange => ({ row: [r0, r1], column: [c0, c1] });

// The cells a single formula rule paints, sorted.
function painted(formula: string, ranges: SingleRange[]): string[] {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].name = 'Sheet1';
    ctx.sheets[0].data = numberRows(GRID);
    ctx.sheets[1].name = 'Data';
    ctx.sheets[1].data = numberRows([
        [1, 0],
        [0, 1],
    ]);
    ctx.sheets[0].conditionalFormats = formatsOf([
        {
            type: 'default',
            ranges,
            format: { cellColor: '#ff0000' },
            conditionName: 'formula',
            conditionRange: [],
            conditionValue: [formula],
        },
    ]);
    return Object.keys(getComputeMap(ctx) ?? {}).sort();
}

describe('state/condition-format — formula rules resolve relative refs per cell', () => {
    it('shifts a relative ref along both axes', () => {
        expect(painted('=A1>2', [range(0, 5, 0, 1)])).toEqual(['0_1', '1_0', '2_0', '3_0', '3_1', '5_0', '5_1']);
    });

    it('keeps an absolute column and shifts the row', () => {
        expect(painted('=$A1>2', [range(0, 5, 0, 2)])).toEqual([
            '1_0',
            '1_1',
            '1_2',
            '2_0',
            '2_1',
            '2_2',
            '3_0',
            '3_1',
            '3_2',
            '5_0',
            '5_1',
            '5_2',
        ]);
    });

    it('keeps an absolute row and shifts the column', () => {
        expect(painted('=A$1>2', [range(0, 1, 0, 3)])).toEqual(['0_1', '1_1']);
    });

    it('never moves a fully absolute ref', () => {
        expect(painted('=$D$1>0', [range(0, 1, 0, 1)])).toEqual(['0_0', '0_1', '1_0', '1_1']);
        expect(painted('=A1>=$D$2', [range(0, 5, 0, 1)])).toEqual([
            '0_1',
            '1_0',
            '1_1',
            '2_0',
            '3_0',
            '3_1',
            '5_0',
            '5_1',
        ]);
    });

    it('grows a range with one absolute and one relative leg', () => {
        expect(painted('=SUM($A$1:A1)>5', [range(0, 5, 0, 0)])).toEqual(['2_0', '3_0', '4_0', '5_0']);
    });

    it('slides a fully relative range and holds a fully absolute one', () => {
        expect(painted('=SUM(A1:B1)>6', [range(0, 5, 0, 0)])).toEqual(['3_0', '5_0']);
        expect(painted('=COUNTIF($A$1:$A$6,A1)>1', [range(0, 5, 0, 0)])).toEqual(['1_0', '3_0']);
    });

    it('shifts a whole-column range by column only', () => {
        expect(painted('=COUNTIF(A:A,A1)>1', [range(0, 5, 0, 1)])).toEqual(['1_0', '3_0']);
    });

    it('mixes absolute and relative legs inside one function call', () => {
        expect(painted('=AND($A1>2,B$2=2)', [range(0, 5, 0, 1)])).toEqual(['1_0', '2_0', '3_0', '5_0']);
    });

    it('shifts a sheet-qualified ref', () => {
        expect(painted('=Data!A1>0', [range(0, 1, 0, 1)])).toEqual(['0_0', '1_1']);
    });

    it('leaves reference-shaped text inside a string literal alone', () => {
        expect(painted('=IF(A1>2,"B1","x")="B1"', [range(0, 5, 0, 0)])).toEqual(['1_0', '2_0', '3_0', '5_0']);
    });

    it('anchors every range of a rule at the first range top-left', () => {
        expect(painted('=A1>2', [range(0, 1, 0, 0), range(3, 4, 1, 1)])).toEqual(['1_0', '3_1']);
    });

    it('paints nothing for a formula that does not parse', () => {
        expect(painted('=A1>', [range(0, 5, 0, 1)])).toEqual([]);
    });
});

// A rule the dialog hands to addConditionRule, with a value typed for its type.
function ruleDraft(rulesType: ConditionRuleType, typed: Partial<ConditionRulesProps> = {}): ConditionRulesProps {
    return {
        rulesType,
        rulesValue: '',
        textColor: { check: false, color: '#009966' },
        cellColor: { check: true, color: '#d0fae5' },
        betweenValue: { value1: '', value2: '' },
        dateValue: '',
        repeatValue: '0',
        projectValue: '10',
        ...typed,
    };
}

// A1 holds 5 and B1 holds 7; B2:C3 is selected.
function ctxForRule(): Context {
    const ctx = workbookContextFactory({
        selections: [{ row: [1, 2], column: [1, 2] }],
    });
    ctx.sheets[0].data = numberRows([
        [5, 7, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ]);
    return ctx;
}

const savedRules = (ctx: Context) => formatList(ctx.sheets[0].conditionalFormats);
const savedValues = (ctx: Context) =>
    savedRules(ctx).flatMap((rule) => (rule.type === 'default' ? [rule.conditionValue] : []));

// What conditionRuleError says about a rule. A refused rule saves nothing, and neither way leaves a notice behind.
function refusal(draft: ConditionRulesProps): string | undefined {
    const ctx = ctxForRule();
    const error = conditionRuleError(ctx, draft);
    addConditionRule(ctx, draft);
    expect(savedRules(ctx)).toHaveLength(error ? 0 : 1);
    expect(ctx.warnDialog).toBeUndefined();
    return error;
}

const NUMBER_OR_CELL = 'Enter a number, or a cell such as =A1';

describe('state/condition-format — addConditionRule', () => {
    it('stores a value typed with = as the formula Excel writes, so the rule reads the cell live', () => {
        const formulas: [ConditionRuleType, Partial<ConditionRulesProps>, string][] = [
            ['greaterThan', { rulesValue: '=A1' }, '=B2>A1'],
            ['lessThan', { rulesValue: '=$A$1' }, '=B2<$A$1'],
            ['equal', { rulesValue: '=A1' }, '=B2=A1'],
            ['textContains', { rulesValue: '=A1' }, '=NOT(ISERROR(SEARCH(A1,B2)))'],
            ['between', { betweenValue: { value1: '=A1', value2: '9' } }, '=AND(B2>=A1,B2<=9)'],
        ];
        for (const [rulesType, typed, formula] of formulas) {
            const ctx = ctxForRule();
            addConditionRule(ctx, ruleDraft(rulesType, typed));
            expect(savedRules(ctx)).toEqual([
                {
                    type: 'default',
                    ranges: [{ row: [1, 2], column: [1, 2] }],
                    format: { textColor: null, cellColor: '#d0fae5' },
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: [formula],
                },
            ]);
        }
    });

    it('repaints a rule that reads a cell when that cell changes', () => {
        const ctx = ctxForRule();
        ctx.sheets[0].data = numberRows([
            [5, 0, 0],
            [0, 4, 6],
            [0, 8, 2],
        ]);
        addConditionRule(ctx, ruleDraft('greaterThan', { rulesValue: '=$A$1' }));
        expect(Object.keys(getComputeMap(ctx) ?? {}).sort()).toEqual(['1_2', '2_1']);
        ctx.sheets[0].data = numberRows([
            [3, 0, 0],
            [0, 4, 6],
            [0, 8, 2],
        ]);
        expect(Object.keys(getComputeMap(ctx) ?? {}).sort()).toEqual(['1_1', '1_2', '2_1']);
    });

    it('takes text that looks like a cell, such as FY2024, as text', () => {
        for (const rulesValue of ['FY2024', 'Q1', 'ID1', 'A1']) {
            for (const rulesType of ['equal', 'textContains'] as const) {
                const ctx = ctxForRule();
                addConditionRule(ctx, ruleDraft(rulesType, { rulesValue }));
                expect(savedRules(ctx)).toMatchObject([{ conditionName: rulesType, conditionValue: [rulesValue] }]);
            }
            expect(refusal(ruleDraft('greaterThan', { rulesValue }))).toBe(NUMBER_OR_CELL);
        }
    });

    it('refuses a range, a list of cells or no cell after =', () => {
        for (const rulesValue of ['=A1:B1', '=A1,B1', '=abc', '=', '=Nowhere!A1']) {
            expect(refusal(ruleDraft('greaterThan', { rulesValue }))).toBe('Enter a single cell, such as =A1');
        }
    });

    it('refuses a Between rule whose second value is empty', () => {
        expect(refusal(ruleDraft('between', { betweenValue: { value1: '1', value2: '' } }))).toBe(NUMBER_OR_CELL);
    });

    it('refuses text where a number rule needs a number', () => {
        const typed: [ConditionRuleType, Partial<ConditionRulesProps>][] = [
            ['greaterThan', { rulesValue: 'abc' }],
            ['lessThan', { rulesValue: ' ' }],
            ['between', { betweenValue: { value1: 'abc', value2: '3' } }],
            ['between', { betweenValue: { value1: '1', value2: 'abc' } }],
        ];
        for (const [rulesType, draft] of typed) {
            expect(refusal(ruleDraft(rulesType, draft))).toBe(NUMBER_OR_CELL);
        }
    });

    it('takes text as the value of Equal to and Text contains, and refuses only an empty one', () => {
        for (const rulesType of ['equal', 'textContains'] as const) {
            const ctx = ctxForRule();
            addConditionRule(ctx, ruleDraft(rulesType, { rulesValue: 'abc' }));
            expect(savedValues(ctx)).toEqual([['abc']]);
            expect(refusal(ruleDraft(rulesType))).toBe('Enter a value, or a cell such as =A1');
        }
    });

    it('refuses a missing date and a count outside 1 to 1000', () => {
        expect(refusal(ruleDraft('occurrenceDate'))).toBe('Select a date');
        expect(refusal(ruleDraft('occurrenceDate', { dateValue: '2026-11-02' }))).toBeUndefined();
        for (const projectValue of ['0', '1001', '2.5', '']) {
            expect(refusal(ruleDraft('top10', { projectValue }))).toBe('Enter a whole number from 1 to 1000');
        }
        expect(refusal(ruleDraft('last10_percent', { projectValue: '1000' }))).toBeUndefined();
    });

    it('takes a rule with no value as it is', () => {
        expect(refusal(ruleDraft('aboveAverage'))).toBeUndefined();
        expect(refusal(ruleDraft('duplicateValue', { repeatValue: '1' }))).toBeUndefined();
    });

    it('reads a cell on another sheet from that sheet', () => {
        const ctx = ctxForRule();
        ctx.sheets[1].name = 'Data';
        ctx.sheets[1].data = numberRows([[6]]);
        ctx.sheets[0].data = numberRows([
            [0, 0, 0],
            [0, 4, 7],
            [0, 9, 1],
        ]);
        addConditionRule(ctx, ruleDraft('greaterThan', { rulesValue: '=Data!$A$1' }));
        expect(savedValues(ctx)).toEqual([['=B2>Data!$A$1']]);
        expect(Object.keys(getComputeMap(ctx) ?? {}).sort()).toEqual(['1_2', '2_1']);
    });
});
