// Insert › Auto SUM lists its functions in a fixed order, and each one opens the cell editor on its formula. Image and
// Comment show only when the host can insert one, since nothing in the sheet could enable them.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type Hooks = import('../../../state').Hooks;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mountWorkbook(hooks: Hooks = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, row: 10, column: 5, celldata: [], config: {} }];
    await act(async () => {
        root.render(createElement(Workbook, { data, hooks }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return container;
}

async function openInsert(container: HTMLElement) {
    const insert = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'Insert',
    );
    await act(async () => {
        insert?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

async function openAutoSum(container: HTMLElement) {
    await openInsert(container);
    await openSubmenu('Auto SUM');
}

const lastMenuRows = () =>
    [...([...document.querySelectorAll('[role="menu"]')].at(-1)?.querySelectorAll('[role="menuitem"]') ?? [])].map(
        (row) => row.textContent?.trim(),
    );

test('Insert › Auto SUM lists SUM first, then the four functions, then the function list', async () => {
    const container = await mountWorkbook();
    await openAutoSum(container);
    expect(lastMenuRows()).toEqual(['Sum (SUM)', 'Average', 'Count', 'Max', 'Min', 'More functions…']);
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

test('Insert hides Image and Comment from a host that gives no way to insert them', async () => {
    await openInsert(await mountWorkbook());
    expect(lastMenuRows()).not.toContain('Image');
    expect(lastMenuRows()).not.toContain('Comment');
});

test('Insert shows Image and Comment when the host can insert them', async () => {
    await openInsert(await mountWorkbook({ onInsertImage: () => {}, onAddComment: () => {} }));
    expect(lastMenuRows()).toContain('Image');
    expect(lastMenuRows()).toContain('Comment');
});
