// Sort, fill, copy, cut, move and the format painter, as real Excel does them. Each case runs two tabs and a joiner
// through the real record, applyOp and undo steps, and pins what a person sees, what an undo restores and that a peer's
// rule written meanwhile survives: a sort moves a cell and its link and writes no rule, and a carry takes a rule off a
// cell whose source has none and joins a source's rule to the one on the sheet.

import { describe, expect, test } from 'bun:test';
import type { CellLink, ConditionalFormatRule, DataValidationRule } from '@workspace/lib/sheets';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { Context } from '../../state/context';
import { copy } from '../../state/modules/clipboard';
import { mergeCells } from '../../state/modules/merge';
import { pasteHandlerOfPaintModel } from '../../state/modules/selection';
import { sortRange } from '../../state/modules/sort';
import { handleFormatPainter } from '../../state/modules/toolbar';
import { validationAt } from '../../state/modules/validation-rules';
import type { Cell, Op, Sheet } from '../../state/types';
import { pasteCopy } from './factories/clipboard';
import type { Tab } from './factories/collab';
import { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from './factories/collab';
import { workbookContextFactory } from './factories/context';
import { dragFill } from './factories/grid-dom';
import { cellLinks } from './factories/links';

const ONE = 's1';
const TWO = 's2';
const SIDE = { style: 1, color: '#000' };
const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is/' };

const text = (v: string): Cell => ({ v, m: v, ct: { fa: 'General', t: 's' } });
const number = (v: number): Cell => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });
const calculated = (f: string, v: number): Cell => ({ ...number(v), f });
const linked = (v: string): Cell => ({ ...text(v), link: LINK });
const range = (r1: number, r2: number, c1: number, c2: number) => ({ row: [r1, r2], column: [c1, c2] });
const select = (r1: number, r2: number, c1: number, c2: number) => [
    { ...range(r1, r2, c1, c2), row_focus: r1, column_focus: c1 },
];

const dropdown = (value1: string): DataValidationRule => ({
    type: 'dropdown',
    type2: '',
    value1,
    value2: '',
    prohibitInput: false,
    hintShow: false,
    hintValue: '',
});
const greater = (cellrange: ConditionalFormatRule['cellrange'], value = 5): ConditionalFormatRule => ({
    type: 'default',
    cellrange,
    format: { cellColor: '#ff0000' },
    conditionName: 'greaterThan',
    conditionValue: [value],
});
const formula = (cellrange: ConditionalFormatRule['cellrange'], value: string): ConditionalFormatRule => ({
    type: 'default',
    cellrange,
    format: { cellColor: '#ff0000' },
    conditionName: 'formula',
    conditionValue: [value],
});

function emptySheet(id: string, order: number, seed: Partial<Sheet> = {}): Sheet {
    return {
        id,
        name: id,
        order,
        row: 12,
        column: 6,
        config: {},
        data: Array.from({ length: 12 }, () => Array.from({ length: 6 }, () => null)),
        conditionalFormatRules: [],
        ...seed,
    };
}

function session(seed: (data: (Cell | null)[][]) => void, sheet: Partial<Sheet> = {}) {
    const one = emptySheet(ONE, 0, sheet);
    if (one.data) seed(one.data);
    const base = workbookContextFactory({
        currentSheetId: ONE,
        selections: select(0, 0, 0, 0),
        sheets: [one, emptySheet(TWO, 1)],
    });
    for (const s of base.sheets) normalizeSheetConfig(s);
    const batches: Op[][] = [];
    const a = tab(base);
    const b = tab(base);
    const send = (from: Tab, ops: Op[]) => {
        if (ops.length === 0) return ops;
        batches.push(ops);
        for (const to of [a, b]) if (to !== from) tabReceive(to, ops);
        return ops;
    };
    return {
        a,
        b,
        batches,
        send,
        edit: (t: Tab, recipe: (ctx: Context) => void) => send(t, tabEdit(t, recipe)),
        undo: (t: Tab) => send(t, tabUndo(t)),
        everyone: (id = ONE) => [
            a.ctx.sheets.find((s) => s.id === id),
            b.ctx.sheets.find((s) => s.id === id),
            join(base, batches).find((s) => s.id === id),
        ],
    };
}

type Session = ReturnType<typeof session>;

// Two tabs and a joiner hold the same side tables and the same cell text, undone back to the start when asked.
function expectEveryoneAgrees(s: Session, check: (sheet: Sheet) => void) {
    for (const sheet of s.everyone()) {
        if (!sheet) throw new Error('no sheet');
        check(sheet);
    }
}

function sideTables({ config, dataValidations, conditionalFormatRules, data }: Sheet) {
    return { borderInfo: config?.borderInfo, dataValidations, conditionalFormatRules, data };
}

