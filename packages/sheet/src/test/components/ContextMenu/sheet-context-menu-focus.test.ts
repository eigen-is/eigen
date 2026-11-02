// As the grid's right-click menu closes it hands the focus back to the grid's cell input, unless what the menu opened
// took it: Resize the row opens a dialog, and the focus stays in that dialog.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, Fragment, useContext } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { WorkbookContext } = await import('../../../context');
const { useSheetContextMenu } = await import('../../../components/ContextMenu/useSheetContextMenu');

let openAtPoint: ((x: number, y: number) => void) | undefined;

// The row header's menu, over a stand-in for the grid's cell area.
function RowHeaderMenu() {
    const { refs } = useContext(WorkbookContext);
    const menu = useSheetContextMenu('row');
    openAtPoint = menu.openAtPoint;
    return createElement(Fragment, null, createElement('div', { ref: refs.cellArea }), menu.anchor);
}

// Radix hands the focus on a moment after a menu or a dialog closes.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

const openMenu = async () => {
    const dialog = await renderSheetDialog(
        () => {},
        { allowEdit: true },
        () => createElement(RowHeaderMenu),
    );
    await act(async () => openAtPoint?.(60, 60));
    await settle();
    return dialog;
};

test('a dialog the menu opened keeps the focus', async () => {
    const dialog = await openMenu();
    await clickRow('Resize the row');
    await settle();
    expect(dialog.title()).toBe('Row height');
    expect(dialog.dialogs()[0]?.contains(document.activeElement)).toBe(true);
});

test('Escape on the menu hands the focus to the grid', async () => {
    await openMenu();
    await act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    await settle();
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
});
