// The Custom currencies dialog keeps the dialog contract. It builds a currency format from a symbol and a layout, and
// Apply sets it on the selection and closes. Typing in the symbol field filters the list by name, and picking a
// currency from the list takes its symbol and its side of the number. With no symbol, Apply says so under the field.

import { expect, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, SYNCHRONOUS_WRITE, typeInto } = await import('../sheet-dialog');
const { CustomCurrencies } = await import('../../../components/FormatDialogs/CustomCurrencies');
type Context = import('../../../state').Context;

const SYMBOL = 'Currency symbol';

// A1 selected, holding a number.
const A1_NUMBER = {
    sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data: [[{ v: 1000, m: '1000' }]] }],
    selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    editingCellPosition: [],
};
const openCurrencies = () => renderSheetDialog((d) => d.showDialog(createElement(CustomCurrencies)), A1_NUMBER);

const format = (context: Context) => context.sheets[0]?.data?.[0]?.[0]?.ct?.fa;

const rowNames = () =>
    [...document.querySelectorAll('[role="dialog"] .eigen-list-item')].map((row) => row.firstChild?.textContent);

// A currency row by its first text. A browser clicks a focused button on Enter or Space, and type="button" keeps that
// click from submitting the form, so a row that is such a button can be picked from the keyboard.
const presetRow = (text: string) =>
    [...document.querySelectorAll('[role="dialog"] .eigen-list-item')].find(
        (row) => row.firstChild?.textContent === text,
    );
const pickableByKeyboard = (row: Element | undefined) => row instanceof HTMLButtonElement && row.type === 'button';

test('Custom currencies keeps the dialog contract', async () => {
    const form = sheetDialogForm((d) => d.showDialog(createElement(CustomCurrencies)), A1_NUMBER);
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: SYMBOL,
        onSubmit: form.write,
        makeChanged: () => typeInto(SYMBOL, 'kr'),
        makeInvalid: () => typeInto(SYMBOL, ''),
        invalidField: SYMBOL,
        except: SYNCHRONOUS_WRITE,
    });
});

test('Apply sets the currency format of the typed symbol and closes', async () => {
    const dialog = await openCurrencies();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Custom currencies');
    expect(dialog.footer()).toEqual(['Cancel', 'Apply']);
    expect(dialog.button('Apply')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog.field(SYMBOL).value).toBe('€');
    await dialog.type(SYMBOL, 'kr');
    await dialog.click('Apply');
    expect(format(dialog.context())).toBe('"kr"#,##0.00');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the symbol field applies it', async () => {
    const dialog = await openCurrencies();
    await dialog.type(SYMBOL, '$');
    await act(async () => pressEnter(dialog.field(SYMBOL)));
    expect(format(dialog.context())).toBe('$#,##0.00');
    expect(dialog.dialogs()).toHaveLength(0);
});

test('typing filters the list, and a currency picked by mouse or keyboard takes its symbol and side', async () => {
    const dialog = await openCurrencies();
    await dialog.type(SYMBOL, 'swed');
    expect(rowNames()).toEqual(['Swedish Krona']);
    const row = presetRow('Swedish Krona');
    expect(pickableByKeyboard(row)).toBe(true);
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(dialog.field(SYMBOL).value).toBe('kr');
    await dialog.click('Apply');
    expect(format(dialog.context())).toBe('#,##0.00"kr"');
});

test('with no symbol, Enter says so under the field and keeps the dialog open', async () => {
    const dialog = await openCurrencies();
    await dialog.type(SYMBOL, '');
    expect(document.querySelector('[data-slot="field-error"]')).toBeNull();
    await act(async () => pressEnter(dialog.field(SYMBOL)));
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe('Enter a currency symbol');
    expect(format(dialog.context())).toBeUndefined();
    expect(dialog.dialogs()).toHaveLength(1);
});
