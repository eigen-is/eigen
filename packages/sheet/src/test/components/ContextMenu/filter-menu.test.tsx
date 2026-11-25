// The filter menu a filtered column's header button opens: its footer says Apply, which hides the rows whose values
// were unticked and closes the menu, and Cancel closes it with the filter as it was.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { renderSheetDialog } = await import('../sheet-dialog');
const { FilterMenu } = await import('../../../components/ContextMenu/FilterMenu');

const cell = (v: string) => ({ v, m: v });

// A1:A3 under a filter, with its menu open on column A.
const openFilterMenu = () =>
    renderSheetDialog(
        () => {},
        {
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: {},
                    data: [[cell('Fruit')], [cell('apple')], [cell('pear')]],
                },
            ],
            filterContextMenu: { x: 0, y: 0, col: 0, startRow: 0, endRow: 2, startCol: 0, endCol: 0 },
        },
        () => createElement(FilterMenu),
    );

const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button')].find(
        (b) => b.textContent === label,
    );

test('Apply hides the unticked values and closes the menu', async () => {
    const menu = await openFilterMenu();
    expect(button('Confirm')?.textContent).toBeUndefined();
    const pear = [...document.querySelectorAll('[data-slot="popover-content"] label')].find((l) =>
        l.textContent?.startsWith('pear'),
    );
    await act(async () => pear?.querySelector<HTMLElement>('[role="checkbox"]')?.click());
    await act(async () => button('Apply')?.click());
    expect(Object.keys(menu.context().sheets[0].config?.rowhidden ?? {})).toEqual(['2']);
    expect(menu.context().filterContextMenu).toBeUndefined();
});

test('Cancel closes the menu and filters nothing', async () => {
    const menu = await openFilterMenu();
    await act(async () => button('Cancel')?.click());
    expect(menu.context().sheets[0].config?.rowhidden ?? {}).toEqual({});
    expect(menu.context().filterContextMenu).toBeUndefined();
});
