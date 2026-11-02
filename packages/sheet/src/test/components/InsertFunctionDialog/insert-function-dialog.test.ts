// The Insert function dialog lists the functions of a category, or those the search matches, with one highlighted. OK,
// or Enter in the search field, opens the in-cell editor on the focus cell with `=NAME(` and closes. Cancel and Escape
// close it and leave the cell, and an edit already open in it, as they were. After OK the editor has the focus, with
// the caret after the bracket, so the user types the arguments straight away.

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
    renderSheetDialog((d) => d.showDialog(createElement(InsertFunctionDialog)), {
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

test('after OK the editor has the focus, with the caret after the bracket', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'SUMIF');
    await dialog.click('OK');
    // Radix hands the focus on a moment after the dialog unmounts.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    const editor = document.activeElement;
    const caret = document.getSelection()?.getRangeAt(0);
    if (!editor || !caret) throw new Error('no caret');
    const before = document.createRange();
    before.setStart(editor, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    expect(caret.collapsed).toBe(true);
    expect(before.toString()).toBe('=SUMIF(');
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

test('the search matches a description in any case, after the names that match', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'cosine of');
    expect(listed()).toContain('COS');
    await dialog.type(SEARCH, 'SUM OF A SERIES');
    expect(listed()).toContain('SUM');
    await dialog.type(SEARCH, 'sum');
    const byName = listed().map((name) => name?.includes('SUM'));
    expect(byName.indexOf(false)).toBeGreaterThan(byName.lastIndexOf(true));
});

test('a typed name lists that function first, then the names that start with it, so Enter inserts it', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'cos');
    expect(listed().slice(0, 2)).toEqual(['COS', 'COSH']);
    expect(listed()).toContain('ACOS');
    await dialog.type(SEARCH, 'sum');
    expect(highlighted()).toBe('SUM');
    await act(async () => pressEnter(dialog.field(SEARCH)));
    expect(dialog.editorText()).toBe('=SUM(');
});

// Cancelable, as a browser's is, so the test sees whether the field kept the key from moving its caret.
const pressArrow = (key: 'ArrowUp' | 'ArrowDown', field: HTMLInputElement) =>
    act(async () => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        field.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

test('Up and Down in the search field move the highlight, and Enter inserts it', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'cos');
    await pressArrow('ArrowUp', dialog.field(SEARCH));
    expect(highlighted()).toBe('COS');
    await pressArrow('ArrowDown', dialog.field(SEARCH));
    await pressArrow('ArrowDown', dialog.field(SEARCH));
    await pressArrow('ArrowUp', dialog.field(SEARCH));
    expect(highlighted()).toBe('COSH');
    await act(async () => pressEnter(dialog.field(SEARCH)));
    expect(dialog.editorText()).toBe('=COSH(');
});

test('Down stops at the last function', async () => {
    const dialog = await openInsertFunction();
    await dialog.type(SEARCH, 'cosh');
    expect(listed()).toEqual(['COSH', 'ACOSH']);
    await pressArrow('ArrowDown', dialog.field(SEARCH));
    await pressArrow('ArrowDown', dialog.field(SEARCH));
    expect(highlighted()).toBe('ACOSH');
});