function expectUndoRestores(s: Session, edit: () => void) {
    const before = structuredClone(sideTables(s.a.ctx.sheets[0]));
    edit();
    s.undo(s.a);
    expect(sideTables(s.a.ctx.sheets[0])).toEqual(before);
    expect(sideTables(s.b.ctx.sheets[0])).toEqual(before);
}

const shown = (sheet: Sheet, r: number, c: number) => sheet.data?.[r]?.[c]?.v;
const writesTo = (ops: Op[], field: string) => ops.filter((op) => op.path[0] === field);

describe('a sort moves what a cell holds, and leaves the rest where it is', () => {
    // Column A sorts b, c, a into a, b, c. a is bordered and yellow, b linked, c validated.
    const rows = (sheet: Partial<Sheet> = {}) =>
        session(
            (d) => {
                d[0][0] = linked('b');
                d[1][0] = text('c');
                d[2][0] = { ...text('a'), bg: '#ffff00' };
            },
            {
                config: { borderInfo: { '2_0': { t: SIDE } } },
                dataValidations: { v: { ranges: [range(1, 1, 0, 0)], rule: dropdown('c') } },
                ...sheet,
            },
        );
    const sort = (ctx: Context) => sortRange(ctx, range(0, 2, 0, 0), true);

    test('its text, cell format and link move, and its border and validation stay', () => {
        const s = rows();
        s.edit(s.a, sort);
        expectEveryoneAgrees(s, (sheet) => {
            expect([0, 1, 2].map((r) => shown(sheet, r, 0))).toEqual(['a', 'b', 'c']);
            expect(sheet.data?.[0][0]?.bg).toBe('#ffff00');
            expect(cellLinks(sheet)).toEqual({ '1_0': LINK });
            expect(sheet.config?.borderInfo).toEqual({ '2_0': { t: SIDE } });
            expect(sheet.dataValidations?.v.ranges).toEqual([range(1, 1, 0, 0)]);
        });
    });

    test('and an undo puts it all back', () => {
        const s = rows();
        expectUndoRestores(s, () => s.edit(s.a, sort));
    });

    test('it writes no border and no rule', () => {
        const s = rows({
            conditionalFormatRules: [greater([range(1, 1, 0, 0)]), formula([range(0, 2, 0, 0)], '=$B1>0')],
        });
        const ops = s.edit(s.a, sort);
        expect(ops.filter((op) => op.path[0] !== 'data')).toEqual([]);
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(1, 1, 0, 0)]);
        });
    });

    test('a row that stays and a cell that lands on its twin are not written', () => {
        const s = session((d) => {
            d[0][0] = text('b');
            d[0][1] = text('same');
            d[1][0] = text('a');
            d[1][1] = text('same');
            d[2][0] = text('c');
        });
        const ops = s.edit(s.a, (ctx) => sortRange(ctx, range(0, 2, 0, 1), true));
        expect(ops.map((op) => op.path)).toEqual([
            ['data', 0, 0],
            ['data', 1, 0],
        ]);
    });

    test('rows already in order write nothing', () => {
        const s = session((d) => {
            d[0][0] = text('a');
            d[1][0] = text('b');
        });
        expect(s.edit(s.a, (ctx) => sortRange(ctx, range(0, 1, 0, 0), true))).toEqual([]);
        expect(s.a.history.undoList.at(-1)?.patches ?? []).toEqual([]);
    });

    test('a relative reference follows the row and an absolute one stays', () => {
        const s = session((d) => {
            d[0][0] = number(2);
            d[0][1] = calculated('=A1*$D$1', 20);
            d[1][0] = number(1);
            d[1][1] = calculated('=A2*$D$1', 10);
            d[0][3] = number(10);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 1, 0, 1), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.data?.[0][1]).toMatchObject({ f: '=A1*$D$1', v: 10 });
            expect(sheet.data?.[1][1]).toMatchObject({ f: '=A2*$D$1', v: 20 });
        });
    });
});

