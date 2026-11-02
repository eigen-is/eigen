// The data-validation dialog over a column header's selection names it B:B and puts the rule on the whole column, to
// the grid's last row. OK checks the draft first: a refused range or value keeps the dialog open with the reason under
// it and the draft as typed. Delete verification takes a range out of a rule and keeps the rest. A grid button swaps
// the dialog for the range picker, and the picker's OK or Cancel brings it back with the draft as the user left it.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { REFERENCE_ROW_COUNT } = await import('@workspace/lib/sheets');
const { renderSheetDialog } = await import('../sheet-dialog');
const { DataVerification } = await import('../../../components/DataVerification');
type Selection = import('../../../state').Selection;

const LAST = REFERENCE_ROW_COUNT - 1;
const LIST = { type: 'dropdown', type2: '', value1: 'Yes,No', value2: '' };
const NUMBER = { type: 'number', type2: 'between', value1: '1', value2: '10' };
const B3 = { row: [2, 2], column: [1, 1], row_focus: 2, column_focus: 1 };
const NO_RANGE = 'Enter a cell range, such as A1:B10';

// The dialog over a 1,000-row sheet.
const openDialog = (selection: Selection, dataValidations = {}) =>
    renderSheetDialog((d) => d.showDialog(createElement(DataVerification)), {
        sheets: [
            {
                id: 'id_1',
                name: 'Sheet1',
                order: 0,
                config: {},
                data: Array.from({ length: 1000 }, () => [null, null, null]),
                dataValidations,
            },
        ],
        selections: [selection],
    });

type Dialog = Awaited<ReturnType<typeof openDialog>>;

const rules = (dialog: Dialog) => dialog.context().sheets[0].dataValidations;

// The message that says why OK or Delete refused what a field holds.
const problemOf = (field: HTMLElement) => {
    const id = field.getAttribute('aria-describedby');
    return id ? document.getElementById(id)?.textContent : undefined;
};

const pickWith = (label: string) =>
    act(async () => {
        document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`)?.click();
    });

test('a column header selection is named B:B, and OK puts the rule on the whole column and closes', async () => {
    const dialog = await openDialog({
        row: [0, 999],
        column: [1, 1],
        row_focus: 0,
        column_focus: 1,
        column_select: true,
    });
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data verification');
    expect(dialog.footer()).toEqual(['Delete verification', 'Cancel', 'OK']);
    expect(dialog.button('OK')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog.field('Cell range').value).toBe('B:B');
    await dialog.type('Options', 'Yes,No');
    await dialog.click('OK');
    expect(Object.values(rules(dialog) ?? {})).toMatchObject([
        { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: { type: 'dropdown', value1: 'Yes,No' } },
    ]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in a text field submits', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Options', 'Red,Green');
    await act(async () => pressEnter(dialog.field('Options')));
    expect(Object.values(rules(dialog) ?? {})).toMatchObject([{ rule: { type: 'dropdown', value1: 'Red,Green' } }]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a refused value keeps the dialog open, says why, and keeps what was typed until it changes', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    await dialog.type('Value 2', '0');
    await dialog.click('OK');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(problemOf(dialog.field('Value 2'))).toBe('The value 2 cannot be less than the value 1');
    expect(dialog.field('Value 2').value).toBe('0');
    expect(rules(dialog)).toEqual({ v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    expect(dialog.context().warnDialog).toBeUndefined();
    await dialog.type('Value 2', '20');
    expect(problemOf(dialog.field('Value 2'))).toBeUndefined();
});

test('a range that names no cells keeps the dialog open and says why under the range', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Options', 'Yes,No');
    await dialog.type('Cell range', '');
    await dialog.click('OK');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(problemOf(dialog.field('Cell range'))).toBe(NO_RANGE);
    expect(dialog.field('Options').value).toBe('Yes,No');
    expect(rules(dialog)).toEqual({});
});

test("opening on a rule's cell reads the rule, and Delete verification takes its range out of the rule", async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: LIST } });
    expect(dialog.field('Cell range').value).toBe('B3');
    expect(dialog.field('Options').value).toBe('Yes,No');
    await dialog.type('Cell range', 'B2:B3');
    await dialog.click('Delete verification');
    expect(rules(dialog)).toEqual({
        v: {
            ranges: [
                { row: [0, 0], column: [1, 1] },
                { row: [3, LAST], column: [1, 1] },
            ],
            rule: LIST,
        },
    });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Delete with no range to take the rule from stays open and says why under the range', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: LIST } });
    await dialog.type('Cell range', '');
    await dialog.click('Delete verification');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data verification');
    expect(problemOf(dialog.field('Cell range'))).toBe(NO_RANGE);
    expect(Object.keys(rules(dialog) ?? {})).toEqual(['v']);
});

test('back from the range picker, the draft keeps every value the user typed', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    await dialog.type('Value 2', '50');
    await pickWith('Select cell range');
    expect(dialog.title()).toBe('Select cell range');
    expect(dialog.context().rangeDialog.show).toBe(true);
    await dialog.click('OK');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data verification');
    expect(dialog.field('Cell range').value).toBe('B3');
    expect(dialog.field('Value 2').value).toBe('50');
    expect(dialog.context().rangeDialog.show).toBe(false);
});

test('Cancel in the range picker brings the dialog back with its draft too', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    await dialog.type('Value 2', '50');
    await pickWith('Select cell range');
    await dialog.click('Cancel');
    expect(dialog.title()).toBe('Data verification');
    expect(dialog.field('Value 2').value).toBe('50');
    expect(dialog.context().rangeDialog.show).toBe(false);
});

test("a notice that takes the range picker's place lets the cell editor back", async () => {
    const dialog = await openDialog(B3);
    await pickWith('Select cell range');
    expect(dialog.context().rangeDialog.show).toBe(true);
    await dialog.show((d) => d.showDialog('A notice', 'ok'));
    expect(dialog.context().rangeDialog.show).toBe(false);
    expect(dialog.dialogs()[0]?.textContent).toContain('A notice');
});

test("the list's grid button picks the options' source and keeps the range", async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Cell range', 'B2:B3');
    await dialog.type('Options', 'A1:A2');
    await pickWith('Select options from a range');
    await dialog.click('OK');
    expect(dialog.field('Cell range').value).toBe('B2:B3');
    expect(dialog.field('Options').value).toBe('A1:A2');
});
