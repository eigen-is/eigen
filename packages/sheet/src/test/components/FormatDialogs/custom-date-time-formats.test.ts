// The Custom date and time formats dialog edits a date pattern as chips and separator text, previews it on a fixed
// date, and Apply, or Enter in a separator field, sets it on the selection and closes. A pattern numfmt can't read
// disables Apply, says why, and keeps what was typed. A preset replaces the whole pattern.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { CustomDateTimeFormats } = await import('../../../components/FormatDialogs/CustomDateTimeFormats');
type Context = import('../../../state').Context;

const SEPARATOR = 'Separator text';

// A1 selected, holding a number with no date format, so the dialog opens on dd/MM/yyyy.
const openDateTimeFormats = () =>
    renderSheetDialog((d) => d.showFormDialog(createElement(CustomDateTimeFormats)), {
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data: [[{ v: 45000, m: '45000' }]] }],
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [],
    });

const format = (context: Context) => context.sheets[0]?.data?.[0]?.[0]?.ct?.fa;

test('Apply sets the pattern on the selection and closes', async () => {
    const dialog = await openDateTimeFormats();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Custom date and time formats');
    expect(dialog.footer()).toEqual(['Cancel', 'Apply']);
    expect(dialog.button('Apply')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog.dialogs()[0]?.textContent).toContain('Preview: 05/08/1930');
    await dialog.type(SEPARATOR, '-');
    await dialog.click('Apply');
    expect(format(dialog.context())).toBe('dd-MM/yyyy');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in a separator field applies the pattern', async () => {
    const dialog = await openDateTimeFormats();
    await dialog.type(SEPARATOR, '.');
    await act(async () => pressEnter(dialog.field(SEPARATOR)));
    expect(format(dialog.context())).toBe('dd.MM/yyyy');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a pattern numfmt refuses disables Apply, says why, and keeps the typed text', async () => {
    const dialog = await openDateTimeFormats();
    await dialog.type(SEPARATOR, '.,');
    expect(dialog.button('Apply')?.disabled).toBe(true);
    expect(dialog.dialogs()[0]?.textContent).toContain('Illegal format');
    await act(async () => pressEnter(dialog.field(SEPARATOR)));
    expect(format(dialog.context())).toBeUndefined();
    expect(dialog.field(SEPARATOR).value).toBe('.,');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('Cancel closes and leaves the format', async () => {
    const dialog = await openDateTimeFormats();
    await dialog.click('Cancel');
    expect(format(dialog.context())).toBeUndefined();
    expect(dialog.dialogs()).toHaveLength(0);
});