// A formula landed on a new row is recalculated in the same edit, which writes into its ct.
describe('a table of formulas moves', () => {
    test('a sort of a formula reading beside the range takes the value of its new row', () => {
        const s = session((d) => {
            d[0][0] = number(2);
            d[0][1] = calculated('=D1*2', 20);
            d[0][3] = number(10);
            d[1][0] = number(1);
            d[1][1] = calculated('=D2*2', 60);
            d[1][3] = number(30);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 1, 0, 1), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.data?.[0][1]).toMatchObject({ f: '=D1*2', v: 20, m: '20' });
            expect(sheet.data?.[1][1]).toMatchObject({ f: '=D2*2', v: 60, m: '60' });
        });
    });

    test('a formula moved onto a result of another type takes that type', () => {
        const s = session((d) => {
            d[0][0] = number(2);
            d[0][1] = { f: '=IF(D1>1,"big",0)', v: 'big', m: 'big', ct: { fa: 'General', t: 's' } };
            d[0][3] = number(2);
            d[1][0] = number(1);
            d[1][1] = { f: '=IF(D2>1,"big",0)', v: 0, m: '0', ct: { fa: '##0.00', t: 'n' } };
            d[1][3] = number(1);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 1, 0, 1), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.data?.[0][1]).toMatchObject({ v: 'big', m: 'big', ct: { fa: '##0.00', t: 'g' } });
            expect(sheet.data?.[1][1]).toMatchObject({ v: 0, m: '0', ct: { fa: 'General', t: 'n' } });
        });
    });

    test('a sort by a formula reading to its right', () => {
        const s = session((d) => {
            d[0][0] = calculated('=B1*2', 6);
            d[0][1] = number(3);
            d[1][0] = calculated('=B2*2', 2);
            d[1][1] = number(1);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 1, 0, 1), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.data?.[0][0]).toMatchObject({ f: '=B1*2', v: 2, ct: { t: 'n' } });
            expect(sheet.data?.[1][0]).toMatchObject({ f: '=B2*2', v: 6, ct: { t: 'n' } });
        });
    });

    test('a sort with a formula that reads another sorted row', () => {
        const s = session((d) => {
            d[0][0] = number(2);
            d[0][1] = calculated('=A3', 9);
            d[1][0] = number(1);
            d[1][1] = calculated('=A3', 9);
            d[2][0] = number(9);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 2, 0, 1), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.data?.[0][1]).toMatchObject({ f: '=A2', v: 2 });
            expect(sheet.data?.[1][1]?.f).toBe('=A4');
        });
    });

    test('a sort under a running total', () => {
        const s = session((d) => {
            d[0][0] = number(3);
            d[0][1] = calculated('=A1', 3);
            d[1][0] = number(1);
            d[1][1] = calculated('=B1+A2', 4);
            d[2][0] = number(2);
            d[2][1] = calculated('=B2+A3', 6);
        });
        s.edit(s.a, (ctx) => sortRange(ctx, range(0, 2, 0, 0), true));
        expectEveryoneAgrees(s, (sheet) => {
            expect([0, 1, 2].map((r) => shown(sheet, r, 1))).toEqual([1, 3, 6]);
        });
        const inside = session((d) => {
            d[0][0] = number(3);
            d[0][1] = calculated('=A1', 3);
            d[1][0] = number(1);
            d[1][1] = calculated('=B1+A2', 4);
        });
        inside.edit(inside.a, (ctx) => sortRange(ctx, range(0, 1, 0, 1), true));
        expectEveryoneAgrees(inside, (sheet) => {
            expect(sheet.data?.[1][1]).toMatchObject({ f: '=A2', v: 3 });
        });
    });

    test('a cut of a formula that reads the cells it leaves', () => {
        const s = session((d) => {
            d[0][0] = number(1);
            d[0][1] = calculated('=SUM(A1:A2)', 3);
            d[1][0] = number(2);
        });
        s.edit(s.a, (ctx) => {
            ctx.selections = select(0, 0, 0, 1);
            copy(ctx, { cut: true });
            ctx.selections = select(5, 5, 2, 2);
            pasteCopy(ctx);
        });
        expectEveryoneAgrees(s, (sheet) => {
            expect(shown(sheet, 5, 2)).toBe(1);
            expect(sheet.data?.[5][3]).toMatchObject({ v: 2, ct: { t: 'n' } });
            expect(sheet.data?.[0][1] ?? null).toBeNull();
        });
    });

    test('a cut that lands on itself changes nothing', () => {
        const s = session(
            (d) => {
                d[0][0] = { ...number(1), link: LINK };
                d[0][1] = calculated('=A1', 1);
            },
            {
                config: { borderInfo: { '0_0': { t: SIDE } } },
                dataValidations: { v: { ranges: [range(0, 0, 0, 0)], rule: dropdown('v') } },
                conditionalFormatRules: [greater([range(0, 0, 0, 0)])],
            },
        );
        const before = structuredClone(sideTables(s.a.ctx.sheets[0]));
        s.edit(s.a, (ctx) => {
            ctx.selections = select(0, 0, 0, 1);
            copy(ctx, { cut: true });
            ctx.selections = select(0, 0, 0, 0);
            pasteCopy(ctx);
        });
        expect(sideTables(s.a.ctx.sheets[0])).toEqual(before);
    });
});

