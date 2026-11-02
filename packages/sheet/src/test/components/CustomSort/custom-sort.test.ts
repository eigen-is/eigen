// The Custom sort dialog sorts the selected range by the column picked under Sort by, ascending or descending, and
// closes. With a header row ticked, it names the columns by their header and leaves that row in place, and two columns
// with the same header are still two choices. Cancel closes it with the range as it was.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { CustomSort } = await import('../../../components/CustomSort');

const consoleError = spyOn(console, 'error');
afterEach(() => consoleError.mockClear());

const cell = (v: string | number) => ({ v, m: String(v) });
const A1_B3 = { row: [0, 2], column: [0, 1], row_focus: 0, column_focus: 0 };

// A1:B3 selected, with a header row whose two columns share a name.
const openWithHeaders = () =>
    renderSheetDialog((d) => d.showDialog(createElement(CustomSort, { selection: A1_B3 })), {
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                config: {},
                data: [
                    [cell('Name'), cell('Name')],
                    [cell('b'), cell(2)],
                    [cell('a'), cell(1)],
                ],
            },
        ],
        selections: [A1_B3],
    });

// A1:B3 selected, rows of a letter and a number.
const openCustomSort = () =>
    renderSheetDialog((d) => d.showDialog(createElement(CustomSort, { selection: A1_B3 })), {
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                config: {},
                data: [
                    [cell('b'), cell(2)],
                    [cell('c'), cell(3)],
                    [cell('a'), cell(1)],
                ],
            },
        ],
        selections: [A1_B3],
    });

const columnA = (context: import('../../../state').Context) => context.sheets[0]?.data?.map((row) => row[0]?.v);
const columnB = (context: import('../../../state').Context) => context.sheets[0]?.data?.map((row) => row[1]?.v);
const sortBy = () => document.querySelector('[role="dialog"] [role="combobox"]')?.textContent;

test('it names the range, sorts it descending by the first column and closes', async () => {
    const dialog = await openCustomSort();
    expect(dialog.dialogs()).toHaveLength(1);
    expect(dialog.title()).toBe('Custom sort');
    expect(dialog.dialogs()[0]?.textContent).toContain('Sort range from A1 to B3');
    expect(sortBy()).toBe('A');
    expect(dialog.footer()).toEqual(['Cancel', 'Sort']);
    expect(dialog.button('Sort')?.dataset.size).toBe('default');
    expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="radio"][value="desc"]')?.click());
    await dialog.click('Sort');
    expect(columnA(dialog.context())).toEqual(['c', 'b', 'a']);
    expect(columnB(dialog.context())).toEqual([3, 2, 1]);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('Cancel closes it and leaves the range as it was', async () => {
    const dialog = await openCustomSort();
    await dialog.click('Cancel');
    expect(columnA(dialog.context())).toEqual(['b', 'c', 'a']);
    expect(dialog.dialogs()).toHaveLength(0);
});

test('a header row whose columns share a name keeps one choice per column', async () => {
    await openWithHeaders();
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')?.click());
    const duplicateKeys = consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'));
    expect(duplicateKeys).toEqual([]);
    expect(sortBy()).toBe('Name');
});

test('a ticked header row stays in place and only the rows below it sort', async () => {
    const dialog = await openWithHeaders();
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')?.click());
    await dialog.click('Sort');
    expect(columnA(dialog.context())).toEqual(['Name', 'a', 'b']);
    expect(columnB(dialog.context())).toEqual(['Name', 1, 2]);
    expect(dialog.dialogs()).toHaveLength(0);
});
