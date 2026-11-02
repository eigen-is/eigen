// The Insert function dialog lists the functions of a category, or those the search matches, with one highlighted. OK,
// or Enter in the search field, opens the in-cell editor on the focus cell with `=NAME(` and closes. Cancel and Escape
// close it and leave the cell, and an edit already open in it, as they were.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { InsertFunctionDialog } = await import('../../../components/InsertFunctionDialog');

const SEARCH = 'Search function';

// B2 selected, with no edit open unless the test opens one.
const openInsertFunction = (editingCellPosition: number[] = []) =>
    renderSheetDialog((d) => d.showFormDialog(createElement(InsertFunctionDialog)), {
        selections: [{ row: [1, 1], column: [1, 1], row_focus: 1, column_focus: 1 }],
        editingCellPosition,
        functionHint: null,
    });

const highlighted = () => document.querySelector('[role="dialog"] .eigen-list-item-active div')?.textContent;
const listed = () =>
    [...document.querySelectorAll('[role="dialog"] .eigen-list-item div:first-child')].map((n) => n.textContent);

test('OK opens the editor on the focus cell with the highlighted function and closes', async () => {
    const dialog = await openInsertFunction();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Select a function');
    expect(dialog.footer()).toEqual(['Cancel', 'OK']);
    expect(dialog.button('OK')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await dialog.type(SEARCH, 'SUMIF');
    expect(highlighted()).toBe('SUMIF');
    await dialog.click('OK');
    expect(dialog.context().editingCellPosition).toEqual([1, 1]);
    expect(dialog.context().functionHint).toBe('SUMIF');
    expect(dialog.editorText()).toBe('=SUMIF(');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the search field inserts the highlighted function', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'AVERAGEIF');
    expect(highlighted()).toBe('AVERAGEIF');
    await act(async () => pressEnter(dialog.field(SEARCH)));
    expect(dialog.editorText()).toBe('=AVERAGEIF(');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a search with no match turns OK off, and Enter keeps the dialog open', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'NOSUCHFUNCTION');
    expect(listed()).toEqual([]);
    expect(dialog.button('OK')?.disabled).toBe(true);
    await act(async () => pressEnter(dialog.field(SEARCH)));
    expect(dialog.field(SEARCH).value).toBe('NOSUCHFUNCTION');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('Cancel closes and leaves an open edit as it was', async () => {
    const dialog = await openInsertFunction([1, 1]);
    dialog.setEditorText('=1+');
    await dialog.click('Cancel');
    expect(dialog.context().editingCellPosition).toEqual([1, 1]);
    expect(dialog.editorText()).toBe('=1+');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Escape closes the same way as Cancel', async () => {
    const dialog = await openInsertFunction([1, 1]);
    dialog.setEditorText('=1+');
    await act(async () => {
        dialog
            .field(SEARCH)
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog.context().editingCellPosition).toEqual([1, 1]);
    expect(dialog.editorText()).toBe('=1+');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a clicked function is the one OK inserts', async () => {
    const dialog = await openInsertFunction();
    const third = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .eigen-list-item')[2];
    const name = third?.firstChild?.textContent ?? undefined;
    await act(async () => third?.click());
    expect(highlighted()).toBe(name);
    await dialog.click('OK');
    expect(dialog.editorText()).toBe(`=${name}(`);
});