describe('a source cell without a rule takes the destination rule away, cell by cell', () => {
    const columnC = (sheet: Partial<Sheet> = {}) =>
        session((d) => {
            d[0][0] = text('plain');
            d[1][0] = text('plain too');
            d[0][2] = number(1);
            d[1][2] = number(2);
            d[2][2] = number(3);
        }, sheet);
    const pasteOn = (r: number, c: number) => (ctx: Context) => {
        ctx.selections = select(0, 0, 0, 0);
        copy(ctx, {});
        ctx.selections = select(r, r, c, c);
        pasteCopy(ctx);
    };

    test('a paste leaves a hole in a conditional format', () => {
        const s = columnC({ conditionalFormatRules: [greater([range(0, 2, 2, 2)])] });
        s.edit(s.a, pasteOn(1, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([greater([range(0, 0, 2, 2), range(2, 2, 2, 2)])]);
        });
    });

    test('and in a validation', () => {
        const rule = dropdown('v');
        const s = columnC({ dataValidations: { v: { ranges: [range(0, 2, 2, 2)], rule } } });
        s.edit(s.a, pasteOn(1, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.dataValidations?.v).toEqual({ ranges: [range(0, 0, 2, 2), range(2, 2, 2, 2)], rule });
        });
    });

    test('a fill does the same, from a source inside no rule', () => {
        const rule = dropdown('v');
        const s = session(
            (d) => {
                d[0][0] = text('plain');
                d[1][0] = text('kept');
            },
            {
                dataValidations: { v: { ranges: [range(1, 3, 0, 0)], rule } },
                conditionalFormatRules: [greater([range(1, 3, 0, 0)])],
            },
        );
        s.edit(s.a, (ctx) => {
            dragFill(ctx, range(0, 0, 0, 0), range(1, 2, 0, 0), 'down');
        });
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.dataValidations?.v.ranges).toEqual([range(3, 3, 0, 0)]);
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(3, 3, 0, 0)]);
        });
    });

    test('a rule left with no cell goes, and the rule after it stays', () => {
        const s = columnC({ conditionalFormatRules: [greater([range(1, 1, 2, 2)]), greater([range(9, 9, 5, 5)], 1)] });
        s.edit(s.a, pasteOn(1, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([greater([range(9, 9, 5, 5)], 1)]);
        });
        const u = columnC({ conditionalFormatRules: [greater([range(1, 1, 2, 2)]), greater([range(9, 9, 5, 5)], 1)] });
        expectUndoRestores(u, () => u.edit(u.a, pasteOn(1, 2)));
    });

    test('a landed cell takes its source rule in place of the one it had', () => {
        const s = session(
            (d) => {
                d[0][0] = number(9);
            },
            { conditionalFormatRules: [greater([range(0, 0, 0, 0)]), greater([range(0, 2, 2, 2)], 1)] },
        );
        s.edit(s.a, pasteOn(1, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([
                greater([range(0, 0, 0, 0), range(1, 1, 2, 2)]),
                greater([range(0, 0, 2, 2), range(2, 2, 2, 2)], 1),
            ]);
        });
    });

    test.each([
        ['the middle', 1, '=C1>0', [range(0, 0, 2, 2), range(2, 2, 2, 2)]],
        ['the corner', 0, '=C2>0', [range(1, 2, 2, 2)]],
    ] as const)('a formula rule still reads its own cells after a hole in %s', (_, r, shifted, ranges) => {
        const s = columnC({ conditionalFormatRules: [formula([range(0, 2, 2, 2)], '=C1>0')] });
        s.edit(s.a, pasteOn(r, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([formula([...ranges], shifted)]);
        });
    });

    test('a paste inside a formula rule that lands on its corner moves the corner', () => {
        const s = columnC({ conditionalFormatRules: [formula([range(0, 2, 2, 2)], '=C1>0')] });
        s.edit(s.a, (ctx) => {
            ctx.selections = select(1, 1, 2, 2);
            copy(ctx, {});
            ctx.selections = select(0, 0, 2, 2);
            pasteCopy(ctx);
        });
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([formula([range(1, 2, 2, 2), range(0, 0, 2, 2)], '=C2>0')]);
        });
    });

    test('only the landed cells change, on a sheet of rules, and an undo restores them', () => {
        const seed = {
            dataValidations: { far: { ranges: [range(11, 11, 5, 5)], rule: dropdown('far') } },
            conditionalFormatRules: [greater([range(11, 11, 4, 4)]), greater([range(0, 2, 2, 2)], 1)],
        };
        const s = columnC(seed);
        const ops = s.edit(s.a, pasteOn(1, 2));
        expect(writesTo(ops, 'dataValidations')).toEqual([]);
        expect(writesTo(ops, 'conditionalFormatRules').map((op) => op.path)).toEqual([['conditionalFormatRules', 1]]);
        const u = columnC(seed);
        expectUndoRestores(u, () => u.edit(u.a, pasteOn(1, 2)));
    });

    test('a rule beside the area is not written, whatever its ranges look like', () => {
        const s = columnC({ conditionalFormatRules: [greater([range(0, 0, 2, 2), range(1, 1, 2, 2)])] });
        const ops = s.edit(s.a, pasteOn(5, 5));
        expect(writesTo(ops, 'conditionalFormatRules')).toEqual([]);
    });

    test("a peer's new rule sent at once survives a hole", () => {
        const s = columnC({ conditionalFormatRules: [greater([range(0, 2, 2, 2)])] });
        const mine = tabEdit(s.a, pasteOn(1, 2));
        const theirs = tabEdit(s.b, (ctx) => {
            ctx.sheets[0].conditionalFormatRules?.push(greater([range(9, 9, 5, 5)], 1));
        });
        tabReceive(s.a, theirs);
        tabReceive(s.b, mine);
        s.batches.push(theirs, mine);
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([
                greater([range(0, 0, 2, 2), range(2, 2, 2, 2)]),
                greater([range(9, 9, 5, 5)], 1),
            ]);
        });
    });

    test('on another sheet a paste takes the rule off the cell it lands on', () => {
        const s = columnC();
        s.edit(s.a, (ctx) => {
            ctx.sheets[1].conditionalFormatRules = [greater([range(0, 2, 2, 2)])];
        });
        s.edit(s.a, (ctx) => {
            ctx.selections = select(0, 0, 0, 0);
            copy(ctx, {});
            ctx.currentSheetId = TWO;
            ctx.selections = select(1, 1, 2, 2);
            pasteCopy(ctx);
            ctx.currentSheetId = ONE;
        });
        for (const sheet of s.everyone(TWO)) {
            expect(sheet?.conditionalFormatRules).toEqual([greater([range(0, 0, 2, 2), range(2, 2, 2, 2)])]);
        }
    });
});

