// The data-validation dialog over a column header's selection names it B:B and puts the rule on the whole column, to
// the grid's last row. Its delete takes a range out of a rule and keeps the rest. A grid button swaps it for the range
// picker, and the picker's OK or Cancel brings it back with the draft as the user left it.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { REFERENCE_ROW_COUNT } = await import('@workspace/lib/sheets');
const { renderSheetDialog } = await import('../sheet-dialog');
const { DataVerification } = await import('../../../components/DataVerification');
type Selection = import('../../../state').Selection;

const LAST = REFERENCE_ROW_COUNT - 1;
const LIST = { type: 'dropdown', type2: '', value1: 'Yes,No', value2: '' };
const NUMBER = { type: 'number', type2: 'between', value1: '1', value2: '10' };

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

const B3 = { row: [2, 2], column: [1, 1], row_focus: 2, column_focus: 1 };

const input = (placeholder: string) => {
    const found = document.querySelector<HTMLInputElement>(`[role="dialog"] input[placeholder="${placeholder}"]`);
    if (!found) throw new Error(`no field ${placeholder}`);
    return found;
};

const typeInto = (target: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, value);
        target.dispatchEvent(new Event('input', { bubbles: true }));
    });

// The Cell range field, the dialog's first.
const rangeField = () => {
    const found = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (!found) throw new Error('no Cell range field');
    return found;
};

// The icon button beside the Cell range field, the dialog's first.
const pickRange = () =>
    act(async () => {
        document.querySelector<HTMLButtonElement>('[role="dialog"] button:has(svg)')?.click();
    });

test('a column header selection is named B:B, and its rule covers the whole column', async () => {
    const dialog = await openDialog({
        row: [0, 999],
        column: [1, 1],
        row_focus: 0,
        column_focus: 1,
        column_select: true,
    });
    expect(dialog.context().validationDraft.rangeTxt).toBe('B:B');
    await typeInto(input('Please enter the options, separated by commas, such as 1,2,3,4,5'), 'Yes,No');
    await dialog.click('OK');
    expect(Object.values(dialog.context().sheets[0].dataValidations ?? {})).toMatchObject([
        { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: { type: 'dropdown', value1: 'Yes,No' } },
    ]);
});

test("opening on a rule's cell reads the rule, and delete takes its range out of the rule", async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: LIST } });
    expect(dialog.context().validationDraft).toMatchObject({ rangeTxt: 'B3', value1: 'Yes,No' });
    await typeInto(rangeField(), 'B2:B3');
    await dialog.click('Delete verification');
    expect(dialog.context().sheets[0].dataValidations).toEqual({
        v: {
            ranges: [
                { row: [0, 0], column: [1, 1] },
                { row: [3, LAST], column: [1, 1] },
            ],
            rule: LIST,
        },
    });
});

test('back from the range picker, the draft keeps every value the user typed', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    await typeInto(input('100'), '50');
    await pickRange();
    expect(dialog.title()).toBe('Select cell range');
    await dialog.click('OK');
    expect(dialog.title()).toBe('Data verification');
    expect(input('100').value).toBe('50');
    expect(dialog.context().validationDraft).toMatchObject({ type: 'number', rangeTxt: 'B3', value2: '50' });
    expect(dialog.context().rangeDialog.show).toBe(false);
});

test('Cancel in the range picker brings the dialog back with its draft too', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], rule: NUMBER } });
    await typeInto(input('100'), '50');
    await pickRange();
    await dialog.click('Cancel');
    expect(dialog.title()).toBe('Data verification');
    expect(input('100').value).toBe('50');
});

test('Delete with no range to take the rule from stays open and says why under the range', async () => {
    const dialog = await openDialog(B3, { v: { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: LIST } });
    await typeInto(rangeField(), '');
    await dialog.click('Delete verification');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data verification');
    expect(rangeField().parentElement?.nextElementSibling?.textContent).toBe(
        'The selection operation has not been performed yet',
    );
    expect(Object.keys(dialog.context().sheets[0].dataValidations ?? {})).toEqual(['v']);
});
