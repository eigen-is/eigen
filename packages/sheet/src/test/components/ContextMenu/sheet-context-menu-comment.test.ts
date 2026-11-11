// Delete comment in the grid's cell menu asks first, as a card's own menu does, and then deletes the card it asked
// about.

import { beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow } from '@workspace/ui/test/menu-rows';

installHappyDom();

const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));

const { act, createElement, Fragment, useContext } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { WorkbookContext } = await import('../../../context');
const { useSheetContextMenu } = await import('../../../components/ContextMenu/useSheetContextMenu');

const lifecycle = {
    setOpenCardId: () => {},
    openCardForEdit: () => {},
    updateCard: () => {},
    resolveComment: { mutate: () => {} },
    assignComment: { mutate: () => {} },
    members: [],
    isCardDeleted: () => false,
};

let deleted: string[] = [];
let openAtPoint: ((x: number, y: number) => void) | undefined;

beforeEach(() => {
    deleted = [];
});

function CellMenu() {
    const { refs } = useContext(WorkbookContext);
    refs.hooks.current = {
        commentLifecycle: lifecycle as never,
        onDeleteComment: (cardId: string) => deleted.push(cardId),
        getCommentInfo: () => ({ card: { id: 'card', title: 'A card' }, entry: undefined }) as never,
    };
    const menu = useSheetContextMenu('cell');
    openAtPoint = menu.openAtPoint;
    return createElement(Fragment, null, createElement('div', { ref: refs.cellArea }), menu.anchor);
}

// Radix hands the focus on a moment after a menu or a dialog closes.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

const pressDelete = async () => {
    const data = [[{ v: 1, commentCardIds: ['card'] }]];
    const dialog = await renderSheetDialog(
        () => {},
        {
            allowEdit: true,
            currentSheetId: 'sheet',
            sheets: [{ id: 'sheet', name: 'One', order: 0, data }] as never,
            selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
            visibledatarow: [200],
            visibledatacolumn: [200],
        },
        () => createElement(CellMenu),
    );
    await act(async () => openAtPoint?.(60, 60));
    await settle();
    await clickRow('Delete comment');
    await settle();
    return dialog;
};

test('asks first', async () => {
    const dialog = await pressDelete();
    expect(dialog.title()).toBe('Delete comment');
    expect(deleted).toEqual([]);
});

test('Cancel keeps the comment and hands the focus to the grid', async () => {
    const dialog = await pressDelete();
    await dialog.click('Cancel');
    await settle();
    expect(deleted).toEqual([]);
    expect(dialog.dialogs()).toEqual([]);
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
});

test('Delete deletes the card it asked about', async () => {
    const dialog = await pressDelete();
    await dialog.click('Delete');
    await settle();
    expect(deleted).toEqual(['card']);
    expect(dialog.dialogs()).toEqual([]);
});