describe('a source with a rule extends it', () => {
    test('paste twice along a row, and it is one rule', () => {
        const s = session(
            (d) => {
                d[0][3] = number(9);
            },
            {
                dataValidations: { v: { ranges: [range(0, 0, 3, 3)], rule: dropdown('v') } },
                conditionalFormatRules: [greater([range(0, 0, 3, 3)])],
            },
        );
        for (const c of [4, 5]) {
            s.edit(s.a, (ctx) => {
                ctx.selections = select(0, 0, 3, 3);
                copy(ctx, {});
                ctx.selections = select(0, 0, c, c);
                pasteCopy(ctx);
            });
        }
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([greater([range(0, 0, 3, 5)])]);
            expect(sheet.dataValidations?.v.ranges).toEqual([range(0, 0, 3, 5)]);
        });
    });

    test('paste twice on another sheet, and it is one validation', () => {
        const s = session(
            (d) => {
                d[0][0] = number(9);
            },
            {
                dataValidations: { v: { ranges: [range(0, 0, 0, 0)], rule: dropdown('v') } },
                conditionalFormatRules: [greater([range(0, 0, 0, 0)])],
            },
        );
        for (const c of [0, 1]) {
            s.edit(s.a, (ctx) => {
                ctx.selections = select(0, 0, 0, 0);
                copy(ctx, {});
                ctx.currentSheetId = TWO;
                ctx.selections = select(0, 0, c, c);
                pasteCopy(ctx);
                ctx.currentSheetId = ONE;
            });
        }
        for (const sheet of s.everyone(TWO)) {
            expect(sheet?.conditionalFormatRules).toEqual([greater([range(0, 0, 0, 1)])]);
            expect(Object.values(sheet?.dataValidations ?? {})).toEqual([
                { ranges: [range(0, 0, 0, 1)], rule: dropdown('v') },
            ]);
        }
    });

    test('a paste inside its own validation writes no rule', () => {
        const s = session(
            (d) => {
                d[0][0] = number(9);
            },
            { dataValidations: { v: { ranges: [range(0, 2, 0, 0)], rule: dropdown('v') } } },
        );
        const ops = s.edit(s.a, (ctx) => {
            ctx.selections = select(0, 0, 0, 0);
            copy(ctx, {});
            ctx.selections = select(1, 1, 0, 0);
            pasteCopy(ctx);
        });
        expect(writesTo(ops, 'dataValidations')).toEqual([]);
    });

    test('a fill down gives one range', () => {
        const s = session(
            (d) => {
                d[0][5] = number(9);
            },
            {
                dataValidations: { v: { ranges: [range(0, 0, 5, 5)], rule: dropdown('v') } },
                conditionalFormatRules: [greater([range(0, 0, 5, 5)])],
            },
        );
        s.edit(s.a, (ctx) => {
            dragFill(ctx, range(0, 0, 5, 5), range(1, 3, 5, 5), 'down');
        });
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(0, 3, 5, 5)]);
            expect(sheet.dataValidations?.v.ranges).toEqual([range(0, 3, 5, 5)]);
        });
    });
});

