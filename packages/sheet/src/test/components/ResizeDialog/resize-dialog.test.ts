// The Row height and Column width dialog keeps the dialog contract. It opens on the selected rows' or columns' shared
// size and sets each of them to the typed size on Apply. A size the engine refuses says why under the field and keeps
// what was typed, an empty one says so once Apply is pressed, and Apply stays live.

import { expect, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, typeInto } = await import('../sheet-dialog');
const { ResizeDialog } = await import('../../../components/ResizeDialog');
const { getSheetConfig } = await import('../../../state');

const ROW_HEIGHT = 'Row height in pixels';

// Rows 1 and 2 selected, both 30 px high.
const ROWS = {
    config: { rowlen: { 0: 30, 1: 30 } },
    selections: [{ row: [0, 1], column: [0, 3], row_focus: 0, column_focus: 0, row_select: true }],
};
const openRowHeight = () => renderSheetDialog((d) => d.showDialog(createElement(ResizeDialog, { mode: 'row' })), ROWS);

test('Row height keeps the dialog contract', async () => {
    const form = sheetDialogForm((d) => d.showDialog(createElement(ResizeDialog, { mode: 'row' })), ROWS);
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: ROW_HEIGHT,
        onSubmit: form.write,
        makeChanged: () => typeInto(ROW_HEIGHT, '48'),
        makeInvalid: () => typeInto(ROW_HEIGHT, ''),
        invalidField: ROW_HEIGHT,
        savesAtOnce: true,
    });
});

test('it opens on the shared size, sets every selected row on Apply and closes', async () => {
    const dialog = await openRowHeight();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Row height');
    expect(dialog.field(ROW_HEIGHT).value).toBe('30');
    expect(document.activeElement).toBe(dialog.field(ROW_HEIGHT));
    expect(dialog.button('Cancel')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await dialog.type(ROW_HEIGHT, '48');
    await dialog.click('Apply');
    expect(getSheetConfig(dialog.context())?.rowlen).toEqual({ 0: 48, 1: 48 });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the field submits', async () => {
    const dialog = await openRowHeight();
    await dialog.type(ROW_HEIGHT, '25');
    await act(async () => pressEnter(dialog.field(ROW_HEIGHT)));
    expect(getSheetConfig(dialog.context())?.rowlen).toEqual({ 0: 25, 1: 25 });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a size past the limit says why, refuses Apply, and keeps the typed value', async () => {
    const dialog = await openRowHeight();
    await dialog.type(ROW_HEIGHT, '600');
    expect(dialog.button('Apply')?.disabled).toBe(false);
    const describedBy = dialog.field(ROW_HEIGHT).getAttribute('aria-describedby');
    const reason = describedBy ? document.getElementById(describedBy) : null;
    expect(reason?.textContent).toBe('Enter a value between 1 and 545.');
    expect(reason?.getAttribute('role')).toBe('alert');
    await act(async () => pressEnter(dialog.field(ROW_HEIGHT)));
    expect(getSheetConfig(dialog.context())?.rowlen).toEqual({ 0: 30, 1: 30 });
    expect(dialog.field(ROW_HEIGHT).value).toBe('600');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('with nothing selected, Apply says what to select', async () => {
    const dialog = await renderSheetDialog((d) => d.showDialog(createElement(ResizeDialog, { mode: 'column' })), {
        selections: [],
    });
    await dialog.type('Column width in pixels', '80');
    await dialog.click('Apply');
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe(
        'Select the columns to resize first.',
    );
    expect(dialog.dialogs()).toHaveLength(1);
});

test('a column takes a width past the row limit', async () => {
    const dialog = await renderSheetDialog((d) => d.showDialog(createElement(ResizeDialog, { mode: 'column' })), {
        selections: [{ row: [0, 3], column: [2, 2], row_focus: 0, column_focus: 2, column_select: true }],
    });
    expect(dialog.title()).toBe('Column width');
    await dialog.type('Column width in pixels', '1200');
    await dialog.click('Apply');
    expect(getSheetConfig(dialog.context())?.columnlen).toEqual({ 2: 1200 });
});
