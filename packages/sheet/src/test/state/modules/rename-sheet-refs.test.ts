// A tab rename points every text that names the tab at its new name, as Excel does: formulas, formula rules, list
// sources and links. The batch is one op every receiver's engine runs, so a peer, a joiner, an undo and a redo agree.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { cellLinks } from '../factories/links';

installHappyDom();

const { defaultContext } = await import('../../../state/context');
const { setCellValue } = await import('../../../state/modules/cell');
const { execFunctionGroup, getcellrange, warmFormulaCellInfoMap } = await import('../../../state/modules/formula-exec');
const { insertRowCol } = await import('../../../state/modules/rowcol');
const { editSheetName } = await import('../../../state/modules/sheet');
const { updateDropCell } = await import('../../../state/modules/drop-cell');
const { saveHyperlink } = await import('../../../state/modules/hyperlink');
const { dataToCelldata } = await import('../../../engine/celldata');
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
            },
            cellInput: ref(),
            fxInput: ref(),
            canvas: ref(),
            cellArea: ref(),
            workbookContainer: ref(),
            hooks: { current: {} },
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
    input.innerText = name;
    return tabEdit(t, (ctx) => editSheetName(ctx, sheet.id, input), { renameSheetOp: { id: sheet.id } });
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
            setCellValue(ctx, 0, 0, data, 9);
            execFunctionGroup(ctx, [{ r: 0, c: 0, id: 'id_1' }]);
        });
        expect(t.ctx.sheets[1].data?.[0][0]?.v).toBe(10);
    });

    test('a rename keeps the values: a rewritten ref reads the cell it read', () => {
        const t = workbookTab({ '0_0': '=One!A1' });
        renameFirst(t, 'Inputs');
        const once = t.ctx.sheets[1].data?.[0][0];
        expect(once?.f).toBe('=Inputs!A1');
        renameFirst(t, 'Inputs2');
        expect(t.ctx.sheets[1].data?.[0][0]).toEqual({ ...once, f: '=Inputs2!A1' });
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
                data: [
                    [
                        { link: { type: 'sheet', address: 'One' } },
                        { link: { type: 'cellrange', address: 'One!A1:B2' } },
                        { link: { type: 'webpage', address: 'One' } },
                    ],
                ],
                charts: { c1: chart },
            },
        );
        renameFirst(t, 'Q1 plan');
        const sheet = t.ctx.sheets[1];
        const [rule] = sheet.conditionalFormatRules ?? [];
        expect(rule.type === 'default' && rule.conditionValue).toEqual(["='Q1 plan'!A1>0"]);
        expect(sheet.dataValidations?.list.rule.value1).toBe("'Q1 plan'!$A$1:$A$3");
        expect(sheet.dataValidations?.items.rule.value1).toBe('One,Two');
        expect(cellLinks(sheet)).toEqual({
            '0_0': { type: 'sheet', address: 'Q1 plan' },
            '0_1': { type: 'cellrange', address: "'Q1 plan'!A1:B2" },
            '0_2': { type: 'webpage', address: 'One' },
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

    test("a peer's batch ends the rename's undo and redo", () => {
        const author = workbookTab({ '0_0': '=One!A1' });
        renameFirst(author, 'Inputs');
        tabReceive(author, [{ op: 'replace', id: 'id_2', path: ['data', 1, 1], value: { f: '=Inputs!A1', v: 1 } }]);
        expect(tabUndo(author)).toEqual([]);
        expect(author.ctx.sheets[0].name).toBe('Inputs');
        renameFirst(author, 'Other');
        tabUndo(author);
        tabReceive(author, [{ op: 'replace', id: 'id_2', path: ['color'], value: 'red' }]);
        expect(tabRedo(author)).toEqual([]);
        expect(author.ctx.sheets[0].name).toBe('Inputs');
    });

    test("an undo can't overwrite a peer's later rename, or find its old name taken", () => {
        const author = workbookTab({ '0_0': '=One!A1' });
        renameFirst(author, 'Inputs');
        tabReceive(author, [renameOp('id_1', 'Peer')]);
        expect(tabUndo(author)).toEqual([]);
        expect(author.ctx.sheets[0].name).toBe('Peer');

        const other = workbookTab({});
        renameFirst(other, 'Inputs');
        tabReceive(other, [renameOp('id_2', 'One')]);
        expect(tabUndo(other)).toEqual([]);
        expect(other.ctx.sheets.map((sheet) => sheet.name)).toEqual(['Inputs', 'One']);
    });

    test('a tab that is not the current one is the one renamed, and its op and undo name it', () => {
        const t = workbookTab({ '0_0': '=Two!A1' });
        const input = document.createElement('span');
        input.innerText = 'Second';
        const ops = tabEdit(t, (ctx) => editSheetName(ctx, 'id_2', input), { renameSheetOp: { id: 'id_2' } });
        expect(t.ctx.currentSheetId).toBe('id_1');
        expect(t.ctx.sheets.map((sheet) => sheet.name)).toEqual(['One', 'Second']);
        expect(ops).toEqual([renameOp('id_2', 'Second')]);
        expect(tabUndo(t)).toEqual([renameOp('id_2', 'Two')]);
        expect(t.ctx.sheets.map((sheet) => sheet.name)).toEqual(['One', 'Two']);
        input.innerText = 'a:b';
        expect(() =>
            tabEdit(t, (ctx) => editSheetName(ctx, 'id_2', input), { renameSheetOp: { id: 'id_2' } }),
        ).toThrow();
        expect(input.innerText).toBe('Two');
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

    const insertRowAbove = (t: Tab) => {
        const op = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        return tabEdit(t, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
    };

    // A row op's batch and its undo's carry no name, so neither can undo a rename on any reader.
    test.each([
        ['the rename first', [0, 1]],
        ['the row op first', [1, 0]],
    ])('a rename and a row op, %s in the log, read the tab on the author, a peer and a joiner', (_, order) => {
        const author = workbookTab({ '2_0': '=One!A3' });
        const base = author.ctx;
        const peer = tab(base);
        const rename = renameFirst(author, 'Inputs');
        const insert = insertRowAbove(peer);
        tabReceive(author, insert);
        tabReceive(peer, rename);
        for (const t of [author, peer]) {
            expect(t.ctx.sheets[0].name).toBe('Inputs');
            expect(formula(t, 2, 0)).toBe('=Inputs!A4');
        }
        const log = order.map((i) => [rename, insert][i]);
        expect(join(base, log)[1].celldata?.[0].v?.f).toBe('=Inputs!A4');
    });

    test.each([
        ['after', true],
        ['before', false],
    ])(
        'a row op %s a rename, and its undo, leave the tab its name on the author, a peer and a joiner',
        (_, renamedFirst) => {
            const author = workbookTab({ '2_0': '=One!A3' });
            const base = author.ctx;
            const peer = tab(base);
            const log: Op[][] = [];
            const send = (ops: Op[]) => {
                log.push(ops);
                tabReceive(peer, ops);
            };
            if (renamedFirst) send(renameFirst(author, 'Inputs'));
            send(insertRowAbove(author));
            if (!renamedFirst) send(renameFirst(author, 'Inputs'));
            for (let undo = renamedFirst ? 1 : 2; undo > 0; undo -= 1) send(tabUndo(author));
            expect(log.flat().flatMap(({ path }) => path)).not.toContain('name');
            const name = renamedFirst ? 'Inputs' : 'One';
            for (const sheets of [author.ctx.sheets, peer.ctx.sheets, join(base, log)]) {
                expect(sheets[0].name).toBe(name);
                const [cell] = sheets[1].data ? dataToCelldata(sheets[1].data) : (sheets[1].celldata ?? []);
                expect(cell.v?.f).toBe(`=${name}!A3`);
            }
        },
    );

    describe('a name with a ! in it', () => {
        const named = (cells: Record<string, string>) => {
            const author = workbookTab(cells);
            const base = author.ctx;
            const peer = tab(base);
            const log = [renameFirst(author, 'Q1!')];
            tabReceive(peer, log[0]);
            return { author, base, peer, log };
        };

        test('reads its cells, on a recalc and in a dependent, and a row op and its undo move the ref', () => {
            const { author, base, peer, log } = named({ '0_0': '=One!A1+1', '0_1': '=SUM(One!A1:B2)' });
            expect(formula(author)).toBe("='Q1!'!A1+1");
            expect(join(base, log)[1].celldata?.[0].v?.f).toBe("='Q1!'!A1+1");

            warmFormulaCellInfoMap(author.ctx);
            tabEdit(author, (ctx) => {
                const { data } = ctx.sheets[0];
                if (!data) return;
                setCellValue(ctx, 0, 0, data, 9);
                execFunctionGroup(ctx, [{ r: 0, c: 0, id: 'id_1' }]);
            });
            expect(author.ctx.sheets[1].data?.[0][0]?.v).toBe(10);

            tabReceive(peer, insertRowAbove(author));
            for (const t of [author, peer]) {
                expect(formula(t)).toBe("='Q1!'!A2+1");
                expect(formula(t, 0, 1)).toBe("=SUM('Q1!'!A2:B3)");
            }
            tabReceive(peer, tabUndo(author));
            for (const t of [author, peer]) expect(formula(t)).toBe("='Q1!'!A1+1");
        });

        test('renames again, and its undo reads the plain name', () => {
            const { author } = named({ '0_0': '=One!A1+1' });
            renameFirst(author, 'Plain');
            expect(formula(author)).toBe('=Plain!A1+1');
            tabUndo(author);
            expect(formula(author)).toBe("='Q1!'!A1+1");
        });
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

    // One op over every formula naming the tab would otherwise make a text of the name's size per formula.
    test.each([
        ['past the length limit', 'x'.repeat(32)],
        ['of a megabyte', 'x'.repeat(1_000_000)],
        ['empty', ''],
        ['with a colon', 'a:b'],
        ['with brackets', '[x]'],
        ['with a quote at its end', "x'"],
    ])('a name %s fails its batch on a tab and in the replay', (_, name) => {
        const t = workbookTab({ '0_0': '=One!A1' });
        const bad = [renameOp('id_1', name)];
        const base = t.ctx;
        tabReceive(t, bad);
        expect(t.ctx.sheets[0].name).toBe('One');
        expect(formula(t)).toBe('=One!A1');
        const joined = join(base, [bad]);
        expect(joined[0].name).toBe('One');
        expect(joined[1].celldata?.[0].v?.f).toBe('=One!A1');
    });
});

describe('a rename after a fill down from a linked cell', () => {
    // A1 of the first tab gets a link and fills down to A2, as the fill handle does.
    function linkedAndFilled() {
        const t = workbookTab({ '0_0': '=One!A1' });
        const base = t.ctx;
        const link = tabEdit(t, (ctx) => saveHyperlink(ctx, 0, 0, 'go', 'webpage', 'https://example.com'));
        const fill = tabEdit(t, (ctx) => {
            ctx.selections = [{ row: [0, 1], column: [0, 0], row_focus: 0, column_focus: 0 }];
            updateDropCell(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });
        return { t, base, log: [link, fill] };
    }

    test('the fill ships the link of the cell it fills, with its value', () => {
        const { t, log } = linkedAndFilled();
        const link = { type: 'webpage', address: 'https://example.com' };
        expect(t.ctx.sheets[0].data?.[1][0]?.link).toEqual(link);
        expect(log[1].find(({ path }) => path.join() === 'data,1,0')?.value?.link).toEqual(link);
    });

    test('the peer and the joiner take the rename', () => {
        const { t, base, log } = linkedAndFilled();
        const peer = tab(base);
        for (const ops of log) tabReceive(peer, ops);
        const rename = renameFirst(t, 'Renamed');
        tabReceive(peer, rename);
        for (const sheets of [t.ctx.sheets, peer.ctx.sheets, join(base, [...log, rename])]) {
            expect(sheets[0].name).toBe('Renamed');
            expect(Object.keys(cellLinks(sheets[0]))).toEqual(['0_0', '1_0']);
        }
    });

    test.each([
        ['a link with no value', ['data', 1, 0, 'link'], undefined],
        ['a link that is null', ['data', 1, 0, 'link'], null],
        ['a link of the wrong shape', ['data', 1, 0, 'link'], 'https://example.com'],
        ['a link with no address', ['data', 1, 0, 'link'], { type: 'cellrange' }],
        ['an address that is no text', ['data', 1, 0, 'link'], { type: 'cellrange', address: 5 }],
        ['a whole cell holding a bad link', ['data', 1, 0], { v: 'x', m: 'x', link: null }],
        ['a whole row holding a bad link', ['data', 1], [{ link: { type: 'webpage' } }]],
        ['a write into a link', ['data', 0, 0, 'link', 'address'], 5],
    ])('%s from a peer is dropped, so a later rename still applies', (_, path, value) => {
        const { t, base, log } = linkedAndFilled();
        const forged: Op[] = [{ op: 'replace', id: 'id_1', path, value }];
        tabReceive(t, forged);
        const rename = renameFirst(t, 'Renamed');
        const joined = join(base, [...log, forged, rename]);
        expect(joined[0].name).toBe('Renamed');
        const link = { type: 'webpage', address: 'https://example.com' };
        expect(cellLinks(joined[0])).toEqual({ '0_0': link, '1_0': link });
        expect(cellLinks(t.ctx.sheets[0])).toEqual(cellLinks(joined[0]));
    });
});

describe("a peer's rename empties the undo and redo stacks", () => {
    const setCell = (t: Tab, cell: { v?: string; f?: string }) =>
        tabEdit(t, (ctx) => {
            const { data } = ctx.sheets[1];
            if (data) data[0][0] = cell;
        });

    test('text over a formula naming the tab: an undo brings no formula back', () => {
        const t = workbookTab({ '0_0': '=One!A1' });
        setCell(t, { v: 'text' });
        tabReceive(t, [renameOp('id_1', 'Renamed')]);
        expect(tabUndo(t)).toEqual([]);
        expect(t.ctx.sheets[1].data?.[0][0]?.v).toBe('text');
        expect(t.history.undoList).toEqual([]);
    });

    test('a formula typed and undone: a redo brings nothing back', () => {
        const t = workbookTab({});
        setCell(t, { f: '=One!A1' });
        tabUndo(t);
        tabReceive(t, [renameOp('id_1', 'Renamed')]);
        expect(tabRedo(t)).toEqual([]);
        expect(t.ctx.sheets[1].data?.[0][0]).toBeNull();
        expect(t.history.redoList).toEqual([]);
    });

    test('a formula typed: it stays through an undo, as the rename rewrote it', () => {
        const t = workbookTab({});
        setCell(t, { f: '=One!A1' });
        tabReceive(t, [renameOp('id_1', 'Renamed')]);
        expect(tabUndo(t)).toEqual([]);
        expect(formula(t)).toBe('=Renamed!A1');
    });

    test('a rename its batch fails on, and a batch with no rename, leave them', () => {
        const t = workbookTab({});
        setCell(t, { f: '=One!A1' });
        tabReceive(t, [renameOp('id_1', 'Two')]);
        expect(t.history.undoList).toHaveLength(1);
        tabReceive(t, [{ op: 'replace', id: 'id_2', path: ['data', 3, 3], value: { v: 'peer' } }]);
        expect(t.history.undoList).toHaveLength(1);
    });
});