describe('a tab, a peer and a joiner agree through a whole session', () => {
    // What anyone can see of a sheet: its cells' formulas, values and formats, and the side tables.
    const seen = ({ data, config, dataValidations, conditionalFormatRules }: Sheet) => ({
        cells: data?.map((row) =>
            row.map((cell) => (cell ? { f: cell.f, v: cell.v, bg: cell.bg, t: cell.ct?.t, link: cell.link } : null)),
        ),
        borderInfo: config?.borderInfo,
        dataValidations,
        conditionalFormatRules,
    });

    test('a sort, a fill and a paste, each undone and redone', () => {
        const s = session(
            (d) => {
                d[0][0] = calculated('=B1*2', 6);
                d[0][1] = { ...number(3), bg: '#ffff00' };
                d[0][2] = linked('three');
                d[1][0] = calculated('=B2*2', 2);
                d[1][1] = number(1);
                d[1][2] = text('one');
                d[2][0] = calculated('=B3*2', 4);
                d[2][1] = number(2);
                d[2][2] = text('two');
                d[5][4] = text('plain');
            },
            {
                config: { borderInfo: { '0_1': { t: SIDE } } },
                dataValidations: { v: { ranges: [range(0, 5, 2, 2)], rule: dropdown('v') } },
                conditionalFormatRules: [formula([range(0, 5, 1, 1)], '=B1>1')],
            },
        );
        const edits: ((ctx: Context) => void)[] = [
            (ctx) => sortRange(ctx, range(0, 2, 0, 2), true),
            (ctx) => {
                dragFill(ctx, range(0, 2, 0, 2), range(3, 4, 0, 2), 'down');
            },
            (ctx) => {
                ctx.selections = select(5, 5, 4, 4);
                copy(ctx, {});
                ctx.selections = select(1, 1, 1, 1);
                pasteCopy(ctx);
            },
        ];
        const expectSame = () => {
            const [a, b, joined] = s.everyone().map((sheet) => {
                if (!sheet) throw new Error('no sheet');
                return seen(sheet);
            });
            expect(b).toEqual(a);
            // With nothing to replay a joiner holds stored cells and no matrix yet.
            if (s.batches.length > 0) expect(joined).toEqual(a);
            return a;
        };
        for (const edit of edits) {
            const before = expectSame();
            s.edit(s.a, edit);
            const after = expectSame();
            s.send(s.a, tabUndo(s.a));
            expect(expectSame()).toEqual(before);
            s.send(s.a, tabRedo(s.a));
            expect(expectSame()).toEqual(after);
        }
        const sheet = s.a.ctx.sheets[0];
        expect(sheet.data?.[0][0]).toMatchObject({ f: '=B1*2', v: 2 });
        expect(cellLinks(sheet)['2_2']).toEqual(LINK);
        expect(sheet.config?.borderInfo?.['0_1']).toEqual({ t: SIDE });
        expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(0, 0, 1, 1), range(2, 5, 1, 1)]);
    });
});

