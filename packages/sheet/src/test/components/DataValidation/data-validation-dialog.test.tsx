// The data-validation dialog keeps the dialog contract. Over a column header's selection it names it B:B and puts the
// rule on the whole column, to the grid's last row. Apply checks the draft first: a refused range or value keeps the
// dialog open with the reason under it and the draft as typed. Remove validation takes a range out of a rule and keeps
// the rest. A grid button swaps the dialog for the range picker, and the picker's Select or Cancel brings it back with
// the draft as the user left it, still asking before Esc drops it.

import { expect, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { REFERENCE_ROW_COUNT } = await import('@workspace/lib/sheets');
const { renderSheetDialog, sheetDialogForm, SYNCHRONOUS_WRITE, typeInto } = await import('../sheet-dialog');
const { DataValidation } = await import('../../../components/DataValidation');
const { InputBox } = await import('../../../components/SheetOverlay/InputBox');
type Selection = import('../../../state').Selection;
type ReactNode = import('react').ReactNode;

const LAST = REFERENCE_ROW_COUNT - 1;
const LIST = { type: 'dropdown', type2: '', value1: 'Yes,No', value2: '' };
const NUMBER = { type: 'number', type2: 'between', value1: '1', value2: '10' };
const B3 = { row: [2, 2], column: [1, 1], row_focus: 2, column_focus: 1 };
const NO_RANGE = 'Enter a cell range, such as A1:B10';

// A 1,000-row sheet with these rules and this selection.
const sheetWith = (selection: Selection, dataValidations = {}) => ({
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

const openDialog = (selection: Selection, dataValidations = {}, grid?: () => ReactNode) =>
    renderSheetDialog((d) => d.showDialog(createElement(DataValidation)), sheetWith(selection, dataValidations), grid);

type Dialog = Awaited<ReturnType<typeof openDialog>>;

const rules = (dialog: Dialog) => dialog.context().sheets[0].dataValidations;

// The message that says why Apply or Remove validation refused what a field holds.
const problemOf = (field: HTMLElement) => {
    const id = field.getAttribute('aria-describedby');
    return id ? document.getElementById(id)?.textContent : undefined;
};

const pickWith = (label: string) =>
    act(async () => {
        document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`)?.click();
    });

test('Data validation keeps the dialog contract', async () => {
    const form = sheetDialogForm((d) => d.showDialog(createElement(DataValidation)), sheetWith(B3));
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: 'Cell range',
        onSubmit: form.write,
        makeChanged: () => typeInto('Options', 'Yes,No'),
        makeInvalid: () => typeInto('Cell range', ''),
        invalidField: 'Cell range',
        except: SYNCHRONOUS_WRITE,
    });
});

test('a column header selection is named B:B, and Apply puts the rule on the whole column and closes', async () => {
    const dialog = await openDialog({
        row: [0, 999],
        column: [1, 1],
        row_focus: 0,
        column_focus: 1,
        column_select: true,
    });
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data validation');
    expect(dialog.footer()).toEqual(['Remove validation', 'Cancel', 'Apply']);
    expect(dialog.button('Remove validation')?.dataset.variant).toBe('ghost');
    expect(dialog.button('Apply')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog.field('Cell range').value).toBe('B:B');
    await dialog.type('Options', 'Yes,No');
    await dialog.click('Apply');
    expect(Object.values(rules(dialog) ?? {})).toMatchObject([
        { ranges: [{ row: [0, LAST], column: [1, 1] }], order: 'a0', rule: { type: 'dropdown', value1: 'Yes,No' } },
    ]);
    expect(dialog.dialogs()).toHaveLength(0);
});

// The choices of the dialog's drop-downs, in order: the rule type first, then the condition.
const choices = () =>
    [...document.querySelectorAll('[role="dialog"] select')].map((select) =>
        [...select.querySelectorAll('option')].map((option) => option.textContent),
    );

test('the rule types and their conditions read as plain words', async () => {
    await openDialog(B3, { v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER } });
    expect(choices()).toEqual([
        ['Drop-down list', 'Checkbox', 'Number', 'Whole number', 'Decimal number', 'Text', 'Text length', 'Date'],
        [
            'Between',
            'Not between',
            'Equal to',
            'Not equal to',
            'Greater than',
            'Less than',
            'Greater than or equal to',
            'Less than or equal to',
        ],
    ]);
});

test('the reason a value is refused is an alert the field points at', async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER },
    });
    await dialog.type('Value 2', '0');
    await dialog.click('Apply');
    const id = dialog.field('Value 2').getAttribute('aria-describedby');
    expect(id && document.getElementById(id)?.getAttribute('role')).toBe('alert');
});

test('Enter in a text field submits', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Options', 'Red,Green');
    await act(async () => pressEnter(dialog.field('Options')));
    expect(Object.values(rules(dialog) ?? {})).toMatchObject([{ rule: { type: 'dropdown', value1: 'Red,Green' } }]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a refused value keeps the dialog open, says why, and keeps what was typed until it changes', async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER },
    });
    await dialog.type('Value 2', '0');
    await dialog.click('Apply');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(problemOf(dialog.field('Value 2'))).toBe('The value 2 cannot be less than the value 1');
    expect(dialog.field('Value 2').value).toBe('0');
    expect(rules(dialog)).toEqual({ v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER } });
    expect(dialog.context().warning).toBeUndefined();
    await dialog.type('Value 2', '20');
    expect(problemOf(dialog.field('Value 2'))).toBeUndefined();
});

test('a range that names no cells keeps the dialog open and says why under the range', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Options', 'Yes,No');
    await dialog.type('Cell range', '');
    await dialog.click('Apply');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(problemOf(dialog.field('Cell range'))).toBe(NO_RANGE);
    expect(dialog.field('Options').value).toBe('Yes,No');
    expect(rules(dialog)).toEqual({});
});

test("opening on a rule's cell reads the rule, and Remove validation takes its range out of the rule", async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, LAST], column: [1, 1] }], order: 'a0', rule: LIST },
    });
    expect(dialog.field('Cell range').value).toBe('B3');
    expect(dialog.field('Options').value).toBe('Yes,No');
    await dialog.type('Cell range', 'B2:B3');
    await dialog.click('Remove validation');
    expect(rules(dialog)).toEqual({
        v: {
            ranges: [
                { row: [0, 0], column: [1, 1] },
                { row: [3, LAST], column: [1, 1] },
            ],
            order: 'a0',
            rule: LIST,
        },
    });
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Remove validation with no range to take the rule from stays open and says why under the range', async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, LAST], column: [1, 1] }], order: 'a0', rule: LIST },
    });
    await dialog.type('Cell range', '');
    await dialog.click('Remove validation');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data validation');
    expect(problemOf(dialog.field('Cell range'))).toBe(NO_RANGE);
    expect(Object.keys(rules(dialog) ?? {})).toEqual(['v']);
});

test('back from the range picker, the draft keeps every value the user typed', async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER },
    });
    await dialog.type('Value 2', '50');
    await pickWith('Select cell range');
    expect(dialog.title()).toBe('Select cell range');
    await dialog.click('Select');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Data validation');
    expect(dialog.field('Cell range').value).toBe('B3');
    expect(dialog.field('Value 2').value).toBe('50');
});

test('back from the range picker, a changed draft still asks before Esc drops it', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Options', 'Red,Green');
    await pickWith('Select cell range');
    await dialog.click('Select');
    await act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toContain('Discard changes?');
});

test('Cancel in the range picker brings the dialog back with its draft too', async () => {
    const dialog = await openDialog(B3, {
        v: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: NUMBER },
    });
    await dialog.type('Value 2', '50');
    await pickWith('Select cell range');
    await dialog.click('Cancel');
    expect(dialog.title()).toBe('Data validation');
    expect(dialog.field('Value 2').value).toBe('50');
});

test('Escape in the range picker brings the dialog back with its draft too', async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Cell range', 'B2:B3');
    await pickWith('Select cell range');
    await act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    expect(dialog.title()).toBe('Data validation');
    expect(dialog.field('Cell range').value).toBe('B2:B3');
});

// Whichever dialog takes the slot, the editor comes back: it must not stay off-screen for good.
test('the cell editor waits off-screen only while the range picker holds the slot', async () => {
    const dialog = await openDialog(B3, {}, () => createElement(InputBox));
    const parked = () => document.querySelector<HTMLElement>('.sheet-input-box')?.style.left === '-10000px';
    expect(parked()).toBe(false);
    await pickWith('Select cell range');
    expect(parked()).toBe(true);
    await dialog.show((d) => d.showConfirm({ title: 'Delete sheet?', description: 'A question', onConfirm: () => {} }));
    expect(dialog.dialogs()[0]?.textContent).toContain('A question');
    expect(parked()).toBe(false);
});

test("the list's grid button picks the options' source and keeps the range", async () => {
    const dialog = await openDialog(B3);
    await dialog.type('Cell range', 'B2:B3');
    await dialog.type('Options', 'A1:A2');
    await pickWith('Select options from a range');
    await dialog.click('Select');
    expect(dialog.field('Cell range').value).toBe('B2:B3');
    expect(dialog.field('Options').value).toBe('A1:A2');
});

test('each label names its control', async () => {
    await openDialog(B3);
    const target = (text: string) => {
        const label = [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent === text);
        return label && document.getElementById(label.getAttribute('for') ?? '');
    };
    expect(target('Cell range')?.hasAttribute('aria-label')).toBe(false);
    expect(target('Validation condition')?.getAttribute('role')).toBe('combobox');
    for (const text of ['Allow multiple selection', 'Prohibit input when input data is invalid']) {
        expect(target(text)?.getAttribute('role')).toBe('checkbox');
    }
});
