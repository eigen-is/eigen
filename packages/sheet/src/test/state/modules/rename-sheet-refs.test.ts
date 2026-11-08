// A tab rename points every text that names the tab at its new name, as Excel does: formulas, formula rules, list
// sources and links. The batch is one op every receiver's engine runs, so a peer, a joiner, an undo and a redo agree.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { defaultContext } = await import('../../../state/context');
const { setCellValue } = await import('../../../state/modules/cell');
const { execFunctionGroup, getcellrange, groupValuesRefresh, warmFormulaCellInfoMap } = await import(
    '../../../state/modules/formula-exec'
);
const { editSheetName } = await import('../../../state/modules/sheet');
const { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } = await import('../factories/collab');
type Tab = import('../factories/collab').Tab;
type Sheet = import('../../../state/types').Sheet;
type Op = import('../../../state/types').Op;

function matrix(cells: Record<string, string>) {
    const rows: ({ f?: string; v?: number; m?: string } | null)[][] = Array.from({ length: 4 }, () =>
        Array.from({ length: 4 }, () => null),
    );
    for (const [key, f] of Object.entries(cells)) {
        const [r, c] = key.split('_').map(Number);
        rows[r][c] = { f, v: 1, m: '1' };
    }
    return rows;
}

// The first tab holds a value at A1, the second the cells and the fields a test gives it.
function workbookTab(cells: Record<string, string>, extra: Partial<Sheet> = {}, names = ['One', 'Two']): Tab {
    const ref = <T>(): { current: T | null } => ({ current: null });
    const first = matrix({});
    first[0][0] = { v: 5, m: '5' };
    const sheets: Sheet[] = names.map((name, order) => ({
        id: `id_${order + 1}`,
        name,
        order,
        config: {},
        calcChain:
            order === 1
                ? Object.keys(cells).map((key) => {
                      const [r, c] = key.split('_').map(Number);
                      return { r, c, id: 'id_2' };
                  })
                : [],
        data: order === 0 ? first : order === 1 ? matrix(cells) : matrix({}),
        ...(order === 1 ? extra : {}),
    }));
    return tab({
        ...defaultContext({
            globalCache: {
                undoList: [],
                redoList: [],
                scrollLeft: 0,
                scrollTop: 0,
                scrollListeners: new Set(),
                notifyScrollListeners: () => {},
            },
            cellInput: ref(),
            fxInput: ref(),
            canvas: ref(),
            cellArea: ref(),
            workbookContainer: ref(),
        }),
        sheets,
        currentSheetId: 'id_1',
        allowEdit: true,
    });
}

// As the tab bar does: the first sheet is current, and its tab holds the new text.
function renameFirst(t: Tab, name: string): Op[] {
    const input = document.createElement('span');
    const [sheet] = t.ctx.sheets;
    input.dataset.oldText = sheet.name;
    input.innerText = name;
    return tabEdit(t, (ctx) => editSheetName(ctx, input), { renameSheetOp: { id: sheet.id, name, from: sheet.name } });
}

const renameOp = (id: string, name: unknown): Op => ({ op: 'renameSheet', id, path: [], value: { name } });
const formula = (t: Tab, r = 0, c = 0) => t.ctx.sheets[1].data?.[r][c]?.f;
const firstRow = (t: Tab) => t.ctx.sheets[1].data?.[0].map((cell) => cell?.f);

