// A conditional-format rule's dialog adds its rule over the selection on OK or Enter and closes. A value the rule
// refuses keeps the dialog open with the reason under the field and the typed value in place, and saves nothing. A
// click in a color swatch's popover picks the color and leaves the dialog open, as a click outside it does not.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { ConditionRules } = await import('../../../components/ConditionFormat/ConditionRules');

type RuleType = import('../../../components/ConditionFormat/ConditionRules').ConditionRuleType;

const cell = (v: number) => ({ v, m: String(v), ct: { fa: 'General', t: 'n' } });

// A1 holds 5, and B2:C3 is selected.
const openRule = (type: RuleType) =>
    renderSheetDialog((d) => d.showFormDialog(createElement(ConditionRules, { type })), {
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                config: {},
                data: [
                    [cell(5), null, null],
                    [null, null, null],
                    [null, null, null],
                ],
            },
        ],
        selections: [{ row: [1, 2], column: [1, 2] }],
    });

const rules = (context: import('../../../state').Context) => context.sheets[0]?.conditionalFormatRules ?? [];
const values = (context: import('../../../state').Context) =>
    rules(context).flatMap((rule) => (rule.type === 'default' ? [rule.conditionValue] : []));
const alert = () => document.querySelector('[role="dialog"] [role="alert"]')?.textContent;

// Radix starts listening for outside clicks a tick after the dialog opens, and closes on the click, so the whole press
// goes in.
const press = async (target: Element) => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
};

test('it adds a Greater than rule over the selection on OK and closes', async () => {
    const dialog = await openRule('greaterThan');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Greater than');
    expect(dialog.dialogs()[0]?.textContent).toContain('Format cells greater than');
    expect(dialog.footer()).toEqual(['Cancel', 'OK']);
    expect(dialog.button('OK')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await dialog.type('Value', '3');
    await dialog.click('OK');
    expect(rules(dialog.context())).toEqual([
        {
            type: 'default',
            cellrange: [{ row: [1, 2], column: [1, 2] }],
            format: { textColor: null, cellColor: '#d0fae5' },
            conditionName: 'greaterThan',
            conditionRange: [],
            conditionValue: ['3'],
        },
    ]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the value field submits, and a typed cell reads that cell', async () => {
    const dialog = await openRule('equal');
    await dialog.type('Value', 'A1');
    await act(async () => pressEnter(dialog.field('Value')));
    expect(values(dialog.context())).toEqual([[5]]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a refused value stays open with the reason under the field and the typed value kept', async () => {
    const dialog = await openRule('greaterThan');
    await dialog.type('Value', 'abc');
    await dialog.click('OK');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(alert()).toBe('The condition value can only be a number or a single cell');
    expect(dialog.field('Value').value).toBe('abc');
    expect(rules(dialog.context())).toEqual([]);
    expect(dialog.context().warnDialog).toBeUndefined();

    await dialog.type('Value', 'A1:B2');
    await act(async () => pressEnter(dialog.field('Value')));
    expect(alert()).toBe('Only a single cell can be referenced');
    expect(dialog.dialogs()).toHaveLength(1);
});

test('Between takes two values, and refuses an empty second one', async () => {
    const dialog = await openRule('between');
    await dialog.type('Lower value', '1');
    await dialog.click('OK');
    expect(alert()).toBe('The condition value can only be a number or a single cell');
    expect(dialog.field('Lower value').value).toBe('1');
    await dialog.type('Upper value', '9');
    await dialog.click('OK');
    expect(values(dialog.context())).toEqual([['1', '9']]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Top 10 refuses a count past 1000 and keeps it', async () => {
    const dialog = await openRule('top10');
    await dialog.type('Number of cells', '1001');
    await dialog.click('OK');
    expect(alert()).toBe('Please enter an integer between 1 and 1000');
    expect(dialog.field('Number of cells').value).toBe('1001');
    expect(rules(dialog.context())).toEqual([]);
});

test('a color picked in the swatch popover keeps the dialog open and colors the rule', async () => {
    const dialog = await openRule('aboveAverage');
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] #checkTextColor')?.click());
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Choose text color"]')?.click());
    const swatch = document.querySelector<HTMLElement>('[data-slot="popover-content"] button[title]');
    if (!swatch) throw new Error('no color in the popover');
    await press(swatch);
    expect(document.querySelectorAll('[data-slot="dialog-content"]')).toHaveLength(1);
    await dialog.click('OK');
    const [rule] = rules(dialog.context());
    expect(rule?.type === 'default' && rule.format.textColor).toBe(swatch.title);
});

test('a click outside the dialog closes it and saves nothing', async () => {
    const dialog = await openRule('greaterThan');
    await dialog.type('Value', '3');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (!overlay) throw new Error('no overlay');
    await press(overlay);
    expect(dialog.dialogs()).toHaveLength(0);
    expect(rules(dialog.context())).toEqual([]);
});
