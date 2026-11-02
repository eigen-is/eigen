// The Custom number formats dialog opens on the format of the focus cell and previews the pattern on its value. Apply,
// or Enter in the pattern field, sets the pattern on the selection and closes. A pattern numfmt can't read disables
// Apply, says why, and keeps what was typed. A preset fills the pattern field, from the mouse or the keyboard.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { CustomNumberFormats } = await import('../../../components/FormatDialogs/CustomNumberFormats');
type Context = import('../../../state').Context;

const PATTERN = 'Number format';

// A1:B1 selected, A1 holding 1234.5 in the two-decimal format.
const openNumberFormats = () =>
    renderSheetDialog((d) => d.showDialog(createElement(CustomNumberFormats)), {
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                config: {},
                data: [
                    [
                        { v: 1234.5, m: '1,234.50', ct: { fa: '#,##0.00', t: 'n' } },
                        { v: 2, m: '2' },
                    ],
                ],
            },
        ],
        selections: [{ row: [0, 0], column: [0, 1], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [],
    });

// A preset row by its first text. A browser clicks a focused button on Enter or Space, and type="button" keeps that
// click from submitting the form, so a row that is such a button can be picked from the keyboard.
const presetRow = (text: string) =>
    [...document.querySelectorAll('[role="dialog"] .eigen-list-item')].find(
        (row) => row.firstChild?.textContent === text,
    );
const pickableByKeyboard = (row: Element | undefined) => row instanceof HTMLButtonElement && row.type === 'button';

const formats = (context: Context) => context.sheets[0]?.data?.[0]?.map((c) => c?.ct?.fa);

test('Apply sets the pattern on the selection and closes', async () => {
    const dialog = await openNumberFormats();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Custom number formats');
    expect(dialog.footer()).toEqual(['Cancel', 'Apply']);
    expect(dialog.button('Apply')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog.field(PATTERN).value).toBe('#,##0.00');
    await dialog.type(PATTERN, '0.0');
    expect(dialog.dialogs()[0]?.textContent).toContain('Preview: 1234.5');
    await dialog.click('Apply');
    expect(formats(dialog.context())).toEqual(['0.0', '0.0']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the pattern field applies it', async () => {
    const dialog = await openNumberFormats();
    await dialog.type(PATTERN, '0%');
    await act(async () => pressEnter(dialog.field(PATTERN)));
    expect(formats(dialog.context())).toEqual(['0%', '0%']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a pattern numfmt refuses disables Apply, says why, and keeps the typed text', async () => {
    const dialog = await openNumberFormats();
    await dialog.type(PATTERN, '0[Red');
    expect(dialog.button('Apply')?.disabled).toBe(true);
    expect(dialog.dialogs()[0]?.textContent).toContain('Illegal character');
    await act(async () => pressEnter(dialog.field(PATTERN)));
    expect(formats(dialog.context())).toEqual(['#,##0.00', undefined]);
    expect(dialog.field(PATTERN).value).toBe('0[Red');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('Cancel closes and leaves the format', async () => {
    const dialog = await openNumberFormats();
    await dialog.type(PATTERN, '0');
    await dialog.click('Cancel');
    expect(formats(dialog.context())).toEqual(['#,##0.00', undefined]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a preset row fills the pattern field, and the keyboard can pick it', async () => {
    const dialog = await openNumberFormats();
    const row = presetRow('0.00%');
    expect(pickableByKeyboard(row)).toBe(true);
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(dialog.field(PATTERN).value).toBe('0.00%');
    // The preset in use is marked, as in the other format dialogs.
    expect(presetRow('0.00%')?.classList).toContain('eigen-list-item-active');
    expect(document.querySelectorAll('[role="dialog"] .eigen-list-item-active')).toHaveLength(1);
    expect(dialog.dialogs()).toHaveLength(1);
});
