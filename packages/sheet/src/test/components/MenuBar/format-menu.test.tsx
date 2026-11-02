// Format › Number is a choice: the presets in Google's groups, the cell's format checked, the custom dialogs after.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { checkRows, clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mountWorkbook() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const data: Sheet[] = [
        { id: 's1', name: 'One', order: 0, status: 1, row: 10, column: 5, celldata: [], config: {} },
    ];
    await act(async () => {
        root.render(createElement(Workbook, { data, showToolbar: true, showFormulaBar: false, hooks: {} }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return container;
}

async function openNumber(container: HTMLElement) {
    const format = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'Format',
    );
    await act(async () => {
        format?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await openSubmenu('Number');
}

// The open submenu's plain rows, which follow its choice.
const actionRows = () =>
    [...([...document.querySelectorAll('[role="menu"]')].at(-1)?.querySelectorAll('[role="menuitem"]') ?? [])].map(
        (row) => row.textContent?.trim(),
    );
const checked = () => checkRows().filter(([, state]) => state === 'true');

test("Format › Number checks the cell's format and a pick sets it", async () => {
    const container = await mountWorkbook();
    await openNumber(container);
    expect(actionRows()).toEqual(['Custom currency', 'Custom date and time', 'Custom number format']);
    expect(checkRows().map(([label]) => label)).toContain('Percent10.12%');
    expect(checked()).toEqual([['Automatic', 'true']]);

    await clickRow('Percent10.12%');
    await openNumber(container);
    expect(checked()).toEqual([['Percent10.12%', 'true']]);
});

async function openConditionalFormatting(container: HTMLElement) {
    const format = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'Format',
    );
    await act(async () => {
        format?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await openSubmenu('Conditional formatting');
}

// One dialog, not a FormDialog nested in the slot's old shell.
const dialogTitles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);

test('Format › Conditional formatting opens a rule dialog as one dialog', async () => {
    const container = await mountWorkbook();
    await openConditionalFormatting(container);
    await openSubmenu('Highlight cell rules');
    await clickRow('Greater than>');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialogTitles()).toEqual(['Greater than']);
});

test('Format › Conditional formatting › Manage rules opens the rules list as one dialog', async () => {
    const container = await mountWorkbook();
    await openConditionalFormatting(container);
    await clickRow('Manage rules');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialogTitles()).toEqual(['Manage rules']);
});

test('Format › Conditional formatting › Delete rule holds only Delete sheet rules', async () => {
    const container = await mountWorkbook();
    await openConditionalFormatting(container);
    await openSubmenu('Delete rule');
    expect(actionRows()).toEqual(['Delete sheet rules']);
});
