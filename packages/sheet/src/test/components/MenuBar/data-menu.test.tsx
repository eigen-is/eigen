// The Data menu sorts one selected range: with no selection, or several, its Sort range submenu is disabled. Custom
// sort opens on the selected range, and a whole-row selection offers only the columns that hold data.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import(
    '@workspace/ui/components/dropdown-menu'
);
const { DataMenu } = await import('../../../components/MenuBar/data-menu');
type Selection = import('../../../state').Selection;

const cell = (v: string) => ({ v, m: v });

// The Data menu, open, over a sheet whose data fills A1:B2 of 200 columns.
const openDataMenu = (selections: Selection[]) =>
    renderSheetDialog(
        () => {},
        {
            sheets: [
                {
                    id: 'id_1',
                    name: 'Sheet1',
                    order: 0,
                    config: {},
                    data: [
                        [cell('b'), cell('2'), ...Array(198).fill(null)],
                        [cell('a'), cell('1'), ...Array(198).fill(null)],
                    ],
                },
            ],
            selections,
            allowEdit: true,
        },
        () =>
            createElement(
                DropdownMenu,
                { open: true },
                createElement(DropdownMenuTrigger, null, 'Data'),
                createElement(DropdownMenuContent, null, createElement(DataMenu)),
            ),
    );

const sortRange = () =>
    [...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent?.trim() === 'Sort range');

test('with no selection, Sort range is disabled', async () => {
    await openDataMenu([]);
    expect(sortRange()?.getAttribute('aria-disabled')).toBe('true');
});

test('a whole-row selection offers only the columns that hold data', async () => {
    const dialog = await openDataMenu([
        { row: [0, 1], column: [0, 199], row_focus: 0, column_focus: 0, row_select: true },
    ]);
    expect(sortRange()?.getAttribute('aria-disabled')).toBeNull();
    await openSubmenu('Sort range');
    await clickRow('Custom sort');
    expect(dialog.title()).toBe('Custom sort');
    expect(dialog.dialogs()[0]?.textContent).toContain('Sort range from A1 to B2');
    expect(document.querySelectorAll('[role="dialog"] select option')).toHaveLength(2);
});
