// The Manage rules dialog lists the sheet's conditional formats, each with its description and range, and a named
// delete button that removes that rule at once. It is a list with no submit, so its footer has only Close.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { ManageRules } = await import('../../../components/ConditionFormat/ManageRules');

type Rule = import('@workspace/lib/sheets').ConditionalFormatRule;
type SheetConfig = import('../../../state').SheetConfig;

const GREATER_THAN: Rule = {
    type: 'default',
    cellrange: [{ row: [0, 3], column: [0, 0] }],
    format: { textColor: null, cellColor: '#d0fae5' },
    conditionName: 'greaterThan',
    conditionRange: [],
    conditionValue: ['3'],
};
const COLOR_SCALE: Rule = {
    type: 'colorGradation',
    cellrange: [{ row: [1, 1], column: [1, 1] }],
    format: ['#f8696b', '#ffffff'],
};

const openManageRules = (rules: Rule[], config: SheetConfig = {}) =>
    renderSheetDialog((d) => d.showDialog(createElement(ManageRules)), {
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, config, data: [[null]], conditionalFormatRules: rules }],
    });

const deleteButtons = () => [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"] button[aria-label="Delete rule"]'),
];

test('it lists the rules in one dialog with only Close, which closes it', async () => {
    const dialog = await openManageRules([GREATER_THAN, COLOR_SCALE]);
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Manage rules');
    expect(dialog.footer()).toEqual(['Close']);
    expect(dialog.button('Close')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    // A long list scrolls inside the dialog, so the footer stays on screen.
    expect(document.querySelector('[role="dialog"] .overflow-y-auto')?.classList).toContain('max-h-[40vh]');
    await dialog.click('Close');
    expect(dialog.dialogs()).toHaveLength(0);
    expect(dialog.context().sheets[0]?.conditionalFormatRules).toEqual([GREATER_THAN, COLOR_SCALE]);
});

test('a sheet with no rules says so', async () => {
    const dialog = await openManageRules([]);
    expect(dialog.dialogs()[0]?.textContent).toContain('No rules on this sheet.');
});

test('each rule has a named delete button that removes it at once', async () => {
    const dialog = await openManageRules([GREATER_THAN, COLOR_SCALE]);
    expect(dialog.dialogs()[0]?.textContent).toContain('Greater than 3');
    expect(dialog.dialogs()[0]?.textContent).toContain('A1:A4');
    expect(dialog.dialogs()[0]?.textContent).toContain('B2');
    expect(deleteButtons()).toHaveLength(2);
    await act(async () => deleteButtons()[0]?.click());
    expect(dialog.context().sheets[0]?.conditionalFormatRules).toEqual([COLOR_SCALE]);
    expect(dialog.dialogs()).toHaveLength(1);
});

test('a formula rule, such as one whose value reads a cell, shows its formula', async () => {
    const dialog = await openManageRules([{ ...GREATER_THAN, conditionName: 'formula', conditionValue: ['=A1>$B$1'] }]);
    expect(dialog.dialogs()[0]?.textContent).toContain('Custom formula =A1>$B$1');
});
