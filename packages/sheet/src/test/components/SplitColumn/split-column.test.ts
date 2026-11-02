// The Split text dialog previews the selected column cut at the ticked separators. OK, or Enter in the Other field,
// writes the pieces across the row and closes. When the cells to the right hold data, OK asks first and the question
// stays open: only a yes overwrites them.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { SplitColumn } = await import('../../../components/SplitColumn');
type Cell = import('../../../state').Cell;

const consoleError = spyOn(console, 'error');
afterEach(() => consoleError.mockClear());

const cell = (v: string) => ({ v, m: v });

// A1:A2 selected.
const openSplitText = (data: (Cell | null)[][]) =>
    renderSheetDialog((d) => d.showFormDialog(createElement(SplitColumn)), {
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data }],
        selections: [{ row: [0, 1], column: [0, 0], row_focus: 0, column_focus: 0 }],
    });

const tick = (label: string) =>
    act(async () => {
        const row = [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent === label);
        row?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    });

const preview = () =>
    [...document.querySelectorAll('[role="dialog"] table tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );

test('a row whose pieces repeat previews every piece', async () => {
    await openSplitText([
        [cell('x,x'), null],
        [cell('y,z'), null],
    ]);
    await tick('comma');
    expect(preview()).toEqual([
        ['x', 'x'],
        ['y', 'z'],
    ]);
    const duplicateKeys = consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'));
    expect(duplicateKeys).toEqual([]);
});

const row = (context: import('../../../state').Context, r: number) =>
    context.sheets[0]?.data?.[r]?.slice(0, 2).map((c) => c?.v ?? null);

test('OK writes the pieces across the row and closes', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), null],
        [cell('Alan,Turing'), null],
    ]);
    expect(dialog.title()).toBe('Split text');
    expect(dialog.footer()).toEqual(['Cancel', 'OK']);
    expect(dialog.button('OK')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await tick('comma');
    await dialog.click('OK');
    expect(row(dialog.context(), 0)).toEqual(['Ada', 'Lovelace']);
    expect(row(dialog.context(), 1)).toEqual(['Alan', 'Turing']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Enter in the Other field splits at its character', async () => {
    const dialog = await openSplitText([
        [cell('Ada;Lovelace'), null],
        [cell('Alan;Turing'), null],
    ]);
    await tick('Other');
    await dialog.type('Other separator', ';');
    await act(async () => pressEnter(dialog.field('Other separator')));
    expect(row(dialog.context(), 0)).toEqual(['Ada', 'Lovelace']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('with data to the right, OK asks first, and the question stays open until a yes', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), cell('keep')],
        [cell('Alan,Turing'), null],
    ]);
    await tick('comma');
    await dialog.click('OK');
    expect(dialog.title()).toBe('Notice');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(row(dialog.context(), 0)).toEqual(['Ada,Lovelace', 'keep']);
    await dialog.click('OK');
    expect(row(dialog.context(), 0)).toEqual(['Ada', 'Lovelace']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Cancel on the question leaves the data to the right', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), cell('keep')],
        [cell('Alan,Turing'), null],
    ]);
    await tick('comma');
    await dialog.click('OK');
    await dialog.click('Cancel');
    expect(row(dialog.context(), 0)).toEqual(['Ada,Lovelace', 'keep']);
    expect(dialog.dialogs()).toHaveLength(0);
});
