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
    renderSheetDialog((d) => d.showDialog(createElement(CustomDateTimeFormats)), {
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data: [[{ v: 45000, m: '45000' }]] }],
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [],
    });

// A preset row by its first text. A browser clicks a focused button on Enter or Space, and type="button" keeps that
// click from submitting the form, so a row that is such a button can be picked from the keyboard.
const presetRow = (text: string) =>
    [...document.querySelectorAll('[role="dialog"] .eigen-list-item')].find(
        (row) => row.firstChild?.textContent === text,
    );
const pickableByKeyboard = (row: Element | undefined) => row instanceof HTMLButtonElement && row.type === 'button';

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

test('a pattern numfmt refuses disables Apply, says so, and keeps the typed text', async () => {
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

test('a preset row replaces the pattern, and the keyboard can pick it', async () => {
    const dialog = await openDateTimeFormats();
    const row = presetRow('1930-08-05');
    expect(pickableByKeyboard(row)).toBe(true);
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(dialog.dialogs()[0]?.textContent).toContain('Preview: 1930-08-05');
    await dialog.click('Apply');
    expect(format(dialog.context())).toBe('yyyy-MM-dd');
});

test('the insert menu lists the tokens by group, and a pick adds the token with its first variant', async () => {
    const dialog = await openDateTimeFormats();
    await act(async () =>
        document
            .querySelector('[aria-label="Insert token"]')
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([
        'Day',
        'Month',
        'Year',
        'Hour',
        'Minute',
        'Second',
        'Millisecond',
        'a.m./p.m.',
        'Elapsed hours',
        'Elapsed minutes',
        'Elapsed seconds',
        'Separator text',
    ]);
    await act(async () =>
        items.find((item) => item.textContent === 'Hour')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await dialog.click('Apply');
    expect(format(dialog.context())).toBe('dd/MM/yyyyHH');
});
