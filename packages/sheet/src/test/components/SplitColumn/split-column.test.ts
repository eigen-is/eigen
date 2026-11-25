// The Split text dialog keeps the dialog contract. It previews the selected column cut at the ticked separators, each
// named in sentence case, and Apply writes the pieces across the row and closes. With nothing to split at, Apply says
// why under the separators. When the cells to the right hold data, Apply asks first, naming them, and the question
// stays open: only Replace overwrites them.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog, sheetDialogForm, SYNCHRONOUS_WRITE } = await import('../sheet-dialog');
const { SplitColumn } = await import('../../../components/SplitColumn');
type Cell = import('../../../state').Cell;

const consoleError = spyOn(console, 'error');
afterEach(() => consoleError.mockClear());

const cell = (v: string) => ({ v, m: v });

// A1:A2 selected.
const columnOf = (data: (Cell | null)[][]) => ({
    sheets: [{ name: 'sheet', id: 'id_1', order: 0, config: {}, data }],
    selections: [{ row: [0, 1], column: [0, 0], row_focus: 0, column_focus: 0 }],
});
const openSplitText = (data: (Cell | null)[][]) =>
    renderSheetDialog((d) => d.showDialog(createElement(SplitColumn)), columnOf(data));

const tick = (label: string) =>
    act(async () => {
        const name = [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent === label);
        document.getElementById(name?.getAttribute('for') ?? '')?.click();
    });

const preview = () =>
    [...document.querySelectorAll('[role="dialog"] table tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );

const NAMES = [
    [cell('Ada,Lovelace'), null],
    [cell('Alan,Turing'), null],
];

test('Split text keeps the dialog contract', async () => {
    const form = sheetDialogForm((d) => d.showDialog(createElement(SplitColumn)), columnOf(NAMES));
    await expectFormContract({
        kind: 'dialog',
        render: form.render,
        submitLabel: 'Apply',
        firstField: 'Other separator',
        onSubmit: form.write,
        makeChanged: () => tick('Comma'),
        // A fresh dialog has no separator ticked.
        makeInvalid: async () => {},
        invalidField: 'Tab',
        except: SYNCHRONOUS_WRITE,
    });
});

const refusal = () => document.querySelector('[role="dialog"] [data-slot="field-error"]')?.textContent;

test('with nothing to split at, Apply says why and keeps the dialog', async () => {
    const dialog = await openSplitText(NAMES);
    await dialog.click('Apply');
    expect(refusal()).toBe('Choose a separator');
    await tick('Semicolon');
    expect(refusal()).toBeUndefined();
    await dialog.click('Apply');
    expect(refusal()).toBe('No selected cell holds these separators');
    await tick('Other');
    await dialog.click('Apply');
    expect(refusal()).toBe('Type the other separator');
    expect(document.activeElement).toBe(dialog.field('Other separator'));
    expect(row(dialog.context(), 0)).toEqual(['Ada,Lovelace', null]);
    expect(dialog.dialogs()).toHaveLength(1);
});

test('a row whose pieces repeat previews every piece', async () => {
    await openSplitText([
        [cell('x,x'), null],
        [cell('y,z'), null],
    ]);
    await tick('Comma');
    expect(preview()).toEqual([
        ['x', 'x'],
        ['y', 'z'],
    ]);
    const duplicateKeys = consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'));
    expect(duplicateKeys).toEqual([]);
});

test('it names each separator in sentence case, and two separators in a row can count as one', async () => {
    const dialog = await openSplitText([
        [cell('Ada,,Lovelace'), null],
        [cell('Alan,Turing'), null],
    ]);
    expect(dialog.dialogs()[0]?.textContent).toStartWith('Split textSeparators');
    expect([...document.querySelectorAll('[role="dialog"] label')].map((l) => l.textContent)).toEqual([
        'Tab',
        'Semicolon',
        'Comma',
        'Space',
        'Other',
        'Treat consecutive separators as one',
    ]);
    await tick('Comma');
    expect(preview()[0]).toEqual(['Ada', '', 'Lovelace']);
    await tick('Treat consecutive separators as one');
    await dialog.click('Apply');
    expect(row(dialog.context(), 0)).toEqual(['Ada', 'Lovelace']);
});

const row = (context: import('../../../state').Context, r: number) =>
    context.sheets[0]?.data?.[r]?.slice(0, 2).map((c) => c?.v ?? null);

test('Apply writes the pieces across the row and closes', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), null],
        [cell('Alan,Turing'), null],
    ]);
    expect(dialog.title()).toBe('Split text');
    expect(dialog.footer()).toEqual(['Cancel', 'Apply']);
    expect(dialog.button('Apply')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await tick('Comma');
    await dialog.click('Apply');
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

test('with data to the right, Apply asks first, and the question stays open until Replace', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), cell('keep')],
        [cell('Alan,Turing'), null],
    ]);
    await tick('Comma');
    await dialog.click('Apply');
    expect(dialog.title()).toBe('Replace data?');
    expect(dialog.dialogs()[0]?.textContent).toContain("There's already data in B1:B2. Do you want to replace it?");
    expect(dialog.footer()).toEqual(['Cancel', 'Replace']);
    expect(dialog.button('Replace')?.dataset.variant).toBe('destructive');
    expect(dialog.dialogs()).toHaveLength(1);
    expect(row(dialog.context(), 0)).toEqual(['Ada,Lovelace', 'keep']);
    await dialog.click('Replace');
    expect(row(dialog.context(), 0)).toEqual(['Ada', 'Lovelace']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Cancel on the question leaves the data to the right', async () => {
    const dialog = await openSplitText([
        [cell('Ada,Lovelace'), cell('keep')],
        [cell('Alan,Turing'), null],
    ]);
    await tick('Comma');
    await dialog.click('Apply');
    await dialog.click('Cancel');
    expect(row(dialog.context(), 0)).toEqual(['Ada,Lovelace', 'keep']);
    expect(dialog.dialogs()).toHaveLength(0);
});
