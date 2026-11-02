// The Manage rules dialog lists the sheet's conditional formats, each with its description and range, and a named
// delete button that removes that rule at once. It has no submit: Close closes it.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { ManageRules } = await import('../../../components/ConditionFormat/ManageRules');

type Rule = import('@workspace/lib/sheets').ConditionalFormatRule;

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

const openManageRules = (rules: Rule[]) =>
    renderSheetDialog((d) => d.showDialog(createElement(ManageRules)), {
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data: [[null]], conditionalFormatRules: rules }],
    });

const deleteButtons = () => [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"] button[aria-label="Delete rule"]'),
];

test('each rule has a named delete button that removes it at once', async () => {
    const dialog = await openManageRules([GREATER_THAN, COLOR_SCALE]);
    expect(dialog.dialogs()[0]?.textContent).toContain('Greater than 3');
    expect(dialog.dialogs()[0]?.textContent).toContain('A1:A4');
    expect(deleteButtons()).toHaveLength(2);
    await act(async () => deleteButtons()[0]?.click());
    expect(dialog.context().sheets[0]?.conditionalFormatRules).toEqual([COLOR_SCALE]);
    expect(dialog.dialogs()).toHaveLength(1);
});
