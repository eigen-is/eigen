// A sheet tab's Hide hides its sheet, unless it is the last one shown: the workbook always shows one, so Hide then
// shows a notice that says so and leaves the sheet as it was. A name the rename refuses, such as an empty one, shows
// a notice with the reason and puts the old name back.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { SheetItem } = await import('../../../components/SheetTab/SheetItem');

type Sheet = import('../../../state').Sheet;

const sheet = (id: string, name: string): Sheet => ({ id, name, order: 0, config: {}, data: [[null]] });

// The tabs of these sheets.
const renderTabs = (sheets: Sheet[]) =>
    renderSheetDialog(
        () => {},
        { sheets, currentSheetId: sheets[0]?.id, allowEdit: true },
        (ctx) => ctx.sheets.map((s) => createElement(SheetItem, { key: s.id, id: s.id, sheet: s })),
    );

// The tabs of these sheets, with the first one's menu opened by a right click.
async function openTabMenu(sheets: Sheet[]) {
    const dialog = await renderTabs(sheets);
    await act(async () => {
        document
            .querySelector('[role="button"]')
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const hide = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === 'Hide');
    if (!hide) throw new Error('no Hide item');
    await act(async () => hide.click());
    return dialog;
}

test('Hide hides a sheet while another one is shown', async () => {
    const dialog = await openTabMenu([sheet('a', 'First'), sheet('b', 'Second')]);
    expect(dialog.context().sheets.map((s) => s.hide)).toEqual([1, undefined]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Hide on the last shown sheet shows a notice and keeps the sheet', async () => {
    const dialog = await openTabMenu([sheet('a', 'Only')]);
    expect(dialog.context().sheets[0]?.hide).toBeUndefined();
    expect(dialog.title()).toBe('Notice');
    expect(dialog.dialogs()[0]?.textContent).toContain('To hide this sheet');
    expect(dialog.dialogs()[0]?.textContent).not.toContain('delete');
});

test('an empty name shows a notice with the reason and keeps the old name', async () => {
    const dialog = await renderTabs([sheet('a', 'First')]);
    const name = document.querySelector<HTMLElement>('[role="button"] span');
    if (!name) throw new Error('no tab name');
    await act(async () => name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await act(async () => {
        name.innerText = '';
        name.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(dialog.title()).toBe('Notice');
    expect(dialog.dialogs()[0]?.textContent).toContain('Sheet name cannot be empty');
    expect(dialog.context().sheets[0]?.name).toBe('First');
    expect(name.innerText).toBe('First');
});

// Picks a row of the first tab's menu, and waits out the tick after which Radix runs its close focus.
async function pick(row: string) {
    await act(async () => {
        document
            .querySelector('[role="button"]')
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === row);
    if (!item) throw new Error(`no ${row} item`);
    await act(async () => item.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test('Duplicate leaves the focus on the grid, so the next keys reach a cell and not the menu', async () => {
    await renderTabs([sheet('a', 'First'), sheet('b', 'Second')]);
    await pick('Duplicate');
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
});

test('Rename puts the focus in the name with the name selected, so typing replaces it', async () => {
    await renderTabs([sheet('a', 'First'), sheet('b', 'Second')]);
    await pick('Rename');
    expect(document.activeElement).toBe(document.querySelector('[role="button"] span'));
    expect(window.getSelection()?.toString()).toBe('First');
});
