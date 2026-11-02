// The Split text dialog previews the selected column cut at the ticked separators. OK writes the pieces across the
// row and closes. When the cells to the right hold data, OK asks first, and only a yes overwrites them.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

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
    renderSheetDialog((d) => d.showDialog(createElement(SplitColumn)), {
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
