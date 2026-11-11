// Conditional formats and validation rules are records by id with an order key, so every write names its rule. Each
// case runs two tabs and a joiner through the real record, applyOp and undo steps on a sheet of 6 rows by 3 columns:
// rules added at once both stay, a delete hits the rule it named, the last rule in order wins a cell, and a rule's
// ranges move and carry under its id.

import { describe, expect, test } from 'bun:test';
import { orderedRules } from '@workspace/lib/sheets';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Context } from '../../../state/context';
import {
    addConditionRule,
    applyDataBarPreset,
    clearSheetRules,
    deleteSheetRule,
} from '../../../state/modules/condition-format';
import { applyDataValidation } from '../../../state/modules/data-validation';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { validationAt } from '../../../state/modules/validation-rules';
import type {
    ConditionalFormatRule,
    ConditionRulesProps,
    DataValidationRule,
    Op,
    Sheet,
    SheetValidation,
    SingleRange,
} from '../../../state/types';
import type { Tab } from '../factories/collab';
import { join, tab, tabEdit, tabReceive, tabUndo } from '../factories/collab';
import { workbookContextFactory } from '../factories/context';
import { pasteInternal, sel, typed } from '../factories/edit-cycle';

const ONE = 's1';
const area = (r1: number, r2: number, c1: number, c2: number): SingleRange => ({ row: [r1, r2], column: [c1, c2] });

const format = (order: string, cellColor: string, ranges = [area(0, 0, 0, 0)]): ConditionalFormatRule => ({
    type: 'default',
    ranges,
    order,
    format: { cellColor },
    conditionName: 'greaterThan',
    conditionValue: [1],
});

const LIST: DataValidationRule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const NUMBER: DataValidationRule = { type: 'number', type2: 'greaterThan', value1: '1', value2: '' };

const DRAFT: ConditionRulesProps = {
    rulesType: 'greaterThan',
    rulesValue: '5',
    textColor: { check: false, color: '#000000' },
    cellColor: { check: true, color: '#ff0000' },
    betweenValue: { value1: '', value2: '' },
    dateValue: '',
    repeatValue: '0',
    projectValue: '10',
};

function session(rules: Pick<Sheet, 'conditionalFormats' | 'dataValidations'> = {}) {
    const sheet: Sheet = {
        id: ONE,
        name: 'One',
        order: 0,
        row: 6,
        column: 3,
        config: {},
        data: Array.from({ length: 6 }, () => Array.from({ length: 3 }, () => null)),
        ...rules,
    };
    const base = workbookContextFactory({ currentSheetId: ONE, sheets: [sheet] });
    for (const s of base.sheets) normalizeSheetConfig(s);
    const batches: Op[][] = [];
    const a = tab(base);
    const b = tab(base);
    const send = (from: Tab, ops: Op[]) => {
        if (ops.length === 0) return;
        batches.push(ops);
        tabReceive(from === a ? b : a, ops);
    };
    return {
        a,
        b,
        batches,
        edit: (t: Tab, recipe: (ctx: Context) => void, options?: Parameters<typeof tabEdit>[2]) =>
            send(t, tabEdit(t, recipe, options)),
        // Both tabs edit before either hears of the other's batch, and A's lands first in the log. B then stands for
        // no reader: a tab whose batch landed second replays the log, as the joiner does.
        atOnce: (
            mine: (ctx: Context) => void,
            theirs: (ctx: Context) => void,
            options?: Parameters<typeof tabEdit>[2],
        ) => {
            const fromA = tabEdit(a, mine, options);
            const fromB = tabEdit(b, theirs);
            batches.push(fromA, fromB);
            tabReceive(a, fromB);
            b.ctx = a.ctx;
        },
        undo: (t: Tab) => send(t, tabUndo(t)),
        joiner: () => join(base, batches)[0],
    };
}

const formats = (sheet: Sheet) => orderedRules(sheet.conditionalFormats);
const colors = (sheet: Sheet) =>
    formats(sheet).map(([, rule]) => (rule.type === 'default' ? rule.format.cellColor : rule.type));
const select = (r: number, c: number, recipe: (ctx: Context) => void) => (ctx: Context) => {
    ctx.selections = sel(r, r, c, c);
    recipe(ctx);
};

