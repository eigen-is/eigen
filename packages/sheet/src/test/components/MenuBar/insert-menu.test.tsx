// Insert › Auto SUM lists its functions in a fixed order, and each one opens the cell editor on its formula.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

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
        root.render(createElement(Workbook, { data, hooks: {} }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return container;
}

async function openAutoSum(container: HTMLElement) {
    const insert = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'Insert',
    );
    await act(async () => {
        insert?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await openSubmenu('Auto SUM');
}

const autoSumRows = () =>
    [...([...document.querySelectorAll('[role="menu"]')].at(-1)?.querySelectorAll('[role="menuitem"]') ?? [])].map(
        (row) => row.textContent?.trim(),
    );

test('Insert › Auto SUM lists SUM first, then the four functions, then the function list', async () => {
    const container = await mountWorkbook();
    await openAutoSum(container);
    expect(autoSumRows()).toEqual(['Sum (SUM)', 'Average', 'Count', 'Max', 'Min', 'More functions…']);
});

test('each function opens the cell editor on its own formula', async () => {
    const container = await mountWorkbook();
    for (const [label, formula] of [
        ['Average', '=AVERAGE()'],
        ['Count', '=COUNT()'],
        ['Max', '=MAX()'],
        ['Min', '=MIN()'],
    ]) {
        await openAutoSum(container);
        await clickRow(label);
        expect(container.querySelector('#sheet-rich-text-editor')?.textContent).toBe(formula);
    }
});
