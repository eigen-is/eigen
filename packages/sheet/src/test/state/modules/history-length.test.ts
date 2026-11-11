// An edit that changes an array's length has no per-cell undo: its inverse writes the array's `length`, which no check
// can skip for a peer. Each case runs two tabs and a joiner through the real record, applyOp and undo steps, on a sheet
// of 5 rows by 3 columns, and pins that a peer's batch ends such an entry as it ends a row op, and that alone nothing
// changes. A conditional format is a record entry under its id, so adding or removing one is no such edit.

import { describe, expect, test } from 'bun:test';
import { nextRuleOrder } from '@workspace/lib/sheets';
import { dataToCelldata } from '../../../engine/celldata';
import type { InsertRowColOp } from '../../../engine/rowcol';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Context } from '../../../state/context';
import { applyDataBarPreset, deleteSheetRule } from '../../../state/modules/condition-format';
import { insertRowCol } from '../../../state/modules/rowcol';
import type { Op, Sheet } from '../../../state/types';
import { pasteText } from '../factories/clipboard';
import type { Tab } from '../factories/collab';
import { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { workbookContextFactory } from '../factories/context';
import { sel, typed } from '../factories/edit-cycle';
import { formatList, formatsOf } from '../factories/validations';

const ONE = 's1';

type CfRule = ReturnType<typeof formatList>[number];

const rule = (cellColor: string): CfRule => ({
    type: 'default',
    ranges: [{ row: [0, 0], column: [0, 0] }],
    format: { cellColor },
    conditionName: 'formula',
    conditionValue: ['=TRUE'],
});

function session(rules?: CfRule[]) {
    const sheet: Sheet = {
        id: ONE,
        name: 'One',
        order: 0,
        row: 5,
        column: 3,
        config: {},
        data: Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => null)),
        conditionalFormats: rules && formatsOf(rules),
    };
    const base = workbookContextFactory({ currentSheetId: ONE, sheets: [sheet] });
    for (const s of base.sheets) normalizeSheetConfig(s);
    const batches: Op[][] = [];
    const a = tab(base);
    const b = tab(base);
    const send = (from: Tab, ops: Op[]) => {
        if (ops.length === 0) return;
        batches.push(ops);
        for (const to of [a, b]) if (to !== from) tabReceive(to, ops);
    };
    return {
        a,
        b,
        batches,
        edit: (t: Tab, recipe: (ctx: Context) => void, options?: Parameters<typeof tabEdit>[2]) =>
            send(t, tabEdit(t, recipe, options)),
        undo: (t: Tab) => send(t, tabUndo(t)),
        redo: (t: Tab) => send(t, tabRedo(t)),
        joiner: () => join(base, batches),
    };
}

const paste = (r: number, c: number, text: string) => (ctx: Context) => {
    ctx.selections = sel(r, r, c, c);
    pasteText(ctx, text);
};

function values({ data, celldata }: Sheet) {
    return Object.fromEntries((data ? dataToCelldata(data) : (celldata ?? [])).map((x) => [`${x.r},${x.c}`, x.v?.v]));
}

// What a user sees, the size each reader holds the grid at, and that no matrix has a hole.
function expectEveryone(s: ReturnType<typeof session>, cells: Record<string, string>, rows: number, columns = 3) {
    for (const sheet of [s.a.ctx.sheets[0], s.b.ctx.sheets[0], s.joiner()[0]]) {
        expect(values(sheet)).toEqual(cells);
        expect(sheet.row).toBe(rows);
        expect(sheet.column).toBe(columns);
    }
    for (const { data } of [s.a.ctx.sheets[0], s.b.ctx.sheets[0]]) {
        expect(Array.from(data ?? [], (row) => row?.length)).toEqual(Array<number>(rows).fill(columns));
    }
}

const PASTED = { '4,0': 'p1', '5,0': 'p2', '6,0': 'p3' };