describe('a fill lands through the carry', () => {
    const fillDown =
        (from: number[], to: number[], c1 = 0, c2 = 0) =>
        (ctx: Context) => {
            dragFill(ctx, range(from[0], from[1], c1, c2), range(to[0], to[1], c1, c2), 'down');
        };

    test('copies a link onto every filled cell, and an undo takes them away', () => {
        const seeded = () =>
            session((d) => {
                d[0][0] = linked('site');
            });
        const s = seeded();
        s.edit(s.a, fillDown([0, 0], [1, 2]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(cellLinks(sheet)).toEqual({ '0_0': LINK, '1_0': LINK, '2_0': LINK });
        });
        const u = seeded();
        expectUndoRestores(u, () => u.edit(u.a, fillDown([0, 0], [1, 2])));
    });

    test('takes the link of a cell it overwrites from a source without one', () => {
        const s = session((d) => {
            d[0][0] = text('plain');
            d[1][0] = linked('old');
        });
        s.edit(s.a, fillDown([0, 0], [1, 1]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(cellLinks(sheet)).toEqual({});
        });
    });

    test('a hidden row keeps its cell, its link, and takes no rule', () => {
        const s = session(
            (d) => {
                d[0][0] = linked('site');
                d[2][0] = text('hidden');
            },
            {
                config: { rowhidden: { 2: 0 } },
                dataValidations: { v: { ranges: [range(0, 0, 0, 0)], rule: dropdown('v') } },
                conditionalFormatRules: [greater([range(0, 0, 0, 0)])],
            },
        );
        s.edit(s.a, fillDown([0, 0], [1, 3]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(shown(sheet, 2, 0)).toBe('hidden');
            expect(cellLinks(sheet)).toEqual({ '0_0': LINK, '1_0': LINK, '3_0': LINK });
            expect(validationAt(sheet.dataValidations, 2, 0)).toBeUndefined();
            expect(validationAt(sheet.dataValidations, 3, 0)).toEqual(dropdown('v'));
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(0, 1, 0, 0), range(3, 3, 0, 0)]);
        });
    });

    test('a hidden column in a downward fill stays out of the rule too', () => {
        const s = session(
            (d) => {
                d[0][0] = text('a');
                d[0][1] = text('b');
                d[0][2] = text('c');
            },
            {
                config: { colhidden: { 1: 0 } },
                conditionalFormatRules: [greater([range(0, 0, 0, 2)])],
            },
        );
        s.edit(s.a, fillDown([0, 0], [1, 2], 0, 2));
        expectEveryoneAgrees(s, (sheet) => {
            expect(shown(sheet, 1, 1)).toBeUndefined();
            expect(shown(sheet, 1, 2)).toBe('c');
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([
                range(0, 0, 0, 2),
                range(1, 2, 0, 0),
                range(1, 2, 2, 2),
            ]);
        });
    });

    test('a rule grows only over the cells that repeat a cell inside it', () => {
        const s = session(
            (d) => {
                d[0][0] = number(1);
                d[1][0] = text('x');
            },
            { conditionalFormatRules: [greater([range(0, 0, 0, 0)])] },
        );
        s.edit(s.a, fillDown([0, 1], [2, 5]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([
                range(0, 0, 0, 0),
                range(2, 2, 0, 0),
                range(4, 4, 0, 0),
            ]);
        });
    });

    test('an undo takes a rule back off the filled cells, alone in the tab', () => {
        const s = session(
            (d) => {
                d[0][0] = number(7);
            },
            { conditionalFormatRules: [greater([range(0, 0, 0, 0)])] },
        );
        expectUndoRestores(s, () => s.edit(s.a, fillDown([0, 0], [1, 3])));
    });

    test("a fill's rule write is one entry, and a peer's new rule sent at once survives", () => {
        const s = session(
            (d) => {
                d[0][0] = number(7);
            },
            { conditionalFormatRules: [greater([range(0, 0, 0, 0)])] },
        );
        const mine = tabEdit(s.a, fillDown([0, 0], [1, 3]));
        const theirs = tabEdit(s.b, (ctx) => {
            ctx.sheets[0].conditionalFormatRules?.push(greater([range(9, 9, 5, 5)], 1));
        });
        expect(writesTo(mine, 'conditionalFormatRules').map((op) => op.path)).toEqual([['conditionalFormatRules', 0]]);
        tabReceive(s.a, theirs);
        tabReceive(s.b, mine);
        s.batches.push(theirs, mine);
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([
                greater([range(0, 3, 0, 0)]),
                greater([range(9, 9, 5, 5)], 1),
            ]);
        });
    });

    test('a fill up lands each link and rule by the source cell it repeats', () => {
        const s = session(
            (d) => {
                d[4][0] = linked('site');
                d[5][0] = text('plain');
            },
            {
                conditionalFormatRules: [greater([range(4, 4, 0, 0)])],
            },
        );
        s.edit(s.a, (ctx) => {
            dragFill(ctx, range(4, 5, 0, 0), range(0, 3, 0, 0), 'up');
        });
        expectEveryoneAgrees(s, (sheet) => {
            expect(Object.keys(cellLinks(sheet)).sort()).toEqual(['0_0', '2_0', '4_0']);
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([
                range(4, 4, 0, 0),
                range(0, 0, 0, 0),
                range(2, 2, 0, 0),
            ]);
        });
    });
});