function expectAgreed(s: ReturnType<typeof session>) {
    const [mine] = s.a.ctx.sheets;
    expect(s.b.ctx.sheets[0].conditionalFormats).toEqual(mine.conditionalFormats);
    expect(s.b.ctx.sheets[0].dataValidations).toEqual(mine.dataValidations);
    expect(s.joiner().conditionalFormats).toEqual(mine.conditionalFormats);
    expect(s.joiner().dataValidations).toEqual(mine.dataValidations);
    return mine;
}

describe('conditional formats by id', () => {
    test('two rules added at once on a sheet with none both stay, in one order on every reader', () => {
        const s = session();
        s.atOnce(
            select(0, 0, (ctx) => addConditionRule(ctx, DRAFT)),
            select(1, 1, (ctx) => applyDataBarPreset(ctx, 'solidColorDataBar_1')),
        );
        const sheet = expectAgreed(s);
        expect(colors(sheet).sort()).toEqual(['#ff0000', 'dataBar']);
        expect(colors(s.b.ctx.sheets[0])).toEqual(colors(sheet));
    });

    test('an added rule is one write under its id, and it goes last', () => {
        const s = session({ conditionalFormats: { x: format('a0', 'x') } });
        s.edit(
            s.a,
            select(2, 2, (ctx) => addConditionRule(ctx, DRAFT)),
        );
        expect(s.batches[0]).toHaveLength(1);
        expect(s.batches[0][0]).toMatchObject({ op: 'add', id: ONE });
        expect(s.batches[0][0].path).toHaveLength(2);
        expect(s.batches[0][0].path[0]).toBe('conditionalFormats');
        expect(colors(expectAgreed(s))).toEqual(['x', '#ff0000']);
    });

    test("a delete takes out the rule it named, whatever a peer's add and delete did to the others", () => {
        const stored = { x: format('a1', 'x'), y: format('a2', 'y'), z: format('a3', 'z') };
        const s = session({ conditionalFormats: stored });
        s.atOnce(
            (ctx) => deleteSheetRule(ctx, 'y'),
            (ctx) => deleteSheetRule(ctx, 'x'),
        );
        expect(colors(expectAgreed(s))).toEqual(['z']);
        expect(s.batches[0]).toEqual([{ op: 'remove', id: ONE, path: ['conditionalFormats', 'y'], value: undefined }]);
    });

    test("clearing a sheet's rules leaves a rule a peer added at the same time", () => {
        const s = session({ conditionalFormats: { x: format('a1', 'x'), y: format('a2', 'y') } });
        s.atOnce(
            clearSheetRules,
            select(1, 1, (ctx) => addConditionRule(ctx, DRAFT)),
        );
        expect(colors(expectAgreed(s))).toEqual(['#ff0000']);
    });

    test("an added rule and a deleted one stay on the undo stack through a peer's batch", () => {
        const s = session({ conditionalFormats: { x: format('a1', 'x'), y: format('a2', 'y') } });
        s.edit(
            s.a,
            select(2, 2, (ctx) => addConditionRule(ctx, DRAFT)),
        );
        s.edit(s.a, (ctx) => deleteSheetRule(ctx, 'x'));
        s.edit(s.b, typed(0, 0, 'PEER'));
        s.edit(
            s.b,
            select(1, 1, (ctx) => applyDataBarPreset(ctx, 'solidColorDataBar_1')),
        );
        expect(s.a.history.undoList).toHaveLength(2);
        s.undo(s.a);
        expect(colors(expectAgreed(s))).toEqual(['x', 'y', '#ff0000', 'dataBar']);
        s.undo(s.a);
        expect(colors(expectAgreed(s))).toEqual(['x', 'y', 'dataBar']);
    });

    test('a row insert moves each rule under its id and ships none, so a rule a peer added at once stays as written', () => {
        const s = session({ conditionalFormats: { x: format('a1', 'x', [area(2, 3, 0, 0)]) } });
        const insert = { type: 'row', index: 1, count: 2, direction: 'lefttop', id: ONE } as const;
        s.atOnce(
            (ctx) => insertRowCol(ctx, insert),
            (ctx) => {
                ctx.selections = [area(4, 4, 1, 1)];
                addConditionRule(ctx, DRAFT);
            },
            { insertRowColOp: insert },
        );
        expect(s.batches[0].map(({ op }) => op)).toEqual(['insertRowCol']);
        const sheet = expectAgreed(s);
        expect(formats(sheet).map(([, rule]) => rule.ranges)).toEqual([[area(4, 5, 0, 0)], [area(4, 4, 1, 1)]]);
    });

    test("the undo of a deleted rule puts it back where a peer's row insert moved its cells", () => {
        const s = session({ conditionalFormats: { x: format('a1', 'x', [area(2, 3, 0, 0)]) } });
        s.edit(s.a, (ctx) => deleteSheetRule(ctx, 'x'));
        const insert = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: ONE } as const;
        s.edit(s.b, (ctx) => insertRowCol(ctx, insert), { insertRowColOp: insert });
        s.undo(s.a);
        expect(expectAgreed(s).conditionalFormats).toEqual({ x: format('a1', 'x', [area(3, 4, 0, 0)]) });
    });

    test('the undo of a row delete that took a rule sends that rule under its id, never the whole record', () => {
        const stored = { x: format('a1', 'x', [area(2, 3, 0, 0)]), y: format('a2', 'y', [area(5, 5, 0, 0)]) };
        const s = session({ conditionalFormats: stored });
        const remove = { type: 'row', start: 2, end: 3, id: ONE } as const;
        s.edit(s.a, (ctx) => deleteRowCol(ctx, remove), { deleteRowColOp: remove });
        expect(expectAgreed(s).conditionalFormats).toEqual({ y: format('a2', 'y', [area(3, 3, 0, 0)]) });
        s.undo(s.a);
        const ruleWrites = s.batches[1].filter(({ path }) => path[0] === 'conditionalFormats');
        expect(ruleWrites.map(({ op, path }) => [op, ...path])).toEqual([['add', 'conditionalFormats', 'x']]);
        expect(expectAgreed(s).conditionalFormats).toEqual(stored);
    });

    test('a paste inside the sheet lands on the source rule, one write under its id', () => {
        const s = session({ conditionalFormats: { x: format('a1', 'x'), y: format('a2', 'y', [area(5, 5, 2, 2)]) } });
        s.edit(s.a, typed(0, 0, '7'));
        s.edit(s.a, pasteInternal([0, 0], [3, 1]));
        const ruleWrites = s.batches[1].filter(({ path }) => path[0] === 'conditionalFormats');
        expect(ruleWrites.map(({ op, path }) => [op, ...path])).toEqual([['replace', 'conditionalFormats', 'x']]);
        expect(expectAgreed(s).conditionalFormats?.['x'].ranges).toEqual([area(0, 0, 0, 0), area(3, 3, 1, 1)]);
    });
});

