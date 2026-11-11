// The workbook's bar keeps every menu and every format icon in reach. A wide bar shows the icon row beside the
// menus. A narrow bar folds the row away by its own width, which happy-dom can't draw, so the test pins where the
// folded icons go: each one's action is a row of the Format menu. Each menu's rows are pinned as a user reads them:
// a command row leads with its icon, and a choice or a submenu's leaf row has none, as in Google Sheets.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { checkRows, clickRow, collapseSeparators, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AppBarMenu } = await import('@workspace/ui/components/layout/toolbar');
const { DropdownMenuItem } = await import('@workspace/ui/components/dropdown-menu');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type CellWithRowAndCol = import('@workspace/lib/sheets').CellWithRowAndCol;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// A workbook with the host's items at the bar's ends, as the Sheets app passes its File menu and share buttons.
async function mountWorkbook({
    celldata = [],
    allowEdit = true,
}: {
    celldata?: CellWithRowAndCol[];
    allowEdit?: boolean;
} = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, row: 10, column: 5, celldata, config: {} }];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref: workbook,
                data,
                allowEdit,
                hooks: {},
                toolbarLeftItems: createElement(AppBarMenu, {
                    label: 'File',
                    children: createElement(DropdownMenuItem, null, 'New sheet'),
                }),
                toolbarRightItems: createElement('button', { type: 'button', 'aria-label': 'Share' }),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const cell = (r: number, c: number) => workbook.current?.getAllSheets()[0]?.data?.[r]?.[c];
    return { container, cell };
}

const menuTriggers = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="menubar"] [role="menuitem"]')].map((trigger) => trigger.textContent);

