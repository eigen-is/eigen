// The Row height and Column width dialog opens on the selected rows' or columns' shared size, sets each of them to the
// typed size on OK or Enter and closes. A size the engine refuses disables OK, shows why, and keeps what was typed.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { ResizeDialog } = await import('../../../components/ResizeDialog');
const { getSheetConfig } = await import('../../../state');

const ROW_HEIGHT = 'Row height in pixels';

// Rows 1 and 2 selected, both 30 px high.
const openRowHeight = () =>
    renderSheetDialog((d) => d.showFormDialog(createElement(ResizeDialog, { mode: 'row' })), {
        config: { rowlen: { 0: 30, 1: 30 } },
        selections: [{ row: [0, 1], column: [0, 3], row_focus: 0, column_focus: 0, row_select: true }],
    });

test('it opens on the shared size, sets every selected row on OK and closes', async () => {
    const dialog = await openRowHeight();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Row height');
    expect(dialog.field(ROW_HEIGHT).value).toBe('30');
    expect(document.activeElement).toBe(dialog.field(ROW_HEIGHT));
    expect(dialog.button('Cancel')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await dialog.type(ROW_HEIGHT, '48');
    await dialog.click('OK');
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

test('a size past the limit disables OK, says why, and keeps the typed value', async () => {
    const dialog = await openRowHeight();
    await dialog.type(ROW_HEIGHT, '600');
    expect(dialog.button('OK')?.disabled).toBe(true);
    expect(dialog.dialogs()[0]?.textContent).toContain('Enter a value between 1 and 545.');
    await act(async () => pressEnter(dialog.field(ROW_HEIGHT)));
    expect(getSheetConfig(dialog.context())?.rowlen).toEqual({ 0: 30, 1: 30 });
    expect(dialog.field(ROW_HEIGHT).value).toBe('600');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('a column takes a width past the row limit', async () => {
    const dialog = await renderSheetDialog((d) => d.showFormDialog(createElement(ResizeDialog, { mode: 'column' })), {
        selections: [{ row: [0, 3], column: [2, 2], row_focus: 0, column_focus: 2, column_select: true }],
    });
    expect(dialog.title()).toBe('Column width');
    await dialog.type('Column width in pixels', '1200');
    await dialog.click('OK');
    expect(getSheetConfig(dialog.context())?.columnlen).toEqual({ 2: 1200 });
});
