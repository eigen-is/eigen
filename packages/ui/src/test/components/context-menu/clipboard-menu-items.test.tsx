// The clipboard rows read as every Edit menu reads them: Cut, Copy and Paste, then Select all, Duplicate and a red
// Delete last. A host draws only the rows it passes, and with nothing selected the rows that act on a selection grey
// out while Paste and Select all stay.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows, renderOpenMenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement } = await import('react');
const { ClipboardMenuItems } = await import('../../../components/context-menu/object-menu-items');

let unmount = async () => {};
afterEach(() => unmount());

const noop = () => {};

async function render(props: Parameters<typeof ClipboardMenuItems>[0]) {
    ({ unmount } = await renderOpenMenu(createElement(ClipboardMenuItems, props)));
}

// A row's label, without the shortcut hint beside it.
const label = (row: Element) =>
    row.textContent?.replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '').trim();
const rowNamed = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((row) => label(row) === name);
const disabledRows = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"][data-disabled]')].map(label);

test('Cut, Copy and Paste alone draw as before, one group', async () => {
    await render({ onCut: noop, onCopy: noop, onPaste: noop });
    expect(menuRows()).toEqual(['Cut', 'Copy', 'Paste']);
    expect(document.querySelectorAll('[role="menu"] [role="separator"]').length).toBe(0);
});

test("docs' rows: Select all and Delete after the clipboard, Delete last and red", async () => {
    await render({ onCut: noop, onCopy: noop, onPaste: noop, onSelectAll: noop, onDelete: noop });
    expect(menuRows()).toEqual(['Cut', 'Copy', 'Paste', '—', 'Select all', 'Delete']);
    const rows = document.querySelectorAll('[role="menu"] [role="menuitem"]');
    expect(rows[rows.length - 1]?.getAttribute('data-variant')).toBe('destructive');
});

test("the canvas' rows: Duplicate before Delete", async () => {
    await render({ onCut: noop, onCopy: noop, onPaste: noop, onDuplicate: noop, onDelete: noop });
    expect(menuRows()).toEqual(['Cut', 'Copy', 'Paste', '—', 'Duplicate', 'Delete']);
});

test('nothing selected greys the rows that act on a selection, Paste and Select all stay', async () => {
    await render({
        onCut: noop,
        onCopy: noop,
        onPaste: noop,
        onSelectAll: noop,
        onDuplicate: noop,
        onDelete: noop,
        selectionEmpty: true,
    });
    expect(disabledRows()).toEqual(['Cut', 'Copy', 'Duplicate', 'Delete']);
});

test('a pick runs its row', async () => {
    const onSelectAll = mock(noop);
    const onDuplicate = mock(noop);
    await render({ onSelectAll, onDuplicate });
    await act(async () => rowNamed('Duplicate')?.click());
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onSelectAll).not.toHaveBeenCalled();
});