describe('a paste that grew the grid', () => {
    test("a peer's cell in the new rows survives the author's undo", () => {
        const s = session();
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.edit(s.b, typed(6, 2, 'PEER'));
        s.undo(s.a);
        expectEveryone(s, { ...PASTED, '6,2': 'PEER' }, 7);
    });

    test("a peer's paste below it survives, and the peer's own undo leaves no hole", () => {
        const s = session();
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.edit(s.b, paste(6, 1, 'q1\nq2\nq3'));
        s.undo(s.a);
        expectEveryone(s, { ...PASTED, '6,1': 'q1', '7,1': 'q2', '8,1': 'q3' }, 9);
        s.undo(s.b);
        expectEveryone(s, PASTED, 7);
    });

    test('the grid takes every later edit once both undo, on each reader', () => {
        const s = session();
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.edit(s.b, paste(6, 1, 'q1\nq2\nq3'));
        s.undo(s.a);
        s.undo(s.b);
        s.edit(s.a, typed(6, 2, 'x'));
        s.edit(s.a, paste(6, 0, 'a\nb\nc'));
        const row: InsertRowColOp = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: ONE };
        s.edit(s.b, (ctx) => insertRowCol(ctx, row), { insertRowColOp: row });
        const column: InsertRowColOp = { type: 'column', index: 0, count: 1, direction: 'lefttop', id: ONE };
        s.edit(s.b, (ctx) => insertRowCol(ctx, column), { insertRowColOp: column });
        expectEveryone(s, { '5,1': 'p1', '6,1': 'p2', '7,1': 'a', '7,3': 'x', '8,1': 'b', '9,1': 'c' }, 10, 4);
    });

    test("a peer's cell in the new columns survives the author's undo", () => {
        const s = session();
        s.edit(s.a, paste(0, 2, 'x\ty\tz'));
        s.edit(s.b, typed(1, 4, 'PEER'));
        s.undo(s.a);
        expectEveryone(s, { '0,2': 'x', '0,3': 'y', '0,4': 'z', '1,4': 'PEER' }, 5, 5);
    });

    test("a peer's batch ends it and what is below it, and what is above it still undoes", () => {
        const s = session();
        s.edit(s.a, typed(0, 0, 'older'));
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.edit(s.a, typed(1, 1, 'newer'));
        s.edit(s.b, typed(2, 2, 'PEER'));
        s.undo(s.a);
        expectEveryone(s, { '0,0': 'older', ...PASTED, '2,2': 'PEER' }, 7);
        s.undo(s.a);
        expectEveryone(s, { '0,0': 'older', ...PASTED, '2,2': 'PEER' }, 7);
    });

    test("a peer's batch ends its redo too", () => {
        const s = session();
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.undo(s.a);
        s.edit(s.b, typed(0, 0, 'PEER'));
        s.redo(s.a);
        expectEveryone(s, { '0,0': 'PEER' }, 5);
    });

    test('alone, undo and redo work as before', () => {
        const s = session();
        s.edit(s.a, paste(4, 0, 'p1\np2\np3'));
        s.undo(s.a);
        expectEveryone(s, {}, 5);
        s.redo(s.a);
        expectEveryone(s, PASTED, 7);
    });

    test('alone, the cap on whole matrices leaves older entries, however many pastes grew the grid', () => {
        const s = session();
        s.edit(s.a, typed(0, 0, 'oldest'));
        for (let i = 0; i < 12; i += 1) s.edit(s.a, paste(5 + i, 0, 'x'));
        for (let i = 0; i < 13; i += 1) s.undo(s.a);
        expectEveryone(s, {}, 5);
    });
});

describe('a conditional format added or taken out', () => {
    const colors = (t: Tab) => formatList(t.ctx.sheets[0].conditionalFormats).map(({ format }) => format);
    const color = (cellColor: string) => ({ cellColor });
    const push = (cellColor: string) => (ctx: Context) => {
        const sheet = ctx.sheets[0];
        const formats = sheet.conditionalFormats ?? {};
        formats[cellColor] = { ...rule(cellColor), order: nextRuleOrder(formats) };
        sheet.conditionalFormats = formats;
    };
    const shift = (ctx: Context) => deleteSheetRule(ctx, 'f1');

    test("a peer's rule survives the undo of a rule pushed before it", () => {
        const s = session([rule('r0')]);
        s.edit(s.a, push('A'));
        s.edit(s.b, push('B'));
        s.undo(s.a);
        expect(colors(s.a)).toEqual([color('r0'), color('B')]);
        expect(colors(s.b)).toEqual(colors(s.a));
        expect(s.joiner()[0].conditionalFormats).toEqual(s.a.ctx.sheets[0].conditionalFormats);
    });

    test('so does one the toolbar adds', () => {
        const s = session([rule('r0')]);
        s.edit(s.a, (ctx) => {
            ctx.selections = sel(0, 0, 0, 0);
            applyDataBarPreset(ctx, 'solidColorDataBar_6');
        });
        s.edit(s.b, push('B'));
        s.undo(s.a);
        expect(colors(s.a)).toHaveLength(2);
        expect(colors(s.b)).toEqual(colors(s.a));
    });

    test('alone, a pushed rule undoes and redoes', () => {
        const s = session([rule('r0')]);
        s.edit(s.a, push('A'));
        s.undo(s.a);
        expect(colors(s.b)).toEqual([color('r0')]);
        s.redo(s.a);
        expect(colors(s.b)).toEqual([color('r0'), color('A')]);
    });

    test('alone, a rule taken out comes back in its place', () => {
        const s = session([rule('r0'), rule('r1')]);
        s.edit(s.a, shift);
        s.undo(s.a);
        expect(colors(s.a)).toEqual([color('r0'), color('r1')]);
        expect(colors(s.b)).toEqual(colors(s.a));
    });

    test("a peer's batch leaves the undo of a rule taken out", () => {
        const s = session([rule('r0'), rule('r1')]);
        s.edit(s.a, shift);
        s.edit(s.b, push('B'));
        s.undo(s.a);
        expect(colors(s.a)).toEqual([color('r0'), color('r1'), color('B')]);
        expect(colors(s.b)).toEqual(colors(s.a));
    });
});

// A list inside one target is that target's own write: a peer's edit elsewhere leaves the entry on the stack.
describe('an array inside one target stays a plain entry', () => {
    test('a range added to a rule', () => {
        const s = session([rule('r0')]);
        s.edit(s.a, (ctx) => {
            ctx.sheets[0].conditionalFormats?.f1.ranges.push({ row: [1, 1], column: [1, 1] });
        });
        s.edit(s.b, typed(0, 0, 'PEER'));
        expect(s.a.history.undoList).toHaveLength(1);
    });

    test('a run added to a rich cell', () => {
        const s = session();
        s.edit(s.a, (ctx) => {
            const { data } = ctx.sheets[0];
            if (data) data[0][0] = { ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'one' }] } };
        });
        s.edit(s.a, (ctx) => {
            ctx.sheets[0].data?.[0][0]?.ct?.s?.push({ v: 'two' });
        });
        s.edit(s.b, typed(1, 1, 'PEER'));
        expect(s.a.history.undoList).toHaveLength(2);
    });
});
