import { describe, expect, it } from 'bun:test';
import type { SingleRange } from '@workspace/lib/sheets';
import type { Context } from '../../../index';
import { getComputeMap } from '../../../state/modules/condition-format';
import { contextFactory } from '../factories/context';

function ctxWithRules(): Context {
    const ctx = contextFactory() as Context;
    for (const sheet of ctx.sheets) {
        sheet.conditionalFormatRules = [
            {
                type: 'default',
                cellrange: [{ row: [0, 3], column: [0, 3] }],
                format: { cellColor: '#ff0000' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ];
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
        ctx.sheets[0].conditionalFormatRules = [...ctx.sheets[0].conditionalFormatRules!];

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
function painted(formula: string, cellrange: SingleRange[]): string[] {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].name = 'Sheet1';
    ctx.sheets[0].data = numberRows(GRID);
    ctx.sheets[1].name = 'Data';
    ctx.sheets[1].data = numberRows([
        [1, 0],
        [0, 1],
    ]);
    ctx.sheets[0].conditionalFormatRules = [
        {
            type: 'default',
            cellrange,
            format: { cellColor: '#ff0000' },
            conditionName: 'formula',
            conditionRange: [],
            conditionValue: [formula],
        },
    ];
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

    it('anchors each range of a rule at its own top-left', () => {
        expect(painted('=A1>2', [range(0, 1, 0, 0), range(3, 4, 1, 1)])).toEqual(['1_0', '4_1']);
    });

    it('paints nothing for a formula that does not parse', () => {
        expect(painted('=A1>', [range(0, 5, 0, 1)])).toEqual([]);
    });
});
