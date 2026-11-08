// The workbook's bar keeps every menu and every format icon in reach. A wide bar shows the icon row beside the
// menus. A narrow bar folds the row away by its own width, which happy-dom can't draw, so the test pins where the
// folded icons go: each one's action is a row of the Format menu.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AppBarMenu } = await import('@workspace/ui/components/layout/toolbar');
const { DropdownMenuItem } = await import('@workspace/ui/components/dropdown-menu');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// A workbook with the host's items at the bar's ends, as the Sheets app passes its File menu and share buttons.
async function mountWorkbook() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, row: 10, column: 5, celldata: [], config: {} }];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                data,
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
    return container;
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

async function openFormat(container: HTMLElement) {
    const format = [...container.querySelectorAll('[role="menubar"] [role="menuitem"]')].find(
        (trigger) => trigger.textContent === 'Format',
    );
    await act(async () => {
        format?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

test('a wide bar holds the host items, the six menus and the whole icon row', async () => {
    const container = await mountWorkbook();

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
    const container = await mountWorkbook();

    await openFormat(container);
    expect(openRows()).toEqual(expect.arrayContaining(['Text', 'Alignment', 'Font size', 'Fill color']));

    // Bold, Italic, the font picker and Text color.
    await openSubmenu('Text');
    expect(openRows()).toEqual(expect.arrayContaining(['Bold', 'Italic', 'Font', 'Font color']));

    // The three align buttons.
    await openSubmenu('Alignment');
    expect(openRows()).toEqual(expect.arrayContaining(['Left', 'Center', 'Right']));

    // The size box and its steppers.
    await openSubmenu('Font size');
    expect(openRows()).toEqual(expect.arrayContaining(['10', '12', '14']));
});