const labelledButtons = (container: HTMLElement) =>
    [...container.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label'));

// Every row of every open menu, a submenu's included, each without its shortcut, which reads per platform.
const openRows = () =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((row) =>
        (row.textContent ?? '')
            .replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
            .trim(),
    );

// Opens a bar menu, closing the one open first, as a press elsewhere would.
async function openMenu(container: HTMLElement, label: string) {
    while (document.querySelector('[role="menu"]')) {
        await act(async () => {
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
        });
    }
    const trigger = [...container.querySelectorAll('[role="menubar"] [role="menuitem"]')].find(
        (entry) => entry.textContent === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

const openFormat = (container: HTMLElement) => openMenu(container, 'Format');

// The last-opened menu's rows, a separator as '—' and a row that leads with an icon as '+ label'. A submenu's chevron
// and a choice's check trail or sit apart from the label, so neither counts as the row's icon.
const iconRows = () =>
    collapseSeparators(
        [...([...document.querySelectorAll('[role="menu"]')].at(-1)?.children ?? [])]
            .flatMap((row) => (row.getAttribute('role') === 'group' ? [...row.children] : [row]))
            .map((row) => {
                if (row.getAttribute('role') === 'separator') return '—';
                const label = (row.textContent ?? '')
                    .replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
                    .trim();
                const icon = [...row.children].some(
                    (child) => child.tagName.toLowerCase() === 'svg' && !child.classList.contains('ml-auto'),
                );
                return icon ? `+ ${label}` : label;
            }),
    );

test('a wide bar holds the host items, the six menus and the whole icon row', async () => {
    const { container } = await mountWorkbook();

    expect(menuTriggers(container)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Data']);
    // The font picker names the cell's font.
    expect(
        [...container.querySelectorAll('button[aria-haspopup="menu"]')].some(
            (button) => button.textContent === 'Inter',
        ),
    ).toBe(true);
    // The bar comes first, the sheet tabs after it.
    expect(labelledButtons(container).slice(0, 10)).toEqual([
        'Decrease font size',
        'Increase font size',
        'Bold',
        'Italic',
        'Text color',
        'Fill color',
        'Align left',
        'Align center',
        'Align right',
        'Share',
    ]);
});

test('a narrow bar folds the icon row into the Format menu', async () => {
    const { container } = await mountWorkbook();

    await openFormat(container);
    expect(openRows()).toEqual(expect.arrayContaining(['Text', 'Alignment', 'Font size', 'Fill color']));

    // Bold, Italic, the font picker and Text color.
    await openSubmenu('Text');
    expect(openRows()).toEqual(expect.arrayContaining(['Bold', 'Italic', 'Font', 'Text color']));

    // The three align buttons.
    await openSubmenu('Alignment');
    expect(openRows()).toEqual(expect.arrayContaining(['Left', 'Center', 'Right']));

    // The size box and its steppers.
    await openSubmenu('Font size');
    expect(openRows()).toEqual(expect.arrayContaining(['10', '12', '14']));
});

test('Edit holds the shared rows with their icons, and the Delete submenu its plain rows', async () => {
    const { container } = await mountWorkbook();

    await openMenu(container, 'Edit');
    // No find bar is mounted here, so Find and Find and replace are left out.
    expect(iconRows()).toEqual([
        '+ Undo',
        '+ Redo',
        '—',
        '+ Cut',
        '+ Copy',
        '+ Paste',
        '—',
        '+ Select all',
        '+ Paint format',
        '—',
        '+ Delete',
    ]);

    await openSubmenu('Delete');
    expect(iconRows()).toEqual(['Clear contents', 'Row', 'Column']);
});

test("a viewer's Edit menu copies and selects all", async () => {
    const { container } = await mountWorkbook({ allowEdit: false });

    await openMenu(container, 'Edit');
    expect(iconRows()).toEqual(['+ Copy', '—', '+ Select all']);
});

test('Edit › Select all selects the whole sheet', async () => {
    const { container, cell } = await mountWorkbook({
        celldata: [
            { r: 0, c: 0, v: { v: 'a', m: 'a' } },
            { r: 9, c: 4, v: { v: 'b', m: 'b' } },
        ],
    });

    await openMenu(container, 'Edit');
    // clickRow reads a row's whole text, and Select all's holds its shortcut.
    const selectAll = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((row) =>
        row.textContent?.trim().startsWith('Select all'),
    );
    await act(async () => selectAll?.click());
    await openFormat(container);
    await openSubmenu('Wrapping');
    await clickRow('Wrap');
    // The handler stores the wrap code as text: 2 is wrap.
    expect([cell(0, 0)?.tb, cell(9, 4)?.tb]).toEqual(['2', '2']);
});

test('View, Insert and Data lead each command with its icon, and their submenus list plain rows', async () => {
    const { container } = await mountWorkbook();

    await openMenu(container, 'View');
    expect(iconRows()).toEqual(['+ Freeze']);
    await openSubmenu('Freeze');
    expect(iconRows()).toEqual([
        'Cancel freezing',
        '—',
        'Freeze to current row',
        'Freeze to current column',
        'Freeze to current cell',
    ]);

    await openMenu(container, 'Insert');
    expect(iconRows()).toEqual([
        '+ Row',
        '+ Column',
        '+ Sheet',
        '—',
        '+ Chart',
        '+ Image',
        '—',
        '+ Auto SUM',
        '+ Link',
        '+ Tick box',
        '—',
        '+ Comment',
    ]);
    await openSubmenu('Auto SUM');
    expect(iconRows()).toEqual(['Sum (SUM)', 'Average', 'Count', 'Max', 'Min', '—', 'More functions…']);

    await openMenu(container, 'Data');
    expect(iconRows()).toEqual(['+ Sort range', '—', '+ Create filter', '—', '+ Data validation', '+ Split text']);
});

test('Format leads each command with its icon, and its choices have none', async () => {
    const { container } = await mountWorkbook();

    await openFormat(container);
    expect(iconRows()).toEqual([
        '+ Number',
        '+ Text',
        '+ Alignment',
        '+ Wrapping',
        '+ Text rotate',
        '—',
        '+ Font size',
        '+ Fill color',
        '+ Borders',
        '+ Merge cells',
        '—',
        '+ Conditional formatting',
        '—',
        '+ Clear formatting',
    ]);

    await openSubmenu('Text');
    expect(iconRows()).toEqual(['+ Bold', '+ Italic', '+ Underline', '+ Strikethrough', '—', '+ Font', '+ Text color']);

    await openMenu(container, 'Format');
    await openSubmenu('Font size');
    expect(iconRows().slice(0, 3)).toEqual(['9', '10', '11']);
});

test("Format › Alignment checks the cell's alignment, each option with its icon", async () => {
    const { container } = await mountWorkbook({ celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x', ht: 2, vt: 0 } }] });

    await openFormat(container);
    await openSubmenu('Alignment');
    expect(iconRows()).toEqual(['+ Left', '+ Center', '+ Right', '—', '+ Top', '+ Middle', '+ Bottom']);
    expect(checkRows()).toEqual([
        ['Left', 'false'],
        ['Center', 'false'],
        ['Right', 'true'],
        ['Top', 'false'],
        ['Middle', 'true'],
        ['Bottom', 'false'],
    ]);

    await clickRow('Left');
    await openFormat(container);
    await openSubmenu('Alignment');
    expect(checkRows()[0]).toEqual(['Left', 'true']);
});
