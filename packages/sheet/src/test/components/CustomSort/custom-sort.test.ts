// The Custom sort dialog sorts the selected range by the column picked under Sort by, and names the columns by their
// header when the data has a header row. Two columns with the same header are still two choices.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { CustomSort } = await import('../../../components/CustomSort');

const consoleError = spyOn(console, 'error');
afterEach(() => consoleError.mockClear());

const cell = (v: string | number) => ({ v, m: String(v) });

// A1:B3 selected, with a header row whose two columns share a name.
const openCustomSort = () =>
    renderSheetDialog((d) => d.showDialog(createElement(CustomSort)), {
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
        selections: [{ row: [0, 2], column: [0, 1], row_focus: 0, column_focus: 0 }],
    });

test('a header row whose columns share a name keeps one choice per column', async () => {
    await openCustomSort();
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')?.click());
    const duplicateKeys = consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'));
    expect(duplicateKeys).toEqual([]);
});