describe('a paste joins the rule on the sheet', () => {
    const copyPaste =
        (source: number[], to: [number, number], { cut = false, sheet = ONE } = {}) =>
        (ctx: Context) => {
            ctx.currentSheetId = ONE;
            ctx.selections = select(source[0], source[1], source[2], source[3]);
            copy(ctx, { cut });
            ctx.currentSheetId = sheet;
            ctx.selections = select(to[0], to[0], to[1], to[1]);
            pasteCopy(ctx);
            ctx.currentSheetId = ONE;
        };
    const withRule = (rule: ConditionalFormatRule) =>
        session(
            (d) => {
                d[1][1] = number(9);
            },
            { conditionalFormatRules: [rule] },
        );

    test('a copy adds no second rule, however often it lands', () => {
        const s = withRule(greater([range(1, 1, 1, 1)]));
        s.edit(s.a, copyPaste([1, 1, 1, 1], [5, 1]));
        s.edit(s.a, copyPaste([1, 1, 1, 1], [6, 1]));
        s.edit(s.a, copyPaste([1, 1, 1, 1], [6, 1]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([greater([range(1, 1, 1, 1), range(5, 6, 1, 1)])]);
        });
    });

    test('and writes that one entry, which an undo restores', () => {
        const s = withRule(greater([range(1, 1, 1, 1)]));
        const ops = s.edit(s.a, copyPaste([1, 1, 1, 1], [5, 1]));
        expect(writesTo(ops, 'conditionalFormatRules').map((op) => op.path)).toEqual([['conditionalFormatRules', 0]]);
        s.undo(s.a);
        expect(s.b.ctx.sheets[0].conditionalFormatRules).toEqual([greater([range(1, 1, 1, 1)])]);
    });

    test('a formula rule keeps its corner, so a copy above it stays alive', () => {
        const s = withRule(formula([range(4, 9, 0, 0)], '=A4>0'));
        s.edit(s.a, copyPaste([4, 4, 0, 0], [0, 0]));
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules).toEqual([formula([range(4, 9, 0, 0), range(0, 0, 0, 0)], '=A4>0')]);
        });
    });

    test('a copy onto a cell the rule covers changes nothing of the rule', () => {
        const s = withRule(greater([range(1, 5, 1, 1)]));
        const ops = s.edit(s.a, copyPaste([1, 1, 1, 1], [3, 1]));
        expect(writesTo(ops, 'conditionalFormatRules')).toEqual([]);
    });

    test('on another sheet a second paste joins the rule the first one made', () => {
        const s = withRule(formula([range(1, 1, 1, 1)], '=B2>0'));
        s.edit(s.a, copyPaste([1, 1, 1, 1], [3, 3], { sheet: TWO }));
        s.edit(s.a, copyPaste([1, 1, 1, 1], [7, 2], { sheet: TWO }));
        for (const sheet of s.everyone(TWO)) {
            expect(sheet?.conditionalFormatRules).toEqual([formula([range(3, 3, 3, 3), range(7, 7, 2, 2)], '=D4>0')]);
        }
    });

    test('a cut within the sheet writes only the rule over the cut cells', () => {
        const s = session(
            (d) => {
                d[1][1] = number(9);
            },
            { conditionalFormatRules: [greater([range(1, 1, 1, 1)]), greater([range(9, 9, 5, 5)])] },
        );
        const ops = s.edit(s.a, copyPaste([1, 1, 1, 1], [5, 1], { cut: true }));
        expect(writesTo(ops, 'conditionalFormatRules').map((op) => op.path)).toEqual([['conditionalFormatRules', 0]]);
        expectEveryoneAgrees(s, (sheet) => {
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([range(5, 5, 1, 1)]);
        });
    });

    test("a cut to another sheet keeps a peer's rule on both sheets", () => {
        const s = withRule(greater([range(1, 2, 1, 1)]));
        const ops = s.edit(s.a, copyPaste([1, 1, 1, 1], [3, 3], { cut: true, sheet: TWO }));
        for (const op of writesTo(ops, 'conditionalFormatRules')) expect(op.path.length).toBe(2);
        const [one] = s.everyone(ONE);
        const [two] = s.everyone(TWO);
        expect(one?.conditionalFormatRules?.[0].cellrange).toEqual([range(2, 2, 1, 1)]);
        expect(two?.conditionalFormatRules?.[0].cellrange).toEqual([range(3, 3, 3, 3)]);
    });
});

describe('the format painter lands rules as a copy does', () => {
    const paint = (to: number[]) => (ctx: Context) => {
        ctx.selections = select(0, 2, 0, 0);
        handleFormatPainter(ctx);
        ctx.selections = select(to[0], to[1], to[2], to[3]);
        if (ctx.painterSource) pasteHandlerOfPaintModel(ctx, ctx.painterSource);
    };

    test("a filter's skipped row takes no rule, and two paints add no second rule", () => {
        const s = session(
            (d) => {
                d[0][0] = number(1);
                d[1][0] = number(2);
                d[2][0] = number(3);
            },
            {
                config: { rowhidden: { 1: 0 } },
                filter: { 0: { rowhidden: { 1: 0 }, optionstate: true, str: 0, edr: 2, cindex: 0, stc: 0, edc: 0 } },
                // The rule covers only the row the filter hides and the last one.
                conditionalFormatRules: [greater([range(1, 2, 0, 0)])],
            },
        );
        s.edit(s.a, paint([5, 6, 2, 2]));
        s.edit(s.a, paint([5, 6, 2, 2]));
        expectEveryoneAgrees(s, (sheet) => {
            // The carried rows are 0 and 2, so only the second landed row is inside the rule.
            expect(sheet.conditionalFormatRules).toEqual([greater([range(1, 2, 0, 0), range(6, 6, 2, 2)])]);
        });
    });
});

// A paste reads the live cells, so a merge made after the copy can start outside the copied block.
test('a copied cell merged since into a merge above the block lands as a plain cell', () => {
    const s = session((d) => {
        d[0][0] = text('top');
        d[1][0] = text('copied');
    });
    s.edit(s.a, (ctx) => {
        ctx.selections = select(1, 1, 0, 0);
        copy(ctx);
    });
    s.edit(s.a, (ctx) => mergeCells(ctx, ONE, [range(0, 1, 0, 0)], 'merge-all'));
    s.edit(s.a, (ctx) => {
        ctx.selections = select(5, 5, 3, 3);
        pasteCopy(ctx);
    });
    expectEveryoneAgrees(s, (sheet) => {
        expect(sheet.data?.[5][3]?.mc).toBeUndefined();
        expect(sheet.config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 1 } });
    });
});
