// A link lives on its cell: what each writer of a cell does to it, and what a peer's whole sheet may bring.

import { describe, expect, test } from 'bun:test';
import type { CellLink } from '@workspace/lib/sheets';
import { renameSheetTexts, sheetFinder } from '../../../engine';
import { replaySheetsOps } from '../../../engine/replay-ops';
import type { Context } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import {
    getCellHyperlink,
    goToLink,
    removeHyperlink,
    saveHyperlink,
    showLinkCard,
} from '../../../state/modules/hyperlink';
import { mergeCells } from '../../../state/modules/merge';
import { deleteSheet } from '../../../state/modules/sheet';
import { handleClearFormat } from '../../../state/modules/toolbar';
import { author, tab, tabEdit, tabUndo } from '../factories/collab';
import { contextFactory } from '../factories/context';
import { cellLinks } from '../factories/links';

const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const everyCell = [{ row: [0, 0], column: [0, 1], row_focus: 0, column_focus: 0 }];

function grid(): Context {
    return contextFactory({
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                data: [
                    [{ v: 'a', m: 'a' }, { v: 'b', m: 'b' }, null],
                    [null, null, null],
                ],
                config: {},
            },
            { name: 'Other', id: 'id_2', data: [[null]], config: {} },
        ],
        selections: everyCell,
    }) as Context;
}

function linkedGrid(): Context {
    const { next } = author(grid(), (ctx) => saveHyperlink(ctx, 0, 0, 'a', LINK.type, LINK.address));
    return next;
}

test('a web address is saved without the spaces around it', () => {
    const ctx = grid();
    saveHyperlink(ctx, 0, 0, 'a', 'webpage', '  eigen.is  ');
    expect(getCellHyperlink(ctx, 0, 0)).toEqual({ type: 'webpage', address: 'eigen.is' });
});

describe('the writers of a cell', () => {
    test('a typed value keeps the link, as Excel does', () => {
        const { next } = author(linkedGrid(), (ctx) => updateCell(ctx, 0, 0, null, 'typed'));
        expect(next.sheets[0].data?.[0][0]).toMatchObject({ v: 'typed', link: LINK });
    });

    test('clearing formats keeps the link and takes its look', () => {
        const { next } = author(linkedGrid(), handleClearFormat);
        expect(next.sheets[0].data?.[0][0]).toEqual({ v: 'a', m: 'a', link: LINK });
    });

    test('a merge keeps the link of the cell whose value it keeps, and the card finds it there', () => {
        const { next } = author(linkedGrid(), (ctx) => {
            mergeCells(ctx, 'id_1', [{ row: [0, 0], column: [0, 1] }], 'merge-all');
            showLinkCard(ctx, 0, 0);
        });
        expect(getCellHyperlink(next, 0, 0)).toEqual(LINK);
        expect(next.linkCard?.originAddress).toBe(LINK.address);
        expect(cellLinks(next.sheets[0])).toEqual({ '0_0': LINK });
    });

    test('the card on a cell merged down hangs from the merge, not from its first row', () => {
        const { next } = author(linkedGrid(), (ctx) => {
            mergeCells(ctx, 'id_1', [{ row: [0, 1], column: [0, 0] }], 'merge-all');
            showLinkCard(ctx, 0, 0);
        });
        expect(next.linkCard?.position.bottom).toBe(next.visibledatarow[1]);
    });

    test('an unmerge leaves the link on the first cell alone', () => {
        const merged = author(linkedGrid(), (ctx) =>
            mergeCells(ctx, 'id_1', [{ row: [0, 0], column: [0, 1] }], 'merge-all'),
        ).next;
        const { next } = author(merged, (ctx) =>
            mergeCells(ctx, 'id_1', [{ row: [0, 0], column: [0, 1] }], 'merge-cancel'),
        );
        expect(cellLinks(next.sheets[0])).toEqual({ '0_0': LINK });
    });

    test('a removal writes only the link and its look', () => {
        const { ops } = author(linkedGrid(), (ctx) => removeHyperlink(ctx, 0, 0));
        expect(ops.map(({ op, path }) => [op, path.join()]).sort()).toEqual([
            ['remove', 'data,0,0,fc'],
            ['remove', 'data,0,0,link'],
            ['remove', 'data,0,0,un'],
        ]);
    });

    test('saving a link is one undo entry that puts the cell back', () => {
        const t = tab(grid());
        tabEdit(t, (ctx) => saveHyperlink(ctx, 0, 0, 'new text', LINK.type, LINK.address));
        expect(t.history.undoList).toHaveLength(1);
        tabUndo(t);
        expect(t.ctx.sheets[0].data?.[0][0]).toEqual({ v: 'a', m: 'a' });
        expect(t.history.undoList).toHaveLength(0);
    });
});

describe('a link to a sheet', () => {
    const toOther: CellLink = { type: 'sheet', address: 'Other' };

    test('a rename reaches it in the stored list a file import holds', () => {
        const sheet = { id: 'x', name: 'x', celldata: [{ r: 0, c: 0, v: { link: toOther } }] };
        const renamed = renameSheetTexts(sheet, sheetFinder([{ name: 'Other' }]), new Map([['Other', 'New']]));
        expect(cellLinks(renamed)).toEqual({ '0_0': { type: 'sheet', address: 'New' } });
    });

    test('a tab delete leaves it naming no sheet, and following it stays where it is', () => {
        const ctx = grid();
        saveHyperlink(ctx, 0, 0, 'a', toOther.type, toOther.address);
        deleteSheet(ctx, 'id_2');
        goToLink(ctx, 0, 0);
        expect(ctx.currentSheetId).toBe('id_1');
        expect(getCellHyperlink(ctx, 0, 0)).toEqual({ ...toOther, address: '#REF!' });
    });
});

describe("a peer's whole sheet", () => {
    const named = { id: 'new', name: 'New' };
    const added = (value: Record<string, unknown>) =>
        replaySheetsOps([], [[{ op: 'addSheet', id: 'new', path: [], value }]]).map((sheet) => sheet.id);

    test('passes with well-formed links in the list or the matrix', () => {
        expect(added({ ...named, celldata: [{ r: 0, c: 0, v: { link: LINK } }] })).toEqual(['new']);
        expect(added({ ...named, data: [[{ link: LINK }, null]] })).toEqual(['new']);
    });

    test.each([
        ['a list cell with a link of no address', { celldata: [{ r: 0, c: 0, v: { link: { type: 'webpage' } } }] }],
        ['a list cell with a null link', { celldata: [{ r: 0, c: 0, v: { link: null } }] }],
        ['a matrix cell with a link that is text', { data: [[{ link: 'https://eigen.is' }]] }],
        ['an address that is no text', { data: [[{ link: { type: 'webpage', address: 5 } }]] }],
        ['a link of a kind no reader follows', { data: [[{ link: { type: 'file', address: 'x' } }]] }],
    ])('is refused for %s', (_, cells) => {
        expect(added({ ...named, ...cells })).toEqual([]);
    });
});