describe('a tab rename rewrites the text that names the tab', () => {
    test('a formula naming the old name reads the tab after the rename', () => {
        const t = workbookTab({ '0_0': '=One!A1+1' });
        renameFirst(t, 'Inputs');
        expect(t.ctx.sheets[0].name).toBe('Inputs');
        expect(formula(t)).toBe('=Inputs!A1+1');
        warmFormulaCellInfoMap(t.ctx);
        expect(t.ctx.formulaCache.dependencyIndex.dependentsOf('id_1', 0, 0)).toEqual(['r0c0iid_2']);
    });

    test('an edit of the tab recomputes a formula that named it before the rename', () => {
        const t = workbookTab({ '0_0': '=One!A1+1' });
        renameFirst(t, 'Inputs');
        tabEdit(t, (ctx) => {
            const { data } = ctx.sheets[0];
            if (!data) return;
            execFunctionGroup(ctx, 0, 0, 9, 'id_1');
            setCellValue(ctx, 0, 0, data, 9);
            groupValuesRefresh(ctx);
        });
        expect(t.ctx.sheets[1].data?.[0][0]?.v).toBe(10);
    });

    test('a rename keeps the values: a rewritten ref reads the cell it read', () => {
        const t = workbookTab({ '0_0': '=One!A1' });
        const before = t.ctx.sheets[1].data?.[0][0];
        renameFirst(t, 'Inputs');
        expect(t.ctx.sheets[1].data?.[0][0]).toEqual({ ...before, f: '=Inputs!A1' });
    });

    test('a quoted name, a case variant and both legs of a range are rewritten', () => {
        const t = workbookTab(
            {
                '0_0': "='My data'!A1+1",
                '0_1': "=SUM('My data'!A1:B2)",
                '0_2': "='MY DATA'!$A$1",
                '0_3': "=SUM('My data'!A1:'My data'!B2)",
            },
            {},
            ['My data', 'Two'],
        );
        renameFirst(t, 'Inputs');
        expect(firstRow(t)).toEqual([
            '=Inputs!A1+1',
            '=SUM(Inputs!A1:B2)',
            '=Inputs!$A$1',
            '=SUM(Inputs!A1:Inputs!B2)',
        ]);
    });

    test('a new name that needs quotes gets them, a quote in it doubled', () => {
        const t = workbookTab({ '0_0': '=One!A1', '0_1': '=SUM(One!A1:B2)' });
        renameFirst(t, 'Q1 plan');
        expect(formula(t)).toBe("='Q1 plan'!A1");
        expect(formula(t, 0, 1)).toBe("=SUM('Q1 plan'!A1:B2)");
        renameFirst(t, "Q1's");
        expect(formula(t)).toBe("='Q1''s'!A1");
    });

    test('a sheet whose name contains the old name, a string and spacing stay as written', () => {
        const t = workbookTab(
            {
                '0_0': "='One Two'!A1+Onerous!A1+One!A1",
                '0_1': '=Onerous!A1',
                '0_2': '=CONCAT("One!A1",One!A1)',
                '0_3': '=A1  +  Two!B1',
            },
            {},
            ['One', 'Two', 'One Two', 'Onerous'],
        );
        renameFirst(t, 'Inputs');
        expect(firstRow(t)).toEqual([
            "='One Two'!A1+Onerous!A1+Inputs!A1",
            '=Onerous!A1',
            '=CONCAT("One!A1",Inputs!A1)',
            '=A1  +  Two!B1',
        ]);
    });

    test('a formula rule, a list source and a link follow the rename, and a chart ref needs nothing', () => {
        const chart = {
            id: 'c1',
            index: 'a0',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            specChart: '{}',
            specTitle: '{}',
            specLegend: '{}',
            specData: '{"values":{"sheetId":"id_1","row":[0,1],"column":[0,0]}}',
            specAxes: {},
            specPlots: {},
            specSeries: {},
            specPoints: {},
        };
        const t = workbookTab(
            {},
            {
                conditionalFormatRules: [
                    {
                        type: 'default',
                        conditionName: 'formula',
                        conditionValue: ['=One!A1>0'],
                        cellrange: [{ row: [0, 0], column: [0, 0] }],
                        format: {},
                    },
                ],
                dataValidations: {
                    list: {
                        ranges: [{ row: [0, 0], column: [0, 0] }],
                        rule: { type: 'dropdown', type2: '', value1: 'One!$A$1:$A$3', value2: '' },
                    },
                    items: {
                        ranges: [{ row: [1, 1], column: [0, 0] }],
                        rule: { type: 'dropdown', type2: '', value1: 'One,Two', value2: '' },
                    },
                },
                hyperlink: {
                    '0_0': { linkType: 'sheet', linkAddress: 'One' },
                    '0_1': { linkType: 'cellrange', linkAddress: 'One!A1:B2' },
                    '0_2': { linkType: 'webpage', linkAddress: 'One' },
                },
                charts: { c1: chart },
            },
        );
        renameFirst(t, 'Q1 plan');
        const sheet = t.ctx.sheets[1];
        const [rule] = sheet.conditionalFormatRules ?? [];
        expect(rule.type === 'default' && rule.conditionValue).toEqual(["='Q1 plan'!A1>0"]);
        expect(sheet.dataValidations?.list.rule.value1).toBe("'Q1 plan'!$A$1:$A$3");
        expect(sheet.dataValidations?.items.rule.value1).toBe('One,Two');
        expect(sheet.hyperlink).toEqual({
            '0_0': { linkType: 'sheet', linkAddress: 'Q1 plan' },
            '0_1': { linkType: 'cellrange', linkAddress: "'Q1 plan'!A1:B2" },
            '0_2': { linkType: 'webpage', linkAddress: 'One' },
        });
        expect(getcellrange(t.ctx, "'Q1 plan'!A1")?.sheetId).toBe('id_1');
        expect(sheet.charts?.c1).toEqual(chart);
    });

    test('the batch is one small op, whatever the workbook holds', () => {
        const t = workbookTab({ '0_0': '=One!A1', '0_1': '=One!B1', '1_0': '=One!C1' });
        expect(renameFirst(t, 'Inputs')).toEqual([renameOp('id_1', 'Inputs')]);
    });

    test('a peer and a joiner end as the author, a sheet with only stored cells included', () => {
        const author = workbookTab({ '0_0': '=One!A1', '0_1': "=SUM('One'!A1:B2)" }, {}, ['One', 'Two', 'Three']);
        const base = author.ctx;
        const peer = tab(base);
        const batch = renameFirst(author, 'Q1 plan');
        tabReceive(peer, batch);
        expect(peer.ctx.sheets).toEqual(author.ctx.sheets);
        const joined = join(base, [batch]);
        expect(joined[0].name).toBe('Q1 plan');
        // The batch writes no cell, so the joiner's sheets keep their stored cells and get no matrix.
        expect(joined[1].data).toBeUndefined();
        expect(joined[1].celldata?.map(({ r, c, v }) => [r, c, v?.f])).toEqual([
            [0, 0, "='Q1 plan'!A1"],
            [0, 1, "=SUM('Q1 plan'!A1:B2)"],
        ]);
    });

    test('undo and redo rewrite back and forth, on the author, a peer and a joiner', () => {
        const author = workbookTab({ '0_0': '=One!A1+1' });
        const base = author.ctx;
        const peer = tab(base);
        const batches = [renameFirst(author, 'Q1 plan')];
        tabReceive(peer, batches[0]);

        batches.push(tabUndo(author));
        tabReceive(peer, batches[1]);
        expect(batches[1]).toEqual([renameOp('id_1', 'One')]);
        expect(author.ctx.sheets[0].name).toBe('One');
        expect(formula(author)).toBe('=One!A1+1');
        expect(formula(peer)).toBe('=One!A1+1');
        expect(join(base, batches)[1].celldata?.[0].v?.f).toBe('=One!A1+1');

        batches.push(tabRedo(author));
        tabReceive(peer, batches[2]);
        expect(author.ctx.sheets[0].name).toBe('Q1 plan');
        expect(formula(author)).toBe("='Q1 plan'!A1+1");
        expect(formula(peer)).toBe("='Q1 plan'!A1+1");
        expect(join(base, batches)[1].celldata?.[0].v?.f).toBe("='Q1 plan'!A1+1");
    });

    test('an undo also rewrites a formula a peer wrote since, under the new name', () => {
        const author = workbookTab({ '0_0': '=One!A1' });
        renameFirst(author, 'Inputs');
        tabReceive(author, [{ op: 'replace', id: 'id_2', path: ['data', 1, 1], value: { f: '=Inputs!A1', v: 1 } }]);
        tabUndo(author);
        expect(formula(author, 1, 1)).toBe('=One!A1');
    });

    test('of two renames to one name, the later in the log is dropped on every tab', () => {
        const author = workbookTab({ '0_0': '=One!A1', '0_1': '=Two!A1' });
        const base = author.ctx;
        const taken = [renameOp('id_2', 'Same')];
        const late = [renameOp('id_1', 'same')];
        tabReceive(author, taken);
        tabReceive(author, late);
        expect(author.ctx.sheets.map((sheet) => sheet.name)).toEqual(['One', 'Same']);
        expect(formula(author)).toBe('=One!A1');
        expect(join(base, [taken, late]).map((sheet) => sheet.name)).toEqual(['One', 'Same']);
    });

    test('a rename and a row op land in either order with the same formulas', () => {
        const { ctx: base } = workbookTab({ '2_0': '=One!A3' });
        const insert: Op = {
            op: 'insertRowCol',
            id: 'id_1',
            path: [],
            value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
        };
        const rename = renameOp('id_1', 'Inputs');
        expect(join(base, [[insert], [rename]])[1].celldata?.[0].v?.f).toBe('=Inputs!A4');
        expect(join(base, [[rename], [insert]])[1].celldata?.[0].v?.f).toBe('=Inputs!A4');
    });

    test('a malformed rename fails its batch, and one on a sheet that is gone changes nothing', () => {
        const t = workbookTab({ '0_0': '=One!A1' });
        const bad = [renameOp('id_1', 7), { op: 'replace' as const, id: 'id_1', path: ['color'], value: 'red' }];
        tabReceive(t, bad);
        expect(t.ctx.sheets[0].name).toBe('One');
        expect(t.ctx.sheets[0].color).toBeUndefined();
        expect(join(t.ctx, [bad])[0].color).toBeUndefined();
        tabReceive(t, [renameOp('gone', 'X')]);
        expect(formula(t)).toBe('=One!A1');
    });
});