describe('validation rules by id', () => {
    const entry = (order: string, rule: DataValidationRule, ranges = [area(0, 0, 0, 0)]): SheetValidation => ({
        ranges,
        order,
        rule,
    });

    test('the last rule in order wins a cell two rules cover, whatever their ids', () => {
        const s = session({ dataValidations: { zz: entry('a1', LIST), aa: entry('a2', NUMBER) } });
        expect(validationAt(s.a.ctx.sheets[0].dataValidations, 0, 0)).toEqual(NUMBER);
        const tied = session({ dataValidations: { zz: entry('a1', LIST), aa: entry('a1', NUMBER) } });
        expect(validationAt(tied.a.ctx.sheets[0].dataValidations, 0, 0)).toEqual(LIST);
    });

    test('a new rule goes last, so it wins its cells on a tab that still holds an older rule there', () => {
        const s = session({ dataValidations: { zz: entry('a1', LIST, [area(0, 5, 0, 0)]) } });
        s.atOnce(
            (ctx) => applyDataValidation(ctx, area(0, 0, 0, 0), NUMBER),
            (ctx) => applyDataValidation(ctx, area(0, 1, 0, 0), { ...LIST, value1: 'c,d' }),
        );
        const sheet = expectAgreed(s);
        const winner = validationAt(sheet.dataValidations, 0, 0);
        expect(winner).toEqual(
            orderedRules(sheet.dataValidations).findLast(([, { ranges }]) => ranges[0].row[0] === 0)?.[1].rule,
        );
        expect(validationAt(sheet.dataValidations, 3, 0)).toEqual(LIST);
    });

    test('a carried rule on another cell of its sheet joins its id', () => {
        const s = session({ dataValidations: { v: entry('a1', LIST) } });
        s.edit(s.a, pasteInternal([0, 0], [4, 2]));
        const ruleWrites = s.batches[0].filter(({ path }) => path[0] === 'dataValidations');
        expect(ruleWrites.map(({ op, path }) => [op, ...path])).toEqual([['replace', 'dataValidations', 'v']]);
        expect(expectAgreed(s).dataValidations?.['v']).toEqual(entry('a1', LIST, [area(0, 0, 0, 0), area(4, 4, 2, 2)]));
    });
});
